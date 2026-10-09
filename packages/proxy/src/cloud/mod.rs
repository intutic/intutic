//! Cloud-hosted model upstreams: AWS Bedrock, Google Vertex AI and Azure
//! OpenAI (including Azure AI Foundry's OpenAI v1 API).
//!
//! # How they fit the proxy
//!
//! Every governance feature in `proxy::handle_proxy` — DLP in both
//! directions, SOP/policy gates, WASM/Rego rules, the response gate, cost
//! metering, budgets, traces, the response cache — is written against two
//! upstream wire shapes: the Anthropic Messages API and the OpenAI API. This
//! module makes each cloud upstream *look like one of those two*, so none of
//! that code needs to know a cloud provider exists:
//!
//! | Provider | Wire the proxy sees | What happens underneath |
//! |---|---|---|
//! | Bedrock, Claude Opus 4.7 and later | Anthropic | `bedrock-mantle` Messages API, SigV4 |
//! | Bedrock, earlier Claude models | Anthropic | `InvokeModel`, body rewritten, event-stream → SSE |
//! | Bedrock, every other model | Anthropic | `Converse`, translated both ways |
//! | Vertex AI, Claude | Anthropic | `rawPredict` / `streamRawPredict`, OAuth bearer |
//! | Vertex AI, Gemini | Anthropic | `generateContent`, translated both ways |
//! | Azure OpenAI / Foundry | OpenAI | OpenAI v1 API on the resource, `api-key` or Entra |
//!
//! The request the proxy hands [`send`] is the body it would have sent to
//! Anthropic (or OpenAI) — after DLP, SOP injection, compaction and
//! cross-protocol translation — and what comes back is a `reqwest::Response`
//! carrying that same wire's status, error shape and SSE. Streaming
//! translation happens on the byte stream, before the proxy's line reader, so
//! the DLP holdback and the response gate act on exactly what the client
//! receives.
//!
//! # Model names
//!
//! `bedrock/<model id>`, `vertex/<model>` (`vertex_ai/` is accepted, matching
//! LiteLLM) and `azure/<deployment>`. A `config.yaml` `model_list` entry can
//! alias any name to one of these ([`install_aliases`]), so a client that
//! only knows `claude-sonnet-4-5` can be served from Bedrock unchanged.

pub mod auth;
pub mod azure;
pub mod bedrock;
pub mod config;
pub mod converse;
pub mod errors;
pub mod eventstream;
pub mod gemini;
pub mod sigv4;
pub mod sse;
pub mod vertex;

use std::collections::HashMap;
use std::sync::OnceLock;

pub use config::{CloudConfig, CredentialError};

/// A cloud upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CloudProvider {
    Bedrock,
    Vertex,
    Azure,
}

/// The upstream wire shape a cloud provider is presented as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Anthropic,
    OpenAI,
}

impl CloudProvider {
    /// The provider-credential registry id (`@intutic/shared-types`
    /// `PROVIDER_REGISTRY`) — also the `{id}_config` field a workspace's
    /// stored credential lives under.
    pub fn registry_id(self) -> &'static str {
        match self {
            CloudProvider::Bedrock => "bedrock",
            CloudProvider::Vertex => "vertex_ai",
            CloudProvider::Azure => "azure_openai",
        }
    }

    /// The model-name prefix that names this provider (`bedrock/…`).
    pub fn prefix(self) -> &'static str {
        match self {
            CloudProvider::Bedrock => "bedrock",
            CloudProvider::Vertex => "vertex",
            CloudProvider::Azure => "azure",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            CloudProvider::Bedrock => "AWS Bedrock",
            CloudProvider::Vertex => "Google Vertex AI",
            CloudProvider::Azure => "Azure OpenAI",
        }
    }

    pub fn wire(self) -> Wire {
        match self {
            CloudProvider::Bedrock | CloudProvider::Vertex => Wire::Anthropic,
            CloudProvider::Azure => Wire::OpenAI,
        }
    }

    /// What a self-hosted operator sets when no workspace credential applies;
    /// named in the refusal so the fix is in the error message.
    pub fn configuration_hint(self) -> &'static str {
        match self {
            CloudProvider::Bedrock => {
                "AWS credentials (the standard AWS chain) and AWS_REGION, or AWS_BEARER_TOKEN_BEDROCK"
            }
            CloudProvider::Vertex => {
                "GOOGLE_CLOUD_PROJECT and Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS)"
            }
            CloudProvider::Azure => "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY",
        }
    }
}

