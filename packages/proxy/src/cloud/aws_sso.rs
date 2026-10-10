//! AWS IAM Identity Center (SSO) profiles, as `aws sso login` leaves them.
//!
//! A profile in the AWS config file (`AWS_CONFIG_FILE`, default
//! `~/.aws/config`) names its sign-in either through an `sso-session`
//! section (the current form) or with `sso_start_url` / `sso_region` on the
//! profile itself (the legacy form), plus `sso_account_id` and
//! `sso_role_name`. `aws sso login` writes the access token to
//! `~/.aws/sso/cache/<sha1 hex>.json`, keyed by the session name (or, for a
//! legacy profile, the start URL). The role's credentials come from the
//! portal's `GetRoleCredentials`:
//!
//! `GET https://portal.sso.<region>.amazonaws.com/federation/credentials?account_id=…&role_name=…`
//! with `x-amz-sso_bearer_token`.
//!
//! An expired access token is refreshed with the cached refresh token and
//! client registration (`sso-session` profiles; IAM Identity Center OIDC
//! `CreateToken`, `grantType: refresh_token`), in memory only; when that is
//! not possible the error says to run `aws sso login`.
//! <https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.html>
//! <https://docs.aws.amazon.com/singlesignon/latest/PortalAPIReference/API_GetRoleCredentials.html>
//! <https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_CreateToken.html>

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use super::auth::{cache_get, cache_put, fingerprint, AuthError, Cached};
use super::sigv4::AwsCredentials;

/// An SSO profile's sign-in and the role it assumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SsoProfile {
    pub profile: String,
    pub start_url: String,
    pub sso_region: String,
    pub account_id: String,
    pub role_name: String,
    /// What the token cache file is named after: the session name, or the
    /// start URL for a legacy profile.
    pub cache_key: String,
}

/// Sections of an AWS INI file: `[default]`, `[profile x]`, `[sso-session y]`.
fn sections(text: &str) -> HashMap<String, HashMap<String, String>> {
    let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
            out.entry(name.clone()).or_default();
            current = Some(name);
            continue;
        }
        if let (Some(sec), Some((k, v))) = (&current, line.split_once('=')) {
            if let Some(map) = out.get_mut(sec) {
                map.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
    }
    out
}

/// The SSO configuration of `profile` in an AWS config file's text, if the
/// profile signs in through IAM Identity Center. `Some(Err)` names what is
/// missing from a profile that does.
pub(crate) fn parse_sso_profile(
    text: &str,
    profile: &str,
) -> Option<Result<SsoProfile, AuthError>> {
    let secs = sections(text);
    let p = if profile == "default" {
        secs.get("default").or_else(|| secs.get("profile default"))
    } else {
        secs.get(&format!("profile {profile}"))
    }?;
    let get = |m: &HashMap<String, String>, k: &str| m.get(k).filter(|v| !v.is_empty()).cloned();
    let (start_url, sso_region, cache_key) = if let Some(session) = get(p, "sso_session") {
        let Some(s) = secs.get(&format!("sso-session {session}")) else {
            return Some(Err(AuthError::rejected(format!(
                "AWS profile '{profile}' names sso_session '{session}', which the config file does not define"
            ))));
        };
        (get(s, "sso_start_url"), get(s, "sso_region"), session)
    } else if let Some(url) = get(p, "sso_start_url") {
        (Some(url.clone()), get(p, "sso_region"), url)
    } else {
        return None;
    };
    let missing = |what: &str| {
        AuthError::rejected(format!(
            "AWS profile '{profile}' signs in with IAM Identity Center but has no {what}"
        ))
    };
    let build = || -> Result<SsoProfile, AuthError> {
        Ok(SsoProfile {
            profile: profile.to_string(),
            start_url: start_url.clone().ok_or_else(|| missing("sso_start_url"))?,
            sso_region: sso_region.clone().ok_or_else(|| missing("sso_region"))?,
            account_id: get(p, "sso_account_id").ok_or_else(|| missing("sso_account_id"))?,
            role_name: get(p, "sso_role_name").ok_or_else(|| missing("sso_role_name"))?,
            cache_key: cache_key.clone(),
        })
    };
    let profile_ok = build();
    // The region becomes part of a hostname.
    Some(profile_ok.and_then(|sp| {
        if sp
            .sso_region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            Ok(sp)
        } else {
            Err(AuthError::rejected(format!(
                "AWS profile '{profile}' has an sso_region that is not a region name"
            )))
        }
    }))
}

