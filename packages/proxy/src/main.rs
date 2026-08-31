//! Intutic Proxy Gateway
//!
//! Single entry point. Loads config, selects a storage backend (Valkey when
//! reachable, in-memory otherwise), initializes the WASM plugin chain, and
//! starts the axum HTTP server.
//!
//! Architecture: See docs/lld/02-proxy-gateway.lld.md

use intutic_proxy::{config, dlp, egress_policy, firewall, gateway, heartbeat, proxy, router, routing, sops, store, telemetry, wasm};

use std::net::SocketAddr;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Build an `EgressEnforceConfig` from `enforce` subcommand flags. Defaults the
/// proxy uid to the current user on unix — the common single-user case where
/// the same account runs `intutic start` and `intutic enforce apply`; override
/// with `--uid` when the proxy runs as a different account.
fn egress_enforce_config_from_flags(flags: &[String]) -> anyhow::Result<firewall::EgressEnforceConfig> {
    let mut cfg = firewall::EgressEnforceConfig::default();
    #[cfg(unix)]
    if cfg.proxy_uid.is_none() {
        cfg.proxy_uid = Some(unsafe { libc::getuid() });
    }
    let mut i = 0;
    while i < flags.len() {
        match flags[i].as_str() {
            "--port" => {
                i += 1;
                cfg.proxy_port = flags
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("--port needs a value"))?
                    .parse()?;
            }
            "--uid" => {
                i += 1;
                cfg.proxy_uid = Some(
                    flags
                        .get(i)
                        .ok_or_else(|| anyhow::anyhow!("--uid needs a value"))?
                        .parse()?,
                );
            }
            "--allow" => {
                i += 1;
                let v = flags
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("--allow needs a comma-separated value"))?;
                cfg.allow_cidrs.extend(
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from),
                );
            }
            "--no-dns" => cfg.allow_dns = false,
            "--no-uid" => cfg.proxy_uid = None,
            "--platform" => {
                i += 1;
                cfg.platform = match flags
                    .get(i)
                    .ok_or_else(|| anyhow::anyhow!("--platform needs linux|macos|windows"))?
                    .as_str()
                {
                    "linux" => firewall::Platform::Linux,
                    "macos" | "darwin" => firewall::Platform::MacOs,
                    "windows" => firewall::Platform::Windows,
                    other => anyhow::bail!("unknown platform '{other}'"),
                };
            }
            other => anyhow::bail!("unknown flag '{other}' for enforce"),
        }
        i += 1;
    }
    Ok(cfg)
}

