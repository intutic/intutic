//! `AWS_PROFILE` in the shared AWS files: static keys, an IAM Identity Center
//! sign-in, or a role assumed from one of those.
//!
//! A profile is read from the config file (`AWS_CONFIG_FILE`, default
//! `~/.aws/config`; `[default]` or `[profile name]`) and the credentials file
//! (`AWS_SHARED_CREDENTIALS_FILE`, default `~/.aws/credentials`; `[name]`),
//! the credentials file winning where both set a key, as the AWS CLI does.
//!
//! A profile with `role_arn` assumes that role with STS `AssumeRole`, signed
//! with its source credentials:
//!
//! - `source_profile`: another profile's credentials — itself a role, an SSO
//!   sign-in or static keys, chained to any depth with a cycle guard. A
//!   profile naming itself uses its own static keys.
//! - `credential_source`: `Environment` (`AWS_ACCESS_KEY_ID`…),
//!   `Ec2InstanceMetadata` (the instance role) or `EcsContainer` (container
//!   credentials).
//!
//! `external_id`, `role_session_name` and `duration_seconds` are sent as
//! `ExternalId`, `RoleSessionName` and `DurationSeconds`. A profile with
//! `mfa_serial` is refused: the proxy cannot prompt for a code. Chains stop
//! at 16 profiles. Credentials from each `AssumeRole` are cached until five
//! minutes before they expire, then assumed again.
//!
//! This reads only the operator's own files: a workspace's stored Bedrock
//! credential is a key pair or an API key, never a profile.
//! <https://docs.aws.amazon.com/sdkref/latest/guide/feature-assume-role-credentials.html>
//! <https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html>

use std::collections::HashMap;
use std::time::Duration;

use super::auth::{
    cache_get, cache_put, container_credentials, fingerprint, imds_credentials, sts_credentials,
    AuthError, AwsEndpoints, Cached,
};
use super::aws_sso::{parse_sso_profile, sections, sso_credentials};
use super::sigv4::{self, AwsCredentials};

/// The most profiles one chain may pass through.
const MAX_CHAIN: usize = 16;

/// The shared files, read once per resolution.
pub(crate) struct ProfileFiles {
    config_text: String,
    config: HashMap<String, HashMap<String, String>>,
    credentials: HashMap<String, HashMap<String, String>>,
}

impl ProfileFiles {
    pub(crate) fn parse(config_text: &str, credentials_text: &str) -> Self {
        ProfileFiles {
            config_text: config_text.to_string(),
            config: sections(config_text),
            credentials: sections(credentials_text),
        }
    }

    fn load(env: &impl Fn(&str) -> Option<String>) -> Self {
        let home = env("HOME").or_else(|| env("USERPROFILE"));
        let read = |var: &str, default: &str| {
            env(var)
                .or_else(|| home.as_ref().map(|h| format!("{h}/{default}")))
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_default()
        };
        Self::parse(
            &read("AWS_CONFIG_FILE", ".aws/config"),
            &read("AWS_SHARED_CREDENTIALS_FILE", ".aws/credentials"),
        )
    }

    /// A profile's settings, the credentials file's over the config file's.
    fn profile(&self, name: &str) -> Option<HashMap<String, String>> {
        let from_config = if name == "default" {
            self.config
                .get("default")
                .or_else(|| self.config.get("profile default"))
        } else {
            self.config.get(&format!("profile {name}"))
        };
        let from_credentials = self.credentials.get(name);
        if from_config.is_none() && from_credentials.is_none() {
            return None;
        }
        let mut merged = from_config.cloned().unwrap_or_default();
        if let Some(c) = from_credentials {
            merged.extend(c.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        merged.retain(|_, v| !v.is_empty());
        Some(merged)
    }
}

/// One `AssumeRole` in a chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoleStep {
    pub profile: String,
    pub role_arn: String,
    pub external_id: Option<String>,
    pub session_name: String,
    pub duration_seconds: Option<u32>,
}

/// Where a chain's first credentials come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Base {
    Static(AwsCredentials),
    Sso(String),
    Environment,
    Ec2InstanceMetadata,
    EcsContainer,
}

