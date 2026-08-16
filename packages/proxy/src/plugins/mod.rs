//! Governance plugin system — native Rust implementations.
//!
//! Each plugin receives a [`RequestContext`] and returns a [`Verdict`], and is
//! invoked directly by the proxy at its own call site — `BudgetGatePlugin` in
//! `proxy.rs` is the live example. There is no chained dispatcher: an
//! `evaluate_chain` function existed here with a docstring claiming the proxy
//! called it on every request, but it never had a production caller (only its
//! own tests) and was deleted rather than left reading as working governance —
//! the same standard the Removed-plugins note below applies.
//!
//! # Removed plugins
//!
//! `pcas_gate`, `dlp_gate` and `sop_prompt_injector` were defined here but
//! never called from the request path — dead code that read as working
//! governance. Each is superseded rather than dropped:
//!
//! * `pcas_gate` — tool authorisation is now `UnauthorizedToolDetector`,
//!   driven by `deny_tools` in an SOP. The original defaulted every unlisted
//!   tool to `Unknown -> Hijack`, which open core cannot use: with no policy
//!   service to populate the permission map, every tool call would be held for
//!   a review that has nowhere to happen.
//! * `dlp_gate` — DLP runs directly via `dlp::scan` on the request path, and
//!   its findings reach `DlpEscalationDetector`. The plugin was a wrapper
//!   around work already being done.
//! * `sop_prompt_injector` — replaced by `sops`, which resolves SOPs by role
//!   and injects their content. The original fetched a rule *count* from the
//!   control plane and returned a notice nothing consumed.

pub mod anomaly;
pub mod budget_gate;
pub mod hijack;
pub mod response_gate;
pub mod semantic_cache;

use crate::wasm::context::{RequestContext, Verdict};

/// Plugin trait — identical interface for native Rust and future WASM plugins.
///
/// Every governance gate implements this trait and is called directly where
/// it applies (`BudgetGatePlugin` on the request path in `proxy.rs`).
///
/// # Contract
///
/// - [`name`](IntuticPlugin::name) must be a stable, kebab-case identifier
///   (e.g. `"budget-gate"`) used in telemetry spans and audit logs.
/// - [`priority`](IntuticPlugin::priority) determines execution order:
///   **lower values run first**. Security-critical gates (DLP) should use
///   single-digit priorities.
/// - [`evaluate`](IntuticPlugin::evaluate) must be **pure** — no I/O, no
///   mutations. Side-effects belong in the proxy pipeline, not in plugins.
pub trait IntuticPlugin: Send + Sync {
    /// Stable identifier for telemetry and audit logs.
    fn name(&self) -> &str;

    /// Execution priority — lower values run first.
    fn priority(&self) -> u8;

    /// Evaluate the request context and return a governance verdict.
    fn evaluate(&self, ctx: &RequestContext) -> Verdict;
}
