//! Google workload identity federation: `external_account` credential files.
//!
//! A credential configuration file (`gcloud iam workload-identity-pools
//! create-cred-config`) names a subject token the workload already holds — an
//! OIDC or SAML token in a file or behind a URL, or the workload's AWS
//! identity — and how to exchange it:
//!
//! 1. read the subject token from `credential_source` (`file`, `url`, or
//!    `environment_id: aws1`, a signed STS `GetCallerIdentity` request);
//! 2. exchange it at `token_url` (Security Token Service, RFC 8693
//!    token exchange) for a federated access token;
//! 3. with `service_account_impersonation_url`, exchange that for a service
//!    account's access token (IAM Credentials `generateAccessToken`).
//!
//! Executable-sourced credentials are not run: the proxy does not start
//! processes a credential file names.
//!
//! Only an operator's credential file (`providers.vertex.credentials_file`,
//! `GOOGLE_APPLICATION_CREDENTIALS`) may be one: a workspace-stored credential
//! would otherwise choose a local file for the gateway to read or a URL for it
//! to call. `token_url` and the impersonation URL must be `https` Google API
//! hosts, so the subject token goes nowhere else.
//! <https://google.aip.dev/auth/4117>
//! <https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers>

use std::time::Duration;

use serde_json::{json, Value};

use super::auth::{
    cache_get, cache_put, fingerprint, oauth_exchange, require_secure_url, AuthError, Cached,
};
use super::config::Secret;
use super::sigv4::{self, AwsCredentials};

const CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";

/// Where the AWS metadata is read for an `aws1` source when the file names
/// none; and whether the Google endpoints are held to Google's hosts.
/// Overridden only by tests.
pub(crate) struct Options {
    pub validate_hosts: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            validate_hosts: true,
        }
    }
}

fn google_api_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.port().is_none()
            && u.host_str()
                .is_some_and(|h| h == "googleapis.com" || h.ends_with(".googleapis.com"))
    })
}

/// An access token for an `external_account` credential document.
pub(crate) async fn token(
    client: &reqwest::Client,
    doc: &Value,
    opts: &Options,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<Secret, AuthError> {
    let s = |k: &str| doc.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let cache_key = format!("gcp-ext:{}", fingerprint(&[&doc.to_string()]));
    if let Some(Cached::Token(t)) = cache_get(&cache_key) {
        return Ok(t);
    }
    let token_url = s("token_url");
    let impersonation = s("service_account_impersonation_url");
    if s("audience").is_empty() || s("subject_token_type").is_empty() || token_url.is_empty() {
        return Err(AuthError::rejected(
            "the external_account credential needs audience, subject_token_type and token_url",
        ));
    }
    if opts.validate_hosts
        && (!google_api_url(token_url)
            || (!impersonation.is_empty() && !google_api_url(impersonation)))
    {
        return Err(AuthError::rejected(
            "the external_account credential's token_url and service_account_impersonation_url \
             must be https Google API endpoints (*.googleapis.com)",
        ));
    }
    const TOKEN_URL: &str = "the external_account credential's token_url";
    require_secure_url(token_url, TOKEN_URL)?;
    if !impersonation.is_empty() {
        require_secure_url(
            impersonation,
            "the external_account credential's service_account_impersonation_url",
        )?;
    }

    let subject = subject_token(client, doc, env).await?;

    // RFC 8693 token exchange at Google's STS.
    let mut form: Vec<(&str, String)> = vec![
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange".into(),
        ),
        ("audience", s("audience").into()),
        ("scope", CLOUD_PLATFORM_SCOPE.into()),
        (
            "requested_token_type",
            "urn:ietf:params:oauth:token-type:access_token".into(),
        ),
        ("subject_token", subject),
        ("subject_token_type", s("subject_token_type").into()),
    ];
    // A workforce pool without impersonation bills a user project.
    let user_project = s("workforce_pool_user_project");
    if !user_project.is_empty() && impersonation.is_empty() {
        form.push(("options", json!({"userProject": user_project}).to_string()));
    }
    let form_ref: Vec<(&str, &str)> = form.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let (sts_token, sts_lifetime) = if !s("client_id").is_empty() {
        // A confidential client authenticates the exchange (basic auth).
        let resp = client
            .post(token_url)
            .basic_auth(s("client_id"), Some(s("client_secret")))
            .form(&form_ref)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| AuthError::unreachable("Google STS could not be reached"))?;
        super::auth::token_response(resp, "Google STS").await?
    } else {
        oauth_exchange(client, token_url, TOKEN_URL, &form_ref, "Google STS").await?
    };

    if impersonation.is_empty() {
        cache_put(cache_key, Cached::Token(sts_token.clone()), sts_lifetime);
        return Ok(sts_token);
    }
    let lifetime_secs = doc
        .pointer("/service_account_impersonation/token_lifetime_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    let mut bearer =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {}", sts_token.expose()))
            .map_err(|_| AuthError::unreachable("Google STS answered with an unusable token"))?;
    bearer.set_sensitive(true);
    let resp = client
        .post(impersonation)
        .header("authorization", bearer)
        .json(&json!({"scope": [CLOUD_PLATFORM_SCOPE], "lifetime": format!("{lifetime_secs}s")}))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| AuthError::unreachable("Google IAM Credentials could not be reached"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AuthError::rejected(format!(
            "Google IAM Credentials refused to impersonate the service account (HTTP {})",
            status.as_u16()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AuthError::unreachable("Google IAM Credentials answered without JSON"))?;
    let token = v
        .get("accessToken")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AuthError::unreachable("Google IAM Credentials answered without a token"))?;
    let lifetime = super::auth::lifetime_until(v.get("expireTime").and_then(|e| e.as_str()));
    let token = Secret::new(token);
    cache_put(cache_key, Cached::Token(token.clone()), lifetime);
    Ok(token)
}

