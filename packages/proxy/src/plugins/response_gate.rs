//! Response-side tool-call gate — refuse a tool call before the client sees it.
//!
//! # Why this exists
//!
//! Tool authorisation used to happen exactly one turn late. `UnauthorizedToolDetector`
//! reads `RequestContext::tool_calls`, which `manifest::extract_request_tool_invocations`
//! fills from the *conversation history the client sends back* — so the first
//! request that carries a forbidden call is the request issued *after* the
//! harness already ran it. The proxy blocked the follow-up and reported a
//! violation for something that had already happened.
//!
//! The proxy is, however, the thing that hands the response to the client: it
//! reads the whole body on the non-streaming path and forwards the stream
//! line by line on the streaming one. Every byte passes through here first,
//! which is all response-side enforcement needs. No harness cooperation, no
//! per-harness hook — a call refused here never reaches the tool runner.
//!
//! # What it can and cannot match
//!
//! Non-streaming, the whole body is in hand, so both the tool **name** and its
//! **arguments** are available. Streaming, they are not: OpenAI sends
//! `function.name` on the first `tool_calls` delta and dribbles `arguments` out
//! as JSON fragments across later chunks, and the decision to withhold has to be
//! made on the chunk in front of us — buffering until the arguments are complete
//! would mean holding back the whole response, which defeats streaming.
//!
//! So the streaming gate matches on the tool **name only**. That is exactly
//! sufficient for a denied-tools policy, which is itself keyed on names
//! (`sops::denied_tools_for_role`), and for the SSO group policy, and it is
//! honest about the limit: on a line-by-line stream, **argument-level matching
//! needs the block held.** Anything built on top of this that wants to gate on
//! argument *values* must not assume the streaming path can see them.
//!
//! Two argument-level checks get their arguments on a stream that way: the
//! destructive-SQL guard (`sql_guard:` in a SOP), for *shell-tool* blocks, and
//! the hook-rule guardrails (`plugins::hook_rules`), for a block whose tool a
//! rule names and whose arguments that rule constrains. While one is in force,
//! the lines of such a block are held back until the block ends and evaluated
//! whole — see [`crate::plugins::sql_guard::StreamHold`]. This gate holds no
//! other block; a hook rule that decides on the name alone is decided on the
//! block's first line, like the deny list.
//!
//! # Wire shapes
//!
//! Anthropic (`content[].type == "tool_use"`, `content_block_start`), OpenAI
//! chat completions (`choices[].message.tool_calls[]`,
//! `choices[].delta.tool_calls[]`) and — since the Responses gap was closed —
//! the OpenAI Responses API (`response.output_item.added` with
//! `item.type == "function_call"`).
//!
//! The Responses shape was the serious omission, and it was missing on **both**
//! paths, not just the streaming one:
//!
//! - Streaming: `try_parse_openai` needs `choices[]`, which a Responses stream
//!   never emits, so a denied tool call reached Codex CLI's tool runner.
//! - Non-streaming: a same-provider `/v1/responses` body is forwarded
//!   *untranslated*, so it arrives here as `output[]` — which matched neither
//!   arm of `routing::integrity::response_tool_calls` either. The initial
//!   reading of this gap said non-streaming was covered because the body is
//!   translated to `choices[]`; that is only true cross-provider.
//!
//! Both are closed now. That was a policy control silently off, not a missing
//! feature — the deny list was reported as enforced on a route where nothing
//! enforced it.
//!
//! **Gemini's native `functionCall` parts are not matched**, on either path,
//! because neither of the two extractors this reuses —
//! `routing::integrity::response_tool_calls` and
//! `protocol::tool_use_parser::parse_sse_chunk` — reads
//! `candidates[].content.parts[].functionCall`. A Gemini request the proxy
//! forwards to Gemini is therefore ungated. Teaching those two extractors the
//! Gemini shape is what closes it, and both are shared with the routing
//! integrity scorer, so it is a behaviour change there too rather than an
//! addition here.
//!
//! # SSO-group clearance
//!
//! The same name-keyed check carries the workspace's SSO group policy
//! ([`crate::sso_groups`]): a tool the member's groups do not clear, or one
//! that is on-behalf-of only, is withheld exactly as a `deny_tools` hit is,
//! and the refusal names the deciding rule (`[sso_group.high_risk.Bash]`).
//! Harnesses with no hook system of their own — Roo Code, or aider pointed at
//! the proxy — have no other gate to apply it. Neither
//! shadow enforcement nor any intervention mode softens it, matching the hook
//! gate, the MCP proxy and the harness gates.
//!
//! # Fail direction
//!
//! Two-level, deliberately.
//!
//! 1. **Scope.** Each check is inert unless the workspace declared what it
//!    enforces: a non-empty deny list for the role, an SSO group policy that
//!    names a tool, a `sql_guard:` policy, or a hook-rule guardrail.
//!    A workspace that has declared none of these cannot be broken by any of
//!    this, whatever the response looks like. That is what keeps a fail-closed
//!    default from being reckless: the blast radius is the set of operators who
//!    explicitly asked for enforcement.
//! 2. **Within that scope, closed.** A response body that will not parse as
//!    JSON cannot be shown to be free of a denied call, so while a deny list,
//!    an SSO group policy, a refusing SQL guard or an enforcing hook rule is in
//!    force it is refused rather than forwarded (`ResponseGateConfig::fail_closed`,
//!    default `true`). An operator who would rather ship an unverifiable body
//!    than a refusal sets `fail_closed: false`.
//!
//! The streaming path deliberately does **not** honour `fail_closed`. Most SSE
//! lines are not JSON at all — `event:` headers, blank separators, `:` comments
//! — so "refuse anything that does not parse" would kill every stream rather
//! than a suspicious one. On a stream the gate acts on what it can read and
//! nothing else; see `gate_stream_line`.

use serde_json::Value;

use crate::commands::WireProvider;
use crate::config::ResponseGateConfig;
use crate::plugins::anomaly::AnomalyKind;
use crate::plugins::hook_rules::{CallInput, HookRuleDecision, HookRuleHit, HookRuleSet};
use crate::plugins::sql_guard::{self, SqlGuardPolicy, SqlViolation};
use crate::refusal::{tool_rule_id, Code, InterventionMode, Refusal, RefusalScope};
use crate::sso_groups::{Clearance, SsoGroupDecision, SsoGroupGate};

/// Why the gate refused a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenialReason {
    /// Tool names the role's SOPs forbid, sorted and deduped.
    Tools(Vec<String>),
    /// A tool the workspace's SSO group policy refuses this member — `DENIED`
    /// or `REQUIRES_OBO`, which every gate refuses alike.
    SsoGroup {
        tool: String,
        decision: SsoGroupDecision,
    },
    /// A shell call that would run destructive SQL against a database the
    /// role's `sql_allow_dsns:` does not admit (`plugins::sql_guard`).
    DestructiveSql(SqlViolation),
    /// A call an enforcing hook-rule guardrail refuses (`plugins::hook_rules`)
    /// — or one it could not show is allowed, which it refuses the same way.
    HookRule(HookRuleHit),
    /// A call a decide rule refuses (`decide::gateway`): its rule was true,
    /// it could not decide (the gateway has no ask), or the engine could not
    /// answer for an enforcing rule.
    Decide(crate::decide::gateway::ToolCallRefusal),
    /// A call a qualified `requires_before:` rule gates while its
    /// prerequisite is unmet.
    Prerequisite(PrerequisiteDenial),
    /// A file-changing call outside `scope_paths` under
    /// `scope_paths_mode: enforce`.
    OutOfScope {
        tool: String,
        /// The targets outside the scope, sorted and deduped.
        paths: Vec<String>,
        /// `scope_paths.<sop title>`.
        rule: String,
    },
    /// A call this node's kind may not make.
    NodeKind {
        tool: String,
        denial: crate::plugins::anomaly::graph_detectors::NodeKindDenial,
    },
    /// The body did not parse, so the gate could not show it carried no denied
    /// call. Only ever produced when `fail_closed` is set.
    Unparseable,
}

/// A qualified prerequisite the response gate found unmet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrerequisiteDenial {
    /// The tool call withheld.
    pub tool: String,
    /// The gated token it was (`action:deploy`), or the tool name itself.
    pub gated: String,
    /// The prerequisite as written, qualifier included (`action:run_tests[ok]`).
    pub prerequisite: String,
    /// `requires_before.<first>-><then>`.
    pub rule: String,
    /// Why it is unmet, in 3.0's words.
    pub reason: String,
}

/// A refusal the caller must act on before any of the response reaches the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denial {
    pub reason: DenialReason,
    /// Where the refusal text has to be written on a stream: the content-block
    /// index (Anthropic) or choice index (OpenAI) the withheld event carried.
    ///
    /// Meaningless on the non-streaming path — there the whole body is replaced
    /// — and left at `0` there.
    pub block_index: u64,
}

impl Denial {
    /// Re-address the refusal to a different index.
    ///
    /// Needed on the cross-provider streaming path, where the withheld event is
    /// Anthropic-shaped — so `block_index` is a *content-block* index — while
    /// the refusal is written as an OpenAI chunk, where the index names a
    /// *choice*. Carrying block 1 across would address choice 1 of a completion
    /// that has exactly one choice.
    pub fn at_block(mut self, index: u64) -> Self {
        self.block_index = index;
        self
    }

    /// The code and rule id that name this refusal to an SDK: in the
    /// response headers on the non-streaming path, in the stream marker on
    /// the streaming one (`crate::refusal`).
    pub fn refusal(&self) -> Refusal {
        match &self.reason {
            DenialReason::Tools(t) => Refusal::new(
                Code::ToolDenied,
                tool_rule_id(
                    "deny_tools",
                    t.first().map(String::as_str).unwrap_or_default(),
                ),
            ),
            DenialReason::SsoGroup { tool, decision } => Refusal::new(
                Code::SsoGroup,
                decision
                    .rule_id
                    .clone()
                    .unwrap_or_else(|| tool_rule_id("sso_group", tool)),
            ),
            DenialReason::DestructiveSql(_) => {
                Refusal::new(Code::SqlGuard, "sql_guard.sql_allow_dsns")
            }
            // The deny_tools code: to an SDK this is a tool the policy
            // forbids, and the rule id is the one every other layer names.
            DenialReason::HookRule(hit) => Refusal::new(Code::ToolDenied, hit.rule_id.clone()),
            DenialReason::Decide(d) => Refusal::new(Code::ToolDenied, d.rule_id.clone()),
            DenialReason::Prerequisite(p) => Refusal::new(Code::PrerequisiteUnmet, p.rule.clone()),
            DenialReason::OutOfScope { rule, .. } => Refusal::new(Code::OutOfScope, rule.clone()),
            DenialReason::NodeKind { denial, .. } => {
                Refusal::new(Code::ToolDenied, denial.rule.clone())
            }
            DenialReason::Unparseable => {
                Refusal::new(Code::ResponseUnparseable, "response_gate.fail_closed")
            }
        }
        .with_scope(self.scope())
    }