/// A profile resolved into its source and the roles assumed from it, the
/// outermost (the requested profile's role) first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
    pub base: Base,
    pub roles: Vec<RoleStep>,
}

fn static_keys(s: &HashMap<String, String>) -> Option<AwsCredentials> {
    Some(AwsCredentials {
        access_key_id: s.get("aws_access_key_id")?.clone(),
        secret_access_key: s.get("aws_secret_access_key")?.clone(),
        session_token: s.get("aws_session_token").cloned(),
    })
}

/// How `name`'s credentials are obtained, read from the files alone.
/// `Ok(None)`: the profile does not exist, or names no credentials.
pub(crate) fn plan(files: &ProfileFiles, name: &str) -> Result<Option<Plan>, AuthError> {
    let mut roles = Vec::new();
    let mut visited: Vec<String> = Vec::new();
    let mut current = name.to_string();
    loop {
        if visited.contains(&current) {
            visited.push(current);
            return Err(AuthError::rejected(format!(
                "AWS profiles name each other in a cycle: {}",
                visited.join(" -> ")
            )));
        }
        if visited.len() >= MAX_CHAIN {
            return Err(AuthError::rejected(format!(
                "AWS profile '{name}' chains through more than {MAX_CHAIN} profiles"
            )));
        }
        visited.push(current.clone());
        let Some(s) = files.profile(&current) else {
            if roles.is_empty() {
                return Ok(None);
            }
            return Err(AuthError::rejected(format!(
                "AWS profile '{current}', a source_profile, is not defined"
            )));
        };

        if let Some(role_arn) = s.get("role_arn") {
            if s.contains_key("mfa_serial") {
                return Err(AuthError::rejected(format!(
                    "AWS profile '{current}' requires an MFA code (mfa_serial), which the proxy \
                     cannot prompt for; use a profile without MFA, or temporary credentials"
                )));
            }
            let duration_seconds = match s.get("duration_seconds") {
                None => None,
                Some(d) => match d.parse::<u32>() {
                    Ok(n) if (900..=43_200).contains(&n) => Some(n),
                    _ => {
                        return Err(AuthError::rejected(format!(
                            "AWS profile '{current}' has a duration_seconds outside 900 to 43200"
                        )))
                    }
                },
            };
            roles.push(RoleStep {
                profile: current.clone(),
                role_arn: role_arn.clone(),
                external_id: s.get("external_id").cloned(),
                session_name: s
                    .get("role_session_name")
                    .cloned()
                    .unwrap_or_else(|| "intutic-proxy".into()),
                duration_seconds,
            });
            match (s.get("source_profile"), s.get("credential_source")) {
                (Some(_), Some(_)) => {
                    return Err(AuthError::rejected(format!(
                        "AWS profile '{current}' sets both source_profile and credential_source"
                    )))
                }
                (None, None) => {
                    return Err(AuthError::rejected(format!(
                        "AWS profile '{current}' sets role_arn without source_profile or credential_source"
                    )))
                }
                (Some(source), None) if *source == current => {
                    // A profile that names itself assumes the role with its
                    // own static keys.
                    let keys = static_keys(&s).ok_or_else(|| {
                        AuthError::rejected(format!(
                            "AWS profile '{current}' names itself as source_profile but has no keys"
                        ))
                    })?;
                    return Ok(Some(Plan {
                        base: Base::Static(keys),
                        roles,
                    }));
                }
                (Some(source), None) => {
                    current = source.clone();
                    continue;
                }
                (None, Some(cs)) => {
                    let base = match cs.as_str() {
                        "Environment" => Base::Environment,
                        "Ec2InstanceMetadata" => Base::Ec2InstanceMetadata,
                        "EcsContainer" => Base::EcsContainer,
                        other => {
                            return Err(AuthError::rejected(format!(
                                "AWS profile '{current}' has credential_source '{other}'; use \
                                 Environment, Ec2InstanceMetadata or EcsContainer"
                            )))
                        }
                    };
                    return Ok(Some(Plan { base, roles }));
                }
            }
        }

        if let Some(keys) = static_keys(&s) {
            return Ok(Some(Plan {
                base: Base::Static(keys),
                roles,
            }));
        }
        if s.contains_key("sso_session") || s.contains_key("sso_start_url") {
            return Ok(Some(Plan {
                base: Base::Sso(current),
                roles,
            }));
        }
        if roles.is_empty() {
            // A profile with only settings (a region, say): not a credential.
            return Ok(None);
        }
        return Err(AuthError::rejected(format!(
            "AWS profile '{current}', a source_profile, has no credentials (keys, SSO or a role)"
        )));
    }
}

