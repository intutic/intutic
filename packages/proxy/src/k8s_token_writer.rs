//! Self-hosted gateway token persistence for Kubernetes (TD-341).
//!
//! `heartbeat.rs`'s `INTUTIC_GATEWAY_TOKEN_STATE_FILE` mechanism closes the
//! "self-rotated token lost on restart" gap for bare-metal (a persistent
//! supervisor reads the file back before every spawn) and Docker (a
//! bind-mounted host path survives container recreation). Neither answer
//! fits Kubernetes cleanly: a plain file only survives IN-PLACE container
//! restarts within the same pod (kubelet keeps `emptyDir` across a crash
//! restart), not a pod reschedule or a rolling redeploy — the exact
//! "redeploy" case the tech debt entry calls out. A PersistentVolumeClaim
//! would survive that, but the proxy Deployment's rolling-update strategy
//! (`maxUnavailable: 0, maxSurge: 1` — a new pod comes up before the old one
//! terminates) is incompatible with a ReadWriteOnce PVC, which can't attach
//! to two pods at once; forcing `Recreate` strategy to accommodate a PVC
//! would trade away the chart's zero-downtime-upgrade property for every
//! self-hosted operator, not just the ones who want token persistence.
//!
//! So Kubernetes gets the mechanism its own docs already named as the right
//! one: the pod patches the Secret it was launched from. A Secret's
//! lifecycle is independent of any one pod's, `kubectl`-visible, and needs
//! no storage class — only a narrow, resourceName-scoped RBAC grant (see
//! `tools/helm/intutic-gateway/templates/rbac-self-rotation.yaml`). The next
//! pod created from this Deployment (crash restart OR full redeploy) reads
//! the Secret fresh via its `secretKeyRef` env, same as day one.
//!
//! Deliberately independent of, not a replacement for, the state-file path:
//! a deployment can set both `INTUTIC_GATEWAY_TOKEN_STATE_FILE` and
//! `INTUTIC_GATEWAY_K8S_SECRET_NAME` (the Helm chart does, belt-and-suspenders
//! against a pod that also has `emptyDir` mounted); each write is
//! independent and a failure in one never blocks the other.
//!
//! Raw HTTPS + pod ServiceAccount token, no Kubernetes client crate — the
//! same minimal-client idiom `services/control-plane/src/lib/k8sClient.ts`
//! uses for cross-cluster cell provisioning (constructor injection for
//! tests, `from_env()`/pod-mount reads for production).
//!
//! @module

use base64::Engine as _;

const SA_TOKEN_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const SA_NAMESPACE_PATH: &str = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

/// Patches one key of one Secret with a new token value. Config is read
/// once at construction — a `heartbeat.rs` self-rotation cycle calling
/// `patch_token` does not re-read the pod's mounted files each time.
#[derive(Debug, Clone)]
pub struct K8sSecretWriter {
    base_url: String,
    token: String,
    /// PEM-encoded CA bundle. `None` only in tests (plain-HTTP fake server).
    ca_pem: Option<Vec<u8>>,
    namespace: String,
    secret_name: String,
    secret_key: String,
}

