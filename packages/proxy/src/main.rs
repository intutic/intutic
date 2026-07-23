//! Intutic Proxy Gateway
//!
//! Single entry point. Loads config, initializes WASM plugin chain,
//! connects to Valkey, and starts the axum HTTP server.
//!
//! Architecture: See docs/lld/02-proxy-gateway.lld.md

use intutic_proxy::{config, proxy, router, telemetry, wasm};

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

    // Initialize OpenTelemetry tracer
    let (otel_layer, _uninstall) = if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok() {
        use opentelemetry::KeyValue;
        use opentelemetry_otlp::WithExportConfig;
        use opentelemetry_sdk::trace::{self, Sampler};

        use opentelemetry::trace::TracerProvider;

        let tracer_provider = opentelemetry_otlp::new_pipeline()
            .tracing()
            .with_exporter(
                opentelemetry_otlp::new_exporter()
                    .tonic()
                    .with_endpoint(otel_endpoint.clone()),
            )
            .with_trace_config(
                trace::config()
                    .with_sampler(Sampler::AlwaysOn)
                    .with_resource(opentelemetry_sdk::Resource::new(vec![KeyValue::new(
                        "service.name",
                        service_name,
                    )])),
            )
            .install_batch(opentelemetry_sdk::runtime::Tokio)
            .expect("Failed to initialize OpenTelemetry tracer");

        let tracer = tracer_provider.tracer("intutic-proxy");
        let layer = tracing_opentelemetry::layer().with_tracer(tracer);
        (Some(layer), Some(()))
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
    let valkey = telemetry::connect_valkey(&valkey_url).await?;
    tracing::info!("Connected to Valkey at {}", valkey_url);

    // Initialize WASM plugin registry
    let wasm_registry = wasm::registry::PluginRegistry::new(&valkey).await?;
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

    // Shutdown OpenTelemetry
    if _uninstall.is_some() {
        opentelemetry::global::shutdown_tracer_provider();
    }

    Ok(())
}
