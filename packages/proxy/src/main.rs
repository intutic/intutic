//! Intutic Proxy Gateway
//!
//! Single entry point. Loads config, initializes WASM plugin chain,
//! connects to Valkey, and starts the axum HTTP server.
//!
//! Architecture: See docs/lld/02-proxy-gateway.lld.md

use intutic_proxy::{config, proxy, router, routing, telemetry, wasm};

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

    // Connect to Valkey
    let valkey_url =
        std::env::var("VALKEY_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    // Valkey is currently required — the WASM registry, telemetry, metering,
    // semantic cache and bandit router all hold a connection. Surface that as
    // something actionable: the bare `Connection refused (os error 111)` this
    // used to emit gave no clue what was being connected to or how to fix it,
    // which is where the documented install left users stranded (issue #1).
    let valkey = match telemetry::connect_valkey(&valkey_url).await {
        Ok(v) => v,
        Err(e) => {
            return Err(anyhow::anyhow!(
                "Could not connect to Valkey at {valkey_url}: {e}\n\n\
                 The proxy needs Valkey for its policy cache and telemetry. Start one with:\n\n  \
                 docker run -d --name intutic-valkey -p 6379:6379 valkey/valkey:8-alpine\n\n\
                 Then re-run the proxy. Point elsewhere with VALKEY_URL=redis://host:port."
            ));
        }
    };
    tracing::info!("Connected to Valkey at {}", valkey_url);

    // Initialize WASM plugin registry (Valkey + local ~/.intutic/wasm rules)
    let wasm_registry = wasm::registry::PluginRegistry::new(
        &valkey,
        config.intutic_settings.wasm_local_dir.as_deref(),
    )
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
        valkey,
        wasm_registry,
        http_client,
        reward_engine: std::sync::Arc::new(routing::reward::RewardEngine::new()),
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
