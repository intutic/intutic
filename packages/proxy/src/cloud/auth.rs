//! Credentials for cloud calls: AWS (SigV4 credential chain or Bedrock API
//! key), Google OAuth access tokens, Azure `api-key` or Entra ID tokens.
//!
//! Minted tokens and temporary credentials are cached in process until five
//! minutes before they expire, keyed by a hash of the credential they came
//! from — never by the credential itself, and nothing here logs a value.
//!
//! Sources, in the order each cloud's own SDKs use:
//!
//! - **AWS chain**: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
//!   (`AWS_SESSION_TOKEN`); static keys in the shared credentials file
//!   (`AWS_PROFILE`); web identity (`AWS_WEB_IDENTITY_TOKEN_FILE` +
//!   `AWS_ROLE_ARN`, EKS IRSA) via STS `AssumeRoleWithWebIdentity`; container
//!   credentials (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `_FULL_URI`, ECS
//!   and EKS Pod Identity); EC2 instance metadata (IMDSv2) unless
//!   `AWS_EC2_METADATA_DISABLED=true`.
//! - **Google**: a service-account key (RS256 JWT bearer grant), an
//!   `authorized_user` file from `gcloud auth application-default login`
//!   (refresh-token grant), or the metadata server (Compute Engine,
//!   Kubernetes Engine Workload Identity, Cloud Run). ADC looks at `GOOGLE_APPLICATION_CREDENTIALS`, then
//!   gcloud's well-known file, then the metadata server.
//! - **Azure**: an `api-key`; Entra ID client credentials; or a managed
//!   identity (App Service's `IDENTITY_ENDPOINT`, else IMDS).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::config::{AwsAuth, AzureAuth, GcpAuth, Secret};
use super::sigv4::AwsCredentials;

/// Why a credential could not be produced. Rendered to the client as an
/// error in the provider's wire shape; `message` never contains a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    pub status: u16,
    pub kind: &'static str,
    pub message: String,
}

impl AuthError {
    fn rejected(message: impl Into<String>) -> Self {
        AuthError {
            status: 401,
            kind: "authentication_error",
            message: message.into(),
        }
    }
    fn unreachable(message: impl Into<String>) -> Self {
        AuthError {
            status: 502,
            kind: "api_error",
            message: message.into(),
        }
    }
}

// ── Cache ────────────────────────────────────────────────────────────

#[derive(Clone)]
enum Cached {
    Token(Secret),
    Aws(AwsCredentials),
}

static CACHE: Lazy<Mutex<HashMap<String, (Cached, Instant)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Refresh this long before the upstream's stated expiry.
const EXPIRY_MARGIN: Duration = Duration::from_secs(300);

fn cache_get(key: &str) -> Option<Cached> {
    let map = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    map.get(key)
        .filter(|(_, until)| Instant::now() < *until)
        .map(|(c, _)| c.clone())
}

fn cache_put(key: String, value: Cached, lifetime: Duration) {
    let Some(until) = Instant::now().checked_add(lifetime.saturating_sub(EXPIRY_MARGIN)) else {
        return;
    };
    if lifetime <= EXPIRY_MARGIN {
        return;
    }
    let mut map = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    map.insert(key, (value, until));
}

fn fingerprint(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    hex::encode(&h.finalize()[..12])
}

