//! Intutic Proxy Gateway
//!
//! Single entry point. Loads config, selects a storage backend (Valkey when
//! reachable, in-memory otherwise), initializes the WASM plugin chain, and
//! starts the axum HTTP server.
//!
//! Architecture: See docs/lld/02-proxy-gateway.lld.md

use intutic_proxy::{config, proxy, router, routing, store, telemetry, wasm};

use std::net::SocketAddr;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Read OTEL endpoint
    let otel_endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "intutic-proxy".to_string());

    // Initialize OpenTelemetry tracer.
    //
    // opentelemetry 0.32 removed the `new_pipeline()` builder chain in favour of
    // constructing the exporter and provider explicitly. The provider is kept
    // rather than discarded so shutdown can flush pending spans — the old
    // `global::shutdown_tracer_provider()` no longer exists.
    let (otel_layer, tracer_provider) = if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok() {
        use opentelemetry::trace::TracerProvider;
        use opentelemetry_otlp::{SpanExporter, WithExportConfig};
        use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
        use opentelemetry_sdk::Resource;

        let exporter = SpanExporter::builder()
            .with_tonic()
            .with_endpoint(otel_endpoint.clone())
            .build()
            .expect("Failed to build OTLP span exporter");

        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_sampler(Sampler::AlwaysOn)
            .with_resource(Resource::builder().with_service_name(service_name).build())
            .build();

        let tracer = provider.tracer("intutic-proxy");
        let layer = tracing_opentelemetry::layer().with_tracer(tracer);
        (Some(layer), Some(provider))
    } else {
        (None, None)
    };

    // Initialize tracing registry
    let registry = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "intutic_proxy=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer());

    if let Some(otel_layer) = otel_layer {
        registry.with(otel_layer).init();
        tracing::info!(
            "OpenTelemetry tracing initialized targeting {}",
            otel_endpoint
        );
    } else {
        registry.init();
        tracing::info!("Stdout-only tracing initialized");
    }

    tracing::info!("Intutic Proxy Gateway starting...");

    // Load configuration
    let config_path = std::env::var("CONFIG_PATH").unwrap_or_else(|_| "config.yaml".to_string());
    let config = config::load_config(&config_path)?;
    tracing::info!("Config loaded from {}", config_path);

    // ── Storage backend ───────────────────────────────────────────────
    //
    // Valkey is not required. Falling back to standalone is deliberately
    // permissive so that open-core users hit zero friction — that failure was
    // exactly what left the documented install unable to reach a running proxy
    // (issue #1).
    //
    // Permissive everywhere except one case, which is a security boundary
    // rather than a preference. Standalone means `NullControlPlaneCache`, and
    // that reports every virtual key as `Unmanaged` — correct when no control
    // plane exists, an authentication bypass when one does but is merely
    // unreachable. So the rule is intent-based:
    //
    //   * `CONTROL_PLANE_URL` set → this deployment is managed. Valkey holds the
    //     auth and budget cache it depends on, so an unreachable Valkey is a
    //     hard error. Never silently degrade a managed deployment into an
    //     unauthenticated one.
    //   * otherwise → standalone on any failure, with a log line saying what is
    //     inactive.
    //
    // `INTUTIC_STANDALONE=1` forces standalone regardless, so a stray Valkey on
    // the default port cannot silently opt a deployment back in.
    let standalone_forced = std::env::var("INTUTIC_STANDALONE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let managed = std::env::var("CONTROL_PLANE_URL")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let valkey_url =
        std::env::var("VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

    if standalone_forced && managed {
        return Err(anyhow::anyhow!(
            "INTUTIC_STANDALONE and CONTROL_PLANE_URL are both set, which ask for \
             opposite things: standalone has no control plane. Unset one."
        ));
    }

    let valkey = if standalone_forced {
        tracing::info!("INTUTIC_STANDALONE set — running standalone, not probing for Valkey.");
        None
    } else {
        match telemetry::connect_valkey(&valkey_url).await {
            Ok(v) => {
                tracing::info!("Connected to Valkey at {}", valkey_url);
                Some(v)
            }
            Err(e) if managed => {
                return Err(anyhow::anyhow!(
                    "Could not connect to Valkey at {valkey_url}: {e}\n\n\
                     CONTROL_PLANE_URL is set, so this proxy is control-plane managed and \
                     Valkey holds the auth and budget cache it depends on. Running without \
                     it would leave requests unauthenticated, so this is fatal rather than \
                     a fallback.\n\n  \
                     docker run -d --name intutic-valkey -p 6379:6379 valkey/valkey:8-alpine\n\n\
                     Point elsewhere with VALKEY_URL=redis://host:port."
                ));
            }
            Err(e) => {
                tracing::info!(
                    "No Valkey at {} ({}). Running standalone — bandit learning persists to \
                     ~/.intutic, the response cache is in-memory, and control-plane features \
                     (auth, budgets, WASM rule distribution, auto-judge) are inactive. \
                     Connect a control plane with CONTROL_PLANE_URL to enable them.",
                    valkey_url,
                    e
                );
                None
            }
        }
    };

    let (store, control_plane): (
        std::sync::Arc<dyn store::LocalStore>,
        std::sync::Arc<dyn store::ControlPlaneCache>,
    ) = match &valkey {
        Some(conn) => {
            let store: std::sync::Arc<dyn store::LocalStore> =
                std::sync::Arc::new(store::ValkeyStore::new(conn.clone()));
            // Upgrading from standalone must not reset the workspace to cold
            // start. Seeds only arms Valkey does not already have, so this is a
            // no-op on every boot after the first.
            match store::migrate_local_learning(&store, &store::local_snapshot_path()).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(
                    "carried {} bandit arm(s) over from standalone learning",
                    n
                ),
                Err(e) => tracing::warn!("could not carry over standalone learning: {}", e),
            }
            (
                store,
                std::sync::Arc::new(store::ValkeyControlPlaneCache::new(conn.clone())),
            )
        }
        // Standalone learns across restarts; losing every arm on each boot
        // would mean the `>= 20 pulls` gate never opens for a per-session CLI
        // proxy, and intelligent routing would never activate.
        None => (
            std::sync::Arc::new(store::MemoryStore::durable()),
            std::sync::Arc::new(store::NullControlPlaneCache),
        ),
    };

    // Initialize WASM plugin registry (control plane + local ~/.intutic/wasm rules)
    let wasm_registry =
        wasm::registry::PluginRegistry::new(config.intutic_settings.wasm_local_dir.as_deref())
            .await?;
    tracing::info!(
        "WASM plugin registry initialized ({} plugins)",
        wasm_registry.plugin_count().await
    );

    // Build HTTP client for upstream LLM forwarding (shared, connection-pooled)
    let http_client = std::sync::Arc::new(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("Failed to build reqwest client"),
    );

    // Build application state
    let state = proxy::AppState {
        config,
        wasm_registry,
        http_client,
        reward_engine: std::sync::Arc::new(routing::reward::RewardEngine::new()),
        store,
        control_plane,
    };

    // Ensure local CA exists for TLS MITM (generates ca.crt/ca.key if missing)
    let _ = intutic_proxy::ca_manager::ensure_ca_exists().await;

    // Build router
    let app = router::build_router(state);

    // Start server
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "4000".to_string())
        .parse()?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    // Shutdown OpenTelemetry, flushing any spans still in the batch queue.
    if let Some(provider) = tracer_provider {
        if let Err(err) = provider.shutdown() {
            tracing::warn!("OpenTelemetry shutdown failed: {err}");
        }
    }

    Ok(())
}