/// The SSO profile `AWS_PROFILE` (default `default`) names in the config file.
pub(crate) fn sso_profile(
    env: &impl Fn(&str) -> Option<String>,
) -> Option<Result<SsoProfile, AuthError>> {
    let path = env("AWS_CONFIG_FILE").or_else(|| {
        env("HOME")
            .or_else(|| env("USERPROFILE"))
            .map(|h| format!("{h}/.aws/config"))
    })?;
    let text = std::fs::read_to_string(path).ok()?;
    let profile = env("AWS_PROFILE").unwrap_or_else(|| "default".into());
    parse_sso_profile(&text, &profile)
}

/// The token cache file name for a session name or start URL.
pub(crate) fn cache_file_name(cache_key: &str) -> String {
    format!("{}.json", hex::encode(Sha1::digest(cache_key.as_bytes())))
}

/// Where the portal and OIDC endpoints are; overridden only by tests.
#[derive(Debug, Clone, Default)]
pub(crate) struct SsoEndpoints {
    pub portal: Option<String>,
    pub oidc: Option<String>,
}

fn login_again(p: &SsoProfile) -> AuthError {
    AuthError::rejected(format!(
        "the IAM Identity Center session for AWS profile '{}' has expired; run `aws sso login --profile {}`",
        p.profile, p.profile
    ))
}