    /// What the refusal was about, for the agent to retry inside it.
    /// Bounded, and dropped under OPAQUE, by [`Refusal`].
    pub fn scope(&self) -> Option<RefusalScope> {
        Some(match &self.reason {
            DenialReason::Tools(t) => RefusalScope::tools(t.iter().cloned()),
            DenialReason::SsoGroup { tool, decision } => {
                let s = RefusalScope::tools([tool.as_str()]);
                match &decision.rule_id {
                    Some(r) => s.with_rule(r.clone()),
                    None => s,
                }
            }
            DenialReason::DestructiveSql(_) => return None,
            DenialReason::HookRule(hit) => {
                RefusalScope::tools([hit.tool.as_str()]).with_rule(hit.rule_id.clone())
            }
            DenialReason::Decide(d) => {
                RefusalScope::tools([d.tool.as_str()]).with_rule(d.rule_id.clone())
            }
            DenialReason::Prerequisite(p) => RefusalScope::tools([p.gated.as_str()])
                .with_step(p.prerequisite.clone())
                .with_rule(p.rule.clone()),
            DenialReason::OutOfScope { paths, rule, .. } => {
                RefusalScope::paths(paths.iter().cloned()).with_rule(rule.clone())
            }
            DenialReason::NodeKind { tool, denial } => {
                RefusalScope::tools([tool.as_str()]).with_rule(denial.rule.clone())
            }
            DenialReason::Unparseable => return None,
        })
    }

    /// The mode this refusal is shown to the agent under. Every denial but
    /// [`DenialReason::Unparseable`] names a rule (the tool an SOP denies, the
    /// SSO group rule, the SQL guard's DSN list) and follows the workspace's
    /// mode. An unparseable body is not a rule's decision but a check that
    /// could not run, and its message tells the agent to retry, so it reads
    /// the same in every mode.
    fn shown_under(&self, mode: InterventionMode) -> InterventionMode {
        match self.reason {
            DenialReason::Unparseable => InterventionMode::Transparent,
            _ => mode,
        }
    }

    /// [`Denial::refusal`] as an agent in a workspace under `mode` may see it:
    /// under OPAQUE, the rule id is dropped and the code kept
    /// ([`Refusal::for_mode`]).
    pub fn refusal_for(&self, mode: InterventionMode) -> Refusal {
        self.refusal().for_mode(self.shown_under(mode))
    }

    /// [`Denial::agent_message`] as an agent in a workspace under `mode` is
    /// told it ([`InterventionMode::agent_text`]). The operator's log line,
    /// [`Denial::log_message`], and the trace's finding keep the reason whole.
    pub fn agent_text(&self, mode: InterventionMode) -> String {
        self.shown_under(mode)
            .agent_text(&self.agent_message())
            .to_string()
    }

    /// Operator-facing one-liner. Deliberately the same vocabulary as the
    /// request-side block at `proxy.rs` so both read as one policy rather than
    /// two features: `[UNAUTHORIZED_TOOL]` plus the offending names.
    pub fn log_message(&self) -> String {
        match &self.reason {
            DenialReason::Tools(t) => format!(
                "Response blocked by anomaly policy [{}]: forbidden tool call: {} — denied by an SOP in force for this node",
                AnomalyKind::UnauthorizedTool.as_str(),
                t.join(", ")
            ),
            DenialReason::SsoGroup { decision, .. } => format!(
                "Response blocked by SSO group policy [{}]: {}",
                decision.clearance.as_str(),
                decision.refusal_reason()
            ),
            DenialReason::DestructiveSql(v) => format!(
                "Response blocked by anomaly policy [{}]: {}",
                AnomalyKind::ToolAbuse.as_str(),
                v.log_message()
            ),
            DenialReason::HookRule(hit) => format!(
                "Response blocked by anomaly policy [{}]: forbidden tool call: {} — hook rule {}: {}",
                AnomalyKind::UnauthorizedTool.as_str(),
                hit.tool,
                hit.rule_id,
                hit.reason
            ),
            DenialReason::Decide(d) => format!(
                "Response blocked by anomaly policy [{}]: tool call {} refused by decide rule {} ({}): {}",
                AnomalyKind::UnauthorizedTool.as_str(),
                d.tool,
                d.rule_id,
                d.code,
                d.reason
            ),
            DenialReason::Prerequisite(p) => format!(
                "Response blocked by anomaly policy [{}]: tool call {} withheld — {} [{}]",
                AnomalyKind::ScopeViolation.as_str(),
                p.tool,
                p.reason,
                p.rule
            ),
            DenialReason::OutOfScope { tool, paths, rule } => format!(
                "Response blocked by anomaly policy [{}]: tool call {} changes files outside the declared scope: {} [{}]",
                AnomalyKind::ScopeViolation.as_str(),
                tool,
                paths.join(", "),
                rule
            ),
            DenialReason::NodeKind { denial, .. } => format!(
                "Response blocked by anomaly policy [{}]: {} [{}]",
                AnomalyKind::UnauthorizedTool.as_str(),
                denial.reason,
                denial.rule
            ),
            DenialReason::Unparseable => format!(
                "Response blocked by anomaly policy [{}]: response body did not parse, and a tool deny list, SSO group policy or SQL guard is in force — cannot show it carries no forbidden call",
                AnomalyKind::UnauthorizedTool.as_str()
            ),
        }
    }

    /// What the *agent* is told, in the response body itself.
    ///
    /// Written for a model that will read it as its own previous turn, so it
    /// says what happened, that the call did not run, and what to do instead.
    /// A bare "blocked" invites an immediate retry of the same call.
    pub fn agent_message(&self) -> String {
        match &self.reason {
            DenialReason::Tools(t) => format!(
                "[Intutic] Blocked tool call: {}. This tool is denied by an SOP in force for this agent role. \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that tool, or ask an operator to change the policy.",
                t.join(", ")
            ),
            DenialReason::SsoGroup { tool, decision } => format!(
                "[Intutic] Blocked tool call: {tool}. {} \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that tool, or ask an operator for the access.",
                decision.refusal_reason()
            ),
            DenialReason::DestructiveSql(v) => v.agent_message(),
            DenialReason::HookRule(hit) => format!(
                "[Intutic] Blocked tool call: {}. {} [{}] \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that call, or ask an operator to change the policy.",
                hit.tool, hit.reason, hit.rule_id
            ),
            DenialReason::Decide(d) => format!(
                "[Intutic] Blocked tool call: {}. {} [{}, {}] \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that call, or ask an operator to change the policy.",
                d.tool, d.reason, d.code, d.rule_id
            ),
            DenialReason::Prerequisite(p) => format!(
                "[Intutic] Blocked tool call: {}. {}. [{}] \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Run {} and let it pass first, then retry.",
                p.tool,
                p.reason,
                p.rule,
                p.prerequisite.trim_end_matches("[ok]")
            ),
            DenialReason::OutOfScope { tool, paths, rule } => format!(
                "[Intutic] Blocked tool call: {tool}. It changes {} outside the file scope this task is limited to. [{rule}] \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Keep changes inside the declared scope, or ask an operator to widen it.",
                paths.join(", ")
            ),
            DenialReason::NodeKind { denial, .. } => format!(
                "[Intutic] Blocked tool call: {}. [{}] \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — hand the work to a node allowed to do it.",
                denial.reason, denial.rule
            ),
            DenialReason::Unparseable => {
                "[Intutic] The model's response could not be parsed, and a tool deny list, SSO group policy or SQL guard is in force \
                 for this agent role, so the proxy could not show the response carried no forbidden \
                 tool call. The response was withheld. Retry the request."
                    .to_string()
            }
        }
    }
}

/// Case-insensitive membership, matching `UnauthorizedToolDetector`.
fn is_denied(name: &str, denied_tools: &[String]) -> bool {
    denied_tools.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Whether this gate has anything to do at all.
///
/// Both halves matter: `enabled` is the operator's off switch, and an empty
/// deny list means there is no policy to enforce, so running would only be a
/// chance to be wrong.
fn active(cfg: &ResponseGateConfig, denied_tools: &[String]) -> bool {
    cfg.enabled && !denied_tools.is_empty()
}

/// Evaluate a complete, parsed response body.
///
/// `body` is `None` when the bytes did not parse as JSON — see the fail
/// direction note in the module docs.
pub fn gate_response(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    denied_tools: &[String],
) -> Option<Denial> {
    if !active(cfg, denied_tools) {
        return None;
    }

    let Some(body) = body else {
        return cfg.fail_closed.then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };

    // Shared with the routing-integrity scorer rather than reimplemented: it
    // already handles both wire shapes, including OpenAI's `arguments` arriving
    // as a JSON *string*. Two extractors would be two chances to disagree about
    // what counts as a tool call, and the disagreement would be silent.
    let mut hits: Vec<String> = crate::routing::integrity::response_tool_calls(body)
        .into_iter()
        .map(|(name, _args, _raw)| name)
        .filter(|name| is_denied(name, denied_tools))
        .collect();
    if hits.is_empty() {
        return None;
    }
    hits.sort();
    hits.dedup();

    Some(Denial {
        reason: DenialReason::Tools(hits),
        block_index: 0,
    })
}

/// The SSO group gate, when there is one that could refuse something and the
/// response gate is on.
fn active_sso_gate<'a>(
    cfg: &ResponseGateConfig,
    gate: Option<&'a SsoGroupGate>,
) -> Option<&'a SsoGroupGate> {
    gate.filter(|g| cfg.enabled && g.can_refuse())
}

fn sso_group_denial(gate: &SsoGroupGate, tool: &str, block_index: u64) -> Option<Denial> {
    let decision = gate.decide(tool);
    (decision.clearance != Clearance::Granted).then(|| Denial {
        reason: DenialReason::SsoGroup {
            tool: tool.to_string(),
            decision,
        },
        block_index,
    })
}