/// `AWS_PROFILE`'s credentials, when the shared files define them.
pub(crate) async fn profile_credentials(
    client: &reqwest::Client,
    region: &str,
    ep: &AwsEndpoints,
    env: &impl Fn(&str) -> Option<String>,
) -> Option<Result<AwsCredentials, AuthError>> {
    let files = ProfileFiles::load(env);
    let name = env("AWS_PROFILE").unwrap_or_else(|| "default".into());
    let plan = match plan(&files, &name) {
        Ok(Some(p)) => p,
        Ok(None) => return None,
        Err(e) => return Some(Err(e)),
    };
    Some(run(client, region, ep, env, &files, &plan).await)
}

async fn run(
    client: &reqwest::Client,
    region: &str,
    ep: &AwsEndpoints,
    env: &impl Fn(&str) -> Option<String>,
    files: &ProfileFiles,
    plan: &Plan,
) -> Result<AwsCredentials, AuthError> {
    let mut creds = match &plan.base {
        Base::Static(k) => k.clone(),
        Base::Sso(profile) => {
            let sso = parse_sso_profile(&files.config_text, profile).ok_or_else(|| {
                AuthError::rejected(format!(
                    "AWS profile '{profile}' has no IAM Identity Center settings in the config file"
                ))
            })??;
            let home = env("HOME")
                .or_else(|| env("USERPROFILE"))
                .unwrap_or_default();
            let cache_dir = std::path::Path::new(&home).join(".aws/sso/cache");
            sso_credentials(client, &sso, &cache_dir, &ep.sso).await?
        }
        Base::Environment => match (env("AWS_ACCESS_KEY_ID"), env("AWS_SECRET_ACCESS_KEY")) {
            (Some(id), Some(secret)) => AwsCredentials {
                access_key_id: id,
                secret_access_key: secret,
                session_token: env("AWS_SESSION_TOKEN"),
            },
            _ => {
                return Err(AuthError::rejected(
                    "credential_source Environment, but AWS_ACCESS_KEY_ID and \
                     AWS_SECRET_ACCESS_KEY are not set",
                ))
            }
        },
        Base::Ec2InstanceMetadata => imds_credentials(client, &ep.imds).await?,
        Base::EcsContainer => container_credentials(client, &ep.container_host, env)
            .await
            .unwrap_or_else(|| {
                Err(AuthError::rejected(
                    "credential_source EcsContainer, but no container credentials endpoint is set \
                     (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or _FULL_URI)",
                ))
            })?,
    };
    // Innermost role first: each is assumed with the credentials before it.
    for step in plan.roles.iter().rev() {
        creds = assume_role(client, region, ep.sts.as_deref(), &creds, step).await?;
    }
    Ok(creds)
}