/// A request's cloud destination: the provider and the model id that provider
/// is called with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudModel {
    pub provider: CloudProvider,
    /// The id sent upstream: a Bedrock model / inference-profile id or ARN,
    /// a Vertex model name, or an Azure deployment name.
    pub model: String,
}

/// Parse an explicit `bedrock/`, `vertex/`, `vertex_ai/` or `azure/` model name.
pub fn parse_prefixed(model: &str) -> Option<CloudModel> {
    let (prefix, rest) = model.split_once('/')?;
    let provider = match prefix.to_ascii_lowercase().as_str() {
        "bedrock" => CloudProvider::Bedrock,
        "vertex" | "vertex_ai" => CloudProvider::Vertex,
        "azure" => CloudProvider::Azure,
        _ => return None,
    };
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    Some(CloudModel {
        provider,
        model: rest.to_string(),
    })
}

/// Model-name aliases from `config.yaml`'s `model_list`: `model_name` →
/// a cloud model name in `litellm_params.model`. Installed once at startup.
static ALIASES: OnceLock<HashMap<String, CloudModel>> = OnceLock::new();

/// Record every `model_list` entry whose target is a cloud model. Entries
/// pointing anywhere else are not aliases here: the proxy has always resolved
/// first-party providers from the model name itself, and this keeps every
/// existing config meaning exactly what it meant.
pub fn install_aliases(entries: &[crate::config::ModelEntry]) {
    let map = alias_map(entries);
    if !map.is_empty() {
        tracing::info!(
            aliases = map.len(),
            "cloud model aliases loaded from model_list"
        );
    }
    let _ = ALIASES.set(map);
}

fn alias_map(entries: &[crate::config::ModelEntry]) -> HashMap<String, CloudModel> {
    entries
        .iter()
        .filter_map(|e| {
            parse_prefixed(&e.litellm_params.model).map(|m| (e.model_name.to_lowercase(), m))
        })
        .collect()
}

/// The cloud destination for a requested model name, if it has one: an
/// explicit prefix first, then a `model_list` alias.
pub fn resolve(model: &str) -> Option<CloudModel> {
    parse_prefixed(model).or_else(|| {
        ALIASES
            .get()
            .and_then(|m| m.get(&model.to_lowercase()))
            .cloned()
    })
}