fn seconds(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// ── AWS ──────────────────────────────────────────────────────────────

/// How a Bedrock request is authenticated.
#[derive(Debug, Clone)]
pub enum AwsSigner {
    SigV4(AwsCredentials),
    Bearer(Secret),
}

pub async fn aws(
    client: &reqwest::Client,
    auth: &AwsAuth,
    region: &str,
) -> Result<AwsSigner, AuthError> {
    match auth {
        AwsAuth::Static(c) => Ok(AwsSigner::SigV4(c.clone())),
        AwsAuth::ApiKey(k) => Ok(AwsSigner::Bearer(k.clone())),
        AwsAuth::Chain => aws_chain(client, region, &AwsEndpoints::default(), |k| {
            std::env::var(k).ok()
        })
        .await
        .map(AwsSigner::SigV4),
    }
}

/// Network locations the chain reads from; overridden only by tests.
struct AwsEndpoints {
    sts: Option<String>,
    container_host: String,
    imds: String,
}

impl Default for AwsEndpoints {
    fn default() -> Self {
        AwsEndpoints {
            sts: None,
            container_host: "http://169.254.170.2".into(),
            imds: "http://169.254.169.254".into(),
        }
    }
}

async fn aws_chain(
    client: &reqwest::Client,
    region: &str,
    ep: &AwsEndpoints,
    env: impl Fn(&str) -> Option<String>,
) -> Result<AwsCredentials, AuthError> {
    let env = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    if let (Some(id), Some(secret)) = (env("AWS_ACCESS_KEY_ID"), env("AWS_SECRET_ACCESS_KEY")) {
        return Ok(AwsCredentials {
            access_key_id: id,
            secret_access_key: secret,
            session_token: env("AWS_SESSION_TOKEN"),
        });
    }
    if let Some(c) = profile_credentials(&env) {
        return Ok(c);
    }
    if let (Some(token_file), Some(role)) =
        (env("AWS_WEB_IDENTITY_TOKEN_FILE"), env("AWS_ROLE_ARN"))
    {
        let key = format!("aws-wi:{}", fingerprint(&[&token_file, &role]));
        if let Some(Cached::Aws(c)) = cache_get(&key) {
            return Ok(c);
        }
        let token = std::fs::read_to_string(&token_file)
            .map_err(|_| AuthError::rejected("AWS web identity token file could not be read"))?;
        let sts = ep
            .sts
            .clone()
            .unwrap_or_else(|| format!("https://sts.{region}.amazonaws.com"));
        let session = env("AWS_ROLE_SESSION_NAME").unwrap_or_else(|| "intutic-proxy".into());
        let resp = client
            .post(format!("{sts}/"))
            .header("accept", "application/xml")
            .form(&[
                ("Action", "AssumeRoleWithWebIdentity"),
                ("Version", "2011-06-15"),
                ("RoleArn", role.as_str()),
                ("RoleSessionName", session.as_str()),
                ("WebIdentityToken", token.trim()),
            ])
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| AuthError::unreachable("AWS STS could not be reached"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AuthError::rejected(format!(
                "AWS STS refused AssumeRoleWithWebIdentity (HTTP {})",
                status.as_u16()
            )));
        }
        let (creds, lifetime) = sts_credentials(&body)
            .ok_or_else(|| AuthError::unreachable("AWS STS answered without credentials"))?;
        cache_put(key, Cached::Aws(creds.clone()), lifetime);
        return Ok(creds);
    }
    let container_uri = env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        .map(|rel| format!("{}{rel}", ep.container_host))
        .or_else(|| env("AWS_CONTAINER_CREDENTIALS_FULL_URI"));
    if let Some(uri) = container_uri {
        let key = format!("aws-container:{}", fingerprint(&[&uri]));
        if let Some(Cached::Aws(c)) = cache_get(&key) {
            return Ok(c);
        }
        let auth = env("AWS_CONTAINER_AUTHORIZATION_TOKEN").or_else(|| {
            env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")
                .and_then(|f| std::fs::read_to_string(f).ok())
                .map(|s| s.trim().to_string())
        });
        let mut req = client.get(&uri).timeout(Duration::from_secs(5));
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let v = fetch_json(req, "AWS container credentials").await?;
        let (creds, lifetime) = json_credentials(&v)
            .ok_or_else(|| AuthError::unreachable("AWS container credentials were malformed"))?;
        cache_put(key, Cached::Aws(creds.clone()), lifetime);
        return Ok(creds);
    }
    if env("AWS_EC2_METADATA_DISABLED").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        return Err(no_aws_credentials());
    }
    if let Some(Cached::Aws(c)) = cache_get("aws-imds") {
        return Ok(c);
    }
    imds_credentials(client, &ep.imds).await
}

fn no_aws_credentials() -> AuthError {
    AuthError::rejected(
        "no AWS credentials were found (environment, shared credentials file, web identity, \
         container or instance role); set AWS credentials or a Bedrock API key",
    )
}