/// The subject token `credential_source` names.
async fn subject_token(
    client: &reqwest::Client,
    doc: &Value,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<String, AuthError> {
    let src = doc.get("credential_source").ok_or_else(|| {
        AuthError::rejected("the external_account credential has no credential_source")
    })?;
    let field = |k: &str| src.get(k).and_then(|v| v.as_str());
    if src.get("executable").is_some() {
        return Err(AuthError::rejected(
            "executable-sourced external_account credentials are not supported: the proxy does not \
             run commands a credential file names; use a file- or URL-sourced credential",
        ));
    }
    if field("environment_id").is_some_and(|e| e.starts_with("aws")) {
        return aws_subject_token(client, doc, src, env).await;
    }
    let raw = if let Some(path) = field("file") {
        std::fs::read_to_string(path).map_err(|_| {
            AuthError::rejected("the external_account credential_source file could not be read")
        })?
    } else if let Some(url) = field("url") {
        let mut req = client.get(url).timeout(Duration::from_secs(10));
        if let Some(headers) = src.get("headers").and_then(|h| h.as_object()) {
            for (k, v) in headers {
                if let Some(v) = v.as_str() {
                    req = req.header(k.as_str(), v);
                }
            }
        }
        let resp = req.send().await.map_err(|_| {
            AuthError::unreachable(
                "the external_account credential_source URL could not be reached",
            )
        })?;
        if !resp.status().is_success() {
            return Err(AuthError::rejected(format!(
                "the external_account credential_source URL answered HTTP {}",
                resp.status().as_u16()
            )));
        }
        resp.text().await.map_err(|_| {
            AuthError::unreachable("the external_account credential_source URL answered nothing")
        })?
    } else {
        return Err(AuthError::rejected(
            "the external_account credential_source names no file, url or environment_id",
        ));
    };
    let format = src.get("format");
    let token = match format.and_then(|f| f.get("type")).and_then(|t| t.as_str()) {
        Some("json") => {
            let name = format
                .and_then(|f| f.get("subject_token_field_name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|v| v.get(name).and_then(|t| t.as_str()).map(str::to_string))
                .ok_or_else(|| {
                    AuthError::rejected(format!(
                        "the external_account subject token has no '{name}' field"
                    ))
                })?
        }
        _ => raw.trim().to_string(),
    };
    if token.is_empty() {
        return Err(AuthError::rejected(
            "the external_account subject token is empty",
        ));
    }
    Ok(token)
}

/// An `aws1` subject token: a `GetCallerIdentity` request signed with the
/// workload's AWS credentials, serialized as Google's STS expects it.
async fn aws_subject_token(
    client: &reqwest::Client,
    doc: &Value,
    src: &Value,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<String, AuthError> {
    let field = |k: &str| {
        src.get(k)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
    };
    let env = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    let unreachable = |what: &str| AuthError::unreachable(format!("AWS {what} could not be read"));

    // IMDSv2 session token, when the file asks for one.
    let imds_token = match field("imdsv2_session_token_url") {
        Some(url)
            if env("AWS_REGION")
                .or_else(|| env("AWS_DEFAULT_REGION"))
                .is_none()
                || env("AWS_ACCESS_KEY_ID").is_none() =>
        {
            let t = client
                .put(url)
                .header("x-aws-ec2-metadata-token-ttl-seconds", "300")
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .map_err(|_| unreachable("metadata session token"))?
                .text()
                .await
                .map_err(|_| unreachable("metadata session token"))?;
            Some(t)
        }
        _ => None,
    };
    let imds_get = |url: String| {
        let mut r = client.get(url).timeout(Duration::from_secs(2));
        if let Some(t) = &imds_token {
            r = r.header("x-aws-ec2-metadata-token", t.clone());
        }
        r
    };

    let region = match env("AWS_REGION").or_else(|| env("AWS_DEFAULT_REGION")) {
        Some(r) => r,
        None => {
            let url = field("region_url").ok_or_else(|| unreachable("region"))?;
            let zone = imds_get(url.to_string())
                .send()
                .await
                .map_err(|_| unreachable("region"))?
                .text()
                .await
                .map_err(|_| unreachable("region"))?;
            // An availability zone (`us-east-2b`) less its letter.
            let zone = zone.trim();
            zone[..zone.len().saturating_sub(1)].to_string()
        }
    };
    if region.is_empty()
        || !region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AuthError::rejected("the AWS region is not a region name"));
    }

    let creds = match (env("AWS_ACCESS_KEY_ID"), env("AWS_SECRET_ACCESS_KEY")) {
        (Some(id), Some(secret)) => AwsCredentials {
            access_key_id: id,
            secret_access_key: secret,
            session_token: env("AWS_SESSION_TOKEN"),
        },
        _ => {
            let base = field("url").ok_or_else(|| unreachable("credentials"))?;
            let role = imds_get(base.to_string())
                .send()
                .await
                .map_err(|_| unreachable("role name"))?
                .text()
                .await
                .map_err(|_| unreachable("role name"))?;
            let role = role.lines().next().unwrap_or("").trim().to_string();
            let v: Value = imds_get(format!("{}/{role}", base.trim_end_matches('/')))
                .send()
                .await
                .map_err(|_| unreachable("credentials"))?
                .json()
                .await
                .map_err(|_| unreachable("credentials"))?;
            let f = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
            AwsCredentials {
                access_key_id: f("AccessKeyId").ok_or_else(|| unreachable("credentials"))?,
                secret_access_key: f("SecretAccessKey")
                    .ok_or_else(|| unreachable("credentials"))?,
                session_token: f("Token"),
            }
        }
    };

    let verification = field("regional_cred_verification_url")
        .unwrap_or("https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15")
        .replace("{region}", &region);
    let audience = doc.get("audience").and_then(|a| a.as_str()).unwrap_or("");
    signed_caller_identity(&verification, &region, audience, &creds, chrono::Utc::now())
}

/// The serialized, signed `GetCallerIdentity` request (AIP-4117): a
/// URL-encoded JSON object of the request's URL, method and headers, where
/// the signature covers `x-goog-cloud-target-resource: <audience>`.
pub(crate) fn signed_caller_identity(
    verification_url: &str,
    region: &str,
    audience: &str,
    creds: &AwsCredentials,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String, AuthError> {
    let url = reqwest::Url::parse(verification_url)
        .map_err(|_| AuthError::rejected("regional_cred_verification_url is not a URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| AuthError::rejected("regional_cred_verification_url has no host"))?
        .to_string();
    let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let query_ref: Vec<(&str, &str)> = query
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    let signed = sigv4::sign(
        &sigv4::Request {
            method: "POST",
            host: &host,
            path,
            query: &query_ref,
            headers: &[("x-goog-cloud-target-resource", audience)],
            payload: b"",
        },
        creds,
        region,
        "sts",
        now,
    );
    let mut headers = vec![
        json!({"key": "host", "value": host}),
        json!({"key": "x-goog-cloud-target-resource", "value": audience}),
    ];
    for (k, v) in signed {
        let key = if k == "authorization" {
            "Authorization"
        } else {
            k
        };
        headers.push(json!({"key": key, "value": v}));
    }
    let request = json!({"url": verification_url, "method": "POST", "headers": headers});
    Ok(sigv4::uri_encode(&request.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn test_opts() -> Options {
        Options {
            validate_hosts: false,
        }
    }

    async fn sts_and_iam(server: &MockServer, subject: &str) {
        Mock::given(method("POST"))
            .and(path("/v1/token"))
            .and(body_string_contains(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
            ))
            .and(body_string_contains(format!("subject_token={subject}")))
            .and(body_string_contains(
                "audience=%2F%2Fiam.googleapis.com%2Fprojects%2F123456%2Flocations%2Fglobal%2FworkloadIdentityPools%2Fpool%2Fproviders%2Fprov",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "federated-token", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "token_type": "Bearer", "expires_in": 3600
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/projects/-/serviceAccounts/sa@proj.iam.gserviceaccount.com:generateAccessToken"))
            .and(header("authorization", "Bearer federated-token"))
            .and(body_json(json!({"scope": [CLOUD_PLATFORM_SCOPE], "lifetime": "3600s"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "accessToken": "ya29.impersonated",
                "expireTime": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
            })))
            .mount(server)
            .await;
    }

    /// The documented file-sourced (OIDC) configuration, as
    /// `gcloud iam workload-identity-pools create-cred-config` writes it, with
    /// the endpoints pointed at the mock.
    fn file_sourced(server: &MockServer, file: &str) -> Value {
        json!({
            "type": "external_account",
            "audience": "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/pool/providers/prov",
            "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
            "token_url": format!("{}/v1/token", server.uri()),
            "service_account_impersonation_url": format!(
                "{}/v1/projects/-/serviceAccounts/sa@proj.iam.gserviceaccount.com:generateAccessToken", server.uri()),
            "credential_source": {"file": file}
        })
    }

    #[tokio::test]
    async fn a_file_sourced_oidc_token_is_exchanged_and_impersonated() {
        let server = MockServer::start().await;
        sts_and_iam(&server, "oidc-id-token-from-file").await;
        let dir = std::env::temp_dir().join(format!("intutic-wif-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "oidc-id-token-from-file\n").unwrap();
        let doc = file_sourced(&server, file.to_str().unwrap());
        let t = token(&reqwest::Client::new(), &doc, &test_opts(), &no_env)
            .await
            .unwrap();
        assert_eq!(t.expose(), "ya29.impersonated");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_url_sourced_json_token_without_impersonation_is_the_federated_token() {
        let server = MockServer::start().await;
        sts_and_iam(&server, "azure-mi-token").await;
        // The documented Azure-hosted shape: a JSON response, a named field.
        Mock::given(method("GET"))
            .and(path("/metadata/identity/oauth2/token"))
            .and(header("Metadata", "True"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"access_token": "azure-mi-token"})),
            )
            .mount(&server)
            .await;
        let doc = json!({
            "type": "external_account",
            "audience": "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/pool/providers/prov",
            "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
            "token_url": format!("{}/v1/token", server.uri()),
            "credential_source": {
                "url": format!("{}/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://app", server.uri()),
                "headers": {"Metadata": "True"},
                "format": {"type": "json", "subject_token_field_name": "access_token"}
            }
        });
        let t = token(&reqwest::Client::new(), &doc, &test_opts(), &no_env)
            .await
            .unwrap();
        assert_eq!(t.expose(), "federated-token");
    }

    #[test]
    fn the_aws_subject_token_is_a_signed_get_caller_identity_request() {
        let creds = AwsCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: ["wJalrXUtnFEMI/K7MDENG+", "bPxRfiCYEXAMPLEKEY"].concat(),
            session_token: Some("session-token".into()),
        };
        let now = chrono::DateTime::parse_from_rfc3339("2020-08-11T06:55:22Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let audience = "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/pool/providers/aws";
        let url = "https://sts.us-east-2.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15";
        let encoded = signed_caller_identity(url, "us-east-2", audience, &creds, now).unwrap();
        let decoded = percent_decode(&encoded);
        let v: Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(v["url"], url);
        assert_eq!(v["method"], "POST");
        let header = |k: &str| {
            v["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|h| h["key"] == k)
                .map(|h| h["value"].as_str().unwrap().to_string())
        };
        assert_eq!(
            header("host").as_deref(),
            Some("sts.us-east-2.amazonaws.com")
        );
        assert_eq!(header("x-amz-date").as_deref(), Some("20200811T065522Z"));
        assert_eq!(
            header("x-amz-security-token").as_deref(),
            Some("session-token")
        );
        assert_eq!(
            header("x-goog-cloud-target-resource").as_deref(),
            Some(audience)
        );
        let auth = header("Authorization").unwrap();
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20200811/us-east-2/sts/aws4_request, \
             SignedHeaders=host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource, Signature="
        ), "{auth}");
        // The signature is SigV4's over that request (sigv4 is held to AWS's
        // published vectors in its own tests).
        let expected = sigv4::sign(
            &sigv4::Request {
                method: "POST",
                host: "sts.us-east-2.amazonaws.com",
                path: "/",
                query: &[("Action", "GetCallerIdentity"), ("Version", "2011-06-15")],
                headers: &[("x-goog-cloud-target-resource", audience)],
                payload: b"",
            },
            &creds,
            "us-east-2",
            "sts",
            now,
        );
        assert_eq!(
            Some(auth),
            expected
                .iter()
                .find(|(k, _)| *k == "authorization")
                .map(|(_, v)| v.clone())
        );
    }

    fn percent_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[tokio::test]
    async fn aws_sourced_credentials_reach_sts_with_the_serialized_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/token"))
            .and(body_string_contains(
                "subject_token_type=urn%3Aietf%3Aparams%3Aaws%3Atoken-type%3Aaws4_request",
            ))
            .and(body_string_contains("GetCallerIdentity"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"access_token": "aws-federated", "expires_in": 3600})),
            )
            .mount(&server)
            .await;
        let doc = json!({
            "type": "external_account",
            "audience": "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/pool/providers/aws",
            "subject_token_type": "urn:ietf:params:aws:token-type:aws4_request",
            "token_url": format!("{}/v1/token", server.uri()),
            "credential_source": {
                "environment_id": "aws1",
                "region_url": "http://169.254.169.254/latest/meta-data/placement/availability-zone",
                "url": "http://169.254.169.254/latest/meta-data/iam/security-credentials",
                "regional_cred_verification_url": "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
            }
        });
        let env = |k: &str| match k {
            "AWS_REGION" => Some("us-east-2".to_string()),
            "AWS_ACCESS_KEY_ID" => Some("AKIDENVWIF".to_string()),
            "AWS_SECRET_ACCESS_KEY" => Some("secret-wif".to_string()),
            _ => None,
        };
        let t = token(&reqwest::Client::new(), &doc, &test_opts(), &env)
            .await
            .unwrap();
        assert_eq!(t.expose(), "aws-federated");
    }

    #[tokio::test]
    async fn non_google_endpoints_and_executables_are_refused() {
        let server = MockServer::start().await;
        let doc = file_sourced(&server, "/dev/null");
        let err = token(&reqwest::Client::new(), &doc, &Options::default(), &no_env)
            .await
            .unwrap_err();
        assert!(err.message.contains("googleapis.com"), "{}", err.message);
        assert!(google_api_url("https://sts.googleapis.com/v1/token"));
        assert!(google_api_url("https://iamcredentials.googleapis.com/v1/x"));
        assert!(!google_api_url(
            "https://sts.googleapis.com.evil.net/v1/token"
        ));
        assert!(!google_api_url("http://sts.googleapis.com/v1/token"));

        let mut exec = file_sourced(&server, "/dev/null");
        exec["credential_source"] = json!({"executable": {"command": "/bin/echo token"}});
        let err = token(&reqwest::Client::new(), &exec, &test_opts(), &no_env)
            .await
            .unwrap_err();
        assert!(err.message.contains("executable"));
    }
}
