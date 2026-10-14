//! Hook-rule guardrails, enforced on the tool calls a model returns.
//!
//! # What a hook rule is
//!
//! A policy guardrail of the `hook_rule` kind names the tools it
//! governs and, optionally, literals the call's arguments must contain
//! (`argContains`) and must not contain (`argNotContains`). The local hook
//! gates, the SDK gates, the MCP proxy and the hosted hook gate read it as a
//! rendered regex pair (`toolPattern`, `argPattern`), tested against the tool
//! name and `JSON.stringify(tool_input)`. That argument pattern is nothing but
//! lookarounds over escaped literals — `(?=[\s\S]*lit)` for each required one,
//! `^(?![\s\S]*lit)` for each excluded one — which this crate's `regex` has no
//! syntax for. So the proxy is served the literals themselves and tests what
//! the pattern means: each required literal is a substring of the serialised
//! input, no excluded literal is. Linear in the input, with no regex engine in
//! the way, and pinned to the same decisions as every other layer by
//! `packages/shared-types/fixtures/guardrail-layer-vectors.json`.
//!
//! # Where it comes from
//!
//! One `hook_rule: {json}` front-matter line per rule, in an SOP the control
//! plane serves on `GET /api/v1/workspace/sops-policy` (a gateway reads it from
//! there; a standalone proxy from the file `intutic guardrails pull` writes) and
//! parsed by `sops.rs` with the rest of the front matter. `mode: shadow` in the
//! same fence makes the rule report instead of refuse, exactly as it does for
//! every other front-matter key.
//!
//! # Roles
//!
//! A rule scoped to workspace roles carries them in its line (`"roles":
//! ["developer"]`, lower case) and applies only to a caller whose member role
//! is one of them — the role the control plane's `/auth/key-context` names
//! for the request's virtual key, which `proxy.rs` reads (cached per key, and
//! refetched when the workspace's config version moves) only for a set that
//! has a scoped rule. Every other layer decides the same way
//! (`hookRuleAppliesToRole` in `@intutic/shared-types`): a rule with no roles
//! applies to everyone, and a caller whose role is not known — a standalone
//! proxy, a provider key, a key-context answer that did not come — is held to
//! every rule, scoped or not ([`HookRuleSet::for_member_role`]).
//!
//! That is a different role from the one a `roles:` front-matter line scopes
//! by: the agent-graph role a request header claims. A hand-written SOP that
//! adds `roles:` still scopes its hook rules that way
//! ([`crate::sops::Sop::applies_to`]); the served guardrail SOPs never do.
//!
//! # Decisions
//!
//! A refusal wins: if any enforcing rule fires on a call, the call is refused
//! under the first such rule, whatever shadow rules also matched. Shadow rules
//! that fire are reported either way.
//!
//! # Fail direction
//!
//! A rule the proxy cannot evaluate refuses (the repository's rule: a rule that
//! reaches no verdict never allows):
//!
//! * a `hook_rule:` line that does not parse — malformed JSON, a missing or
//!   empty `tools` list, or a field this proxy does not know (a newer control
//!   plane's narrowing it cannot apply) — fires on every tool call;
//! * a rule that names the called tool and constrains its arguments fires when
//!   those arguments are not readable JSON, because whether a literal is in
//!   them cannot be shown.
//!
//! In shadow mode either case is reported as a would-act, never refused.

use serde::Deserialize;
use serde_json::Value;

use crate::sops::{Sop, SopMode, SopScope};

/// An absent input, which every layer serialises as `{}`.
static NULL_INPUT: Value = Value::Null;

/// One hook rule as served. `id` is the rule id every layer names it by
/// (`guardrail.<pgr>`), `reason` the rendered reason a refusal carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookRule {
    pub id: String,
    pub tools: Vec<String>,
    pub arg_contains: Vec<String>,
    pub arg_not_contains: Vec<String>,
    pub reason: String,
    /// Lower-cased workspace roles the rule applies to; empty for everyone.
    pub roles: Vec<String>,
}