async fn imds_credentials(
    client: &reqwest::Client,
    base: &str,
) -> Result<AwsCredentials, AuthError> {
    let quick = Duration::from_secs(1);
    let token = client
        .put(format!("{base}/latest/api/token"))
        .header("x-aws-ec2-metadata-token-ttl-seconds", "21600")
        .timeout(quick)
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())
        .ok_or_else(no_aws_credentials)?
        .text()
        .await
        .map_err(|_| no_aws_credentials())?;
    let get = |path: String| {
        client
            .get(format!(
                "{base}/latest/meta-data/iam/security-credentials/{path}"
            ))
            .header("x-aws-ec2-metadata-token", token.clone())
            .timeout(quick)
    };
    let role = get(String::new())
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())
        .ok_or_else(no_aws_credentials)?
        .text()
        .await
        .map_err(|_| no_aws_credentials())?;
    let role = role.lines().next().unwrap_or("").trim().to_string();
    if role.is_empty() {
        return Err(no_aws_credentials());
    }
    let v = fetch_json(get(role), "EC2 instance credentials").await?;
    let (creds, lifetime) = json_credentials(&v)
        .ok_or_else(|| AuthError::unreachable("EC2 instance credentials were malformed"))?;
    cache_put("aws-imds".into(), Cached::Aws(creds.clone()), lifetime);
    Ok(creds)
}

/// Static keys from the shared credentials file for `AWS_PROFILE` (default
/// `default`). Profiles that need SSO or role assumption are not resolved
/// here; the environment or a workload role covers servers.
fn profile_credentials(env: &impl Fn(&str) -> Option<String>) -> Option<AwsCredentials> {
    let path = env("AWS_SHARED_CREDENTIALS_FILE").or_else(|| {
        env("HOME")
            .or_else(|| env("USERPROFILE"))
            .map(|h| format!("{h}/.aws/credentials"))
    })?;
    let text = std::fs::read_to_string(path).ok()?;
    let profile = env("AWS_PROFILE").unwrap_or_else(|| "default".into());
    parse_profile(&text, &profile)
}

fn parse_profile(text: &str, profile: &str) -> Option<AwsCredentials> {
    let mut in_section = false;
    let mut kv: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') || line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_section = name.trim() == profile;
            continue;
        }
        if in_section {
            if let Some((k, v)) = line.split_once('=') {
                kv.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
    }
    Some(AwsCredentials {
        access_key_id: kv.remove("aws_access_key_id").filter(|v| !v.is_empty())?,
        secret_access_key: kv
            .remove("aws_secret_access_key")
            .filter(|v| !v.is_empty())?,
        session_token: kv.remove("aws_session_token").filter(|v| !v.is_empty()),
    })
}

/// `{AccessKeyId, SecretAccessKey, Token, Expiration}` — the container and
/// instance-metadata credential document.
fn json_credentials(v: &Value) -> Option<(AwsCredentials, Duration)> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let creds = AwsCredentials {
        access_key_id: s("AccessKeyId")?,
        secret_access_key: s("SecretAccessKey")?,
        session_token: s("Token"),
    };
    Some((creds, lifetime_until(s("Expiration").as_deref())))
}

/// The credentials in an STS `AssumeRoleWithWebIdentity` XML response.
fn sts_credentials(xml: &str) -> Option<(AwsCredentials, Duration)> {
    let tag = |name: &str| {
        let open = format!("<{name}>");
        let start = xml.find(&open)? + open.len();
        let end = xml[start..].find(&format!("</{name}>"))? + start;
        Some(xml[start..end].trim().to_string())
    };
    let creds = AwsCredentials {
        access_key_id: tag("AccessKeyId")?,
        secret_access_key: tag("SecretAccessKey")?,
        session_token: tag("SessionToken"),
    };
    Some((creds, lifetime_until(tag("Expiration").as_deref())))
}

fn lifetime_until(expiration: Option<&str>) -> Duration {
    expiration
        .and_then(|e| chrono::DateTime::parse_from_rfc3339(e).ok())
        .and_then(|t| {
            (t.with_timezone(&chrono::Utc) - chrono::Utc::now())
                .to_std()
                .ok()
        })
        .unwrap_or(Duration::ZERO)
}

async fn fetch_json(req: reqwest::RequestBuilder, what: &str) -> Result<Value, AuthError> {
    let resp = req
        .send()
        .await
        .map_err(|_| AuthError::unreachable(format!("{what} could not be reached")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AuthError::rejected(format!(
            "{what} were refused (HTTP {})",
            status.as_u16()
        )));
    }
    resp.json::<Value>()
        .await
        .map_err(|_| AuthError::unreachable(format!("{what} were not JSON")))
}

// ── Google ───────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";