/// Evaluate a complete, parsed response body against the workspace's SSO
/// group policy, for the member the request's key belongs to.
///
/// Inert without a policy or with the gate off — the same two-level fail
/// direction as the deny list, `fail_closed` included. The first refused call
/// decides; the body is replaced whole, so a second one never ships either.
pub fn gate_response_sso_groups(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    gate: Option<&SsoGroupGate>,
) -> Option<Denial> {
    let gate = active_sso_gate(cfg, gate)?;
    let Some(body) = body else {
        return cfg.fail_closed.then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };
    crate::routing::integrity::response_tool_calls(body)
        .into_iter()
        .find_map(|(name, _args, _raw)| sso_group_denial(gate, &name, 0))
}

/// The SSO group check on one SSE line — name only, like [`gate_stream_line`],
/// and like it `None` for any line that is not a readable tool-call start.
pub fn gate_stream_line_sso_groups(
    cfg: &ResponseGateConfig,
    line: &str,
    gate: Option<&SsoGroupGate>,
) -> Option<Denial> {
    let gate = active_sso_gate(cfg, gate)?;
    let event = crate::protocol::tool_use_parser::parse_sse_chunk(line)?;
    sso_group_denial(gate, &event.tool_name, event.block_index)
}

/// Evaluate a complete, parsed response body against the SQL guard in force.
///
/// Returns the refusal, if an enforcing `refuse` policy is violated, and every
/// other violation (`warn`, shadow) for the caller to log. Argument-level, so
/// on a stream this is [`sql_guard::StreamHold`]'s job instead.
///
/// Inert when the gate is disabled or no SOP declares `sql_guard:` — the same
/// two-level fail direction the deny list follows, including `fail_closed` for
/// a body that will not parse while a `refuse` policy is in force.
pub fn gate_response_sql(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    policies: &[SqlGuardPolicy],
) -> (Option<Denial>, Vec<SqlViolation>) {
    if !cfg.enabled || policies.is_empty() {
        return (None, Vec::new());
    }
    let Some(body) = body else {
        let refusing = policies.iter().any(SqlGuardPolicy::refuses);
        let denial = (cfg.fail_closed && refusing).then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
        return (denial, Vec::new());
    };
    let mut denial = None;
    let mut notes = Vec::new();
    for (name, args, raw) in crate::routing::integrity::response_tool_calls(body) {
        // Arguments that did not parse as JSON are still a command string.
        let args = args
            .or_else(|| raw.map(Value::String))
            .unwrap_or(Value::Null);
        for v in sql_guard::evaluate(policies, &name, &args) {
            if denial.is_none() && v.refuses() {
                denial = Some(Denial {
                    reason: DenialReason::DestructiveSql(v),
                    block_index: 0,
                });
            } else {
                notes.push(v);
            }
        }
    }
    (denial, notes)
}

/// Evaluate one SSE line, before it is forwarded.
///
/// Returns `Some` only when the line *is readable* and *does* carry a denied
/// tool name. A line that is not a `data:` line, or whose payload is not JSON,
/// yields `None`: on a stream that is the overwhelmingly common case (event
/// headers, blank separators, keep-alive comments) and refusing it would end
/// every stream rather than a suspicious one. `fail_closed` is therefore
/// non-streaming-only, by design and not by omission.
pub fn gate_stream_line(
    cfg: &ResponseGateConfig,
    line: &str,
    denied_tools: &[String],
) -> Option<Denial> {
    if !active(cfg, denied_tools) {
        return None;
    }

    let event = crate::protocol::tool_use_parser::parse_sse_chunk(line)?;
    if !is_denied(&event.tool_name, denied_tools) {
        return None;
    }

    Some(Denial {
        reason: DenialReason::Tools(vec![event.tool_name]),
        block_index: event.block_index,
    })
}

/// Evaluate a complete, parsed response body against the hook-rule guardrails
/// in force (`plugins::hook_rules`).
///
/// Returns the refusal, if an enforcing rule fires on any call, and every
/// shadow rule that fired, for the trace. `fired_on_a_call` in the second
/// element says whether the response carried any tool call at all — a shadow
/// rule is reported (evaluated, would-act or not) only when there was one.
///
/// Inert when the gate is off or no hook rule is in force. A body that will
/// not parse is refused under `fail_closed` while an enforcing rule is in
/// force, like the deny list.
pub fn gate_response_hook_rules(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    rules: &HookRuleSet,
) -> (Option<Denial>, HookRuleDecision, bool) {
    if !cfg.enabled || rules.is_empty() {
        return (None, HookRuleDecision::default(), false);
    }
    let Some(body) = body else {
        let denial = (cfg.fail_closed && rules.has_enforcing()).then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
        return (denial, HookRuleDecision::default(), false);
    };
    let calls = crate::routing::integrity::response_tool_calls(body);
    let decision = rules.decide_all(calls.iter().map(|(name, args, raw)| {
        (
            name.as_str(),
            CallInput::from_extracted(args.as_ref(), raw.as_deref()),
        )
    }));
    let denial = decision.refuse.clone().map(|hit| Denial {
        reason: DenialReason::HookRule(hit),
        block_index: 0,
    });
    (denial, decision, !calls.is_empty())
}

/// Evaluate a complete, parsed response body's tool calls against the decide
/// rules in force (`decide::gateway`), each call in order, once every gate
/// above allowed the body. Returns the first refusal.
///
/// Inert when the gate is off or no `on: tool_call` rule is in force. A body
/// that will not parse is refused under `fail_closed` while a rule stamped
/// `enforce` is in force, like the deny list.
pub async fn gate_response_decide(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    rules: &crate::decide::gateway::GatewayRules,
) -> Option<Denial> {
    if !cfg.enabled || rules.tools().is_empty() {
        return None;
    }
    let Some(body) = body else {
        return (cfg.fail_closed && rules.has_enforcing_tool_rules()).then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };
    for (name, args, raw) in crate::routing::integrity::response_tool_calls(body) {
        let args = args.unwrap_or_else(|| raw.map_or(Value::Null, Value::String));
        if let Some(refusal) = rules.check_tool_call(&name, &args).await {
            return Some(Denial {
                reason: DenialReason::Decide(refusal),
                block_index: 0,
            });
        }
    }
    None
}

/// The argument-level checks 3.0 added to the response gate: qualified
/// prerequisites (§2.4), the enforced path scope (§4.1) and the node kind's
/// tool limits (§9.2). Each is inert until declared; with none declared the
/// gate never looks at a response.
///
/// Stateful within one response: a file write the response carries before a
/// gated call makes a passing test result stale for the calls after it (Q1).
#[derive(Debug, Clone, Default)]
pub struct ArgGates {
    /// Qualified `requires_before:` rules: `(prerequisite base, gated,
    /// adjacent)` (`plugins::anomaly::outcome::qualified_rules`).
    pub prerequisites: Vec<(String, String, bool)>,
    /// The session's recorded outcomes; `None` when they could not be read,
    /// which leaves every qualified rule unmet.
    pub outcomes: Option<Vec<(String, crate::plugins::anomaly::outcome::OutcomeEntry)>>,
    /// The enforced scope and the rule id it is refused under.
    pub scope: Option<ScopeGate>,
    /// The node kind in force, when it limits anything.
    pub node_kind: Option<crate::plugins::anomaly::graph_detectors::EffectiveNodeKind>,
    /// A file write has been seen earlier in this response.
    wrote: bool,
    /// Another call has been seen earlier in this response.
    called: bool,
}

/// `scope_paths_mode: enforce`'s union of scopes, and its rule id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeGate {
    pub paths: Vec<String>,
    /// `scope_paths.<sop title>`, the first enforcing SOP's title.
    pub rule: String,
}

impl ArgGates {
    pub fn new(
        prerequisites: Vec<(String, String, bool)>,
        outcomes: Option<Vec<(String, crate::plugins::anomaly::outcome::OutcomeEntry)>>,
        scope: Option<ScopeGate>,
        node_kind: Option<crate::plugins::anomaly::graph_detectors::EffectiveNodeKind>,
    ) -> Self {
        Self {
            prerequisites,
            outcomes,
            scope,
            node_kind,
            wrote: false,
            called: false,
        }
    }

    /// Nothing declared: the gate has nothing to check.
    pub fn is_empty(&self) -> bool {
        self.prerequisites.is_empty()
            && self.scope.is_none()
            && self.node_kind.as_ref().is_none_or(|k| k.limits.is_none())
    }

    /// Whether a streamed block of `tool` must be held until its arguments
    /// are complete, because one of the checks needs them.
    pub fn holds(&self, tool: &str) -> bool {
        use crate::plugins::anomaly::actions::{
            tool_is, EDITOR_TOOLS, FETCH_TOOLS, READ_TOOLS, SHELL_TOOLS,
        };
        if !self.prerequisites.is_empty()
            && (tool_is(tool, SHELL_TOOLS)
                || tool_is(tool, FETCH_TOOLS)
                || tool_is(tool, READ_TOOLS)
                || tool_is(tool, EDITOR_TOOLS)
                || self
                    .prerequisites
                    .iter()
                    .any(|(_, gated, _)| gated.eq_ignore_ascii_case(tool)))
        {
            return true;
        }
        if self.scope.is_some() && crate::manifest::may_change_files(tool) {
            return true;
        }
        if let Some(k) = self.node_kind.as_ref().filter(|k| !k.limits.is_none()) {
            use crate::node_kind::Capability;
            let refuses = |c| k.limits.refuses(c);
            return (refuses(Capability::Spawn)
                && crate::plugins::anomaly::graph_detectors::is_spawn_tool(tool))
                || (refuses(Capability::Write) && crate::manifest::may_change_files(tool))
                || (refuses(Capability::Shell) && tool_is(tool, SHELL_TOOLS));
        }
        false
    }

    /// A tool started on a stream without being held: a write tool makes a
    /// passing result stale for the rest of the response.
    pub fn note_unheld_start(&mut self, tool: &str) {
        use crate::manifest::{DELETE_TOOLS, EDIT_TOOLS, MOVE_TOOLS, WRITE_TOOLS};
        use crate::plugins::anomaly::actions::tool_is;
        self.called = true;
        if tool_is(tool, WRITE_TOOLS)
            || tool_is(tool, EDIT_TOOLS)
            || tool_is(tool, DELETE_TOOLS)
            || tool_is(tool, MOVE_TOOLS)
        {
            self.wrote = true;
        }
    }