/// The name a cloud model id is priced under in the offline pricing bundle.
///
/// Bedrock and Vertex sell Anthropic and Google models at those vendors'
/// list prices, under ids that wrap the vendor's own name:
/// `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` and
/// `vertex/claude-sonnet-4-5@20250929` are both `claude-sonnet-4-5-20250929`.
/// An alias prices as the Bedrock or Vertex model it names. Azure
/// deployments are operator-named, so `azure/gpt-4o` prices as `gpt-4o`, an
/// alias for a deployment prices as the alias (`gpt-4o` → `azure/gpt4o-prod`
/// is `gpt-4o`), and a deployment named after nothing falls to the
/// conservative estimate — over-charging rather than under, the direction a
/// budget gate can survive.
pub fn pricing_name(model: &str) -> String {
    let Some(cm) = resolve(model) else {
        return model.to_string();
    };
    if cm.provider == CloudProvider::Azure && parse_prefixed(model).is_none() {
        return model.to_string();
    }
    let mut id = cm.model.to_lowercase();
    match cm.provider {
        CloudProvider::Bedrock => {
            // ARNs end in the model or profile id after the last '/'.
            if let Some(tail) = id.rsplit('/').next() {
                id = tail.to_string();
            }
            // Cross-region inference profile prefixes.
            for geo in [
                "global.", "us.", "eu.", "apac.", "jp.", "au.", "ca.", "us-gov.",
            ] {
                if let Some(rest) = id.strip_prefix(geo) {
                    id = rest.to_string();
                    break;
                }
            }
            // Vendor prefix: `anthropic.`, `meta.`, `amazon.`, ...
            if let Some((_, rest)) = id.split_once('.') {
                id = rest.to_string();
            }
            // Version suffix: `-v1:0`, `-v1`, `-v2:0:200k`.
            if let Some(pos) = id.rfind("-v") {
                if id[pos + 2..].starts_with(|c: char| c.is_ascii_digit()) {
                    id.truncate(pos);
                }
            }
            id
        }
        CloudProvider::Vertex => id.replace('@', "-"),
        CloudProvider::Azure => id,
    }
}

/// The same model on another provider, for a fallback target that names only
/// a provider ("same model, another provider") — `None` is the model's
/// first-party API.
///
/// Built from the vendor name ([`pricing_name`]), using each cloud's
/// documented id scheme:
///
/// - first-party: `claude-sonnet-4-5-20250929`;
/// - Vertex AI: the release date after `@` (`claude-sonnet-4-5@20250929`),
///   undated ids as they are (`claude-opus-4-7`);
/// - Bedrock: an undated Claude id on the Messages API
///   (`anthropic.claude-opus-4-7`), a dated one as the cross-region inference
///   profile for the configured region's geography
///   (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`; `eu.`, `apac.`, or
///   `global.` outside those);
/// - Azure: a deployment named after the model.
///
/// An account that uses another profile or deployment name pins the target's
/// `model` instead.
pub fn same_model_for(
    primary: &str,
    target: Option<CloudProvider>,
    bedrock_region: Option<&str>,
) -> String {
    let name = pricing_name(primary);
    let dated = name
        .rsplit_once('-')
        .filter(|(_, d)| d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()));
    let claude = name.starts_with("claude");
    match target {
        None => name,
        Some(CloudProvider::Vertex) => match dated {
            Some((base, date)) if claude => format!("vertex/{base}@{date}"),
            _ => format!("vertex/{name}"),
        },
        Some(CloudProvider::Bedrock) if claude => match dated {
            Some(_) => {
                let region = bedrock_region.unwrap_or("");
                let geo = if region.starts_with("us-gov-") {
                    "us-gov"
                } else if region.starts_with("us-") || region.starts_with("ca-") {
                    "us"
                } else if region.starts_with("eu-") {
                    "eu"
                } else if region.starts_with("ap-") {
                    "apac"
                } else {
                    "global"
                };
                format!("bedrock/{geo}.anthropic.{name}-v1:0")
            }
            None => format!("bedrock/anthropic.{name}"),
        },
        Some(c) => format!("{}/{name}", c.prefix()),
    }
}

/// How a Bedrock model is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BedrockApi {
    /// `bedrock-mantle` `/anthropic/v1/messages`: Claude Opus 4.7 and later,
    /// unversioned ids such as `anthropic.claude-opus-4-7`.
    Mantle,
    /// `bedrock-runtime` `InvokeModel`: earlier Claude models, versioned ids
    /// such as `us.anthropic.claude-sonnet-4-5-20250929-v1:0`.
    InvokeModel,
    /// `bedrock-runtime` `Converse`: every other model, and application
    /// inference profile ARNs whose underlying model the id does not name.
    Converse,
}