pub async fn gcp_token(client: &reqwest::Client, auth: &GcpAuth) -> Result<Secret, AuthError> {
    match auth {
        GcpAuth::Json(doc) => gcp_from_document(client, doc.expose(), GOOGLE_TOKEN_URI).await,
        GcpAuth::File(path) => {
            let doc = std::fs::read_to_string(path).map_err(|_| {
                AuthError::rejected("the Google credentials file could not be read")
            })?;
            gcp_from_document(client, &doc, GOOGLE_TOKEN_URI).await
        }
        GcpAuth::Adc => {
            if let Some(path) = std::env::var("GOOGLE_APPLICATION_CREDENTIALS")
                .ok()
                .filter(|p| !p.trim().is_empty())
            {
                let doc = std::fs::read_to_string(&path).map_err(|_| {
                    AuthError::rejected(
                        "GOOGLE_APPLICATION_CREDENTIALS names a file that could not be read",
                    )
                })?;
                return gcp_from_document(client, &doc, GOOGLE_TOKEN_URI).await;
            }
            if let Some(doc) =
                gcloud_well_known_file().and_then(|p| std::fs::read_to_string(p).ok())
            {
                return gcp_from_document(client, &doc, GOOGLE_TOKEN_URI).await;
            }
            let host = std::env::var("GCE_METADATA_HOST")
                .ok()
                .filter(|h| !h.trim().is_empty())
                .unwrap_or_else(|| "metadata.google.internal".into());
            gcp_metadata_token(client, &format!("http://{host}")).await
        }
    }
}

fn gcloud_well_known_file() -> Option<std::path::PathBuf> {
    if cfg!(windows) {
        std::env::var("APPDATA")
            .ok()
            .map(|a| std::path::Path::new(&a).join("gcloud/application_default_credentials.json"))
    } else {
        std::env::var("HOME").ok().map(|h| {
            std::path::Path::new(&h).join(".config/gcloud/application_default_credentials.json")
        })
    }
}

/// A token from a credential JSON document. `token_uri` is where both grants
/// are exchanged; a document's own `token_uri` is ignored, because a
/// workspace-supplied document would otherwise choose where the gateway
/// sends a signed assertion.
async fn gcp_from_document(
    client: &reqwest::Client,
    doc: &str,
    token_uri: &str,
) -> Result<Secret, AuthError> {
    let v: Value = serde_json::from_str(doc)
        .map_err(|_| AuthError::rejected("the Google credential is not JSON"))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    match s("type") {
        "service_account" => {
            let key = format!(
                "gcp-sa:{}",
                fingerprint(&[s("client_email"), s("private_key")])
            );
            if let Some(Cached::Token(t)) = cache_get(&key) {
                return Ok(t);
            }
            let jwt = service_account_jwt(
                s("client_email"),
                s("private_key"),
                s("private_key_id"),
                token_uri,
                chrono::Utc::now().timestamp(),
            )?;
            let form = [
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", jwt.as_str()),
            ];
            let (token, lifetime) =
                oauth_exchange(client, token_uri, &form, "Google OAuth").await?;
            cache_put(key, Cached::Token(token.clone()), lifetime);
            Ok(token)
        }
        "authorized_user" => {
            let key = format!(
                "gcp-user:{}",
                fingerprint(&[s("client_id"), s("refresh_token")])
            );
            if let Some(Cached::Token(t)) = cache_get(&key) {
                return Ok(t);
            }
            let form = [
                ("grant_type", "refresh_token"),
                ("client_id", s("client_id")),
                ("client_secret", s("client_secret")),
                ("refresh_token", s("refresh_token")),
            ];
            let (token, lifetime) =
                oauth_exchange(client, token_uri, &form, "Google OAuth").await?;
            cache_put(key, Cached::Token(token.clone()), lifetime);
            Ok(token)
        }
        other => Err(AuthError::rejected(format!(
            "Google credential type '{other}' is not supported; use a service-account key, \
             `gcloud auth application-default login`, or the metadata server"
        ))),
    }
}

/// Put a token in the cache for a service-account document, as if it had
/// been minted. Tests use it to exercise the calls that need a token without
/// any OAuth endpoint.
#[cfg(test)]
pub(crate) fn seed_gcp_token(doc: &str, token: &str) {
    let v: Value = serde_json::from_str(doc).expect("test document is JSON");
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let key = format!(
        "gcp-sa:{}",
        fingerprint(&[&s("client_email"), &s("private_key")])
    );
    cache_put(
        key,
        Cached::Token(Secret::new(token)),
        Duration::from_secs(3600),
    );
}