/// STS `AssumeRole`, SigV4-signed with `source`.
pub(crate) async fn assume_role(
    client: &reqwest::Client,
    region: &str,
    sts_override: Option<&str>,
    source: &AwsCredentials,
    step: &RoleStep,
) -> Result<AwsCredentials, AuthError> {
    let duration = step.duration_seconds.map(|d| d.to_string());
    let key = format!(
        "aws-role:{}",
        fingerprint(&[
            &step.role_arn,
            &source.access_key_id,
            step.external_id.as_deref().unwrap_or(""),
            &step.session_name,
            duration.as_deref().unwrap_or(""),
        ])
    );
    if let Some(Cached::Aws(c)) = cache_get(&key) {
        return Ok(c);
    }
    let base = sts_override
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://sts.{region}.amazonaws.com"));
    let url = reqwest::Url::parse(&format!("{base}/"))
        .map_err(|_| AuthError::rejected("the AWS STS endpoint is not a URL"))?;
    let host = match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        (None, _) => return Err(AuthError::rejected("the AWS STS endpoint has no host")),
    };
    let mut params: Vec<(&str, &str)> = vec![
        ("Action", "AssumeRole"),
        ("Version", "2011-06-15"),
        ("RoleArn", &step.role_arn),
        ("RoleSessionName", &step.session_name),
    ];
    if let Some(d) = &duration {
        params.push(("DurationSeconds", d));
    }
    if let Some(x) = &step.external_id {
        params.push(("ExternalId", x));
    }
    let body = params
        .iter()
        .map(|(k, v)| format!("{}={}", sigv4::uri_encode(k), sigv4::uri_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";
    let signed = sigv4::sign(
        &sigv4::Request {
            method: "POST",
            host: &host,
            path: "/",
            query: &[],
            headers: &[("content-type", content_type)],
            payload: body.as_bytes(),
        },
        source,
        region,
        "sts",
        chrono::Utc::now(),
    );
    let mut req = client
        .post(url)
        .header("content-type", content_type)
        .header("accept", "application/xml")
        .body(body)
        .timeout(Duration::from_secs(10));
    for (k, v) in signed {
        let mut value = reqwest::header::HeaderValue::from_str(&v)
            .map_err(|_| AuthError::rejected("the AWS source credentials are not valid"))?;
        if k != "x-amz-date" {
            value.set_sensitive(true);
        }
        req = req.header(k, value);
    }
    let resp = req
        .send()
        .await
        .map_err(|_| AuthError::unreachable("AWS STS could not be reached"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = text
            .split("<Code>")
            .nth(1)
            .and_then(|r| r.split("</Code>").next())
            .unwrap_or("");
        return Err(AuthError::rejected(format!(
            "AWS STS refused to assume {} for profile '{}' (HTTP {}{}{})",
            step.role_arn,
            step.profile,
            status.as_u16(),
            if code.is_empty() { "" } else { " " },
            code
        )));
    }
    let (creds, lifetime) = sts_credentials(&text)
        .ok_or_else(|| AuthError::unreachable("AWS STS answered without credentials"))?;
    cache_put(key, Cached::Aws(creds.clone()), lifetime);
    Ok(creds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header_exists, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    /// The shapes in the AWS SDKs and Tools reference guide ("Assume role
    /// credential provider") and the AWS CLI user guide ("Use an IAM role").
    const CONFIG: &str = r#"
[default]
region = us-east-1

[profile marketingadmin]
role_arn = arn:aws:iam::123456789012:role/marketingadminrole
source_profile = user1
role_session_name = session_name_example
duration_seconds = 3600
external_id = unique_value_assigned_by_3rd_party

[profile chained]
role_arn = arn:aws:iam::210987654321:role/ReadOnly
source_profile = marketingadmin

[profile ec2role]
role_arn = arn:aws:iam::123456789012:role/marketingadminrole
credential_source = Ec2InstanceMetadata

[profile envrole]
role_arn = arn:aws:iam::123456789012:role/envrole
credential_source = Environment

[profile mfa]
role_arn = arn:aws:iam::123456789012:role/admin
source_profile = user1
mfa_serial = arn:aws:iam::123456789012:mfa/user1

[profile loop-a]
role_arn = arn:aws:iam::1:role/a
source_profile = loop-b

[profile loop-b]
role_arn = arn:aws:iam::1:role/b
source_profile = loop-a

[profile self]
role_arn = arn:aws:iam::1:role/self
source_profile = self
aws_access_key_id = AKIDSELF
aws_secret_access_key = sself

[profile from-sso]
role_arn = arn:aws:iam::1:role/fromsso
source_profile = sso-dev

[profile sso-dev]
sso_session = my-sso
sso_account_id = 111122223333
sso_role_name = SampleRole

[sso-session my-sso]
sso_region = us-east-1
sso_start_url = https://my-sso-portal.awsapps.com/start

[profile bad-source]
role_arn = arn:aws:iam::1:role/x
credential_source = Ec2Instance

[profile both]
role_arn = arn:aws:iam::1:role/x
source_profile = user1
credential_source = Environment

[profile short]
role_arn = arn:aws:iam::1:role/x
source_profile = user1
duration_seconds = 60
"#;

    fn credentials_file() -> String {
        format!(
            "[user1]\naws_access_key_id = AKIDUSER1\naws_secret_access_key = {}\n\n[default]\naws_access_key_id = AKIDDEF\naws_secret_access_key = sdef\n",
            ["user1", "-secret"].concat()
        )
    }

    fn files() -> ProfileFiles {
        ProfileFiles::parse(CONFIG, &credentials_file())
    }

    #[test]
    fn documented_role_profiles_plan_into_sources_and_steps() {
        let f = files();
        let p = plan(&f, "marketingadmin").unwrap().unwrap();
        assert!(matches!(p.base, Base::Static(ref k) if k.access_key_id == "AKIDUSER1"));
        assert_eq!(
            p.roles,
            vec![RoleStep {
                profile: "marketingadmin".into(),
                role_arn: "arn:aws:iam::123456789012:role/marketingadminrole".into(),
                external_id: Some("unique_value_assigned_by_3rd_party".into()),
                session_name: "session_name_example".into(),
                duration_seconds: Some(3600),
            }]
        );
        let chained = plan(&f, "chained").unwrap().unwrap();
        assert_eq!(chained.roles.len(), 2);
        assert_eq!(
            chained.roles[0].role_arn,
            "arn:aws:iam::210987654321:role/ReadOnly"
        );
        assert_eq!(chained.roles[0].session_name, "intutic-proxy");
        assert_eq!(
            plan(&f, "ec2role").unwrap().unwrap().base,
            Base::Ec2InstanceMetadata
        );
        assert_eq!(
            plan(&f, "envrole").unwrap().unwrap().base,
            Base::Environment
        );
        assert!(
            matches!(plan(&f, "self").unwrap().unwrap().base, Base::Static(ref k) if k.access_key_id == "AKIDSELF")
        );
        assert_eq!(
            plan(&f, "from-sso").unwrap().unwrap().base,
            Base::Sso("sso-dev".into())
        );
        // Static keys from the credentials file; a settings-only profile and
        // an absent one name no credentials.
        assert!(
            matches!(plan(&f, "default").unwrap().unwrap().base, Base::Static(ref k) if k.access_key_id == "AKIDDEF")
        );
        assert!(plan(
            &ProfileFiles::parse("[default]\nregion=us-east-1\n", ""),
            "default"
        )
        .unwrap()
        .is_none());
        assert!(plan(&f, "absent").unwrap().is_none());
    }

    #[test]
    fn unusable_profiles_are_refused_with_the_reason() {
        let f = files();
        let msg = |name: &str| plan(&f, name).unwrap_err().message;
        assert!(msg("mfa").contains("MFA"), "{}", msg("mfa"));
        assert!(
            msg("loop-a").contains("loop-a -> loop-b -> loop-a"),
            "{}",
            msg("loop-a")
        );
        assert!(msg("bad-source").contains("Ec2InstanceMetadata"));
        assert!(msg("both").contains("both"));
        assert!(msg("short").contains("duration_seconds"));
    }

    fn sts_xml(id: &str) -> String {
        let exp = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        format!(
            "<AssumeRoleResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\"><AssumeRoleResult>\
             <Credentials><AccessKeyId>{id}</AccessKeyId><SecretAccessKey>s-{id}</SecretAccessKey>\
             <SessionToken>t-{id}</SessionToken><Expiration>{exp}</Expiration></Credentials>\
             <AssumedRoleUser><Arn>arn</Arn><AssumedRoleId>x</AssumedRoleId></AssumedRoleUser>\
             </AssumeRoleResult></AssumeRoleResponse>"
        )
    }

    #[tokio::test]
    async fn a_chain_assumes_each_role_with_the_credentials_before_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .and(header_exists("x-amz-date"))
            .and(body_string_contains("Action=AssumeRole"))
            .and(body_string_contains(
                "RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Fmarketingadminrole",
            ))
            .and(body_string_contains("RoleSessionName=session_name_example"))
            .and(body_string_contains("DurationSeconds=3600"))
            .and(body_string_contains(
                "ExternalId=unique_value_assigned_by_3rd_party",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(sts_xml("ASIAMARKETING")))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(body_string_contains(
                "RoleArn=arn%3Aaws%3Aiam%3A%3A210987654321%3Arole%2FReadOnly",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(sts_xml("ASIAREADONLY")))
            .expect(1)
            .mount(&server)
            .await;
        let ep = AwsEndpoints {
            sts: Some(server.uri()),
            ..AwsEndpoints::default()
        };
        let mut f = files();
        // A unique source key, so the in-process cache starts empty.
        let unique = format!("AKID{}", uuid::Uuid::new_v4().simple());
        f.credentials
            .get_mut("user1")
            .unwrap()
            .insert("aws_access_key_id".into(), unique.clone());
        let p = plan(&f, "chained").unwrap().unwrap();
        let no_env = |_: &str| None;
        let c = run(&reqwest::Client::new(), "us-east-1", &ep, &no_env, &f, &p)
            .await
            .unwrap();
        assert_eq!(c.access_key_id, "ASIAREADONLY");
        assert_eq!(c.session_token.as_deref(), Some("t-ASIAREADONLY"));

        let reqs: Vec<Request> = server.received_requests().await.unwrap();
        let auth = |r: &Request| r.headers["authorization"].to_str().unwrap().to_string();
        // The inner role is signed with user1's keys, the outer with the inner role's.
        assert!(
            auth(&reqs[0]).contains(&format!("Credential={unique}/")),
            "{}",
            auth(&reqs[0])
        );
        assert!(auth(&reqs[0]).contains("/us-east-1/sts/aws4_request"));
        assert!(auth(&reqs[1]).contains("Credential=ASIAMARKETING/"));
        assert_eq!(reqs[1].headers["x-amz-security-token"], "t-ASIAMARKETING");

        // Cached until near expiry: a second resolution makes no STS call (`expect(1)`).
        let again = run(&reqwest::Client::new(), "us-east-1", &ep, &no_env, &f, &p)
            .await
            .unwrap();
        assert_eq!(again.access_key_id, "ASIAREADONLY");
    }

    #[tokio::test]
    async fn environment_source_and_a_refusal_from_sts() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403).set_body_string(
                "<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not authorized</Message></Error></ErrorResponse>",
            ))
            .mount(&server)
            .await;
        let ep = AwsEndpoints {
            sts: Some(server.uri()),
            ..AwsEndpoints::default()
        };
        let f = files();
        let p = plan(&f, "envrole").unwrap().unwrap();
        let unique = format!("AKIDENV{}", uuid::Uuid::new_v4().simple());
        let env = move |k: &str| match k {
            "AWS_ACCESS_KEY_ID" => Some(unique.clone()),
            "AWS_SECRET_ACCESS_KEY" => Some("env-secret".to_string()),
            _ => None,
        };
        let err = run(&reqwest::Client::new(), "eu-west-1", &ep, &env, &f, &p)
            .await
            .unwrap_err();
        assert!(err.message.contains("AccessDenied"), "{}", err.message);
        assert!(err.message.contains("envrole"));
        assert!(!err.message.contains("env-secret"));
        let no_env = |_: &str| None;
        let err = run(&reqwest::Client::new(), "eu-west-1", &ep, &no_env, &f, &p)
            .await
            .unwrap_err();
        assert!(err.message.contains("AWS_ACCESS_KEY_ID"));
    }
}