    /// Judge one complete call, in response order. `None` releases it, and
    /// notes whether it wrote a file.
    pub fn check(&mut self, tool: &str, args: &Value) -> Option<DenialReason> {
        use crate::manifest::{InvocationSource, ToolInvocation};
        if let Some(denial) = self
            .node_kind
            .as_ref()
            .and_then(|k| crate::plugins::anomaly::graph_detectors::withheld_tool(k, tool, args))
        {
            return Some(DenialReason::NodeKind {
                tool: tool.to_string(),
                denial,
            });
        }
        let call = ToolInvocation {
            name: tool.to_string(),
            input: args.clone(),
            source: InvocationSource::Call,
            call_id: None,
            is_error: None,
        };
        if !self.prerequisites.is_empty() {
            let mut tokens = crate::plugins::anomaly::actions::classify(tool, args);
            tokens.push(tool.to_string());
            use crate::plugins::anomaly::outcome::{
                prerequisite_unmet, prerequisite_unmet_reason, Case,
            };
            let now = chrono::Utc::now().timestamp_millis();
            for (base, gated, adjacent) in &self.prerequisites {
                if !tokens.iter().any(|t| t.eq_ignore_ascii_case(gated)) {
                    continue;
                }
                let unmet = match prerequisite_unmet(self.outcomes.as_deref(), base, *adjacent, now)
                {
                    // Earlier in this response: a write makes the pass
                    // describe code that is no longer there (Q1), and any
                    // call comes between it and a `~>` rule's call.
                    None if self.wrote => Some((Case::Changed, None)),
                    None if *adjacent && self.called => Some((Case::NotAdjacent, None)),
                    other => other,
                };
                if let Some((case, why)) = unmet {
                    let prerequisite = format!("{base}[ok]");
                    let arrow = if *adjacent { "~>" } else { "->" };
                    return Some(DenialReason::Prerequisite(PrerequisiteDenial {
                        tool: tool.to_string(),
                        gated: gated.clone(),
                        rule: format!("requires_before.{prerequisite}{arrow}{gated}"),
                        reason: prerequisite_unmet_reason(base, gated, case, why.as_deref(), ""),
                        prerequisite,
                    }));
                }
            }
        }
        let entries = crate::manifest::manifest_from_invocations(std::slice::from_ref(&call));
        if let Some(scope) = &self.scope {
            let mut outside: Vec<String> = entries
                .iter()
                .filter(|e| {
                    e.op.is_mutation()
                        && e.target_kind == crate::manifest::TargetKind::Path
                        && !e.target.is_empty()
                        && !crate::plugins::anomaly::detectors::is_within_scope(
                            &e.target,
                            &scope.paths,
                        )
                })
                .map(|e| e.target.clone())
                .collect();
            if !outside.is_empty() {
                outside.sort();
                outside.dedup();
                return Some(DenialReason::OutOfScope {
                    tool: tool.to_string(),
                    paths: outside,
                    rule: scope.rule.clone(),
                });
            }
        }
        if entries.iter().any(|e| e.op.is_mutation())
            || crate::plugins::anomaly::outcome::is_file_write_call(tool, args)
        {
            self.wrote = true;
        }
        self.called = true;
        None
    }
}

/// Evaluate a complete, parsed response body against [`ArgGates`], each call
/// in order. Returns the first refusal.
///
/// Inert when the gate is off or nothing is declared. A body that will not
/// parse is refused under `fail_closed` while any of them is in force, like
/// the deny list: it cannot be shown to carry no gated call.
pub fn gate_response_args(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    gates: &ArgGates,
) -> Option<Denial> {
    if !cfg.enabled || gates.is_empty() {
        return None;
    }
    let Some(body) = body else {
        return cfg.fail_closed.then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };
    let mut gates = gates.clone();
    for (name, args, raw) in crate::routing::integrity::response_tool_calls(body) {
        let args = args.unwrap_or_else(|| raw.map_or(Value::Null, Value::String));
        if let Some(reason) = gates.check(&name, &args) {
            return Some(Denial {
                reason,
                block_index: 0,
            });
        }
    }
    None
}

/// The name half of the hook-rule check on one SSE line: a refusal for an
/// enforcing rule that decides on the tool name alone (or could not be read),
/// and the shadow rules that fire on the name. Rules that constrain arguments
/// are decided when the block is complete — see
/// [`crate::plugins::sql_guard::StreamHold`], which holds those blocks.
/// `None` for any line that is not a readable tool-call start.
pub fn gate_stream_line_hook_rules(
    cfg: &ResponseGateConfig,
    line: &str,
    rules: &HookRuleSet,
) -> Option<(Option<Denial>, Vec<HookRuleHit>)> {
    if !cfg.enabled || rules.is_empty() {
        return None;
    }
    let event = crate::protocol::tool_use_parser::parse_sse_chunk(line)?;
    let step = rules.decide_name(&event.tool_name);
    let denial = step.refuse.map(|hit| Denial {
        reason: DenialReason::HookRule(hit),
        block_index: event.block_index,
    });
    Some((denial, step.shadow))
}

/// The body to send instead, on the non-streaming path.
///
/// # Why a 200 with a refusal message and not a 403
///
/// The request-side block returns `403 policy_denied`, and copying that here
/// was the obvious move. It is the wrong one:
///
/// * The streaming path **cannot** return a status — bytes are already on the
///   wire — so it has to refuse in band. Two paths refusing the same policy in
///   two incompatible ways is a bug waiting to be found by a customer whose
///   agent only breaks when `stream: true`.
/// * A request-side 403 happens before the model ran. Here the model *did* run;
///   the thing being refused is one block of its output. The faithful
///   representation of that is an assistant turn saying so.
/// * Harnesses treat a non-2xx from the completions endpoint as a transport
///   fault and retry. The retry replays the same prompt, gets the same tool
///   call, and 403s again — a paid-for loop that never tells the model why. An
///   in-band refusal puts the reason where the model will read it next turn.
///
/// The safety property is unchanged either way: the returned body contains no
/// `tool_use` block and no `tool_calls` array, so there is nothing executable
/// left for the client to run.
///
/// `mode` is the workspace's intervention mode: under OPAQUE the agent reads
/// the generic refusal ([`Denial::agent_text`]).
pub fn refusal_body(
    provider: WireProvider,
    model: &str,
    denial: &Denial,
    mode: InterventionMode,
) -> Value {
    crate::commands::non_streaming_body(provider, model, &denial.agent_text(mode))
}