impl HookRule {
    /// Whether the rule applies to a caller whose member role is
    /// `member_role` (`None` when it is not known, which every rule applies
    /// to). Case-insensitive: key-context names roles in upper case.
    pub fn applies_to_member(&self, member_role: Option<&str>) -> bool {
        if self.roles.is_empty() {
            return true;
        }
        match member_role.map(str::trim).filter(|r| !r.is_empty()) {
            None => true,
            Some(role) => self.roles.iter().any(|r| r.eq_ignore_ascii_case(role)),
        }
    }

    fn constrains_arguments(&self) -> bool {
        !self.arg_contains.is_empty() || !self.arg_not_contains.is_empty()
    }

    fn names(&self, tool: &str) -> bool {
        // Exactly, case included: the rendered `^Bash$` every other layer
        // tests is case-sensitive, so `bash` is another tool there too.
        self.tools.iter().any(|t| t == tool)
    }

    fn arguments_fire(&self, haystack: &str) -> bool {
        self.arg_contains
            .iter()
            .all(|l| haystack.contains(l.as_str()))
            && !self
                .arg_not_contains
                .iter()
                .any(|l| haystack.contains(l.as_str()))
    }
}

/// A `hook_rule:` line, read or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookRuleDecl {
    Rule(HookRule),
    /// The line did not parse. Kept, not dropped: dropping it would be a rule
    /// that silently stopped enforcing. `id` is the line's own `id` when it
    /// had a readable one.
    Unreadable {
        id: Option<String>,
        error: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Wire {
    id: String,
    tools: Vec<String>,
    #[serde(default)]
    arg_contains: Vec<String>,
    #[serde(default)]
    arg_not_contains: Vec<String>,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    roles: Vec<String>,
}

/// Parse the value of one `hook_rule:` line.
pub fn parse_line(raw: &str) -> HookRuleDecl {
    let raw = raw.trim();
    let id = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|s| !s.is_empty());
    let unreadable = |error: String| HookRuleDecl::Unreadable {
        id: id.clone(),
        error,
    };
    let wire: Wire = match serde_json::from_str(raw) {
        Ok(w) => w,
        Err(e) => return unreadable(format!("hook_rule: not a hook rule ({e})")),
    };
    if wire.id.trim().is_empty() {
        return unreadable("hook_rule: `id` is empty".to_string());
    }
    if wire.tools.is_empty() || wire.tools.iter().any(|t| t.is_empty()) {
        return unreadable("hook_rule: `tools` must name at least one tool".to_string());
    }
    if wire
        .arg_contains
        .iter()
        .chain(&wire.arg_not_contains)
        .any(|l| l.is_empty())
    {
        // An empty required literal matches everything and an empty excluded
        // one matches nothing: neither is a rule anyone wrote on purpose.
        return unreadable("hook_rule: an argument literal is empty".to_string());
    }
    if wire.roles.iter().any(|r| r.trim().is_empty()) {
        // An empty role names no one; read as a typo, not as "nobody".
        return unreadable("hook_rule: a role is empty".to_string());
    }
    HookRuleDecl::Rule(HookRule {
        id: wire.id,
        tools: wire.tools,
        arg_contains: wire.arg_contains,
        arg_not_contains: wire.arg_not_contains,
        reason: wire.reason,
        roles: wire
            .roles
            .iter()
            .map(|r| r.trim().to_ascii_lowercase())
            .collect(),
    })
}

/// The serialised tool input every layer matches against:
/// `JSON.stringify(tool_input ?? {})` — compact, no whitespace, non-ASCII left
/// as is. An absent input is `{}`.
///
/// One known difference, which no IR literal can observe: object keys come out
/// sorted here and in insertion order in JavaScript. A literal may not contain
/// `"` (the IR grammar), so it can never span from one key's value into the
/// next key — the only place the order would show.
pub fn haystack(input: &Value) -> String {
    match input {
        Value::Null => "{}".to_string(),
        v => serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()),
    }
}

