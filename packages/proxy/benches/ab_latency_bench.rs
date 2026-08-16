//! Paired A/B: what the proxy actually *adds* to a request.
//!
//! Run:
//!   cd packages/proxy && cargo bench --bench ab_latency_bench
//!
//! # Why this exists, and why nothing else in `benches/` answers it
//!
//! Every other benchmark here measures in-process function time on an idle box.
//! That is not added latency, and the gap between the two is the product:
//! connection reuse, TLS, streaming, queueing under load. `policy_e2e_bench`
//! claims to measure "the REAL proxy overhead" and does not — it never calls the
//! proxy at all (see its own header).
//!
//! This one boots the **real router** on a **real socket** and sends the same
//! payloads twice: once straight to a stub upstream, once through the proxy to
//! the same stub. The reported number is the **delta distribution**, because
//! that is the only quantity a reader can act on.
//!
//! # Deliberately not criterion
//!
//! Criterion reports mean ± σ and cannot express percentiles or concurrency.
//! The tail is exactly what a latency claim hides, so this is a plain binary
//! (`harness = false`) that keeps every sample and reports p50/p95/p99.
//!
//! # It refuses rather than degrades
//!
//! If the stub or the proxy will not bind, this exits non-zero with the reason.
//! `policy_e2e_bench` gets that instinct right — it panics when Valkey is absent
//! rather than quietly measuring an in-memory substitute — and it is the whole
//! difference between a benchmark and a number.
//!
//! # WHAT THIS MEASURES, EXACTLY
//!
//! The **standalone** path: `MemoryStore` + no control plane. A
//! control-plane-backed deployment additionally makes HTTP round trips on the
//! request path (policy check, pre-processor, cost gate) that this harness does
//! **not** measure, and a Valkey-backed store replaces in-memory map lookups
//! with network calls. So this is a **floor** on added latency, not the whole of
//! it, and the report says so in its own output rather than leaving it to a doc
//! page nobody opens.
//!
//! HTTP 200 is not accepted as proof the chain ran: the proxy answers some
//! requests itself without contacting any upstream. The stub counts hits, and a
//! mismatch aborts the run.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Requests per arm. Large enough for a stable p99, small enough to finish.
const SAMPLES: usize = 400;
/// Discarded before measuring, so connection setup and lazily-built state do not
/// land in the distribution.
const WARMUP: usize = 40;

#[derive(Clone, Copy)]
struct Body {
    label: &'static str,
    kb: usize,
}

/// Body sizes an agent turn actually reaches. 1 KB is a bare question; 32 KB is
/// a pasted file or a long history, and it is where the DLP scanner's cost used
/// to become the dominant term.
const BODIES: &[Body] = &[
    Body { label: "1kb", kb: 1 },
    Body { label: "8kb", kb: 8 },
    Body { label: "32kb", kb: 32 },
];

fn make_body(kb: usize) -> String {
    let target = kb * 1024;
    let mut content = String::with_capacity(target + 256);
    let mut i = 0usize;
    while content.len() < target {
        content.push_str(&format!(
            "Line {i}: implement a robust error handling mechanism for the \
             distributed system that gracefully handles network partitions.\n"
        ));
        i += 1;
    }
    serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 64,
        "messages": [{"role": "user", "content": content}],
    })
    .to_string()
}

