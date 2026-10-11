//! Where a cloud call's region, endpoint and credentials come from.
//!
//! Two sources, never mixed within one request:
//!
//! - **The workspace** (a `vk_` request): the provider credential the
//!   workspace provisioned through the control plane (dashboard, CLI,
//!   Terraform), stored as the `{registry id}_config` blob every non-flat
//!   provider credential uses. Read with `LocalStore::workspace_credential`,
//!   the same call every other provider credential goes through, so a change
//!   to how that storage is protected applies here unchanged.
//! - **The operator**: `intutic_settings.providers` in `config.yaml`, then the
//!   provider's conventional environment variables, then (Bedrock, Vertex)
//!   the cloud's own ambient credential chain.
//!
//! Under enforced BYO-key (`gateway::provisioned_key_required_for`) a `vk_`
//! request gets the workspace source or nothing.
//!
//! Secrets never live in `config.yaml` as values: a secret field takes an
//! environment reference (`os.environ/NAME`, LiteLLM's syntax), and a
//! literal is refused when the file loads. Every type holding a secret prints
//! as `<redacted>`.

use std::sync::Arc;

use serde::{Deserialize, Deserializer};

use super::sigv4::AwsCredentials;
use super::CloudProvider;
use crate::store::LocalStore;

/// A secret value. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Secret(s.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// A `config.yaml` secret: the name of the environment variable holding it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretRef(String);

const ENV_REF_PREFIX: &str = "os.environ/";

impl SecretRef {
    pub fn resolve(&self) -> Option<Secret> {
        std::env::var(&self.0)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(|v| Secret(v.trim().to_string()))
    }
}

impl std::fmt::Debug for SecretRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{ENV_REF_PREFIX}{}", self.0)
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.trim().strip_prefix(ENV_REF_PREFIX) {
            Some(name) if !name.is_empty() => Ok(SecretRef(name.to_string())),
            // The message must not echo the value: it is probably the secret.
            _ => Err(serde::de::Error::custom(
                "secret fields take an environment reference such as os.environ/AZURE_OPENAI_API_KEY; \
                 a literal secret in config.yaml is refused",
            )),
        }
    }
}