/// A tool call's arguments as the proxy received them.
#[derive(Debug, Clone, Copy)]
pub enum CallInput<'a> {
    /// Parsed JSON (`Value::Null` for none).
    Parsed(&'a Value),
    /// Present but not JSON — a model that emitted something that is not a
    /// document, or a stream that ended mid-argument.
    Unreadable,
}

impl<'a> CallInput<'a> {
    /// From the `(arguments, raw)` pair `routing::integrity::response_tool_calls`
    /// yields. A blank raw string is the usual "no arguments" and reads as `{}`.
    pub fn from_extracted(args: Option<&'a Value>, raw: Option<&str>) -> Self {
        match (args, raw) {
            (Some(v), _) => CallInput::Parsed(v),
            (None, Some(r)) if !r.trim().is_empty() => CallInput::Unreadable,
            _ => CallInput::Parsed(&NULL_INPUT),
        }
    }
}

/// One rule firing on one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookRuleHit {
    pub rule_id: String,
    pub reason: String,
    pub tool: String,
    /// The SOP the rule came from — what a shadow report is credited to.
    pub sop_title: String,
    pub scope: SopScope,
    /// Fired because the rule (or the call's arguments) could not be read,
    /// not because it matched.
    pub unevaluable: bool,
}

/// The outcome for one call: the refusal, if an enforcing rule fired, and
/// every shadow rule that fired.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookRuleDecision {
    pub refuse: Option<HookRuleHit>,
    pub shadow: Vec<HookRuleHit>,
}

impl HookRuleDecision {
    fn absorb(&mut self, other: HookRuleDecision) {
        if self.refuse.is_none() {
            self.refuse = other.refuse;
        }
        for hit in other.shadow {
            if !self.shadow.iter().any(|h| h.sop_title == hit.sop_title) {
                self.shadow.push(hit);
            }
        }
    }
}

/// What the first line of a streamed tool block allows deciding.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NameStep {
    /// An enforcing rule refuses the call on its name alone.
    pub refuse: Option<HookRuleHit>,
    /// Shadow rules that fire on the name alone.
    pub shadow: Vec<HookRuleHit>,
    /// A rule names this tool and constrains its arguments: the block must be
    /// held until its arguments are complete, then [`HookRuleSet::decide`]d.
    pub hold: bool,
}

#[derive(Debug, Clone)]
struct Armed {
    decl: HookRuleDecl,
    shadow: bool,
    sop_title: String,
    scope: SopScope,
}

impl Armed {
    fn rule_id(&self) -> String {
        match &self.decl {
            HookRuleDecl::Rule(r) => r.id.clone(),
            HookRuleDecl::Unreadable { id: Some(id), .. } => id.clone(),
            HookRuleDecl::Unreadable { id: None, .. } => {
                crate::refusal::tool_rule_id("hook_rule", &self.sop_title)
            }
        }
    }

    fn hit(&self, tool: &str, unevaluable: bool) -> HookRuleHit {
        let reason = match &self.decl {
            HookRuleDecl::Rule(r) if !unevaluable => r.reason.clone(),
            HookRuleDecl::Rule(r) => format!(
                "{} — the call's arguments could not be read, so the rule could not show they are allowed",
                r.reason
            ),
            HookRuleDecl::Unreadable { error, .. } => format!(
                "A hook rule in SOP \"{}\" could not be read ({error}); every tool call is refused until it is fixed",
                self.sop_title
            ),
        };
        HookRuleHit {
            rule_id: self.rule_id(),
            reason,
            tool: tool.to_string(),
            sop_title: self.sop_title.clone(),
            scope: self.scope,
            unevaluable,
        }
    }

    /// Whether this rule fires on `(tool, input)`, and if so whether because it
    /// could not be evaluated.
    fn fires(&self, tool: &str, input: CallInput<'_>) -> Option<bool> {
        match &self.decl {
            HookRuleDecl::Unreadable { .. } => Some(true),
            HookRuleDecl::Rule(r) => {
                if !r.names(tool) {
                    return None;
                }
                if !r.constrains_arguments() {
                    return Some(false);
                }
                match input {
                    CallInput::Parsed(v) => r.arguments_fire(&haystack(v)).then_some(false),
                    CallInput::Unreadable => Some(true),
                }
            }
        }
    }
}

