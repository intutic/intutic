//! OTel metrics — the proxy's exported instrument set (TD-161).
//!
//! Every instrument this crate exports is declared here, next to the test
//! that pins its Prometheus exposition name, because the Grafana dashboard
//! (`docs/monitoring/snip_compactor_v2_dashboard.json`, enterprise repo)
//! queries those names literally and `check-dashboard-metrics.js` gates the
//! dashboard's `implemented: true` flag on each name appearing in this
//! crate's source. Renaming an instrument without updating the dashboard is
//! exactly the drift that gate exists to catch — keep them in one file.
//!
//! Export is OTLP push over the same endpoint and env gate as traces
//! (`OTEL_EXPORTER_OTLP_ENDPOINT`, see `main.rs`). There is deliberately no
//! `/metrics` pull endpoint: `opentelemetry-prometheus` lags the pinned 0.32
//! crate set (see Cargo.toml's advisory note) and adding it would drag the
//! set backward.
//!
//! Instruments carry **no `unit()`** — the collector's Prometheus
//! translation appends unit suffixes to exposition names, which would break
//! the literal-name contract the dashboard depends on. Names already encode
//! their units (`_bytes`, `_ratio` semantics).
//!
//! Labels are low-cardinality by policy: `input_type`/`strategy` for snip,
//! `source`/`action` for refusals. Never `workspace_id`, `session_id`, or
//! `detector_id` — per-workspace accounting is the control plane's job, and
//! unbounded label values are how a metrics pipeline becomes the outage.
//!
//! Deliberately NOT exported: the semantic-cache and reask counters (already
//! persisted per-workspace in Valkey — a different consumer with a different
//! story), and any per-detector breakdown of findings (the trace carries the
//! full detail; the metric answers "how often does policy refuse", not "why").
//!
//! Instruments are `LazyLock`s over `global::meter(..)`. A meter obtained
//! before `set_meter_provider` would bind the no-op provider forever, so the
//! first deref must happen after `main.rs` installs the provider — which the
//! call order guarantees: `register_observables()` runs right after install,
//! and the recording fns only run per-request. Without an endpoint configured
//! nothing installs a provider and every record is a no-op costing an atomic
//! load — OSS users who never configure a collector pay effectively nothing.

use opentelemetry::metrics::{Counter, Histogram, Meter, ObservableCounter};
use opentelemetry::KeyValue;
use std::sync::LazyLock;

/// Instrument names — the source of truth the dashboard test pins.
pub const SNIP_COMPRESSION_RATIO: &str = "snip_compression_ratio";
pub const SNIP_INPUT_BYTES: &str = "snip_input_bytes";
pub const SNIP_OUTPUT_BYTES: &str = "snip_output_bytes";
pub const SNIP_COMPACTED: &str = "snip_compacted";
pub const EGRESS_DENIED: &str = "egress_denied";
pub const EGRESS_WOULD_DENY: &str = "egress_would_deny";
pub const POLICY_REFUSALS: &str = "policy_refusals";

fn meter() -> Meter {
    opentelemetry::global::meter("intutic-proxy")
}

/// Compression ratio is bounded 0..1 by construction (`snip.rs` clamps at 0);
/// 0.05-wide buckets give the dashboard's p50/p90/p99 quantiles 20 rungs.
static COMPRESSION_RATIO_HIST: LazyLock<Histogram<f64>> = LazyLock::new(|| {
    meter()
        .f64_histogram(SNIP_COMPRESSION_RATIO)
        .with_boundaries((1..20).map(|i| i as f64 * 0.05).collect())
        .build()
});

/// Byte-size boundaries: powers of four from 256B to 1MiB. Snip inputs are
/// tool results and code files — spread across orders of magnitude, so
/// exponential buckets, not linear.
fn byte_boundaries() -> Vec<f64> {
    vec![256.0, 1024.0, 4096.0, 16384.0, 65536.0, 262144.0, 1048576.0]
}

static INPUT_BYTES_HIST: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    meter()
        .u64_histogram(SNIP_INPUT_BYTES)
        .with_boundaries(byte_boundaries())
        .build()
});

static OUTPUT_BYTES_HIST: LazyLock<Histogram<u64>> = LazyLock::new(|| {
    meter()
        .u64_histogram(SNIP_OUTPUT_BYTES)
        .with_boundaries(byte_boundaries())
        .build()
});

static COMPACTED_COUNTER: LazyLock<Counter<u64>> =
    LazyLock::new(|| meter().u64_counter(SNIP_COMPACTED).build());