/// `intutic-proxy enforce <generate|apply|remove|status>` — the L2 host
/// firewall (LLD #63 §5). `generate` prints the ruleset (no privilege);
/// `apply`/`remove` change the host firewall (privileged); `status` reports.
fn handle_enforce(args: &[String]) -> anyhow::Result<()> {
    let sub = args.first().map(String::as_str).unwrap_or("status");
    let cfg = egress_enforce_config_from_flags(args.get(1..).unwrap_or(&[]))?;
    match sub {
        "generate" => {
            print!("{}", firewall::generate_egress_enforcement(&cfg));
            Ok(())
        }
        "apply" => {
            let st = firewall::apply_egress_enforcement(&cfg)?;
            println!(
                "egress enforcement applied — backend={} active={} ({})",
                st.backend, st.active, st.detail
            );
            Ok(())
        }
        "remove" => {
            firewall::remove_egress_enforcement(cfg.platform)?;
            println!("egress enforcement removed");
            Ok(())
        }
        "status" => {
            let st = firewall::status_egress_enforcement(cfg.platform);
            println!(
                "{}",
                serde_json::json!({
                    "backend": st.backend,
                    "active": st.active,
                    "detail": st.detail,
                })
            );
            Ok(())
        }
        other => anyhow::bail!("unknown enforce subcommand '{other}' (generate|apply|remove|status)"),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Subcommand dispatch. `intutic-proxy enforce ...` manages the L2
    // default-deny egress firewall and exits, rather than starting the server.
    // Hand-rolled to avoid pulling clap into a binary that otherwise takes no
    // arguments.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("enforce") {
        return handle_enforce(argv.get(1..).unwrap_or(&[]));
    }

    // Read OTEL endpoint
    let otel_endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "intutic-proxy".to_string());

    // Register the W3C trace-context + baggage propagators as the global
    // default. Must run unconditionally (not just inside the
    // `OTEL_EXPORTER_OTLP_ENDPOINT` branch below) so header extraction in
    // `handle_proxy` and W3C `baggage`-based graph identity (see graph.rs)
    // work even when span export itself is off. See otel_propagation.rs for
    // why this exists.
    intutic_proxy::otel_propagation::install_default_propagator();

    // Initialize OpenTelemetry tracer.
    //
    // opentelemetry 0.32 removed the `new_pipeline()` builder chain in favour of
    // constructing the exporter and provider explicitly. The provider is kept
    // rather than discarded so shutdown can flush pending spans — the old
    // `global::shutdown_tracer_provider()` no longer exists.
    let (otel_layer, tracer_provider, meter_provider) = if std::env::var(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
    )
    .is_ok()
    {
        use opentelemetry::trace::TracerProvider;
        use opentelemetry_otlp::{MetricExporter, SpanExporter, WithExportConfig};
        use opentelemetry_sdk::metrics::SdkMeterProvider;
        use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
        use opentelemetry_sdk::Resource;

        let resource = Resource::builder()
            .with_service_name(service_name)
            .build();

        let exporter = SpanExporter::builder()
            .with_tonic()
            .with_endpoint(otel_endpoint.clone())
            .build()
            .expect("Failed to build OTLP span exporter");

        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_sampler(Sampler::AlwaysOn)
            .with_resource(resource.clone())
            .build();

        let tracer = provider.tracer("intutic-proxy");
        let layer = tracing_opentelemetry::layer().with_tracer(tracer);

        // Metrics: same endpoint, same gate, mirror of the tracer pattern
        // (TD-161). Push over OTLP — see metrics.rs for why there is no
        // /metrics pull endpoint. Installed as the global provider BEFORE any
        // instrument is first used: metrics.rs's LazyLock instruments bind
        // whichever provider is global at first deref, and the first deref is
        // either register_observables() below or a per-request record, both
        // after this line.
        let metric_exporter = MetricExporter::builder()
            .with_tonic()
            .with_endpoint(otel_endpoint.clone())
            .build()
            .expect("Failed to build OTLP metric exporter");

        let meters = SdkMeterProvider::builder()
            .with_periodic_exporter(metric_exporter)
            .with_resource(resource)
            .build();
        opentelemetry::global::set_meter_provider(meters.clone());

        (Some(layer), Some(provider), Some(meters))
    } else {
        (None, None, None)
    };

    // Bridge the egress atomics as observable counters. A no-op when no
    // meter provider was installed above.
    let _egress_observables = intutic_proxy::metrics::register_observables();

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

    // Minted here rather than on the first request, so the id is in the boot log
    // next to everything else about this process. Every trace published from now
    // on carries it as `proxy_instance_id`.
    tracing::info!(
        proxy_instance_id = proxy::proxy_instance_id(),
        "Proxy instance id minted for this process"
    );

    // Resolve the SOP set now, so an empty one is reported at boot rather than
    // silently at whichever request happens to arrive first.
    sops::report_at_startup();

    // Load configuration
    let config_path = std::env::var("CONFIG_PATH").unwrap_or_else(|_| "config.yaml".to_string());
    let config = config::load_config(&config_path)?;
    tracing::info!("Config loaded from {}", config_path);

    // Install the L1 egress policy (LLD #63 §4) before the first request. The
    // mode is logged at boot so an operator running in Enforce sees it in the
    // first lines of log, not after the first denied connection.
    //
    // The config/env policy is the base; a central policy the sync-daemon
    // distributed to `~/.intutic/hooks/egress-policy.json` is layered on top
    // (mode authoritative, allow-lists unioned) so an admin can manage
    // enforcement centrally. The file is re-read on a timer below, so a mid-
    // session policy change reaches this running proxy without a restart.
    let base_egress =
        egress_policy::EgressPolicy::from_config_and_env(&config.intutic_settings.egress);
    let egress_file = egress_policy::default_egress_policy_path();
    let expected_ws = std::env::var("INTUTIC_WORKSPACE_ID")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let initial_egress =
        match egress_policy::load_local_egress_file(&egress_file, expected_ws.as_deref()) {
            Some(central) => {
                tracing::info!(
                    ?central.mode,
                    count = central.allow.len(),
                    "Egress: central policy loaded from {}",
                    egress_file.display()
                );
                base_egress.with_central(central.mode, &central.allow)
            }
            None => base_egress.clone(),
        };
    let egress_mode = egress_policy::init_global_policy(initial_egress);

    // Hot-reload the central policy on a timer, so an admin flipping the
    // workspace to enforce/monitor reaches a running proxy this cycle. Absent or
    // invalid file → keep the current policy (fail toward the stricter side; a
    // stopped daemon must not relax enforcement).
    {
        let base = base_egress.clone();
        let path = egress_file.clone();
        let ws = expected_ws.clone();
        let reload_secs = std::env::var("INTUTIC_EGRESS_RELOAD_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&s| s > 0)
            .unwrap_or(30);
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(reload_secs));
            interval.tick().await; // the immediate first tick is the startup load above
            loop {
                interval.tick().await;
                if let Some(central) = egress_policy::load_local_egress_file(&path, ws.as_deref()) {
                    let merged = base.with_central(central.mode, &central.allow);
                    egress_policy::swap_global_policy(merged);
                }
            }
        });
    }

    match egress_mode {
        egress_policy::EgressMode::Off => tracing::info!(
            "Egress policy: OFF — every non-AI host is tunnelled (no egress control). \
             Set intutic_settings.egress.mode or INTUTIC_EGRESS_MODE to monitor/enforce."
        ),
        egress_policy::EgressMode::Monitor => tracing::info!(
            "Egress policy: MONITOR — nothing is denied; connections that would be denied \
             under enforce are logged as egress_would_deny. Visible at GET /intutic/egress."
        ),
        egress_policy::EgressMode::Enforce => tracing::warn!(
            "Egress policy: ENFORCE — non-AI hosts are denied unless on the allow policy. \
             Denials are logged and counted at GET /intutic/egress."
        ),
    }

    // Install the L2 hosted-gateway front door (LLD #64 §2, TD-334 increment 2)
    // before the first request. Off by default — a single-tenant local proxy or
    // an enterprise self-hosted deployment keeps today's behaviour (any bearer
    // token accepted, opportunistic credential capture for a developer's own
    // OAuth/API key). Logged at WARN when on, since it changes what a caller
    // can authenticate with.
    let gateway_cfg = gateway::GatewayConfig::from_config_and_env(&config.intutic_settings.gateway);
    let require_vk = gateway::init_gateway_config(gateway_cfg);
    if require_vk {
        tracing::warn!(
            "Gateway front door: REQUIRE_VK — only vk_ virtual keys are accepted; every other \
             bearer token is refused with 401 before workspace resolution or credential capture."
        );
    } else {
        tracing::info!(
            "Gateway front door: off — any bearer token is accepted (today's single-tenant \
             behaviour). Set intutic_settings.gateway.require_vk or \
             INTUTIC_GATEWAY_REQUIRE_VK=true for a shared multi-tenant gateway."
        );
    }
    if gateway::requires_provisioned_key() {
        tracing::warn!(
            "Gateway front door: REQUIRE_PROVISIONED_KEY (LLD #64 §4) — a workspace with no \
             deliberately provisioned upstream API key is refused with 402 rather than falling \
             back to this pod's shared provider key."
        );
    } else {
        tracing::info!(
            "Gateway front door: BYO-key enforcement off — an unprovisioned workspace rides the \
             shared provider key (today's behaviour). Set \
             intutic_settings.gateway.require_provisioned_key or \
             INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=true to require each workspace provision \
             its own key."
        );
    }

    // Install operator DLP patterns before anything can serve a request.
    //
    // Fail the boot on a bad pattern rather than starting a proxy whose
    // operator believes it is enforcing rules it silently dropped. A DLP
    // scanner that is quietly missing half its patterns is worse than one that
    // refuses to start, because nothing downstream can tell the difference.
    match dlp::install_custom_patterns(&config.intutic_settings.dlp.patterns) {
        Ok(0) => {}
        Ok(n) => tracing::info!(count = n, "DLP: operator patterns installed from config"),
        Err(e) => {
            tracing::error!(error = %e, "DLP: refusing to start");
            anyhow::bail!(e);
        }
    }

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

    // When falling back is allowed, the probe is bounded. `ConnectionManager`
    // retries with exponential backoff, which takes ~9s even on an immediate
    // connection-refused — silent dead air on first run for precisely the
    // no-Docker user this fallback exists for. Managed deployments keep the
    // full retry budget, since there the connection is required and worth
    // waiting for.
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

    let valkey = if standalone_forced {
        tracing::info!("INTUTIC_STANDALONE set — running standalone, not probing for Valkey.");
        None
    } else if !managed {
        match tokio::time::timeout(PROBE_TIMEOUT, telemetry::connect_valkey(&valkey_url)).await {
            Ok(Ok(v)) => {
                tracing::info!("Connected to Valkey at {}", valkey_url);
                Some(v)
            }
            Ok(Err(e)) => {
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
            Err(_) => {
                tracing::info!(
                    "Valkey at {} did not answer within {:?}. Running standalone; \
                     set VALKEY_URL if it lives elsewhere.",
                    valkey_url,
                    PROBE_TIMEOUT
                );
                None
            }
        }
    } else {
        match telemetry::connect_valkey(&valkey_url).await {
            Ok(v) => {
                tracing::info!("Connected to Valkey at {}", valkey_url);
                Some(v)
            }
            Err(e) => {
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

    // Mirroring issues a SECOND, fully billed upstream call per sampled
    // request. Standalone has no control plane to publish the comparison
    // to — `NullControlPlaneCache::publish_mirror_pair` only `debug!`s the
    // result — so a workspace could be paying for mirrored calls whose
    // outcome is visible only at debug log level. `valkey.is_none()`, not a
    // separately-tracked bool: it is exactly the condition the match above
    // branches on.
    if valkey.is_none() && routing::mirror::mirroring_is_configured(&config.intutic_settings.routing) {
        tracing::warn!(
            mirror_sample_rate = config.intutic_settings.routing.mirror_sample_rate,
            "Running standalone with mirroring configured — mirrored requests are billed \
             (a second live upstream call per sampled request) but their comparison result \
             is discarded, not published anywhere. Set mirror_sample_rate to 0 to stop paying \
             for it, or connect a control plane to see the results."
        );
    }

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

    // Sampled `context_snapshot` capture rate for the replay corpus. Default
    // 5%: enough to reach `MIN_REPLAY_CONTEXTS` (50) within a day of modest
    // traffic without writing a full RequestContext onto every trace.
    let context_snapshot_rate = std::env::var("WASM_CONTEXT_SNAPSHOT_RATE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|r| (0.0..=1.0).contains(r))
        .unwrap_or(0.05);

    // Build application state
    let state = proxy::AppState {
        config,
        wasm_registry,
        http_client,
        reward_engine: std::sync::Arc::new(routing::reward::RewardEngine::new()),
        store,
        control_plane,
        context_snapshot_rate,
    };

    // Self-hosted gateway heartbeat (LLD #66, gateway phase 4) — opt-in via
    // INTUTIC_GATEWAY_TOKEN/INTUTIC_GATEWAY_ID, both set together when the
    // dashboard's gateway registration flow provisions this deployment.
    // Absent (the default: SaaS gateway, single-tenant local proxy, or a
    // self-hosted deployment that hasn't opted in), this is a no-op — no
    // background task, no outbound calls, unchanged from today.
    match heartbeat::HeartbeatConfig::from_env() {
        Some(hb_cfg) => {
            tracing::info!(
                gateway_id = %hb_cfg.gateway_id,
                interval_secs = hb_cfg.interval.as_secs(),
                "Self-hosted gateway heartbeat: ENABLED — reporting to {}",
                hb_cfg.control_plane_url,
            );
            heartbeat::spawn_heartbeat_loop(state.http_client.clone(), hb_cfg);
        }
        None => {
            tracing::info!(
                "Self-hosted gateway heartbeat: off (INTUTIC_GATEWAY_TOKEN/INTUTIC_GATEWAY_ID \
                 not set — this proxy is not reporting to a control plane as a registered \
                 self-hosted gateway)."
            );
        }
    }

    // Ensure local CA exists for TLS MITM (generates ca.crt/ca.key if missing)
    let _ = intutic_proxy::ca_manager::ensure_ca_exists().await;

    // ── Guard-liveness probes: at startup, then every 15 minutes ──
    //
    // The suite is in-process and upstream-free (see probes.rs), so the cost
    // is microseconds. Startup is the run that matters most: a deployment
    // whose guards do not fire should say so in its first seconds of log,
    // not after its first incident. Failures log at ERROR — the operator's
    // log stream is a surface that provably reaches someone — and the same
    // verdicts are queryable at GET /intutic/probes.
    tokio::spawn(async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(900));
        loop {
            interval.tick().await;
            let registry = intutic_proxy::plugins::anomaly::DetectorRegistry::with_defaults();
            let sops = intutic_proxy::sops::loaded_sops();
            let verdicts = intutic_proxy::probes::run_guard_probes(&registry, &sops);
            let failed: Vec<_> = verdicts.iter().filter(|v| !v.passed).collect();
            if failed.is_empty() {
                tracing::info!(
                    probes = verdicts.len(),
                    "guard-liveness probes passed — every declared guard fired on its canary"
                );
            } else {
                for v in &failed {
                    tracing::error!(
                        probe = %v.probe_id,
                        guard = %v.guard,
                        detail = %v.detail,
                        "GUARD-LIVENESS PROBE FAILED — a declared control did not behave; \
                         treat as an enforcement outage"
                    );
                }
            }
        }
    });

    // Build router
    let app = router::build_router(state);

    // Start server
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "4000".to_string())
        .parse()?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    // `into_make_service_with_connect_info` rather than the plain
    // `into_make_service()`/bare-`app` form: `/intutic/spend` needs the real
    // peer address (via `ConnectInfo<SocketAddr>`) to enforce its
    // loopback-only guard, since this listener binds `0.0.0.0` and would
    // otherwise leak daily spend to anyone on the local network.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    // Shutdown OpenTelemetry, flushing any spans still in the batch queue.
    if let Some(provider) = tracer_provider {
        if let Err(err) = provider.shutdown() {
            tracing::warn!("OpenTelemetry shutdown failed: {err}");
        }
    }
    // Same for metrics — flushes the periodic reader's last collection.
    if let Some(provider) = meter_provider {
        if let Err(err) = provider.shutdown() {
            tracing::warn!("OpenTelemetry metrics shutdown failed: {err}");
        }
    }

    Ok(())
}