pub fn bedrock_api(model_id: &str) -> BedrockApi {
    let id = model_id.to_ascii_lowercase();
    if !id.contains("anthropic.claude") {
        return BedrockApi::Converse;
    }
    // Versioned ids (`-v1`, `-v1:0`) are the InvokeModel generation; the
    // Messages-API generation drops the suffix.
    let tail = id.rsplit('/').next().unwrap_or(&id);
    let versioned = tail.rfind("-v").is_some_and(|pos| {
        let rest = &tail[pos + 2..];
        !rest.is_empty()
            && rest
                .split(':')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
            && rest.starts_with(|c: char| c.is_ascii_digit())
    });
    if versioned {
        BedrockApi::InvokeModel
    } else if id.starts_with("arn:") {
        BedrockApi::Converse
    } else {
        BedrockApi::Mantle
    }
}

/// One call to a cloud upstream.
pub struct CloudCall<'a> {
    pub model: &'a CloudModel,
    pub config: &'a CloudConfig,
    /// The inbound protocol. Selects Azure's `/chat/completions` vs
    /// `/responses`; Bedrock and Vertex always receive Messages.
    pub protocol: &'a crate::protocol::Protocol,
    /// The body in the provider's wire shape ([`CloudProvider::wire`]).
    pub body: &'a [u8],
    /// The client's request headers: `anthropic-beta` and the W3C trace
    /// context are carried over, nothing else.
    pub client_headers: &'a axum::http::HeaderMap,
    pub timeout: std::time::Duration,
}

/// Send `call` and return the upstream's answer in the provider's wire shape.
///
/// A transport failure is the `Err`, exactly as from `reqwest`, so the caller's
/// unreachable-upstream handling applies unchanged. Everything else — an
/// upstream error status, a request this provider cannot express, a
/// credential that will not mint a token — is an `Ok` response carrying the
/// wire's own error status and body.
pub async fn send(
    client: &reqwest::Client,
    call: CloudCall<'_>,
) -> Result<reqwest::Response, reqwest::Error> {
    let wire = call.model.provider.wire();
    let body: serde_json::Value = match serde_json::from_slice(call.body) {
        Ok(v) => v,
        Err(_) => {
            return Ok(errors::synthesize(
                wire,
                400,
                "invalid_request_error",
                "request body is not JSON",
            ))
        }
    };
    let stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match (call.model.provider, call.config) {
        (CloudProvider::Bedrock, CloudConfig::Bedrock(cfg)) => {
            bedrock::send(client, &call, cfg, body, stream).await
        }
        (CloudProvider::Vertex, CloudConfig::Vertex(cfg)) => {
            vertex::send(client, &call, cfg, body, stream).await
        }
        (CloudProvider::Azure, CloudConfig::Azure(cfg)) => {
            azure::send(client, &call, cfg, body).await
        }
        _ => Ok(errors::synthesize(
            wire,
            500,
            "api_error",
            "cloud provider configuration does not match the model's provider",
        )),
    }
}

/// The client headers carried to every cloud upstream: W3C trace context, so a
/// trace started in the harness continues through the provider call.
pub(crate) fn trace_headers(client: &axum::http::HeaderMap) -> Vec<(&'static str, String)> {
    ["traceparent", "tracestate"]
        .into_iter()
        .filter_map(|n| {
            client
                .get(n)
                .and_then(|v| v.to_str().ok())
                .map(|v| (n, v.to_string()))
        })
        .collect()
}