static REFUSALS_COUNTER: LazyLock<Counter<u64>> =
    LazyLock::new(|| meter().u64_counter(POLICY_REFUSALS).build());

/// One compaction event: histograms + count, all labelled the same way.
/// Called beside (never instead of) the `snip.compacted` tracing line —
/// `check-cache-telemetry.sh` still reads the log fields.
pub fn record_snip_compaction(
    input_type: &'static str,
    strategy: &'static str,
    input_bytes: usize,
    output_bytes: usize,
    ratio: f64,
) {
    let labels = [
        KeyValue::new("input_type", input_type),
        KeyValue::new("strategy", strategy),
    ];
    COMPRESSION_RATIO_HIST.record(ratio, &labels);
    INPUT_BYTES_HIST.record(input_bytes as u64, &labels);
    OUTPUT_BYTES_HIST.record(output_bytes as u64, &labels);
    COMPACTED_COUNTER.add(1, &labels);
}

/// One policy refusal that reached the client as a 4xx.
/// `source` ∈ {"anomaly", "wasm", "model_allowlist"}; `action` ∈ {"kill",
/// "ask", "reask", "reask_exhausted"} — the six refusal sites in `proxy.rs`
/// were previously log-only, which made "how often does governance actually
/// refuse" a log-grep question instead of a graph.
pub fn record_policy_refusal(source: &'static str, action: &'static str) {
    REFUSALS_COUNTER.add(
        1,
        &[
            KeyValue::new("source", source),
            KeyValue::new("action", action),
        ],
    );
}

/// Bridges the egress atomics (`egress_policy.rs`) as observable counters.
/// The recording sites stay untouched — the callback reads the process-
/// lifetime cumulative values, which is exactly the observable-counter
/// contract, so there is no double count and no second write path.
///
/// Called once from `main.rs` immediately after the meter provider is
/// installed (a safe no-op when no endpoint is configured). The returned
/// instruments are intentionally leaked into statics' lifetime by the SDK's
/// own registration — dropping the handles does not unregister callbacks.
pub fn register_observables() -> (ObservableCounter<u64>, ObservableCounter<u64>) {
    let denied = meter()
        .u64_observable_counter(EGRESS_DENIED)
        .with_callback(|observer| {
            observer.observe(crate::egress_policy::denied_count(), &[]);
        })
        .build();
    let would_deny = meter()
        .u64_observable_counter(EGRESS_WOULD_DENY)
        .with_callback(|observer| {
            observer.observe(crate::egress_policy::would_deny_count(), &[]);
        })
        .build();
    (denied, would_deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the instrument-name → Prometheus-exposition contract the
    /// dashboard's PromQL depends on. The collector's Prometheus exporter
    /// renders a histogram `name` as `name_bucket`/`name_sum`/`name_count`
    /// and a monotonic counter as `name_total`; the dashboard queries those
    /// derived series literally. This test is what makes
    /// `check-dashboard-metrics.js`'s literal-substring gate honest: if
    /// anyone renames an instrument, this fails before the dashboard lies.
    #[test]
    fn dashboard_series_names_match_instruments() {
        assert_eq!(format!("{SNIP_COMPRESSION_RATIO}_bucket"), "snip_compression_ratio_bucket");
        assert_eq!(format!("{SNIP_COMPRESSION_RATIO}_sum"), "snip_compression_ratio_sum");
        assert_eq!(format!("{SNIP_INPUT_BYTES}_sum"), "snip_input_bytes_sum");
        assert_eq!(format!("{SNIP_OUTPUT_BYTES}_sum"), "snip_output_bytes_sum");
        assert_eq!(format!("{SNIP_COMPACTED}_total"), "snip_compacted_total");
    }

    /// The recording fns must be callable with no provider installed — the
    /// OSS no-collector path. A panic here is a proxy that requires an
    /// observability stack to serve traffic.
    #[test]
    fn recording_without_a_provider_is_a_noop_not_a_panic() {
        record_snip_compaction("json", "json_aware", 1000, 400, 0.6);
        record_policy_refusal("anomaly", "reask");
        let _handles = register_observables();
    }

    /// Ratio boundaries cover (0, 1) exclusive in 0.05 steps — 19 interior
    /// boundaries; the SDK adds the +Inf bucket itself.
    #[test]
    fn ratio_boundaries_span_the_unit_interval() {
        let bounds: Vec<f64> = (1..20).map(|i| i as f64 * 0.05).collect();
        assert_eq!(bounds.len(), 19);
        assert!(bounds.first().unwrap() > &0.0);
        assert!(bounds.last().unwrap() < &1.0);
    }
}