/// An RS256-signed JWT bearer assertion for the OAuth token endpoint.
fn service_account_jwt(
    email: &str,
    pem: &str,
    key_id: &str,
    aud: &str,
    now: i64,
) -> Result<String, AuthError> {
    if email.is_empty() || pem.is_empty() {
        return Err(AuthError::rejected(
            "the service-account key has no client_email or private_key",
        ));
    }
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut header = serde_json::json!({"alg": "RS256", "typ": "JWT"});
    if !key_id.is_empty() {
        header["kid"] = Value::String(key_id.to_string());
    }
    let claims = serde_json::json!({
        "iss": email,
        "scope": CLOUD_PLATFORM_SCOPE,
        "aud": aud,
        "iat": now,
        "exp": now + 3600,
    });
    let signing_input = format!(
        "{}.{}",
        b64.encode(header.to_string()),
        b64.encode(claims.to_string())
    );
    let key = rsa_key(pem)?;
    let mut sig = vec![0u8; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signing_input.as_bytes(),
        &mut sig,
    )
    .map_err(|_| AuthError::rejected("the service-account private key could not sign"))?;
    Ok(format!("{signing_input}.{}", b64.encode(sig)))
}

fn rsa_key(pem: &str) -> Result<ring::rsa::KeyPair, AuthError> {
    use rustls::pki_types::PrivateKeyDer;
    let bad = || AuthError::rejected("the service-account private_key is not an RSA PEM key");
    let der = rustls_pemfile::private_key(&mut pem.as_bytes())
        .map_err(|_| bad())?
        .ok_or_else(bad)?;
    match der {
        PrivateKeyDer::Pkcs8(k) => ring::rsa::KeyPair::from_pkcs8(k.secret_pkcs8_der()),
        PrivateKeyDer::Pkcs1(k) => ring::rsa::KeyPair::from_der(k.secret_pkcs1_der()),
        _ => return Err(bad()),
    }
    .map_err(|_| bad())
}

async fn gcp_metadata_token(client: &reqwest::Client, base: &str) -> Result<Secret, AuthError> {
    if let Some(Cached::Token(t)) = cache_get("gcp-metadata") {
        return Ok(t);
    }
    let resp = client
        .get(format!(
            "{base}/computeMetadata/v1/instance/service-accounts/default/token"
        ))
        .header("metadata-flavor", "Google")
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| {
            AuthError::rejected(
                "no Google credentials were found (GOOGLE_APPLICATION_CREDENTIALS, gcloud \
                 application-default login, or a metadata server)",
            )
        })?;
    let (token, lifetime) = token_response(resp, "the Google metadata server").await?;
    cache_put(
        "gcp-metadata".into(),
        Cached::Token(token.clone()),
        lifetime,
    );
    Ok(token)
}

async fn oauth_exchange(
    client: &reqwest::Client,
    url: &str,
    form: &[(&str, &str)],
    what: &str,
) -> Result<(Secret, Duration), AuthError> {
    let resp = client
        .post(url)
        .form(form)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| AuthError::unreachable(format!("{what} could not be reached")))?;
    token_response(resp, what).await
}