/// Every hook rule in force for one request's role, enforcing and shadow.
#[derive(Debug, Clone, Default)]
pub struct HookRuleSet {
    rules: Vec<Armed>,
}

impl HookRuleSet {
    /// The hook rules `sops` declare for `role`, in SOP order, each carrying
    /// its SOP's mode.
    pub fn from_sops(sops: &[Sop], role: &str) -> Self {
        let rules = sops
            .iter()
            .filter(|s| !s.hook_rules.is_empty() && s.applies_to(role))
            .flat_map(|s| {
                s.hook_rules.iter().map(move |decl| Armed {
                    decl: decl.clone(),
                    shadow: s.mode == SopMode::Shadow,
                    sop_title: s.title.clone(),
                    scope: s.scope,
                })
            })
            .collect();
        Self { rules }
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Whether any rule here is scoped to roles — the only case in which the
    /// caller's member role has to be read.
    pub fn has_role_scoped(&self) -> bool {
        self.rules
            .iter()
            .any(|a| matches!(&a.decl, HookRuleDecl::Rule(r) if !r.roles.is_empty()))
    }

    /// The rules that apply to a caller whose member role is `member_role`:
    /// a scoped rule outside it is dropped; with the role unknown (`None`)
    /// every rule stays. An unreadable rule always stays — it refuses because
    /// it cannot be read, roles included.
    pub fn for_member_role(mut self, member_role: Option<&str>) -> Self {
        self.rules.retain(|a| match &a.decl {
            HookRuleDecl::Rule(r) => r.applies_to_member(member_role),
            HookRuleDecl::Unreadable { .. } => true,
        });
        self
    }

    /// Whether any rule here can refuse (is not in shadow mode).
    pub fn has_enforcing(&self) -> bool {
        self.rules.iter().any(|a| !a.shadow)
    }

    /// Whether a streamed block calling `tool` must be held until its
    /// arguments are complete.
    pub fn holds(&self, tool: &str) -> bool {
        self.rules
            .iter()
            .any(|a| matches!(&a.decl, HookRuleDecl::Rule(r) if r.names(tool) && r.constrains_arguments()))
    }

    /// Titles of the shadow SOPs carrying hook rules — each owes one shadow
    /// report per response that carried a tool call.
    pub fn shadow_sops(&self) -> Vec<(String, SopScope)> {
        let mut out: Vec<(String, SopScope)> = Vec::new();
        for a in self.rules.iter().filter(|a| a.shadow) {
            if !out.iter().any(|(t, _)| t == &a.sop_title) {
                out.push((a.sop_title.clone(), a.scope));
            }
        }
        out
    }

    /// Decide one complete call.
    pub fn decide(&self, tool: &str, input: CallInput<'_>) -> HookRuleDecision {
        let mut out = HookRuleDecision::default();
        for a in &self.rules {
            let Some(unevaluable) = a.fires(tool, input) else {
                continue;
            };
            if a.shadow {
                if !out.shadow.iter().any(|h| h.sop_title == a.sop_title) {
                    out.shadow.push(a.hit(tool, unevaluable));
                }
            } else if out.refuse.is_none() {
                out.refuse = Some(a.hit(tool, unevaluable));
            }
        }
        out
    }

    /// Decide every call in a response, in order: the first refusal, and every
    /// shadow SOP that fired on any call.
    pub fn decide_all<'a>(
        &self,
        calls: impl IntoIterator<Item = (&'a str, CallInput<'a>)>,
    ) -> HookRuleDecision {
        let mut out = HookRuleDecision::default();
        for (tool, input) in calls {
            out.absorb(self.decide(tool, input));
        }
        out
    }