fn pct(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn us(d: Duration) -> f64 {
    d.as_secs_f64() * 1e6
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let hits = Arc::new(AtomicUsize::new(0));

    // ── Stub upstream ───────────────────────────────────────────────────────
    //
    // A local stub rather than a real provider: a provider costs money, adds
    // network variance far larger than the quantity being measured, and would
    // make the run non-reproducible. Isolating our own overhead is the point.
    // The trade is stated in the report: real upstreams stream, and a stub that
    // answers instantly makes the proxy's share of wall-clock look larger than
    // it is against a slow model.
    let stub_hits = Arc::clone(&hits);
    let stub = axum::Router::new().fallback(axum::routing::any(move || {
        let hits = Arc::clone(&stub_hits);
        async move {
            hits.fetch_add(1, Ordering::Relaxed);
            axum::Json(serde_json::json!({
                "id": "msg_stub",
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-4-20250514",
                "content": [{"type": "text", "text": "ok"}],
                "usage": {"input_tokens": 10, "output_tokens": 2},
            }))
        }
    }));
    let stub_listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FATAL: could not bind the stub upstream: {e}");
            std::process::exit(1);
        }
    };
    let stub_addr = stub_listener.local_addr().expect("stub addr");
    tokio::spawn(async move {
        let _ = axum::serve(stub_listener, stub).await;
    });

    // Point the proxy at the stub. `Provider::upstream_base_url` reads this at
    // call time precisely so it can be redirected.
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", format!("http://{stub_addr}"));

    // ── The real proxy ──────────────────────────────────────────────────────
    // Defaults via a nonexistent path rather than a hand-built struct: this is
    // the same code path the binary takes when there is no config.yaml, so the
    // harness measures the shipped defaults and not a struct literal that has
    // drifted from them.
    let config = intutic_proxy::config::load_config("/nonexistent-so-defaults-apply.yaml")
        .expect("load_config must return defaults for a missing file");
    let wasm_registry = match intutic_proxy::wasm::registry::PluginRegistry::new(None).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FATAL: could not build the WASM registry: {e}");
            std::process::exit(1);
        }
    };
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry,
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
        context_snapshot_rate: 0.0,
    };
    let proxy_listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FATAL: could not bind the proxy: {e}");
            std::process::exit(1);
        }
    };
    let proxy_addr = proxy_listener.local_addr().expect("proxy addr");
    let app = intutic_proxy::router::build_router(state);
    tokio::spawn(async move {
        let _ = axum::serve(proxy_listener, app).await;
    });

    tokio::time::sleep(Duration::from_millis(150)).await;

    // One client, reused across both arms, so connection pooling is identical.
    // A fresh client per arm would measure TCP setup in one and not the other.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("client");

    println!("Intutic proxy — paired A/B added latency");
    println!("========================================\n");
    println!("stub upstream : http://{stub_addr}");
    println!("proxy         : http://{proxy_addr}");
    println!("samples       : {SAMPLES} per arm ({WARMUP} discarded as warm-up)");
    println!("concurrency   : 1 (sequential — the tail here is the proxy's, not a queue's)");
    println!("store         : MemoryStore (standalone); control plane: none\n");

    let mut any_measured = false;

    for body in BODIES {
        let payload = make_body(body.kb);
        let direct_url = format!("http://{stub_addr}/v1/messages");
        let proxy_url = format!("http://{proxy_addr}/v1/messages");

        let mut direct = Vec::with_capacity(SAMPLES);
        let mut through = Vec::with_capacity(SAMPLES);

        let before = hits.load(Ordering::Relaxed);

        for i in 0..(SAMPLES + WARMUP) {
            // Direct arm.
            let t = Instant::now();
            let r = client
                .post(&direct_url)
                .header("content-type", "application/json")
                .body(payload.clone())
                .send()
                .await;
            let d = t.elapsed();
            match r {
                Ok(resp) => {
                    let _ = resp.bytes().await;
                }
                Err(e) => {
                    eprintln!("FATAL: direct arm failed at sample {i}: {e}");
                    std::process::exit(1);
                }
            }
            if i >= WARMUP {
                direct.push(d);
            }

            // Proxy arm — same payload, same client, one extra hop.
            let t = Instant::now();
            let r = client
                .post(&proxy_url)
                .header("content-type", "application/json")
                .header("authorization", "Bearer sk-ab-harness")
                .header("x-intutic-workspace-id", "ws_ab")
                .body(payload.clone())
                .send()
                .await;
            let d = t.elapsed();
            match r {
                Ok(resp) => {
                    let status = resp.status();
                    let _ = resp.bytes().await;
                    if !status.is_success() {
                        eprintln!(
                            "FATAL: proxy arm returned {status} at sample {i}. The harness \
                             measures the full chain or it measures nothing."
                        );
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("FATAL: proxy arm failed at sample {i}: {e}");
                    std::process::exit(1);
                }
            }
            if i >= WARMUP {
                through.push(d);
            }
        }

        // Did the request actually reach the upstream?
        //
        // HTTP 200 does not prove it: the proxy answers some requests itself
        // without contacting any upstream, and a run that measured those would
        // report a flatteringly small delta for the wrong reason.
        let observed = hits.load(Ordering::Relaxed) - before;
        let expected = (SAMPLES + WARMUP) * 2;
        if observed != expected {
            eprintln!(
                "FATAL: stub saw {observed} requests, expected {expected}. The proxy answered \
                 some requests itself, so this run does not measure a proxied request."
            );
            std::process::exit(1);
        }

        direct.sort();
        through.sort();
        any_measured = true;

        println!("── body {} ──────────────────────────────────", body.label);
        println!(
            "  {:<10} {:>12} {:>12} {:>12}",
            "", "p50 (µs)", "p95 (µs)", "p99 (µs)"
        );
        for (label, v) in [("direct", &direct), ("proxied", &through)] {
            println!(
                "  {label:<10} {:>12.1} {:>12.1} {:>12.1}",
                us(pct(v, 0.50)),
                us(pct(v, 0.95)),
                us(pct(v, 0.99))
            );
        }
        println!(
            "  {:<10} {:>12.1} {:>12.1} {:>12.1}   <-- what the proxy adds",
            "DELTA",
            us(pct(&through, 0.50)) - us(pct(&direct, 0.50)),
            us(pct(&through, 0.95)) - us(pct(&direct, 0.95)),
            us(pct(&through, 0.99)) - us(pct(&direct, 0.99)),
        );
        println!();
    }

    if !any_measured {
        eprintln!("FATAL: no body size produced a measurement.");
        std::process::exit(1);
    }

    println!("WHAT THIS NUMBER DOES NOT LICENSE");
    println!("  * It is the STANDALONE path: MemoryStore, no control plane. A");
    println!("    control-plane deployment adds HTTP round trips on the request");
    println!("    path that this does not measure, and Valkey replaces in-memory");
    println!("    map lookups with network calls. This is a FLOOR.");
    println!("  * The upstream is a local stub answering instantly. A real model");
    println!("    takes seconds and streams, so the proxy's share of wall-clock");
    println!("    is far smaller in practice than these figures suggest.");
    println!("  * Concurrency is 1. Nothing here says how the proxy behaves under");
    println!("    load, which is where queueing appears.");
    println!("  * One machine, one run. Record the hardware beside any figure");
    println!("    quoted from it, or it is not a figure.");
}