impl K8sSecretWriter {
    /// Constructor injection for tests — see module doc. Production callers
    /// use [`Self::from_env`].
    pub fn new(
        base_url: impl Into<String>,
        token: impl Into<String>,
        ca_pem: Option<Vec<u8>>,
        namespace: impl Into<String>,
        secret_name: impl Into<String>,
        secret_key: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.into(),
            ca_pem,
            namespace: namespace.into(),
            secret_name: secret_name.into(),
            secret_key: secret_key.into(),
        }
    }

    /// `None` means this mechanism stays off — `INTUTIC_GATEWAY_K8S_SECRET_NAME`
    /// unset (the common case: bare-metal, Docker, or a Kubernetes deployment
    /// that opted out via the chart's `proxy.selfRotationPatchesOwnSecret:
    /// false`), or the pod's ServiceAccount isn't mounted (env var set by
    /// mistake outside a cluster) — logged once at warn, never fatal: the
    /// state-file mechanism (if also configured) and in-memory rotation
    /// still work regardless.
    pub fn from_env() -> Option<Self> {
        let secret_name = std::env::var("INTUTIC_GATEWAY_K8S_SECRET_NAME")
            .ok()
            .filter(|v| !v.trim().is_empty())?;
        let secret_key = std::env::var("INTUTIC_GATEWAY_K8S_SECRET_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "INTUTIC_GATEWAY_TOKEN".to_string());

        let token = match std::fs::read_to_string(SA_TOKEN_PATH) {
            Ok(t) => t.trim().to_string(),
            Err(err) => {
                tracing::warn!(
                    %err,
                    "INTUTIC_GATEWAY_K8S_SECRET_NAME is set but the pod's ServiceAccount token \
                     is not mounted — self-rotation cannot patch the Secret. State-file \
                     persistence (if configured) is unaffected."
                );
                return None;
            }
        };
        let ca_pem = match std::fs::read(SA_CA_PATH) {
            Ok(c) => c,
            Err(err) => {
                tracing::warn!(%err, "Could not read the ServiceAccount CA — Secret self-rotation disabled");
                return None;
            }
        };
        let namespace = match std::fs::read_to_string(SA_NAMESPACE_PATH) {
            Ok(n) => n.trim().to_string(),
            Err(err) => {
                tracing::warn!(%err, "Could not read the pod's namespace — Secret self-rotation disabled");
                return None;
            }
        };

        // Standard in-cluster API server address, always injected by kubelet.
        let host = std::env::var("KUBERNETES_SERVICE_HOST")
            .unwrap_or_else(|_| "kubernetes.default.svc".to_string());
        let port = std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".to_string());

        Some(Self::new(
            format!("https://{host}:{port}"),
            token,
            Some(ca_pem),
            namespace,
            secret_name,
            secret_key,
        ))
    }

    fn build_client(&self) -> Result<reqwest::Client, reqwest::Error> {
        let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
        if let Some(ca) = &self.ca_pem {
            builder = builder.add_root_certificate(reqwest::Certificate::from_pem(ca)?);
        }
        builder.build()
    }

    /// PATCH the Secret's `data.<secret_key>` to `new_token` (base64-encoded,
    /// as the Secret API requires). A strategic-merge-patch touches only
    /// this one key — every other key in the Secret (e.g. `INTUTIC_GATEWAY_ID`)
    /// is left exactly as it was.
    pub async fn patch_token(&self, new_token: &str) -> Result<(), String> {
        let client = self.build_client().map_err(|e| e.to_string())?;
        let url = format!(
            "{}/api/v1/namespaces/{}/secrets/{}",
            self.base_url, self.namespace, self.secret_name
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(new_token.as_bytes());

        let mut data = serde_json::Map::new();
        data.insert(self.secret_key.clone(), serde_json::Value::String(encoded));
        let mut body = serde_json::Map::new();
        body.insert("data".to_string(), serde_json::Value::Object(data));

        let resp = client
            .patch(&url)
            .bearer_auth(&self.token)
            .header("Content-Type", "application/strategic-merge-patch+json")
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Kubernetes API returned {status}: {text}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // Both scenarios below mutate the same process-global env var, so —
    // same discipline as heartbeat.rs's
    // from_env_scenarios_run_sequentially_to_avoid_a_cross_test_race —
    // they're consolidated into one #[test] rather than split out, since
    // cargo runs tests in parallel threads by default.
    #[test]
    fn from_env_scenarios_run_sequentially_to_avoid_a_cross_test_race() {
        std::env::remove_var("INTUTIC_GATEWAY_K8S_SECRET_NAME");
        assert!(K8sSecretWriter::from_env().is_none());

        // Set the name but run outside a cluster (no /var/run/secrets mount
        // in any CI/dev environment) — must fail closed, not panic.
        std::env::set_var("INTUTIC_GATEWAY_K8S_SECRET_NAME", "gateway-token-test-only");
        assert!(K8sSecretWriter::from_env().is_none());
        std::env::remove_var("INTUTIC_GATEWAY_K8S_SECRET_NAME");
    }

    #[tokio::test]
    async fn patch_token_sends_the_expected_strategic_merge_patch() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/namespaces/gw-ns/secrets/gw-secret"))
            .and(header("authorization", "Bearer sa-token-123"))
            .and(header("content-type", "application/strategic-merge-patch+json"))
            .and(body_json(serde_json::json!({
                "data": { "INTUTIC_GATEWAY_TOKEN": base64::engine::general_purpose::STANDARD.encode("gwk_new_rotated_token") }
            })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let writer = K8sSecretWriter::new(
            server.uri(),
            "sa-token-123",
            None,
            "gw-ns",
            "gw-secret",
            "INTUTIC_GATEWAY_TOKEN",
        );
        writer.patch_token("gwk_new_rotated_token").await.expect("patch succeeds");
    }

    #[tokio::test]
    async fn patch_token_honors_a_custom_secret_key() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/api/v1/namespaces/gw-ns/secrets/gw-secret"))
            .and(body_json(serde_json::json!({
                "data": { "MY_TOKEN_KEY": base64::engine::general_purpose::STANDARD.encode("gwk_x") }
            })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let writer = K8sSecretWriter::new(server.uri(), "tok", None, "gw-ns", "gw-secret", "MY_TOKEN_KEY");
        writer.patch_token("gwk_x").await.expect("patch succeeds");
    }

    #[tokio::test]
    async fn patch_token_surfaces_a_non_2xx_response_as_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .respond_with(ResponseTemplate::new(403).set_body_string("Forbidden"))
            .mount(&server)
            .await;

        let writer = K8sSecretWriter::new(server.uri(), "tok", None, "gw-ns", "gw-secret", "INTUTIC_GATEWAY_TOKEN");
        let err = writer.patch_token("gwk_x").await.unwrap_err();
        assert!(err.contains("403"), "error should surface the status code: {err}");
    }
}