/// `intutic_settings.providers` in `config.yaml`.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct ProvidersConfig {
    #[serde(default)]
    pub bedrock: BedrockSettings,
    #[serde(default)]
    pub vertex: VertexSettings,
    #[serde(default)]
    pub azure: AzureSettings,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct BedrockSettings {
    /// Default `AWS_REGION`, then `AWS_DEFAULT_REGION`.
    pub region: Option<String>,
    /// A Bedrock API key. Default `AWS_BEARER_TOKEN_BEDROCK`; without one,
    /// requests are SigV4-signed with the AWS credential chain.
    pub api_key: Option<SecretRef>,
    /// `bedrock-runtime` base URL, for a VPC interface endpoint. Default
    /// `https://bedrock-runtime.<region>.amazonaws.com`.
    pub runtime_endpoint: Option<String>,
    /// `bedrock-mantle` base URL. Default `https://bedrock-mantle.<region>.api.aws`.
    pub mantle_endpoint: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct VertexSettings {
    /// Default `GOOGLE_CLOUD_PROJECT`, then `ANTHROPIC_VERTEX_PROJECT_ID`.
    pub project: Option<String>,
    /// Default `GOOGLE_CLOUD_LOCATION`, then `CLOUD_ML_REGION`, then `global`.
    pub location: Option<String>,
    /// A service-account or `authorized_user` JSON file. Default: Application
    /// Default Credentials.
    pub credentials_file: Option<String>,
    /// API base URL, for a Private Service Connect endpoint. Default
    /// `https://aiplatform.googleapis.com` for `global`, else
    /// `https://<location>-aiplatform.googleapis.com`.
    pub endpoint: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct AzureSettings {
    /// `https://<resource>.openai.azure.com` or
    /// `https://<resource>.services.ai.azure.com`. Default `AZURE_OPENAI_ENDPOINT`.
    pub endpoint: Option<String>,
    /// Default `AZURE_OPENAI_API_KEY`.
    pub api_key: Option<SecretRef>,
    /// Entra ID client credentials. Defaults `AZURE_TENANT_ID`,
    /// `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
    pub tenant_id: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<SecretRef>,
    /// Use the host's managed identity (Azure VM, AKS, App Service with IMDS).
    #[serde(default)]
    pub managed_identity: bool,
}

/// Everything one cloud call needs, resolved.
#[derive(Debug, Clone)]
pub enum CloudConfig {
    Bedrock(BedrockConfig),
    Vertex(VertexConfig),
    Azure(AzureConfig),
    GoogleAi(GoogleAiConfig),
}

/// First-party Gemini API: the workspace's or operator's Gemini key, resolved
/// by the proxy exactly as it is for a request on the `/v1beta` route.
#[derive(Debug, Clone)]
pub struct GoogleAiConfig {
    /// `https://generativelanguage.googleapis.com`, or `GEMINI_UPSTREAM_URL`.
    pub base_url: String,
    pub api_key: Secret,
}

#[derive(Debug, Clone)]
pub struct BedrockConfig {
    pub region: String,
    pub auth: AwsAuth,
    pub runtime_endpoint: Option<String>,
    pub mantle_endpoint: Option<String>,
}

#[derive(Debug, Clone)]
pub enum AwsAuth {
    Static(AwsCredentials),
    ApiKey(Secret),
    /// Environment, shared credentials file, web identity, container and
    /// instance credentials, in the AWS SDKs' order (`auth::aws_chain`).
    Chain,
}

#[derive(Debug, Clone)]
pub struct VertexConfig {
    pub project: String,
    pub location: String,
    pub auth: GcpAuth,
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone)]
pub enum GcpAuth {
    /// A credential JSON document (service account or `authorized_user`).
    Json(Secret),
    /// A path to one.
    File(String),
    /// Application Default Credentials.
    Adc,
}

#[derive(Debug, Clone)]
pub struct AzureConfig {
    /// Resource base URL, no trailing slash.
    pub endpoint: String,
    pub auth: AzureAuth,
}

#[derive(Debug, Clone)]
pub enum AzureAuth {
    ApiKey(Secret),
    ClientSecret {
        tenant_id: String,
        client_id: String,
        secret: Secret,
    },
    ManagedIdentity {
        client_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    /// Enforced BYO-key, and the workspace has provisioned nothing.
    #[error("this workspace has not provisioned a {0} credential")]
    NotProvisioned(&'static str),
    /// Nothing anywhere: no workspace credential, no operator configuration.
    #[error("no {0} configuration is available")]
    NotConfigured(&'static str),
    /// Present but unusable; the reason never contains a secret.
    #[error("the {0} configuration is invalid: {1}")]
    Invalid(&'static str, String),
}

/// Resolve the configuration for one request to `provider`.
pub async fn resolve(
    provider: CloudProvider,
    store: &Arc<dyn LocalStore>,
    workspace_id: &str,
    virtual_key: bool,
    require_provisioned: bool,
    settings: &ProvidersConfig,
) -> Result<CloudConfig, CredentialError> {
    let provider = provider.family();
    if virtual_key {
        let field = format!("{}_config", provider.registry_id());
        if let Some(blob) = store.workspace_credential(workspace_id, &[&field]).await {
            return from_workspace(provider, &blob);
        }
        if require_provisioned {
            return Err(CredentialError::NotProvisioned(provider.display_name()));
        }
    }
    from_operator(provider, settings, |k| std::env::var(k).ok())
}

/// A workspace's stored credential blob — the field names are the
/// `PROVIDER_REGISTRY` entry's field keys.
pub fn from_workspace(provider: CloudProvider, blob: &str) -> Result<CloudConfig, CredentialError> {
    let provider = provider.family();
    let name = provider.display_name();
    let v: serde_json::Value = serde_json::from_str(blob)
        .map_err(|_| CredentialError::Invalid(name, "stored credential is not JSON".into()))?;
    let field = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let missing = |k: &str| CredentialError::Invalid(name, format!("stored credential has no {k}"));
    match provider {
        CloudProvider::Bedrock => {
            let region = valid_region(
                name,
                &field("awsRegion").ok_or_else(|| missing("awsRegion"))?,
            )?;
            let auth = match (
                field("awsAccessKeyId"),
                field("awsSecretAccessKey"),
                field("apiKey"),
            ) {
                (Some(id), Some(secret), _) => AwsAuth::Static(AwsCredentials {
                    access_key_id: id,
                    secret_access_key: secret,
                    session_token: None,
                }),
                (_, _, Some(key)) => AwsAuth::ApiKey(Secret(key)),
                _ => {
                    return Err(CredentialError::Invalid(
                        name,
                        "stored credential needs an access key pair or a Bedrock API key".into(),
                    ))
                }
            };
            Ok(CloudConfig::Bedrock(BedrockConfig {
                region,
                auth,
                runtime_endpoint: None,
                mantle_endpoint: None,
            }))
        }
        CloudProvider::Vertex => {
            let project = valid_project(
                name,
                &field("projectId").ok_or_else(|| missing("projectId"))?,
            )?;
            let location =
                valid_region(name, &field("location").unwrap_or_else(|| "global".into()))?;
            let json = field("serviceAccountJson").ok_or_else(|| missing("serviceAccountJson"))?;
            Ok(CloudConfig::Vertex(VertexConfig {
                project,
                location,
                auth: GcpAuth::Json(Secret(json)),
                endpoint: None,
            }))
        }
        CloudProvider::Azure => {
            let endpoint = field("endpoint").ok_or_else(|| missing("endpoint"))?;
            // A workspace names a host the gateway will POST to with a
            // credential attached: only Azure's own hosts, only over TLS.
            let endpoint = workspace_azure_endpoint(&endpoint)
                .ok_or_else(|| CredentialError::Invalid(name, AZURE_HOST_RULE.into()))?;
            let key = field("apiKey").ok_or_else(|| missing("apiKey"))?;
            Ok(CloudConfig::Azure(AzureConfig {
                endpoint,
                auth: AzureAuth::ApiKey(Secret(key)),
            }))
        }
        CloudProvider::AzureClaude | CloudProvider::GoogleAi => Err(not_here(name)),
    }
}

/// First-party Gemini keys are flat provider keys the proxy reads itself.
fn not_here(name: &'static str) -> CredentialError {
    CredentialError::Invalid(name, "this provider's key is resolved by the proxy".into())
}

/// Operator configuration: `config.yaml`, then environment variables.
pub fn from_operator(
    provider: CloudProvider,
    settings: &ProvidersConfig,
    env: impl Fn(&str) -> Option<String>,
) -> Result<CloudConfig, CredentialError> {
    let provider = provider.family();
    let name = provider.display_name();
    let env = |k: &str| {
        env(k)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let first = |cfg: &Option<String>, vars: &[&str]| {
        cfg.clone()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| vars.iter().find_map(|k| env(k)))
    };
    match provider {
        CloudProvider::Bedrock => {
            let s = &settings.bedrock;
            let region = first(&s.region, &["AWS_REGION", "AWS_DEFAULT_REGION"])
                .ok_or(CredentialError::NotConfigured(name))?;
            let region = valid_region(name, &region)?;
            let auth = match s.api_key.as_ref() {
                Some(r) => AwsAuth::ApiKey(r.resolve().ok_or_else(|| unset(name, r))?),
                None => match env("AWS_BEARER_TOKEN_BEDROCK") {
                    Some(k) => AwsAuth::ApiKey(Secret(k)),
                    None => AwsAuth::Chain,
                },
            };
            Ok(CloudConfig::Bedrock(BedrockConfig {
                region,
                auth,
                runtime_endpoint: optional_endpoint(name, &s.runtime_endpoint)?,
                mantle_endpoint: optional_endpoint(name, &s.mantle_endpoint)?,
            }))
        }
        CloudProvider::Vertex => {
            let s = &settings.vertex;
            let project = first(
                &s.project,
                &["GOOGLE_CLOUD_PROJECT", "ANTHROPIC_VERTEX_PROJECT_ID"],
            )
            .ok_or(CredentialError::NotConfigured(name))?;
            let location = first(&s.location, &["GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION"])
                .unwrap_or_else(|| "global".into());
            Ok(CloudConfig::Vertex(VertexConfig {
                project: valid_project(name, &project)?,
                location: valid_region(name, &location)?,
                auth: match &s.credentials_file {
                    Some(path) if !path.trim().is_empty() => GcpAuth::File(path.trim().to_string()),
                    _ => GcpAuth::Adc,
                },
                endpoint: optional_endpoint(name, &s.endpoint)?,
            }))
        }
        CloudProvider::Azure => {
            let s = &settings.azure;
            let endpoint = first(&s.endpoint, &["AZURE_OPENAI_ENDPOINT"])
                .ok_or(CredentialError::NotConfigured(name))?;
            // The operator's own endpoint may be a private endpoint or an API
            // gateway in front of Azure; only its shape is checked.
            let endpoint = operator_endpoint(&endpoint).ok_or_else(|| {
                CredentialError::Invalid(name, "endpoint must be an http(s) URL".into())
            })?;
            let auth = if let Some(r) = &s.api_key {
                AzureAuth::ApiKey(r.resolve().ok_or_else(|| unset(name, r))?)
            } else if let Some(k) = env("AZURE_OPENAI_API_KEY") {
                AzureAuth::ApiKey(Secret(k))
            } else if s.managed_identity {
                AzureAuth::ManagedIdentity {
                    client_id: first(&s.client_id, &["AZURE_CLIENT_ID"]),
                }
            } else {
                let tenant = first(&s.tenant_id, &["AZURE_TENANT_ID"]);
                let client = first(&s.client_id, &["AZURE_CLIENT_ID"]);
                let secret = match &s.client_secret {
                    Some(r) => Some(r.resolve().ok_or_else(|| unset(name, r))?),
                    None => env("AZURE_CLIENT_SECRET").map(Secret),
                };
                match (tenant, client, secret) {
                    (Some(tenant_id), Some(client_id), Some(secret)) => AzureAuth::ClientSecret {
                        tenant_id,
                        client_id,
                        secret,
                    },
                    _ => return Err(CredentialError::NotConfigured(name)),
                }
            };
            Ok(CloudConfig::Azure(AzureConfig { endpoint, auth }))
        }
        CloudProvider::AzureClaude | CloudProvider::GoogleAi => Err(not_here(name)),
    }
}

fn optional_endpoint(
    name: &'static str,
    e: &Option<String>,
) -> Result<Option<String>, CredentialError> {
    match e.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        None => Ok(None),
        Some(raw) => operator_endpoint(raw).map(Some).ok_or_else(|| {
            CredentialError::Invalid(name, "endpoint must be an http(s) URL".into())
        }),
    }
}

fn unset(name: &'static str, r: &SecretRef) -> CredentialError {
    CredentialError::Invalid(name, format!("{r:?} is not set"))
}

/// AWS regions and Google locations become part of a hostname, so they are
/// held to the character set both clouds use (`us-east-1`, `europe-west4`,
/// `global`), which also rules out anything that could change the host.
fn valid_region(name: &'static str, r: &str) -> Result<String, CredentialError> {
    let r = r.trim().to_ascii_lowercase();
    if !r.is_empty()
        && r.len() <= 32
        && r.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !r.starts_with('-')
    {
        Ok(r)
    } else {
        Err(CredentialError::Invalid(
            name,
            "region/location is not a valid name".into(),
        ))
    }
}

/// GCP project ids and numbers: lowercase letters, digits, hyphens; part of
/// the URL path.
fn valid_project(name: &'static str, p: &str) -> Result<String, CredentialError> {
    let p = p.trim();
    if !p.is_empty()
        && p.len() <= 64
        && p.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        Ok(p.to_string())
    } else {
        Err(CredentialError::Invalid(
            name,
            "project id is not valid".into(),
        ))
    }
}

/// Host suffixes a workspace-supplied Azure endpoint may use.
pub const AZURE_HOST_SUFFIXES: &[&str] = &[
    ".openai.azure.com",
    ".services.ai.azure.com",
    ".cognitiveservices.azure.com",
];

const AZURE_HOST_RULE: &str =
    "endpoint must be https://<resource>.openai.azure.com, .services.ai.azure.com or .cognitiveservices.azure.com";

/// The resource base URL from a workspace-supplied endpoint, if it is an
/// `https` URL on an Azure OpenAI / Foundry host. Anything after the host is
/// dropped: the proxy appends the API path itself.
pub fn workspace_azure_endpoint(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let label = AZURE_HOST_SUFFIXES
        .iter()
        .find_map(|s| host.strip_suffix(s))?;
    if label.is_empty()
        || !label
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    Some(format!("https://{host}"))
}

/// An operator endpoint: any http(s) URL; a trailing `/` and a trailing
/// `/openai` or `/openai/v1` (as copied from the Azure portal) are dropped.
fn operator_endpoint(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    let s = url.as_str().trim_end_matches('/');
    let s = [
        "/openai/v1",
        "/openai",
        "/anthropic/v1/messages",
        "/anthropic/v1",
        "/anthropic",
    ]
    .iter()
    .find_map(|sfx| s.strip_suffix(sfx))
    .unwrap_or(s);
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn a_literal_secret_in_config_yaml_is_refused_without_echoing_it() {
        let err = serde_yaml::from_str::<AzureSettings>("api_key: abc123-literal-value")
            .unwrap_err()
            .to_string();
        assert!(err.contains("os.environ/"), "{err}");
        assert!(!err.contains("abc123"), "{err}");
        let ok: AzureSettings = serde_yaml::from_str("api_key: os.environ/MY_AZURE_KEY").unwrap();
        assert_eq!(
            format!("{:?}", ok.api_key.unwrap()),
            "os.environ/MY_AZURE_KEY"
        );
    }

    #[test]
    fn debug_output_never_contains_a_resolved_secret() {
        let cfg = CloudConfig::Azure(AzureConfig {
            endpoint: "https://r.openai.azure.com".into(),
            auth: AzureAuth::ApiKey(Secret::new("super-secret-key-value")),
        });
        let shown = format!("{cfg:?}");
        assert!(!shown.contains("super-secret"), "{shown}");
        let ws = from_workspace(
            CloudProvider::Vertex,
            r#"{"projectId":"p-1","serviceAccountJson":"{\"private_key\":\"pk-material\"}"}"#,
        )
        .unwrap();
        assert!(!format!("{ws:?}").contains("pk-material"));
    }

    #[test]
    fn workspace_bedrock_takes_a_key_pair_or_an_api_key() {
        let pair = from_workspace(
            CloudProvider::Bedrock,
            r#"{"awsRegion":"eu-west-1","awsAccessKeyId":"AKIA1","awsSecretAccessKey":"s3cret"}"#,
        )
        .unwrap();
        match pair {
            CloudConfig::Bedrock(b) => {
                assert_eq!(b.region, "eu-west-1");
                assert!(matches!(b.auth, AwsAuth::Static(ref c) if c.access_key_id == "AKIA1"));
            }
            _ => panic!(),
        }
        let key = from_workspace(
            CloudProvider::Bedrock,
            r#"{"awsRegion":"us-east-1","apiKey":"bedrock-key"}"#,
        )
        .unwrap();
        assert!(matches!(
            key,
            CloudConfig::Bedrock(BedrockConfig {
                auth: AwsAuth::ApiKey(_),
                ..
            })
        ));
        assert!(matches!(
            from_workspace(CloudProvider::Bedrock, r#"{"awsRegion":"us-east-1"}"#),
            Err(CredentialError::Invalid(..))
        ));
    }

    #[test]
    fn a_region_that_could_change_the_host_is_refused() {
        for bad in ["evil.com/#", "us-east-1.attacker.net", "a b", "", "-x"] {
            let blob = format!(r#"{{"awsRegion":"{bad}","apiKey":"k"}}"#);
            assert!(
                from_workspace(CloudProvider::Bedrock, &blob).is_err(),
                "{bad} accepted"
            );
        }
    }

    #[test]
    fn workspace_azure_endpoints_must_be_azure_hosts_over_tls() {
        assert_eq!(
            workspace_azure_endpoint("https://my-res.openai.azure.com/openai/v1/"),
            Some("https://my-res.openai.azure.com".into())
        );
        assert_eq!(
            workspace_azure_endpoint("https://My-Res.services.ai.azure.com"),
            Some("https://my-res.services.ai.azure.com".into())
        );
        for bad in [
            "http://my-res.openai.azure.com",
            "https://my-res.openai.azure.com.evil.net",
            "https://openai.azure.com",
            "https://169.254.169.254/",
            "https://valkey:6379",
            "https://user@my-res.openai.azure.com",
            "https://my-res.openai.azure.com:8443",
            "https://a.b.openai.azure.com",
        ] {
            assert_eq!(workspace_azure_endpoint(bad), None, "{bad}");
        }
    }

    #[test]
    fn operator_settings_fall_back_to_conventional_environment_variables() {
        let s = ProvidersConfig::default();
        let cfg = from_operator(
            CloudProvider::Bedrock,
            &s,
            env_of(&[("AWS_DEFAULT_REGION", "us-west-2")]),
        )
        .unwrap();
        assert!(
            matches!(cfg, CloudConfig::Bedrock(BedrockConfig { ref region, auth: AwsAuth::Chain, .. }) if region == "us-west-2")
        );

        let cfg = from_operator(
            CloudProvider::Bedrock,
            &s,
            env_of(&[
                ("AWS_REGION", "us-east-1"),
                ("AWS_BEARER_TOKEN_BEDROCK", "tok"),
            ]),
        )
        .unwrap();
        assert!(matches!(
            cfg,
            CloudConfig::Bedrock(BedrockConfig {
                auth: AwsAuth::ApiKey(_),
                ..
            })
        ));

        let cfg = from_operator(
            CloudProvider::Vertex,
            &s,
            env_of(&[
                ("ANTHROPIC_VERTEX_PROJECT_ID", "proj-9"),
                ("CLOUD_ML_REGION", "us-east5"),
            ]),
        )
        .unwrap();
        assert!(
            matches!(cfg, CloudConfig::Vertex(VertexConfig { ref project, ref location, auth: GcpAuth::Adc, .. }) if project == "proj-9" && location == "us-east5")
        );

        let cfg = from_operator(
            CloudProvider::Azure,
            &s,
            env_of(&[
                (
                    "AZURE_OPENAI_ENDPOINT",
                    "https://corp.openai.azure.com/openai/v1/",
                ),
                ("AZURE_OPENAI_API_KEY", "k"),
            ]),
        )
        .unwrap();
        assert!(
            matches!(cfg, CloudConfig::Azure(AzureConfig { ref endpoint, auth: AzureAuth::ApiKey(_) }) if endpoint == "https://corp.openai.azure.com")
        );

        assert_eq!(
            from_operator(CloudProvider::Azure, &s, env_of(&[])).unwrap_err(),
            CredentialError::NotConfigured("Azure OpenAI")
        );
        assert_eq!(
            from_operator(CloudProvider::Vertex, &s, env_of(&[])).unwrap_err(),
            CredentialError::NotConfigured("Google Vertex AI")
        );
    }

    #[test]
    fn config_yaml_overrides_the_environment_and_entra_needs_all_three_values() {
        let s: ProvidersConfig = serde_yaml::from_str(
            "azure:\n  endpoint: https://gw.corp.example/azure\n  tenant_id: t\n  client_id: c\n",
        )
        .unwrap();
        // No secret anywhere: not configured, rather than half an Entra login.
        assert!(from_operator(CloudProvider::Azure, &s, env_of(&[])).is_err());
        let cfg = from_operator(
            CloudProvider::Azure,
            &s,
            env_of(&[
                ("AZURE_CLIENT_SECRET", "x"),
                ("AZURE_OPENAI_ENDPOINT", "https://ignored.openai.azure.com"),
            ]),
        )
        .unwrap();
        assert!(
            matches!(cfg, CloudConfig::Azure(AzureConfig { ref endpoint, auth: AzureAuth::ClientSecret { .. } }) if endpoint == "https://gw.corp.example/azure")
        );
    }

    #[test]
    fn unknown_keys_in_the_providers_block_are_refused() {
        assert!(
            serde_yaml::from_str::<ProvidersConfig>("bedrock:\n  regoin: us-east-1\n").is_err()
        );
    }

    #[tokio::test]
    async fn a_virtual_key_request_uses_the_workspace_credential_and_enforcement_refuses_without_one(
    ) {
        let store: Arc<dyn LocalStore> = Arc::new(crate::store::memory::MemoryStore::new());
        store
            .set_workspace_credential(
                "ws_1",
                "azure_openai_config",
                r#"{"endpoint":"https://ws1.openai.azure.com","apiKey":"ws-key"}"#,
            )
            .await;
        let s = ProvidersConfig::default();
        let cfg = resolve(CloudProvider::Azure, &store, "ws_1", true, true, &s)
            .await
            .unwrap();
        assert!(
            matches!(cfg, CloudConfig::Azure(AzureConfig { ref endpoint, .. }) if endpoint == "https://ws1.openai.azure.com")
        );
        assert_eq!(
            resolve(CloudProvider::Azure, &store, "ws_2", true, true, &s)
                .await
                .unwrap_err(),
            CredentialError::NotProvisioned("Azure OpenAI")
        );
        // A raw (non-vk) caller never reads a workspace's stored credential:
        // with no operator configuration it is simply not configured.
        store
            .set_workspace_credential(
                "ws_1",
                "vertex_ai_config",
                r#"{"projectId":"ws-proj","serviceAccountJson":"{}"}"#,
            )
            .await;
        let raw = resolve(CloudProvider::Vertex, &store, "ws_1", false, false, &s).await;
        assert!(
            !matches!(raw, Ok(CloudConfig::Vertex(VertexConfig { ref project, .. })) if project == "ws-proj")
        );
    }
}