/// The role credentials for an SSO profile.
pub(crate) async fn sso_credentials(
    client: &reqwest::Client,
    p: &SsoProfile,
    cache_dir: &std::path::Path,
    ep: &SsoEndpoints,
) -> Result<AwsCredentials, AuthError> {
    let key = format!(
        "aws-sso:{}",
        fingerprint(&[&p.start_url, &p.account_id, &p.role_name])
    );
    if let Some(Cached::Aws(c)) = cache_get(&key) {
        return Ok(c);
    }
    let file = cache_dir.join(cache_file_name(&p.cache_key));
    let cached: Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| {
            AuthError::rejected(format!(
                "no IAM Identity Center sign-in is cached for AWS profile '{}'; run `aws sso login --profile {}`",
                p.profile, p.profile
            ))
        })?;
    let s = |k: &str| {
        cached
            .get(k)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
    };
    let live = |at: Option<&str>| {
        at.and_then(|e| chrono::DateTime::parse_from_rfc3339(e).ok())
            .is_some_and(|t| {
                t.with_timezone(&chrono::Utc) > chrono::Utc::now() + chrono::Duration::seconds(60)
            })
    };
    let token = if live(s("expiresAt")) {
        s("accessToken").ok_or_else(|| login_again(p))?.to_string()
    } else {
        match (
            s("refreshToken"),
            s("clientId"),
            s("clientSecret"),
            live(s("registrationExpiresAt")),
        ) {
            (Some(refresh), Some(id), Some(secret), true) => {
                refresh_token(client, p, ep, refresh, id, secret).await?
            }
            _ => return Err(login_again(p)),
        }
    };

    let portal = ep
        .portal
        .clone()
        .unwrap_or_else(|| format!("https://portal.sso.{}.amazonaws.com", p.sso_region));
    let mut bearer = reqwest::header::HeaderValue::from_str(&token)
        .map_err(|_| AuthError::rejected("the cached IAM Identity Center token is not valid"))?;
    bearer.set_sensitive(true);
    let resp = client
        .get(format!("{portal}/federation/credentials"))
        .query(&[("account_id", &p.account_id), ("role_name", &p.role_name)])
        .header("x-amz-sso_bearer_token", bearer)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| {
            AuthError::unreachable("the IAM Identity Center portal could not be reached")
        })?;
    let status = resp.status().as_u16();
    if status == 401 {
        return Err(login_again(p));
    }
    if !resp.status().is_success() {
        return Err(AuthError::rejected(format!(
            "IAM Identity Center refused role {} in account {} (HTTP {status})",
            p.role_name, p.account_id
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AuthError::unreachable("IAM Identity Center answered without JSON"))?;
    let rc = v.get("roleCredentials").unwrap_or(&Value::Null);
    let f = |k: &str| rc.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let creds = AwsCredentials {
        access_key_id: f("accessKeyId").ok_or_else(|| {
            AuthError::unreachable("IAM Identity Center answered without credentials")
        })?,
        secret_access_key: f("secretAccessKey").ok_or_else(|| {
            AuthError::unreachable("IAM Identity Center answered without credentials")
        })?,
        session_token: f("sessionToken"),
    };
    // `expiration` is epoch milliseconds.
    let lifetime = rc
        .get("expiration")
        .and_then(|e| e.as_i64())
        .map(|ms| ms - chrono::Utc::now().timestamp_millis())
        .filter(|ms| *ms > 0)
        .map(|ms| Duration::from_millis(ms as u64))
        .unwrap_or(Duration::ZERO);
    cache_put(key, Cached::Aws(creds.clone()), lifetime);
    Ok(creds)
}

async fn refresh_token(
    client: &reqwest::Client,
    p: &SsoProfile,
    ep: &SsoEndpoints,
    refresh: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<String, AuthError> {
    let oidc = ep
        .oidc
        .clone()
        .unwrap_or_else(|| format!("https://oidc.{}.amazonaws.com", p.sso_region));
    let resp = client
        .post(format!("{oidc}/token"))
        .json(&json!({
            "clientId": client_id,
            "clientSecret": client_secret,
            "grantType": "refresh_token",
            "refreshToken": refresh,
        }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| AuthError::unreachable("IAM Identity Center OIDC could not be reached"))?;
    if !resp.status().is_success() {
        return Err(login_again(p));
    }
    let v: Value = resp.json().await.map_err(|_| login_again(p))?;
    v.get("accessToken")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| login_again(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// The two documented shapes, from the AWS SDKs and Tools reference guide
    /// ("IAM Identity Center credential provider").
    const CONFIG: &str = r#"
[default]
region = us-east-1

[profile my-dev-profile]
sso_session = my-sso
sso_account_id = 111122223333
sso_role_name = SampleRole

[sso-session my-sso]
sso_region = us-east-1
sso_start_url = https://my-sso-portal.awsapps.com/start
sso_registration_scopes = sso:account:access

[profile legacy]
sso_start_url = https://legacy-portal.awsapps.com/start
sso_region = eu-west-1
sso_account_id = 444455556666
sso_role_name = ReadOnly

[profile broken]
sso_session = nowhere
"#;

    #[test]
    fn both_profile_shapes_parse_and_static_profiles_are_not_sso() {
        let p = parse_sso_profile(CONFIG, "my-dev-profile")
            .unwrap()
            .unwrap();
        assert_eq!(p.start_url, "https://my-sso-portal.awsapps.com/start");
        assert_eq!(p.sso_region, "us-east-1");
        assert_eq!(p.account_id, "111122223333");
        assert_eq!(p.role_name, "SampleRole");
        assert_eq!(p.cache_key, "my-sso");
        let l = parse_sso_profile(CONFIG, "legacy").unwrap().unwrap();
        assert_eq!(l.cache_key, "https://legacy-portal.awsapps.com/start");
        assert_eq!(l.sso_region, "eu-west-1");
        assert!(parse_sso_profile(CONFIG, "default").is_none());
        assert!(parse_sso_profile(CONFIG, "absent").is_none());
        let err = parse_sso_profile(CONFIG, "broken").unwrap().unwrap_err();
        assert!(err.message.contains("nowhere"));
    }

    #[test]
    fn cache_files_are_named_by_the_sha1_of_the_session_or_start_url() {
        // sha1("my-sso") and sha1 of the start URL, as the AWS CLI names them.
        assert_eq!(
            cache_file_name("my-sso"),
            format!("{}.json", hex::encode(Sha1::digest(b"my-sso")))
        );
        assert_eq!(cache_file_name("my-sso").len(), 45);
    }

    fn write_cache(dir: &std::path::Path, key: &str, doc: serde_json::Value) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(cache_file_name(key)), doc.to_string()).unwrap();
    }

    #[tokio::test]
    async fn a_live_token_gets_role_credentials_from_the_portal() {
        let server = MockServer::start().await;
        let exp = chrono::Utc::now().timestamp_millis() + 3_600_000;
        Mock::given(method("GET"))
            .and(path("/federation/credentials"))
            .and(query_param("account_id", "111122223333"))
            .and(query_param("role_name", "SampleRole"))
            .and(header("x-amz-sso_bearer_token", "sso-access-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "roleCredentials": {"accessKeyId": "ASIASSO", "secretAccessKey": "s", "sessionToken": "t", "expiration": exp}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let dir = std::env::temp_dir().join(format!("intutic-sso-{}", uuid::Uuid::new_v4()));
        let mut p = parse_sso_profile(CONFIG, "my-dev-profile")
            .unwrap()
            .unwrap();
        // A start URL unique to this test, so the in-process cache is fresh.
        p.start_url = format!("{}#{}", p.start_url, uuid::Uuid::new_v4());
        write_cache(
            &dir,
            "my-sso",
            json!({"startUrl": p.start_url, "region": "us-east-1", "accessToken": "sso-access-token",
                   "expiresAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()}),
        );
        let ep = SsoEndpoints {
            portal: Some(server.uri()),
            oidc: None,
        };
        let c = sso_credentials(&reqwest::Client::new(), &p, &dir, &ep)
            .await
            .unwrap();
        assert_eq!(c.access_key_id, "ASIASSO");
        assert_eq!(c.session_token.as_deref(), Some("t"));
        // Served from the in-process cache the second time (`expect(1)`).
        sso_credentials(&reqwest::Client::new(), &p, &dir, &ep)
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_expired_token_is_refreshed_or_the_error_says_to_log_in() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_json(
                json!({"clientId": "cid", "clientSecret": "csecret",
                                  "grantType": "refresh_token", "refreshToken": "rtok"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "refreshed-token", "expiresIn": 3600, "tokenType": "Bearer"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/federation/credentials"))
            .and(header("x-amz-sso_bearer_token", "refreshed-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "roleCredentials": {"accessKeyId": "ASIAREFRESHED", "secretAccessKey": "s", "sessionToken": "t",
                                    "expiration": chrono::Utc::now().timestamp_millis() + 3_600_000}
            })))
            .mount(&server)
            .await;
        let dir = std::env::temp_dir().join(format!("intutic-sso-{}", uuid::Uuid::new_v4()));
        let mut p = parse_sso_profile(CONFIG, "my-dev-profile")
            .unwrap()
            .unwrap();
        p.start_url = format!("{}#{}", p.start_url, uuid::Uuid::new_v4());
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        let future = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
        write_cache(
            &dir,
            "my-sso",
            json!({"accessToken": "stale", "expiresAt": past, "refreshToken": "rtok",
                   "clientId": "cid", "clientSecret": "csecret", "registrationExpiresAt": future}),
        );
        let ep = SsoEndpoints {
            portal: Some(server.uri()),
            oidc: Some(server.uri()),
        };
        let c = sso_credentials(&reqwest::Client::new(), &p, &dir, &ep)
            .await
            .unwrap();
        assert_eq!(c.access_key_id, "ASIAREFRESHED");

        // A legacy profile's cache holds no refresh token: log in again.
        let mut l = parse_sso_profile(CONFIG, "legacy").unwrap().unwrap();
        l.start_url = format!("{}#{}", l.start_url, uuid::Uuid::new_v4());
        write_cache(
            &dir,
            &l.cache_key,
            json!({"accessToken": "stale", "expiresAt": past}),
        );
        let err = sso_credentials(&reqwest::Client::new(), &l, &dir, &ep)
            .await
            .unwrap_err();
        assert!(
            err.message.contains("aws sso login --profile legacy"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("stale"));

        // Nothing cached at all.
        let empty = dir.join("none");
        let err = sso_credentials(&reqwest::Client::new(), &l, &empty, &ep)
            .await
            .unwrap_err();
        assert!(err.message.contains("aws sso login"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