/// `anthropic-beta` flags from the client's header, comma-separated on the wire.
pub(crate) fn anthropic_betas(client: &axum::http::HeaderMap) -> Vec<String> {
    client
        .get_all("anthropic-beta")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_name_the_provider_and_keep_the_upstream_id_verbatim() {
        assert_eq!(
            parse_prefixed("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            Some(CloudModel {
                provider: CloudProvider::Bedrock,
                model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0".into()
            })
        );
        assert_eq!(
            parse_prefixed("vertex_ai/claude-sonnet-4-5@20250929")
                .unwrap()
                .provider,
            CloudProvider::Vertex
        );
        assert_eq!(
            parse_prefixed("Vertex/gemini-2.5-pro").unwrap().model,
            "gemini-2.5-pro"
        );
        assert_eq!(
            parse_prefixed("azure/my-gpt4o-deployment"),
            Some(CloudModel {
                provider: CloudProvider::Azure,
                model: "my-gpt4o-deployment".into()
            })
        );
        // An ARN keeps its own slashes.
        assert_eq!(
            parse_prefixed(
                "bedrock/arn:aws:bedrock:us-east-1:123:application-inference-profile/abc"
            )
            .unwrap()
            .model,
            "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc"
        );
    }

    #[test]
    fn other_slashed_names_are_not_cloud_models() {
        assert_eq!(parse_prefixed("anthropic/claude-3-opus"), None);
        assert_eq!(parse_prefixed("mistralai/mistral-large"), None);
        assert_eq!(parse_prefixed("bedrock/"), None);
        assert_eq!(parse_prefixed("claude-sonnet-4-5"), None);
    }

    #[test]
    fn aliases_come_only_from_cloud_targets() {
        let yaml = r#"
- model_name: Claude-Sonnet
  litellm_params: { model: bedrock/anthropic.claude-sonnet-5 }
- model_name: gpt-4o
  litellm_params: { model: openai/gpt-4o }
- model_name: corp-gpt
  litellm_params: { model: azure/gpt4o-prod }
"#;
        let entries: Vec<crate::config::ModelEntry> = serde_yaml::from_str(yaml).unwrap();
        let map = alias_map(&entries);
        assert_eq!(map.len(), 2);
        assert_eq!(map["claude-sonnet"].model, "anthropic.claude-sonnet-5");
        assert_eq!(map["corp-gpt"].provider, CloudProvider::Azure);
        assert!(!map.contains_key("gpt-4o"));
    }

    /// The only test in this binary that installs aliases (the table is set
    /// once per process).
    #[test]
    fn installed_aliases_route_and_price() {
        let yaml = r#"
- model_name: corp-sonnet
  litellm_params: { model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0 }
- model_name: gpt-4o-corp
  litellm_params: { model: azure/gpt4o-prod }
"#;
        let entries: Vec<crate::config::ModelEntry> = serde_yaml::from_str(yaml).unwrap();
        install_aliases(&entries);
        assert_eq!(
            resolve("Corp-Sonnet").unwrap().provider,
            CloudProvider::Bedrock
        );
        assert_eq!(pricing_name("corp-sonnet"), "claude-sonnet-4-5-20250929");
        // A deployment name says nothing about the model; the alias does.
        assert_eq!(resolve("gpt-4o-corp").unwrap().model, "gpt4o-prod");
        assert_eq!(pricing_name("gpt-4o-corp"), "gpt-4o-corp");
        assert_eq!(pricing_name("azure/gpt4o-prod"), "gpt4o-prod");
    }

    #[test]
    fn cloud_ids_price_under_the_vendor_name() {
        assert_eq!(
            pricing_name("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            "claude-sonnet-4-5-20250929"
        );
        assert_eq!(
            pricing_name("bedrock/global.anthropic.claude-opus-4-6-v1"),
            "claude-opus-4-6"
        );
        assert_eq!(
            pricing_name("bedrock/anthropic.claude-opus-4-7"),
            "claude-opus-4-7"
        );
        assert_eq!(
            pricing_name("bedrock/arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"),
            "claude-haiku-4-5-20251001"
        );
        assert_eq!(
            pricing_name("bedrock/meta.llama3-1-70b-instruct-v1:0"),
            "llama3-1-70b-instruct"
        );
        assert_eq!(
            pricing_name("vertex/claude-sonnet-4-5@20250929"),
            "claude-sonnet-4-5-20250929"
        );
        assert_eq!(pricing_name("vertex_ai/gemini-2.5-pro"), "gemini-2.5-pro");
        assert_eq!(pricing_name("azure/gpt-4o"), "gpt-4o");
        assert_eq!(pricing_name("claude-sonnet-4-5"), "claude-sonnet-4-5");
    }

    #[test]
    fn the_same_model_is_named_in_each_provider_s_scheme() {
        use CloudProvider::*;
        let dated = "claude-sonnet-4-5-20250929";
        assert_eq!(
            same_model_for(dated, Some(Vertex), None),
            "vertex/claude-sonnet-4-5@20250929"
        );
        assert_eq!(
            same_model_for(dated, Some(Bedrock), Some("us-west-2")),
            "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        );
        assert_eq!(
            same_model_for(dated, Some(Bedrock), Some("eu-central-1")),
            "bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0"
        );
        assert_eq!(
            same_model_for("claude-opus-4-7", Some(Bedrock), Some("us-east-1")),
            "bedrock/anthropic.claude-opus-4-7"
        );
        assert_eq!(
            same_model_for("claude-opus-4-7", Some(Vertex), None),
            "vertex/claude-opus-4-7"
        );
        // Back to the first-party API from either cloud.
        assert_eq!(
            same_model_for(
                "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                None,
                None
            ),
            dated
        );
        assert_eq!(
            same_model_for("vertex/claude-sonnet-4-5@20250929", None, None),
            dated
        );
        // Bedrock → Vertex round-trips through the vendor name.
        assert_eq!(
            same_model_for("bedrock/anthropic.claude-opus-4-7", Some(Vertex), None),
            "vertex/claude-opus-4-7"
        );
        assert_eq!(same_model_for("gpt-4o", Some(Azure), None), "azure/gpt-4o");
        // Every name produced resolves back to the provider it names.
        assert_eq!(
            resolve(&same_model_for(dated, Some(Bedrock), Some("ap-south-1")))
                .unwrap()
                .provider,
            Bedrock
        );
        assert_eq!(
            bedrock_api(
                &resolve(&same_model_for(dated, Some(Bedrock), Some("us-east-1")))
                    .unwrap()
                    .model
            ),
            BedrockApi::InvokeModel
        );
    }

    #[test]
    fn bedrock_api_follows_the_model_generation() {
        use BedrockApi::*;
        assert_eq!(bedrock_api("anthropic.claude-opus-4-7"), Mantle);
        assert_eq!(bedrock_api("anthropic.claude-opus-5-5"), Mantle);
        assert_eq!(bedrock_api("anthropic.claude-haiku-4-5"), Mantle);
        assert_eq!(
            bedrock_api("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            InvokeModel
        );
        assert_eq!(
            bedrock_api("global.anthropic.claude-opus-4-6-v1"),
            InvokeModel
        );
        assert_eq!(
            bedrock_api("anthropic.claude-3-5-haiku-20241022-v1:0"),
            InvokeModel
        );
        assert_eq!(
            bedrock_api("arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            InvokeModel
        );
        assert_eq!(
            bedrock_api("arn:aws:bedrock:us-east-1:1:application-inference-profile/a1b2"),
            Converse
        );
        assert_eq!(bedrock_api("meta.llama3-1-70b-instruct-v1:0"), Converse);
        assert_eq!(bedrock_api("amazon.nova-pro-v1:0"), Converse);
    }

    #[test]
    fn betas_split_and_trace_headers_carry_over() {
        let mut h = axum::http::HeaderMap::new();
        h.append("anthropic-beta", "a-1, b-2".parse().unwrap());
        h.append("anthropic-beta", "c-3".parse().unwrap());
        h.insert("traceparent", "00-abc-def-01".parse().unwrap());
        h.insert("x-other", "nope".parse().unwrap());
        assert_eq!(anthropic_betas(&h), vec!["a-1", "b-2", "c-3"]);
        assert_eq!(
            trace_headers(&h),
            vec![("traceparent", "00-abc-def-01".to_string())]
        );
    }
}