/// The bytes to append instead of the withheld event, on the streaming path.
///
/// They open with the SSE comment that names the refusal to an SDK
/// ([`crate::refusal`]), which every client skips.
///
/// This closes the stream *coherently*: a client parsing `text/event-stream`
/// still sees a terminal event, and the refusal arrives as ordinary assistant
/// text at the index the tool call would have occupied.
///
/// `proxy::get_terminal_stream_event` is deliberately not reused for Anthropic.
/// It hardcodes `content_block_stop` at index 0, which double-closes the text
/// block the model had already finished before it reached for the tool — the
/// client would see a stop for a block that is already stopped and no stop for
/// the block this refusal opens. `commands::streaming_body` is not reusable
/// either: it emits a whole stream starting at `message_start`, and a second
/// `message_start` mid-message is not a stream any client can parse.
///
/// `mode` is the workspace's intervention mode, as for [`refusal_body`]; under
/// OPAQUE the marker's `rule` is empty too ([`Denial::refusal_for`]).
pub fn refusal_tail(provider: WireProvider, denial: &Denial, mode: InterventionMode) -> String {
    let text = denial.agent_text(mode);
    let idx = denial.block_index;
    // First, so a client that stops reading at the terminal event has
    // already passed it.
    let marker = denial.refusal_for(mode).stream_marker(&text);

    let events = match provider {
        WireProvider::Anthropic => {
            let start = serde_json::json!({
                "type": "content_block_start",
                "index": idx,
                "content_block": { "type": "text", "text": "" }
            });
            let delta = serde_json::json!({
                "type": "content_block_delta",
                "index": idx,
                "delta": { "type": "text_delta", "text": text }
            });
            let stop = serde_json::json!({ "type": "content_block_stop", "index": idx });
            let msg_delta = serde_json::json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": 0 }
            });
            format!(
                "event: content_block_start\ndata: {start}\n\n\
                 event: content_block_delta\ndata: {delta}\n\n\
                 event: content_block_stop\ndata: {stop}\n\n\
                 event: message_delta\ndata: {msg_delta}\n\n\
                 event: message_stop\ndata: {{\"type\": \"message_stop\"}}\n\n"
            )
        }
        // The Responses API has neither `choices[]` nor `[DONE]`. Emitting the
        // OpenAI arm here would cut the stream — which does stop the tool call,
        // the security property — and then hand Codex CLI bytes it cannot
        // parse, so the agent would see a transport failure rather than the
        // refusal it is supposed to read next turn. The refusal is written as
        // its own output item at the index the withheld `function_call` item
        // claimed, then the stream is closed with `response.completed`.
        WireProvider::OpenAIResponses => format!(
            "{}{}",
            crate::commands::responses_message_events(&text, idx, "msg_intutic_response_gate"),
            crate::commands::responses_terminal_event("intutic-response-gate"),
        ),
        // Gemini follows the OpenAI arm for the same reason
        // `get_terminal_stream_event` and `commands::streaming_body` do: the
        // proxy's Gemini streaming reaches the client as OpenAI chunks.
        _ => {
            let content = serde_json::json!({
                "id": "chatcmpl-intutic-response-gate",
                "object": "chat.completion.chunk",
                "choices": [{
                    "index": idx,
                    "delta": { "content": text },
                    "finish_reason": serde_json::Value::Null
                }]
            });
            let finish = serde_json::json!({
                "id": "chatcmpl-intutic-response-gate",
                "object": "chat.completion.chunk",
                "choices": [{
                    "index": idx,
                    "delta": {},
                    "finish_reason": "stop"
                }]
            });
            format!("data: {content}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
        }
    };
    format!("{marker}{events}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ResponseGateConfig {
        ResponseGateConfig::default()
    }

    fn denied() -> Vec<String> {
        vec!["Bash".to_string(), "terraform_apply".to_string()]
    }

    fn openai_response(tool: &str, args: &str) -> Value {
        serde_json::json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": serde_json::Value::Null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": tool, "arguments": args }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        })
    }

    fn anthropic_response(tool: &str) -> Value {
        serde_json::json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "on it" },
                { "type": "tool_use", "id": "toolu_1", "name": tool, "input": { "cmd": "rm -rf /" } }
            ],
            "stop_reason": "tool_use"
        })
    }

    // ── Non-streaming: the two wire shapes ──────────────────────────────

    #[test]
    fn denies_openai_non_streaming_tool_call() {
        let body = openai_response("Bash", r#"{"command":"rm -rf /"}"#);
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("denied tool must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    #[test]
    fn denies_anthropic_non_streaming_tool_call() {
        let body = anthropic_response("bash");
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("denied tool must be caught");
        // Matched case-insensitively, like `UnauthorizedToolDetector` — a deny
        // list written `Bash` must not be evaded by emitting `bash`.
        assert_eq!(d.reason, DenialReason::Tools(vec!["bash".to_string()]));
    }

    /// The refusal that replaces the body must not smuggle the call through.
    #[test]
    fn refusal_body_carries_no_executable_tool_call() {
        let body = anthropic_response("bash");
        let d = gate_response(&cfg(), Some(&body), &denied()).unwrap();
        let out = refusal_body(
            WireProvider::Anthropic,
            "claude-x",
            &d,
            InterventionMode::Transparent,
        );

        assert!(
            crate::routing::integrity::response_tool_calls(&out).is_empty(),
            "the refusal body still contains a tool call: {out}"
        );
        let rendered = out.to_string();
        assert!(
            rendered.contains("bash"),
            "the refusal must name the tool it blocked"
        );
        assert!(
            !rendered.contains("rm -rf /"),
            "the refusal leaked the blocked arguments"
        );

        let openai_out = refusal_body(
            WireProvider::OpenAI,
            "gpt-x",
            &d,
            InterventionMode::Transparent,
        );
        assert!(
            crate::routing::integrity::response_tool_calls(&openai_out).is_empty(),
            "the OpenAI refusal body still contains a tool call: {openai_out}"
        );
    }

    // ── Non-streaming: everything that must NOT be blocked ──────────────

    #[test]
    fn allowed_tool_call_passes_through_byte_identical() {
        let body = openai_response("read_file", r#"{"path":"/etc/hosts"}"#);
        let before = serde_json::to_vec(&body).unwrap();

        assert!(gate_response(&cfg(), Some(&body), &denied()).is_none());

        assert_eq!(
            serde_json::to_vec(&body).unwrap(),
            before,
            "the gate mutated a body it allowed"
        );
    }

    #[test]
    fn absent_tool_calls_do_not_block() {
        let plain = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" } }]
        });
        assert!(gate_response(&cfg(), Some(&plain), &denied()).is_none());
    }

    /// A `tool_calls` array of the wrong shape must not be read as permission
    /// *or* as a violation — there is no name in it, so there is nothing denied.
    #[test]
    fn malformed_tool_calls_do_not_block() {
        let junk = serde_json::json!({
            "choices": [{ "message": { "tool_calls": "not-an-array" } }]
        });
        assert!(gate_response(&cfg(), Some(&junk), &denied()).is_none());

        let nameless = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{ "function": { "arguments": "{}" } }] } }]
        });
        assert!(gate_response(&cfg(), Some(&nameless), &denied()).is_none());
    }

    /// A denied tool whose `arguments` are not JSON must still be caught: the
    /// name is what the policy is keyed on, and a broken argument string is not
    /// a way out of it.
    #[test]
    fn denied_tool_with_unparseable_arguments_still_blocks() {
        let body = openai_response("Bash", "{not json");
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("name match must survive");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    #[test]
    fn no_deny_list_means_the_gate_never_fires() {
        let body = anthropic_response("bash");
        assert!(gate_response(&cfg(), Some(&body), &[]).is_none());
        assert!(gate_response(&cfg(), None, &[]).is_none());
        assert!(gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &[]).is_none());
    }

    #[test]
    fn disabled_gate_never_fires() {
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        let body = anthropic_response("bash");
        assert!(gate_response(&off, Some(&body), &denied()).is_none());
        assert!(gate_response(&off, None, &denied()).is_none());
        assert!(gate_stream_line(&off, ANTHROPIC_TOOL_LINE, &denied()).is_none());
    }

    // ── Fail direction ──────────────────────────────────────────────────

    #[test]
    fn unparseable_body_fails_closed_by_default_and_open_when_configured() {
        let d = gate_response(&cfg(), None, &denied()).expect("default must fail closed");
        assert_eq!(d.reason, DenialReason::Unparseable);

        let open = ResponseGateConfig {
            enabled: true,
            fail_closed: false,
        };
        assert!(gate_response(&open, None, &denied()).is_none());
    }

    // ── Destructive-SQL guard ───────────────────────────────────────────

    fn sql_policy(
        severity: crate::plugins::sql_guard::SqlGuardSeverity,
        shadow: bool,
    ) -> Vec<SqlGuardPolicy> {
        vec![SqlGuardPolicy {
            severity,
            allow: vec!["postgres://localhost/*".into()],
            org_allow: Vec::new(),
            shadow,
        }]
    }

    #[test]
    fn sql_guard_refuses_a_production_drop_and_passes_an_allowlisted_one() {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'DROP TABLE users'"}"#,
        );
        let (d, notes) = gate_response_sql(&cfg(), Some(&prod), &sql_policy(Refuse, false));
        let d = d.expect("must refuse");
        assert!(matches!(d.reason, DenialReason::DestructiveSql(_)));
        assert!(notes.is_empty());
        let out = refusal_body(
            WireProvider::OpenAI,
            "gpt-x",
            &d,
            InterventionMode::Transparent,
        );
        assert!(crate::routing::integrity::response_tool_calls(&out).is_empty());
        assert!(out.to_string().contains("postgres://db.prod/app"));

        let local = openai_response(
            "Bash",
            r#"{"command":"psql -h localhost -d app -c 'DROP TABLE users'"}"#,
        );
        assert_eq!(
            gate_response_sql(&cfg(), Some(&local), &sql_policy(Refuse, false)),
            (None, Vec::new())
        );
    }

    #[test]
    fn sql_guard_warn_and_shadow_report_without_refusing() {
        use crate::plugins::sql_guard::SqlGuardSeverity::{Refuse, Warn};
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'TRUNCATE events'"}"#,
        );
        for policies in [sql_policy(Warn, false), sql_policy(Refuse, true)] {
            let (d, notes) = gate_response_sql(&cfg(), Some(&prod), &policies);
            assert!(d.is_none());
            assert_eq!(notes.len(), 1);
        }
    }

    #[test]
    fn sql_guard_is_inert_without_a_policy_or_with_the_gate_off() {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -c 'DROP TABLE users'"}"#,
        );
        assert_eq!(
            gate_response_sql(&cfg(), Some(&prod), &[]),
            (None, Vec::new())
        );
        assert_eq!(gate_response_sql(&cfg(), None, &[]), (None, Vec::new()));
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        assert_eq!(
            gate_response_sql(&off, Some(&prod), &sql_policy(Refuse, false)),
            (None, Vec::new())
        );
    }

    #[test]
    fn sql_guard_unparseable_body_fails_closed_only_under_refuse() {
        use crate::plugins::sql_guard::SqlGuardSeverity::{Refuse, Warn};
        let (d, _) = gate_response_sql(&cfg(), None, &sql_policy(Refuse, false));
        assert_eq!(d.unwrap().reason, DenialReason::Unparseable);
        assert!(gate_response_sql(&cfg(), None, &sql_policy(Warn, false))
            .0
            .is_none());
        assert!(gate_response_sql(&cfg(), None, &sql_policy(Refuse, true))
            .0
            .is_none());
    }

    // ── Streaming ───────────────────────────────────────────────────────

    const ANTHROPIC_TOOL_LINE: &str = r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}"#;
    const OPENAI_TOOL_LINE: &str = r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":""}}]}}]}"#;

    #[test]
    fn stream_withholds_denied_anthropic_tool_start() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["bash".to_string()]));
        // The refusal has to be written at the index the tool block claimed,
        // not at 0 — index 0 is the text block the model already closed.
        assert_eq!(d.block_index, 1);
    }

    #[test]
    fn stream_withholds_denied_openai_tool_start() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
        assert_eq!(d.block_index, 0);
    }

    #[test]
    fn stream_lets_ordinary_lines_through() {
        for line in [
            "event: content_block_delta",
            "",
            ": keep-alive",
            "data: [DONE]",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"read_file","input":{}}}"#,
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            "data: {not json",
        ] {
            assert!(
                gate_stream_line(&cfg(), line, &denied()).is_none(),
                "the gate withheld an ordinary line: {line}"
            );
        }
    }

    /// An OpenAI `arguments` fragment arrives on its own chunk with no name.
    /// The gate must not treat that as a second, unnamed call — and must not
    /// pretend it can match arguments there. This is the documented limit.
    #[test]
    fn stream_argument_fragments_are_not_matched() {
        let frag = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"rm -rf /\"}"}}]}}]}"#;
        assert!(gate_stream_line(&cfg(), frag, &denied()).is_none());

        // Even with the tool's *arguments* naming a denied tool, only the name
        // field is policy input on a stream.
        let named_in_args = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{\"cmd\":\"Bash\"}"}}]}}]}"#;
        assert!(gate_stream_line(&cfg(), named_in_args, &denied()).is_none());
    }

    /// The refusal tail must leave a stream a client can still finish parsing:
    /// every `data:` payload valid JSON, and a terminal event present.
    #[test]
    fn anthropic_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(WireProvider::Anthropic, &d, InterventionMode::Transparent);

        assert!(
            tail.contains("event: message_stop"),
            "stream never terminates: {tail}"
        );
        assert!(
            !tail.contains("\"type\":\"tool_use\""),
            "the tail re-emitted the tool call"
        );

        let mut payloads = 0;
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            payloads += 1;
            let v: Value = serde_json::from_str(data)
                .unwrap_or_else(|e| panic!("tail emitted invalid JSON ({e}): {data}"));
            // Every block event must carry the withheld block's index, never 0
            // — index 0 belongs to the text the model already finished.
            if let Some(i) = v.get("index") {
                assert_eq!(
                    i.as_u64(),
                    Some(1),
                    "tail wrote at the wrong block index: {data}"
                );
            }
        }
        assert_eq!(payloads, 5, "unexpected Anthropic tail shape: {tail}");

        // Each SSE event must be blank-line separated.
        assert!(
            tail.ends_with("\n\n"),
            "tail does not close its last event: {tail:?}"
        );
    }

    #[test]
    fn openai_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(WireProvider::OpenAI, &d, InterventionMode::Transparent);

        assert!(
            tail.ends_with("data: [DONE]\n\n"),
            "stream never terminates: {tail}"
        );
        assert!(
            !tail.contains("tool_calls"),
            "the tail re-emitted the tool call"
        );

        let mut finish_reasons = Vec::new();
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let v: Value = serde_json::from_str(data)
                .unwrap_or_else(|e| panic!("tail emitted invalid JSON ({e}): {data}"));
            finish_reasons.push(
                v["choices"][0]["finish_reason"]
                    .as_str()
                    .unwrap_or("null")
                    .to_string(),
            );
        }
        assert_eq!(
            finish_reasons,
            vec!["null", "stop"],
            "unexpected OpenAI tail shape: {tail}"
        );
    }

    /// Non-streaming Responses was blind too, and for a different reason than
    /// the stream: a same-provider `/v1/responses` body is never translated, so
    /// it reaches `gate_response` as `output[]`.
    #[test]
    fn denies_responses_non_streaming_tool_call() {
        let body = serde_json::json!({
            "id": "resp_1", "object": "response",
            "output": [{"type": "function_call", "call_id": "c1", "name": "Bash",
                        "arguments": "{\"command\":\"rm -rf /\"}"}]
        });
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    /// And the refusal body it is replaced with must be a Responses body.
    #[test]
    fn responses_refusal_body_is_a_response_object_with_no_tool_call() {
        let d = Denial {
            reason: DenialReason::Tools(vec!["Bash".into()]),
            block_index: 0,
        };
        let out = refusal_body(
            WireProvider::OpenAIResponses,
            "gpt-5",
            &d,
            InterventionMode::Transparent,
        );
        assert_eq!(out["object"], "response");
        assert_eq!(out["output"][0]["content"][0]["type"], "output_text");
        assert!(out["output"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Blocked tool call"));
        let s = serde_json::to_string(&out).unwrap();
        assert!(
            !s.contains("function_call"),
            "the refusal carried an executable call: {s}"
        );
        assert!(
            !s.contains("choices"),
            "emitted a chat-completions body: {s}"
        );
    }

    // ── OpenAI Responses (Codex CLI) ──────────────────────────────────────

    /// The `response.output_item.added` line Codex CLI's upstream emits when
    /// the model reaches for a tool. Spec-derived, not captured — see
    /// `protocol::tool_use_parser::try_parse_openai_responses`.
    const RESPONSES_TOOL_LINE: &str = r#"data: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"Bash","arguments":""}}"#;

    /// The hole this closes: a denied tool call streamed to Codex CLI reached
    /// the tool runner while the gate reported the deny list as enforced.
    #[test]
    fn stream_withholds_denied_responses_tool_start() {
        let d = gate_stream_line(&cfg(), RESPONSES_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
        // `output_index`, so the refusal item lands where the withheld one was.
        assert_eq!(d.block_index, 2);
    }

    /// Ordinary Responses traffic must not be mistaken for a tool call. A false
    /// positive here refuses a legitimate response, and `fail_closed` cannot
    /// help — the gate would be confidently wrong rather than unsure.
    #[test]
    fn stream_lets_ordinary_responses_lines_through() {
        for line in [
            "event: response.output_text.delta",
            r#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}"#,
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}"#,
            r#"data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}"#,
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"cmd\":"}"#,
            r#"data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}"#,
        ] {
            assert!(
                gate_stream_line(&cfg(), line, &denied()).is_none(),
                "gated an ordinary Responses line: {line}"
            );
        }
    }

    /// An allowed tool call is not withheld — the gate enforces a deny list,
    /// not a blanket ban on tools.
    #[test]
    fn stream_allows_permitted_responses_tool_start() {
        let line = r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_2","type":"function_call","name":"read_file","arguments":""}}"#;
        assert!(gate_stream_line(&cfg(), line, &denied()).is_none());
    }

    /// The refusal must be a Responses stream, not a chat-completions one.
    ///
    /// Cutting the stream is the security property and it holds either way.
    /// This is about the other half: the agent is meant to *read* the refusal
    /// next turn and not retry. A `chat.completion.chunk` here is bytes Codex
    /// CLI cannot parse, so the agent would see a transport failure, retry the
    /// same prompt, and get refused again — a paid-for loop.
    #[test]
    fn responses_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), RESPONSES_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(
            WireProvider::OpenAIResponses,
            &d,
            InterventionMode::Transparent,
        );

        assert!(
            tail.contains("event: response.completed"),
            "stream never terminates in the Responses shape: {tail}"
        );
        assert!(
            !tail.contains("[DONE]"),
            "emitted the chat-completions sentinel: {tail}"
        );
        assert!(
            !tail.contains("chat.completion"),
            "emitted a chat-completions chunk: {tail}"
        );
        assert!(
            !tail.contains("function_call"),
            "the tail re-emitted the tool call"
        );
        assert!(
            !tail.contains("tool_calls"),
            "the tail re-emitted the tool call"
        );
        assert!(
            tail.ends_with("\n\n"),
            "tail does not close its last event: {tail:?}"
        );
        assert_payloads_parse(&tail);

        // The refusal claims the index the withheld item had, and carries the
        // message the agent is supposed to read.
        let mut types = Vec::new();
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let v: Value = serde_json::from_str(data).unwrap();
            if let Some(t) = v["type"].as_str() {
                types.push(t.to_string());
            }
            if let Some(i) = v.get("output_index").and_then(|i| i.as_u64()) {
                assert_eq!(i, 2, "refusal addressed to the wrong output item: {data}");
            }
        }
        assert_eq!(
            types,
            vec![
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed",
            ],
            "unexpected Responses tail sequence"
        );
        assert!(
            tail.contains("Blocked tool call"),
            "the agent is not told why"
        );
    }

    /// Composition, on the shape where the gate used to see nothing at all: the
    /// denied call must not appear anywhere in what the client received, and
    /// what it did receive must still be a parseable, terminated stream.
    #[test]
    fn responses_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let lines = [
            r#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}"#,
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}"#,
            r#"data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Let me run that."}"#,
            RESPONSES_TOOL_LINE,
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"command\":\"rm -rf /\"}"}"#,
            r#"data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}"#,
        ];
        let (sse, tripped) = replay(&lines, WireProvider::OpenAIResponses);
        assert!(tripped, "the denied call was never caught");
        assert!(
            !sse.contains("function_call"),
            "the denied call reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf"),
            "the arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("Let me run that."),
            "text before the call was dropped"
        );
        assert!(
            sse.contains("event: response.completed"),
            "the cut stream never terminates: {sse}"
        );
        assert_payloads_parse(&sse);
    }

    /// Gemini has no distinct streaming shape in this proxy — it reaches the
    /// client as OpenAI chunks, exactly as `get_terminal_stream_event` assumes.
    #[test]
    fn gemini_tail_follows_the_openai_shape() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).unwrap();
        assert_eq!(
            refusal_tail(WireProvider::Gemini, &d, InterventionMode::Transparent),
            refusal_tail(WireProvider::OpenAI, &d, InterventionMode::Transparent)
        );
    }

    /// Walk a realistic transcript the way `proxy::handle_proxy` walks it —
    /// forward each line unless the gate withholds it, and on a withholding
    /// append the tail and stop — then check what the client actually received.
    ///
    /// The unit tests above check the pieces; this checks the composition,
    /// which is where "withheld the event but left the stream unparseable"
    /// would hide.
    fn replay(lines: &[&str], provider: WireProvider) -> (String, bool) {
        let mut out = String::new();
        for line in lines {
            if let Some(d) = gate_stream_line(&cfg(), line, &denied()) {
                out.push_str(&refusal_tail(provider, &d, InterventionMode::Transparent));
                return (out, true);
            }
            out.push_str(line);
            out.push('\n');
        }
        (out, false)
    }

    /// Every `data:` payload in an SSE body must be valid JSON or `[DONE]`.
    fn assert_payloads_parse(sse: &str) {
        for line in sse.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            serde_json::from_str::<Value>(data)
                .unwrap_or_else(|e| panic!("client would fail to parse ({e}): {data}"));
        }
    }

    #[test]
    fn anthropic_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let (sse, tripped) = replay(
            &[
                r#"event: message_start"#,
                r#"data: {"type":"message_start","message":{"id":"msg_1","content":[]}}"#,
                "",
                r#"event: content_block_start"#,
                r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
                "",
                r#"event: content_block_delta"#,
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will run it."}}"#,
                "",
                r#"event: content_block_stop"#,
                r#"data: {"type":"content_block_stop","index":0}"#,
                "",
                // Everything from here must never reach the client.
                r#"event: content_block_start"#,
                ANTHROPIC_TOOL_LINE,
                "",
                r#"event: content_block_delta"#,
                r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"rm -rf /\"}"}}"#,
                "",
                r#"event: message_stop"#,
                r#"data: {"type":"message_stop"}"#,
                "",
            ],
            WireProvider::Anthropic,
        );

        assert!(tripped, "the gate never fired");
        assert!(
            !sse.contains("tool_use"),
            "the tool-use event reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf /"),
            "the tool arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("I will run it."),
            "text emitted before the call was dropped"
        );
        assert!(
            sse.contains("event: message_stop"),
            "stream never terminates: {sse}"
        );
        assert!(
            sse.contains("[Intutic] Blocked tool call"),
            "no in-band reason: {sse}"
        );
        assert_payloads_parse(&sse);

        // The refusal opens block 1 — the index the tool wanted — and closes
        // it. Block 0 is stopped exactly once, by the upstream. Counted over
        // parsed events rather than raw substrings: serde_json orders object
        // keys itself, so a substring count would be asserting its field order.
        let stops: Vec<u64> = sse
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("content_block_stop"))
            .filter_map(|v| v.get("index").and_then(|i| i.as_u64()))
            .collect();
        assert_eq!(
            stops,
            vec![0, 1],
            "blocks were not opened and closed once each: {sse}"
        );
    }

    #[test]
    fn openai_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let (sse, tripped) = replay(
            &[
                r#"data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"I will run it."},"finish_reason":null}]}"#,
                "",
                OPENAI_TOOL_LINE,
                "",
                r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"rm -rf /\"}"}}]}}]}"#,
                "",
                "data: [DONE]",
                "",
            ],
            WireProvider::OpenAI,
        );

        assert!(tripped, "the gate never fired");
        assert!(
            !sse.contains("tool_calls"),
            "the tool-call delta reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf /"),
            "the tool arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("I will run it."),
            "text emitted before the call was dropped"
        );
        assert!(
            sse.trim_end().ends_with("data: [DONE]"),
            "stream never terminates: {sse}"
        );
        assert!(
            sse.contains("[Intutic] Blocked tool call"),
            "no in-band reason: {sse}"
        );
        assert_payloads_parse(&sse);
    }

    /// A stream that never reaches for a denied tool must come out untouched —
    /// the gate is not allowed to rewrite ordinary traffic.
    #[test]
    fn allowed_stream_is_forwarded_unchanged() {
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}"#,
            "",
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":""}}]}}]}"#,
            "",
            "data: [DONE]",
            "",
        ];
        let (sse, tripped) = replay(&lines, WireProvider::OpenAI);

        assert!(!tripped, "the gate fired on an allowed tool");
        assert_eq!(sse, lines.join("\n") + "\n");
    }

    #[test]
    fn messages_name_the_policy_and_the_tool() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).unwrap();
        assert!(d.log_message().contains("UNAUTHORIZED_TOOL"));
        assert!(d.log_message().contains("bash"));
        assert!(d.agent_message().contains("bash"));

        let u = Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        };
        assert!(u.log_message().contains("UNAUTHORIZED_TOOL"));
        assert!(!u.agent_message().is_empty());
    }

    // ── Intervention mode ───────────────────────────────────────────────

    /// OPAQUE: the agent reads the generic sentence and no rule id, under the
    /// same code; the operator's log line and the trace's finding still name
    /// the rule. TRANSPARENT and SILENT_LOG send what they always did.
    #[test]
    fn opaque_hides_the_rule_from_the_agent_and_not_from_the_record() {
        use crate::refusal::OPAQUE_MESSAGE;
        let body = openai_response("Bash", r#"{"command":"ls"}"#);
        let gate = sso_gate(Some(&["eng"]));
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        let rule = "sso_group.high_risk.Bash";

        assert_eq!(d.agent_text(InterventionMode::Opaque), OPAQUE_MESSAGE);
        let opaque = d.refusal_for(InterventionMode::Opaque);
        assert_eq!(opaque.code, Code::SsoGroup);
        assert_eq!(opaque.rule, "");
        let out = refusal_body(WireProvider::OpenAI, "gpt-x", &d, InterventionMode::Opaque);
        assert_eq!(out["choices"][0]["message"]["content"], OPAQUE_MESSAGE);
        assert!(!out.to_string().contains(rule), "{out}");
        let tail = refusal_tail(WireProvider::Anthropic, &d, InterventionMode::Opaque);
        assert!(!tail.contains(rule), "{tail}");
        assert!(tail.contains(r#""code":"SSO_GROUP""#), "{tail}");
        assert!(tail.contains(r#""rule":"""#), "{tail}");

        // The record keeps the reason whole.
        assert!(d.log_message().contains(rule), "{}", d.log_message());
        let finding = crate::telemetry::FindingWire::from_rule_denial(&d).expect("a finding");
        assert_eq!(finding.rule_id.as_deref(), Some(rule));

        for mode in [InterventionMode::Transparent, InterventionMode::SilentLog] {
            assert_eq!(d.agent_text(mode), d.agent_message());
            assert_eq!(d.refusal_for(mode), d.refusal());
            assert_eq!(
                refusal_tail(WireProvider::OpenAI, &d, mode),
                refusal_tail(WireProvider::OpenAI, &d, InterventionMode::Transparent)
            );
        }
    }

    /// A deny-listed tool and a destructive SQL call name their rule too.
    #[test]
    fn opaque_covers_every_rule_denial_but_an_unparseable_body() {
        use crate::refusal::OPAQUE_MESSAGE;
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).unwrap();
        assert_eq!(d.agent_text(InterventionMode::Opaque), OPAQUE_MESSAGE);
        assert_eq!(d.refusal_for(InterventionMode::Opaque).rule, "");
        assert_eq!(
            d.refusal_for(InterventionMode::Opaque).code,
            Code::ToolDenied
        );

        // Not a rule's decision: the check could not run, and the agent is
        // told to retry, in every mode.
        let u = Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        };
        assert_eq!(u.agent_text(InterventionMode::Opaque), u.agent_message());
        assert_eq!(u.refusal_for(InterventionMode::Opaque), u.refusal());
    }

    // ── SSO-group clearance ─────────────────────────────────────────────

    fn sso_gate(member_groups: Option<&[&str]>) -> SsoGroupGate {
        SsoGroupGate {
            policy: crate::sso_groups::parse_policy(&serde_json::json!({
                "highRiskTools": ["Bash"],
                "requiredGroups": ["sre-oncall"],
                "requireOboFor": ["deploy_prod"]
            }))
            .unwrap(),
            member_groups: member_groups.map(|g| g.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn sso_group_denies_a_high_risk_tool_the_member_is_not_cleared_for() {
        let body = openai_response("Bash", r#"{"command":"ls"}"#);
        let gate = sso_gate(Some(&["eng"]));
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        let DenialReason::SsoGroup { tool, decision } = &d.reason else {
            panic!("wrong reason: {d:?}")
        };
        assert_eq!(tool, "Bash");
        assert_eq!(decision.clearance, Clearance::Denied);
        assert_eq!(
            decision.rule_id.as_deref(),
            Some("sso_group.high_risk.Bash")
        );
        // The rule id closes both messages, where `ruleIdFromReason` reads it.
        assert!(
            d.log_message().ends_with("[sso_group.high_risk.Bash]"),
            "{}",
            d.log_message()
        );
        assert!(d.agent_message().contains("[sso_group.high_risk.Bash]"));

        let out = refusal_body(
            WireProvider::OpenAI,
            "gpt-x",
            &d,
            InterventionMode::Transparent,
        );
        assert!(crate::routing::integrity::response_tool_calls(&out).is_empty());
        assert!(!out.to_string().contains("\"command\""));
    }

    #[test]
    fn sso_group_grants_a_cleared_member_and_unlisted_tools() {
        let gate = sso_gate(Some(&["sre-oncall"]));
        let bash = openai_response("Bash", "{}");
        assert!(gate_response_sso_groups(&cfg(), Some(&bash), Some(&gate)).is_none());
        let uncleared = sso_gate(Some(&["eng"]));
        let read = anthropic_response("read_file");
        assert!(gate_response_sso_groups(&cfg(), Some(&read), Some(&uncleared)).is_none());
    }

    /// Names match exactly, as every other gate matches them — unlike the
    /// case-insensitive deny list, which would refuse a call the hook gate
    /// allows.
    #[test]
    fn sso_group_matches_tool_names_exactly() {
        let gate = sso_gate(Some(&["eng"]));
        let lower = anthropic_response("bash");
        assert!(gate_response_sso_groups(&cfg(), Some(&lower), Some(&gate)).is_none());
    }

    #[test]
    fn sso_group_refuses_on_behalf_of_only_tools_even_for_a_cleared_member() {
        let gate = sso_gate(Some(&["sre-oncall"]));
        let body = anthropic_response("deploy_prod");
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        assert!(d.log_message().contains("REQUIRES_OBO"));
        assert!(d
            .log_message()
            .ends_with("[sso_group.require_obo.deploy_prod]"));
    }

    #[test]
    fn sso_group_unknown_groups_are_refused_a_high_risk_tool() {
        let gate = sso_gate(None);
        let body = openai_response("Bash", "{}");
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        assert!(d
            .agent_message()
            .contains("does not know the member's groups"));
    }

    #[test]
    fn sso_group_is_inert_without_a_policy_or_with_the_gate_off() {
        let body = openai_response("Bash", "{}");
        assert!(gate_response_sso_groups(&cfg(), Some(&body), None).is_none());
        assert!(gate_response_sso_groups(&cfg(), None, None).is_none());
        assert!(gate_stream_line_sso_groups(&cfg(), OPENAI_TOOL_LINE, None).is_none());
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        let gate = sso_gate(Some(&["eng"]));
        assert!(gate_response_sso_groups(&off, Some(&body), Some(&gate)).is_none());
        assert!(gate_stream_line_sso_groups(&off, OPENAI_TOOL_LINE, Some(&gate)).is_none());
        // A policy that names no tool cannot refuse one, so it cannot turn an
        // unparseable body into a refusal either.
        let empty = SsoGroupGate {
            policy: crate::sso_groups::SsoGroupPolicy::default(),
            member_groups: None,
        };
        assert!(gate_response_sso_groups(&cfg(), None, Some(&empty)).is_none());
    }

    #[test]
    fn sso_group_unparseable_body_follows_fail_closed() {
        let gate = sso_gate(Some(&["eng"]));
        let d = gate_response_sso_groups(&cfg(), None, Some(&gate)).expect("closed by default");
        assert_eq!(d.reason, DenialReason::Unparseable);
        let open = ResponseGateConfig {
            enabled: true,
            fail_closed: false,
        };
        assert!(gate_response_sso_groups(&open, None, Some(&gate)).is_none());
    }

    #[test]
    fn sso_group_withholds_the_tool_start_on_every_streamed_wire_shape() {
        let gate = sso_gate(Some(&["eng"]));
        for (line, idx) in [(OPENAI_TOOL_LINE, 0), (RESPONSES_TOOL_LINE, 2)] {
            let d = gate_stream_line_sso_groups(&cfg(), line, Some(&gate)).expect("must refuse");
            assert_eq!(d.block_index, idx, "{line}");
            assert!(matches!(d.reason, DenialReason::SsoGroup { .. }));
        }
        let anthropic = r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}"#;
        let d = gate_stream_line_sso_groups(&cfg(), anthropic, Some(&gate)).expect("must refuse");
        assert_eq!(d.block_index, 1);
        let tail = refusal_tail(WireProvider::Anthropic, &d, InterventionMode::Transparent);
        assert!(tail.contains("[sso_group.high_risk.Bash]"));
        assert!(!tail.contains("\"tool_use\""));
        assert_payloads_parse(&tail);

        let cleared = sso_gate(Some(&["sre-oncall"]));
        assert!(gate_stream_line_sso_groups(&cfg(), anthropic, Some(&cleared)).is_none());
        for line in [
            "event: content_block_delta",
            "",
            "data: [DONE]",
            "data: {not json",
        ] {
            assert!(gate_stream_line_sso_groups(&cfg(), line, Some(&gate)).is_none());
        }
    }

    // ── Naming the refusal to an SDK ────────────────────────────────────

    /// One denial of every reason, as the gate builds them.
    fn one_of_each() -> Vec<Denial> {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let tools = gate_response(
            &cfg(),
            Some(&openai_response("terraform_apply", "{}")),
            &denied(),
        )
        .unwrap();
        let sso = gate_response_sso_groups(
            &cfg(),
            Some(&openai_response("Bash", "{}")),
            Some(&sso_gate(Some(&["eng"]))),
        )
        .unwrap();
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'DROP TABLE users'"}"#,
        );
        let sql = gate_response_sql(&cfg(), Some(&prod), &sql_policy(Refuse, false))
            .0
            .unwrap();
        let unparseable = gate_response(&cfg(), None, &denied()).unwrap();
        vec![tools, sso, sql, unparseable]
    }

    #[test]
    fn every_denial_names_its_code_and_deciding_rule() {
        let named: Vec<(&str, String)> = one_of_each()
            .iter()
            .map(|d| {
                let r = d.refusal();
                (r.code.as_str(), r.rule)
            })
            .collect();
        assert_eq!(
            named,
            vec![
                ("TOOL_DENIED", "deny_tools.terraform_apply".to_string()),
                ("SSO_GROUP", "sso_group.high_risk.Bash".to_string()),
                ("SQL_GUARD", "sql_guard.sql_allow_dsns".to_string()),
                (
                    "RESPONSE_UNPARSEABLE",
                    "response_gate.fail_closed".to_string()
                ),
            ]
        );
    }

    /// The marker is the first thing in every tail, on every wire shape, and
    /// carries the text the agent is shown — so an SDK reading the stream
    /// raises with the same reason, and a client that stops at the terminal
    /// event has already passed it.
    #[test]
    fn every_tail_opens_with_the_refusal_marker() {
        for d in one_of_each() {
            for provider in [
                WireProvider::Anthropic,
                WireProvider::OpenAI,
                WireProvider::OpenAIResponses,
                WireProvider::Gemini,
            ] {
                let tail = refusal_tail(provider, &d, InterventionMode::Transparent);
                let first = tail.lines().next().unwrap();
                let json = first
                    .strip_prefix(crate::refusal::STREAM_MARKER)
                    .unwrap_or_else(|| panic!("tail does not open with the marker: {tail}"));
                let v: Value = serde_json::from_str(json).unwrap();
                let r = d.refusal();
                assert_eq!(v["code"], r.code.as_str());
                assert_eq!(v["rule"], r.rule);
                assert_eq!(v["message"], d.agent_message());
                assert_payloads_parse(&tail);
            }
        }
    }
}

#[cfg(test)]
mod lld75_arg_gate_tests {
    use super::*;
    fn entry(state: &str) -> crate::plugins::anomaly::outcome::OutcomeEntry {
        use crate::plugins::anomaly::outcome::{Outcome, OutcomeEntry};
        let (o, why, changed) = match state {
            "ok" => (Outcome::Ok, "exit_zero", false),
            "failed" => (Outcome::Failed, "summary_failed", false),
            "unknown" => (Outcome::Unknown, "no_signal", false),
            _ => (Outcome::Ok, "exit_zero", true),
        };
        OutcomeEntry {
            o,
            at: chrono::Utc::now().timestamp_millis() - 1_000,
            why: Some(why.into()),
            changed,
            later: false,
        }
    }
    use crate::plugins::sql_guard::StreamHold;
    use serde_json::json;

    fn cfg() -> ResponseGateConfig {
        ResponseGateConfig::default()
    }

    fn prereq_gates(state: Option<&str>) -> ArgGates {
        ArgGates::new(
            vec![("action:run_tests".into(), "action:deploy".into(), false)],
            Some(
                state
                    .map(|s| vec![("action:run_tests".to_string(), entry(s))])
                    .unwrap_or_default(),
            ),
            None,
            None,
        )
    }

    fn openai(calls: &[(&str, Value)]) -> Value {
        json!({"choices": [{"index": 0, "message": {"role": "assistant", "content": null,
            "tool_calls": calls.iter().enumerate().map(|(i, (n, a))| json!({
                "id": format!("call_{i}"), "type": "function",
                "function": {"name": n, "arguments": a.to_string()}})).collect::<Vec<_>>()}}]})
    }

    #[test]
    fn an_unmet_prerequisite_withholds_the_gated_call() {
        let push = openai(&[("Bash", json!({"command": "git push origin main"}))]);
        let d = gate_response_args(&cfg(), Some(&push), &prereq_gates(Some("failed")))
            .expect("refused");
        let r = d.refusal();
        assert_eq!(r.code, Code::PrerequisiteUnmet);
        assert_eq!(
            r.rule,
            "requires_before.action:run_tests[ok]->action:deploy"
        );
        assert_eq!(r.scope.as_ref().unwrap().tools, vec!["action:deploy"]);
        assert!(
            d.agent_message()
                .contains("the last action:run_tests failed (summary_failed)"),
            "{}",
            d.agent_message()
        );
        // A passing run lets it through; an unrelated call never asks.
        assert!(gate_response_args(&cfg(), Some(&push), &prereq_gates(Some("ok"))).is_none());
        let ls = openai(&[("Bash", json!({"command": "ls"}))]);
        assert!(gate_response_args(&cfg(), Some(&ls), &prereq_gates(None)).is_none());
        // Inert with nothing declared, and fail-closed on an unreadable body.
        assert!(gate_response_args(&cfg(), Some(&push), &ArgGates::default()).is_none());
        assert_eq!(
            gate_response_args(&cfg(), None, &prereq_gates(Some("ok"))).map(|d| d.reason),
            Some(DenialReason::Unparseable)
        );
    }

    #[test]
    fn a_write_earlier_in_the_response_makes_a_pass_stale() {
        let body = openai(&[
            ("Write", json!({"file_path": "src/a.rs", "content": "x"})),
            ("Bash", json!({"command": "git push"})),
        ]);
        let d = gate_response_args(&cfg(), Some(&body), &prereq_gates(Some("ok"))).expect("stale");
        assert!(
            d.log_message().contains("files changed"),
            "{}",
            d.log_message()
        );
    }

    #[test]
    fn an_enforced_scope_withholds_writes_outside_it() {
        let gates = ArgGates::new(
            Vec::new(),
            None,
            Some(ScopeGate {
                paths: vec!["src".into()],
                rule: "scope_paths.Backend".into(),
            }),
            None,
        );
        let out = openai(&[(
            "Write",
            json!({"file_path": "infra/main.tf", "content": "x"}),
        )]);
        let d = gate_response_args(&cfg(), Some(&out), &gates).expect("refused");
        assert_eq!(d.refusal().code, Code::OutOfScope);
        assert_eq!(d.refusal().rule, "scope_paths.Backend");
        assert_eq!(d.scope().unwrap().paths, vec!["infra/main.tf"]);
        let inside = openai(&[("Write", json!({"file_path": "src/a.rs", "content": "x"}))]);
        assert!(gate_response_args(&cfg(), Some(&inside), &gates).is_none());
        // Shell commands are never judged as paths.
        let shell = openai(&[("Bash", json!({"command": "echo x > infra/main.tf"}))]);
        assert!(gate_response_args(&cfg(), Some(&shell), &gates).is_none());
    }

    #[test]
    fn a_worker_s_spawn_call_is_withheld_as_tool_denied() {
        use crate::node_kind::NodeKind;
        let kind = crate::plugins::anomaly::graph_detectors::effective_node_kind(
            &[NodeKind::Worker],
            None,
            &[],
        );
        let gates = ArgGates::new(Vec::new(), None, None, Some(kind));
        let task = openai(&[("Task", json!({"prompt": "go"}))]);
        let d = gate_response_args(&cfg(), Some(&task), &gates).expect("withheld");
        assert_eq!(d.refusal().code, Code::ToolDenied);
        assert_eq!(d.refusal().rule, "node_kind.worker");
        assert!(gate_response_args(
            &cfg(),
            Some(&openai(&[("Read", json!({"file_path": "a"}))])),
            &gates
        )
        .is_none());
    }

    fn chunk(delta: Value, finish: Value) -> String {
        format!(
            "data: {}",
            json!({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        )
    }

    #[test]
    fn the_stream_holds_a_gated_shell_block_and_refuses_it_whole() {
        let mut hold = StreamHold::new(Vec::new()).with_arg_gates(prereq_gates(Some("unknown")));
        let lines = [
            chunk(
                json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                "function": {"name": "Bash", "arguments": "{\"command\":\"git "}}]}),
                Value::Null,
            ),
            chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": "push\"}"}}]}),
                Value::Null,
            ),
            chunk(json!({}), json!("tool_calls")),
        ];
        let mut emitted = Vec::new();
        let mut refused = None;
        for l in lines {
            let mut step = hold.push(l);
            emitted.append(&mut step.emit);
            if let Some(r) = step.refuse_gate.take() {
                refused = Some(r);
            }
        }
        assert!(emitted.iter().all(|l| !l.contains("git ")), "{emitted:?}");
        let (reason, _) = refused.expect("the block is refused");
        assert!(
            matches!(reason, DenialReason::Prerequisite(_)),
            "{reason:?}"
        );

        // A passing run releases the same block in order.
        let mut hold = StreamHold::new(Vec::new()).with_arg_gates(prereq_gates(Some("ok")));
        let mut out = Vec::new();
        for l in [
            chunk(
                json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                "function": {"name": "Bash", "arguments": "{\"command\":\"git push\"}"}}]}),
                Value::Null,
            ),
            chunk(json!({}), json!("tool_calls")),
        ] {
            let step = hold.push(l);
            assert!(step.refuse_gate.is_none());
            out.extend(step.emit);
        }
        assert!(out.iter().any(|l| l.contains("git push")), "{out:?}");
    }
}