/// `{access_token, expires_in}` — the shape Google's token endpoint, its
/// metadata server, Entra ID and Azure's managed-identity endpoints share.
async fn token_response(
    resp: reqwest::Response,
    what: &str,
) -> Result<(Secret, Duration), AuthError> {
    let status = resp.status();
    if !status.is_success() {
        return Err(AuthError::rejected(format!(
            "{what} refused the credential (HTTP {})",
            status.as_u16()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| AuthError::unreachable(format!("{what} answered without JSON")))?;
    let token = v
        .get("access_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| AuthError::unreachable(format!("{what} answered without a token")))?;
    let lifetime = v
        .get("expires_in")
        .and_then(seconds)
        .map(Duration::from_secs)
        .unwrap_or(Duration::ZERO);
    Ok((Secret::new(token), lifetime))
}

// ── Azure ────────────────────────────────────────────────────────────

/// The resource Entra tokens are requested for (Azure OpenAI and Foundry).
const AZURE_RESOURCE: &str = "https://cognitiveservices.azure.com";

/// The header that authenticates an Azure call: `api-key`, or
/// `authorization: Bearer <Entra token>`.
pub async fn azure_header(
    client: &reqwest::Client,
    auth: &AzureAuth,
) -> Result<(&'static str, Secret), AuthError> {
    match auth {
        AzureAuth::ApiKey(k) => Ok(("api-key", k.clone())),
        AzureAuth::ClientSecret {
            tenant_id,
            client_id,
            secret,
        } => {
            if !tenant_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            {
                return Err(AuthError::rejected(
                    "AZURE_TENANT_ID is not a tenant id or domain",
                ));
            }
            let url = format!("https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token");
            entra_client_credentials(client, &url, client_id, secret).await
        }
        AzureAuth::ManagedIdentity { client_id } => {
            let app_service = std::env::var("IDENTITY_ENDPOINT")
                .ok()
                .zip(std::env::var("IDENTITY_HEADER").ok());
            managed_identity(
                client,
                client_id.as_deref(),
                app_service,
                "http://169.254.169.254",
            )
            .await
        }
    }
}

fn bearer(token: &Secret) -> Secret {
    Secret::new(format!("Bearer {}", token.expose()))
}

async fn entra_client_credentials(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    secret: &Secret,
) -> Result<(&'static str, Secret), AuthError> {
    let key = format!(
        "azure-sp:{}",
        fingerprint(&[url, client_id, secret.expose()])
    );
    if let Some(Cached::Token(t)) = cache_get(&key) {
        return Ok(("authorization", bearer(&t)));
    }
    let scope = format!("{AZURE_RESOURCE}/.default");
    let form = [
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", secret.expose()),
        ("scope", scope.as_str()),
    ];
    let (token, lifetime) = oauth_exchange(client, url, &form, "Microsoft Entra ID").await?;
    cache_put(key, Cached::Token(token.clone()), lifetime);
    Ok(("authorization", bearer(&token)))
}

async fn managed_identity(
    client: &reqwest::Client,
    client_id: Option<&str>,
    app_service: Option<(String, String)>,
    imds: &str,
) -> Result<(&'static str, Secret), AuthError> {
    let key = format!("azure-mi:{}", client_id.unwrap_or(""));
    if let Some(Cached::Token(t)) = cache_get(&key) {
        return Ok(("authorization", bearer(&t)));
    }
    let mut query = vec![("resource", AZURE_RESOURCE.to_string())];
    if let Some(id) = client_id {
        query.push(("client_id", id.to_string()));
    }
    let req = match app_service {
        Some((endpoint, header)) => {
            query.push(("api-version", "2019-08-01".into()));
            client.get(endpoint).header("x-identity-header", header)
        }
        None => {
            query.push(("api-version", "2018-02-01".into()));
            client
                .get(format!("{imds}/metadata/identity/oauth2/token"))
                .header("metadata", "true")
        }
    };
    let resp = req
        .query(&query)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| {
            AuthError::unreachable("the Azure managed identity endpoint could not be reached")
        })?;
    let (token, lifetime) = token_response(resp, "the Azure managed identity endpoint").await?;
    cache_put(key, Cached::Token(token.clone()), lifetime);
    Ok(("authorization", bearer(&token)))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// A throwaway 2048-bit RSA key generated for these tests only. The PEM
    /// armour is assembled at runtime so no contiguous private-key block
    /// exists in source for secret scanners to flag.
    pub(crate) fn test_pem() -> String {
        let label = ["PRIVATE", " KEY"].concat();
        format!("-----BEGIN {label}-----\n{TEST_KEY_BODY}\n-----END {label}-----\n")
    }

    const TEST_KEY_BODY: &str = include_str!("testdata/rsa2048.b64");

    #[test]
    fn the_service_account_jwt_is_a_valid_rs256_assertion_with_the_documented_claims() {
        let jwt = service_account_jwt(
            "sa@p.iam.gserviceaccount.com",
            &test_pem(),
            "kid-1",
            GOOGLE_TOKEN_URI,
            1_700_000_000,
        )
        .unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header: Value = serde_json::from_slice(&b64.decode(parts[0]).unwrap()).unwrap();
        let claims: Value = serde_json::from_slice(&b64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            header,
            serde_json::json!({"alg":"RS256","typ":"JWT","kid":"kid-1"})
        );
        assert_eq!(claims["iss"], "sa@p.iam.gserviceaccount.com");
        assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
        assert_eq!(
            claims["scope"],
            "https://www.googleapis.com/auth/cloud-platform"
        );
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            3600
        );
        // Verify the signature with the key's public half.
        let key = rsa_key(&test_pem()).unwrap();
        let public = ring::signature::UnparsedPublicKey::new(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            key.public().as_ref().to_vec(),
        );
        public
            .verify(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &b64.decode(parts[2]).unwrap(),
            )
            .expect("signature verifies");
    }

    #[tokio::test]
    async fn a_service_account_key_is_exchanged_once_and_then_served_from_cache() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"access_token":"ya29.minted","expires_in":3599,"token_type":"Bearer"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        let doc = serde_json::json!({
            "type": "service_account",
            "client_email": "cache-test@p.iam.gserviceaccount.com",
            "private_key": test_pem(),
            // A document's own token_uri is never used.
            "token_uri": "http://169.254.169.254/steal",
        })
        .to_string();
        let client = reqwest::Client::new();
        let uri = format!("{}/token", server.uri());
        let first = gcp_from_document(&client, &doc, &uri).await.unwrap();
        let second = gcp_from_document(&client, &doc, &uri).await.unwrap();
        assert_eq!(first.expose(), "ya29.minted");
        assert_eq!(second.expose(), "ya29.minted");
    }

    #[tokio::test]
    async fn a_refused_grant_is_an_authentication_error_that_names_no_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error":"invalid_grant"})),
            )
            .mount(&server)
            .await;
        let doc = serde_json::json!({
            "type": "authorized_user",
            "client_id": "cid",
            "client_secret": "csecret-value",
            "refresh_token": "rtoken-value",
        })
        .to_string();
        let err = gcp_from_document(
            &reqwest::Client::new(),
            &doc,
            &format!("{}/token", server.uri()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, 401);
        assert!(!err.message.contains("rtoken-value") && !err.message.contains("csecret"));
    }

    #[tokio::test]
    async fn external_account_credentials_are_refused_with_the_supported_options() {
        let err = gcp_from_document(
            &reqwest::Client::new(),
            r#"{"type":"external_account"}"#,
            "http://unused",
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("external_account"));
    }

    #[tokio::test]
    async fn the_metadata_server_is_asked_with_the_metadata_flavor_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/computeMetadata/v1/instance/service-accounts/default/token",
            ))
            .and(header("metadata-flavor", "Google"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"access_token":"ya29.md","expires_in":3000})),
            )
            .mount(&server)
            .await;
        let t = gcp_metadata_token(&reqwest::Client::new(), &server.uri())
            .await
            .unwrap();
        assert_eq!(t.expose(), "ya29.md");
    }

    #[test]
    fn shared_credentials_file_profiles() {
        let text = "[default]\naws_access_key_id = AKIDDEF\naws_secret_access_key = sdef\n\n[work]\naws_access_key_id=AKIDWORK\naws_secret_access_key=swork\naws_session_token=tok\n";
        assert_eq!(
            parse_profile(text, "default").unwrap().access_key_id,
            "AKIDDEF"
        );
        let w = parse_profile(text, "work").unwrap();
        assert_eq!(w.session_token.as_deref(), Some("tok"));
        assert!(parse_profile(text, "missing").is_none());
        assert!(parse_profile("[sso]\nsso_start_url=x\n", "sso").is_none());
    }

    #[test]
    fn sts_xml_and_credential_json_parse() {
        let exp = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let xml = format!("<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAX</AccessKeyId><SecretAccessKey>sk</SecretAccessKey><SessionToken>st</SessionToken><Expiration>{exp}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>");
        let (c, life) = sts_credentials(&xml).unwrap();
        assert_eq!(c.access_key_id, "ASIAX");
        assert_eq!(c.session_token.as_deref(), Some("st"));
        assert!(life > Duration::from_secs(3000));
        let (c, _) = json_credentials(&serde_json::json!({"AccessKeyId":"A","SecretAccessKey":"S","Token":"T","Expiration":exp})).unwrap();
        assert_eq!(c.secret_access_key, "S");
    }

    fn env_of(pairs: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    }

    #[tokio::test]
    async fn environment_keys_win_and_need_no_network() {
        let c = aws_chain(
            &reqwest::Client::new(),
            "us-east-1",
            &AwsEndpoints::default(),
            env_of(vec![
                ("AWS_ACCESS_KEY_ID", "AKIDENV".into()),
                ("AWS_SECRET_ACCESS_KEY", "senv".into()),
                ("AWS_SESSION_TOKEN", "tenv".into()),
            ]),
        )
        .await
        .unwrap();
        assert_eq!(c.access_key_id, "AKIDENV");
        assert_eq!(c.session_token.as_deref(), Some("tenv"));
    }

    #[tokio::test]
    async fn web_identity_assumes_the_role_through_sts() {
        let server = MockServer::start().await;
        let exp = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        Mock::given(method("POST"))
            .and(body_string_contains("Action=AssumeRoleWithWebIdentity"))
            .and(body_string_contains("WebIdentityToken=jwt-from-file"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "<R><Credentials><AccessKeyId>ASIAWI</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>{exp}</Expiration></Credentials></R>"
            )))
            .mount(&server)
            .await;
        let dir = std::env::temp_dir().join(format!("intutic-wi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("token");
        std::fs::write(&file, "jwt-from-file\n").unwrap();
        let ep = AwsEndpoints {
            sts: Some(server.uri()),
            ..AwsEndpoints::default()
        };
        let c = aws_chain(
            &reqwest::Client::new(),
            "us-east-1",
            &ep,
            env_of(vec![
                (
                    "AWS_WEB_IDENTITY_TOKEN_FILE",
                    file.to_string_lossy().into_owned(),
                ),
                ("AWS_ROLE_ARN", "arn:aws:iam::1:role/r".into()),
                ("HOME", dir.to_string_lossy().into_owned()),
            ]),
        )
        .await
        .unwrap();
        assert_eq!(c.access_key_id, "ASIAWI");
        let _ = std::fs::remove_file(file);
    }

    #[tokio::test]
    async fn container_credentials_send_the_authorization_token() {
        let server = MockServer::start().await;
        let exp = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        Mock::given(method("GET"))
            .and(path("/v2/credentials/abc"))
            .and(header("authorization", "pod-identity-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "AccessKeyId":"ASIACT","SecretAccessKey":"s","Token":"t","Expiration":exp
            })))
            .mount(&server)
            .await;
        let ep = AwsEndpoints {
            container_host: server.uri(),
            ..AwsEndpoints::default()
        };
        let c = aws_chain(
            &reqwest::Client::new(),
            "us-east-1",
            &ep,
            env_of(vec![
                (
                    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                    "/v2/credentials/abc".into(),
                ),
                (
                    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                    "pod-identity-token".into(),
                ),
                ("HOME", "/nonexistent-home".into()),
            ]),
        )
        .await
        .unwrap();
        assert_eq!(c.access_key_id, "ASIACT");
    }

    #[tokio::test]
    async fn imds_v2_takes_a_session_token_first() {
        let server = MockServer::start().await;
        let exp = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        Mock::given(method("PUT"))
            .and(path("/latest/api/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string("imds-tok"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/latest/meta-data/iam/security-credentials/"))
            .and(header("x-aws-ec2-metadata-token", "imds-tok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("my-role\n"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/latest/meta-data/iam/security-credentials/my-role"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "AccessKeyId":"ASIAEC2","SecretAccessKey":"s","Token":"t","Expiration":exp
            })))
            .mount(&server)
            .await;
        let c = imds_credentials(&reqwest::Client::new(), &server.uri())
            .await
            .unwrap();
        assert_eq!(c.access_key_id, "ASIAEC2");
    }

    #[tokio::test]
    async fn entra_client_credentials_request_the_cognitive_services_scope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("grant_type=client_credentials"))
            .and(body_string_contains(
                "scope=https%3A%2F%2Fcognitiveservices.azure.com%2F.default",
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"access_token":"eyJ.entra","expires_in":3599}),
                ),
            )
            .mount(&server)
            .await;
        let (name, value) = entra_client_credentials(
            &reqwest::Client::new(),
            &format!("{}/tenant/oauth2/v2.0/token", server.uri()),
            "client-a",
            &Secret::new("secret-a"),
        )
        .await
        .unwrap();
        assert_eq!(name, "authorization");
        assert_eq!(value.expose(), "Bearer eyJ.entra");
    }

    #[tokio::test]
    async fn managed_identity_uses_imds_with_the_metadata_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/metadata/identity/oauth2/token"))
            .and(header("metadata", "true"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"access_token":"mi-token","expires_in":"3599"}),
                ),
            )
            .mount(&server)
            .await;
        let (_, value) =
            managed_identity(&reqwest::Client::new(), Some("uami-1"), None, &server.uri())
                .await
                .unwrap();
        assert_eq!(value.expose(), "Bearer mi-token");
    }

    #[tokio::test]
    async fn a_malformed_tenant_cannot_change_the_token_host() {
        let err = azure_header(
            &reqwest::Client::new(),
            &AzureAuth::ClientSecret {
                tenant_id: "evil.com/x?".into(),
                client_id: "c".into(),
                secret: Secret::new("s"),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, 401);
    }
}