    /// What can be decided from a streamed block's first line — its tool name.
    pub fn decide_name(&self, tool: &str) -> NameStep {
        let mut step = NameStep::default();
        for a in &self.rules {
            let needs_args = matches!(&a.decl, HookRuleDecl::Rule(r) if r.names(tool) && r.constrains_arguments());
            if needs_args {
                step.hold = true;
                continue;
            }
            // Name-only, or unreadable: decided now. The arguments cannot
            // change the outcome, so there is nothing to hold for.
            let Some(unevaluable) = a.fires(tool, CallInput::Parsed(&NULL_INPUT)) else {
                continue;
            };
            if a.shadow {
                if !step.shadow.iter().any(|h| h.sop_title == a.sop_title) {
                    step.shadow.push(a.hit(tool, unevaluable));
                }
            } else if step.refuse.is_none() {
                step.refuse = Some(a.hit(tool, unevaluable));
            }
        }
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sop(title: &str, mode: SopMode, lines: &[&str]) -> Sop {
        Sop {
            title: title.to_string(),
            mode,
            hook_rules: lines.iter().map(|l| parse_line(l)).collect(),
            ..Sop::default()
        }
    }

    const TF: &str = r#"{"id":"guardrail.pgr_tf","tools":["Bash"],"argContains":["terraform apply"],"argNotContains":[],"reason":"Reviewed plan first"}"#;
    const PUSH: &str = r#"{"id":"guardrail.pgr_push","tools":["Bash"],"argContains":["git push"],"argNotContains":[],"reason":"Pushes are reviewed"}"#;
    const ISSUE: &str = r#"{"id":"guardrail.pgr_issue","tools":["mcp__github__create_issue"],"argContains":[],"argNotContains":[],"reason":"Humans file issues"}"#;

    #[test]
    fn parses_a_served_line() {
        let HookRuleDecl::Rule(r) = parse_line(TF) else {
            panic!("did not parse");
        };
        assert_eq!(r.id, "guardrail.pgr_tf");
        assert_eq!(r.tools, vec!["Bash"]);
        assert_eq!(r.arg_contains, vec!["terraform apply"]);
        assert!(r.arg_not_contains.is_empty());
        assert_eq!(r.reason, "Reviewed plan first");
    }

    const PRODDB_DEV: &str = r#"{"id":"guardrail.pgr_db","tools":["Bash"],"argContains":["prod-db"],"argNotContains":[],"reason":"No prod-db sessions","roles":["developer","em"]}"#;

    #[test]
    fn a_scoped_rule_applies_only_to_its_roles_and_to_an_unknown_role() {
        let HookRuleDecl::Rule(r) = parse_line(PRODDB_DEV) else {
            panic!("did not parse");
        };
        assert_eq!(r.roles, vec!["developer", "em"]);
        let set = HookRuleSet::from_sops(&[sop("s", SopMode::Enforce, &[PRODDB_DEV, TF])], "");
        assert!(set.has_role_scoped());
        let input = json!({"command": "psql -h prod-db"});
        let refused = |role: Option<&str>| {
            set.clone()
                .for_member_role(role)
                .decide("Bash", CallInput::Parsed(&input))
                .refuse
                .map(|h| h.rule_id)
        };
        // key-context names roles in upper case.
        assert_eq!(
            refused(Some("DEVELOPER")).as_deref(),
            Some("guardrail.pgr_db")
        );
        assert_eq!(refused(Some("em")).as_deref(), Some("guardrail.pgr_db"));
        assert_eq!(refused(Some("ADMIN")), None);
        assert_eq!(refused(None).as_deref(), Some("guardrail.pgr_db"));
        assert_eq!(refused(Some(" ")).as_deref(), Some("guardrail.pgr_db"));
        // The unscoped rule beside it applies to every role.
        let tf = json!({"command": "terraform apply"});
        let kept = set.clone().for_member_role(Some("ADMIN"));
        assert!(!kept.has_role_scoped());
        assert_eq!(
            kept.decide("Bash", CallInput::Parsed(&tf))
                .refuse
                .map(|h| h.rule_id)
                .as_deref(),
            Some("guardrail.pgr_tf")
        );
    }

    #[test]
    fn an_unreadable_rule_survives_the_role_filter_and_an_empty_role_is_unreadable() {
        let set = HookRuleSet::from_sops(&[sop("s", SopMode::Enforce, &["{"])], "");
        assert!(set
            .for_member_role(Some("ADMIN"))
            .decide("Read", CallInput::Parsed(&NULL_INPUT))
            .refuse
            .is_some());
        assert!(matches!(
            parse_line(r#"{"id":"guardrail.pgr_x","tools":["Bash"],"roles":[""]}"#),
            HookRuleDecl::Unreadable { .. }
        ));
        assert!(matches!(
            parse_line(r#"{"id":"guardrail.pgr_x","tools":["Bash"],"roles":"developer"}"#),
            HookRuleDecl::Unreadable { .. }
        ));
    }

    #[test]
    fn a_line_with_a_field_this_proxy_does_not_know_is_unreadable() {
        // A newer control plane's narrowing this proxy cannot apply: reading
        // the rest and ignoring it would enforce a different rule.
        let d = parse_line(
            r#"{"id":"guardrail.pgr_x","tools":["Bash"],"argContains":[],"argNotContains":[],"reason":"r","argMatches":["^x"]}"#,
        );
        assert!(
            matches!(d, HookRuleDecl::Unreadable { id: Some(ref id), .. } if id == "guardrail.pgr_x"),
            "{d:?}"
        );
        assert!(matches!(
            parse_line("not json"),
            HookRuleDecl::Unreadable { id: None, .. }
        ));
        assert!(matches!(
            parse_line(r#"{"id":"guardrail.pgr_x","tools":[]}"#),
            HookRuleDecl::Unreadable { .. }
        ));
        assert!(matches!(
            parse_line(r#"{"id":"guardrail.pgr_x","tools":["Bash"],"argContains":[""]}"#),
            HookRuleDecl::Unreadable { .. }
        ));
    }

    #[test]
    fn the_haystack_is_compact_json() {
        assert_eq!(haystack(&Value::Null), "{}");
        assert_eq!(
            haystack(&json!({"command": "echo \"hi\"\nthere"})),
            r#"{"command":"echo \"hi\"\nthere"}"#
        );
        assert_eq!(haystack(&json!({"p": "été"})), r#"{"p":"été"}"#);
    }

    #[test]
    fn a_refusal_wins_over_an_earlier_shadow_match() {
        let set = HookRuleSet::from_sops(
            &[
                sop(
                    "GUARDRAIL:pgr_push hook_rule: Bash",
                    SopMode::Shadow,
                    &[PUSH],
                ),
                sop(
                    "GUARDRAIL:pgr_force hook_rule: Bash",
                    SopMode::Enforce,
                    &[
                        r#"{"id":"guardrail.pgr_force","tools":["Bash"],"argContains":["git push","--force"]}"#,
                    ],
                ),
            ],
            "developer",
        );
        let input = json!({"command": "git push --force origin main"});
        let d = set.decide("Bash", CallInput::Parsed(&input));
        assert_eq!(d.refuse.unwrap().rule_id, "guardrail.pgr_force");
        assert_eq!(d.shadow.len(), 1);
        assert_eq!(d.shadow[0].rule_id, "guardrail.pgr_push");
    }

    #[test]
    fn tool_names_match_exactly() {
        let set = HookRuleSet::from_sops(&[sop("s", SopMode::Enforce, &[TF])], "");
        let input = json!({"command": "terraform apply"});
        assert!(set
            .decide("Bash", CallInput::Parsed(&input))
            .refuse
            .is_some());
        assert!(set
            .decide("bash", CallInput::Parsed(&input))
            .refuse
            .is_none());
        assert!(set
            .decide("BashOutput", CallInput::Parsed(&input))
            .refuse
            .is_none());
    }

    #[test]
    fn unreadable_arguments_refuse_under_an_argument_rule_only() {
        let set = HookRuleSet::from_sops(&[sop("s", SopMode::Enforce, &[TF, ISSUE])], "");
        let hit = set
            .decide("Bash", CallInput::Unreadable)
            .refuse
            .expect("an argument rule cannot show unreadable arguments are allowed");
        assert!(hit.unevaluable);
        assert_eq!(hit.rule_id, "guardrail.pgr_tf");
        // A tool no rule names is not affected by its arguments being unreadable.
        assert!(set.decide("Write", CallInput::Unreadable).refuse.is_none());
        // A name-only rule decides on the name whatever the arguments are.
        let hit = set
            .decide("mcp__github__create_issue", CallInput::Unreadable)
            .refuse
            .unwrap();
        assert!(!hit.unevaluable);
    }

    #[test]
    fn an_unreadable_rule_refuses_every_call_and_shadow_reports_it() {
        let enforcing = HookRuleSet::from_sops(&[sop("Broken", SopMode::Enforce, &["{"])], "");
        let hit = enforcing
            .decide("Read", CallInput::Parsed(&NULL_INPUT))
            .refuse
            .unwrap();
        assert!(hit.unevaluable);
        assert_eq!(hit.rule_id, "hook_rule.Broken");
        let step = enforcing.decide_name("Read");
        assert!(step.refuse.is_some() && !step.hold);

        let shadow = HookRuleSet::from_sops(&[sop("Broken", SopMode::Shadow, &["{"])], "");
        let d = shadow.decide("Read", CallInput::Parsed(&NULL_INPUT));
        assert!(d.refuse.is_none());
        assert_eq!(d.shadow.len(), 1);
    }

    #[test]
    fn the_name_step_refuses_name_only_rules_and_holds_argument_rules() {
        let set = HookRuleSet::from_sops(&[sop("s", SopMode::Enforce, &[TF, ISSUE])], "");
        let step = set.decide_name("mcp__github__create_issue");
        assert_eq!(step.refuse.unwrap().rule_id, "guardrail.pgr_issue");
        assert!(!step.hold);
        let step = set.decide_name("Bash");
        assert!(step.refuse.is_none());
        assert!(step.hold);
        let step = set.decide_name("Write");
        assert_eq!(step, NameStep::default());
    }

    #[test]
    fn decide_all_keeps_the_first_refusal_and_one_report_per_shadow_sop() {
        let set = HookRuleSet::from_sops(
            &[
                sop("A", SopMode::Shadow, &[PUSH]),
                sop("B", SopMode::Enforce, &[TF]),
            ],
            "",
        );
        let push = json!({"command": "git push"});
        let tf = json!({"command": "terraform apply"});
        let d = set.decide_all([
            ("Bash", CallInput::Parsed(&push)),
            ("Bash", CallInput::Parsed(&push)),
            ("Bash", CallInput::Parsed(&tf)),
        ]);
        assert_eq!(d.refuse.unwrap().rule_id, "guardrail.pgr_tf");
        assert_eq!(d.shadow.len(), 1);
    }

    #[test]
    fn a_role_scoped_sop_scopes_its_hook_rules() {
        let mut s = sop("s", SopMode::Enforce, &[TF]);
        s.roles = vec!["deployer".to_string()];
        let input = json!({"command": "terraform apply"});
        assert!(HookRuleSet::from_sops(std::slice::from_ref(&s), "deployer")
            .decide("Bash", CallInput::Parsed(&input))
            .refuse
            .is_some());
        assert!(HookRuleSet::from_sops(std::slice::from_ref(&s), "reviewer").is_empty());
    }

    #[test]
    fn call_input_from_extracted() {
        let v = json!({"a": 1});
        assert!(matches!(
            CallInput::from_extracted(Some(&v), None),
            CallInput::Parsed(_)
        ));
        assert!(matches!(
            CallInput::from_extracted(None, Some("  ")),
            CallInput::Parsed(Value::Null)
        ));
        assert!(matches!(
            CallInput::from_extracted(None, Some("{\"a\":")),
            CallInput::Unreadable
        ));
        assert!(matches!(
            CallInput::from_extracted(None, None),
            CallInput::Parsed(Value::Null)
        ));
    }
}
