//! What the agent actually touched — extracting tool calls, and what they did.
//!
//! Two jobs that belong together because one is derived from the other:
//!
//! 1. Pulling tool calls out of a request body, in whichever shape the harness
//!    sent them, and reducing the cumulative history to a per-turn delta.
//! 2. Turning that delta into a **change manifest** — an ordered record of the
//!    files, URLs and commands the calls named.
//!
//! # Why the manifest exists
//!
//! Everything else in this proxy governs *behaviour*: which tool, in what
//! order, how often. None of it knows what the agent did with the tool. A long
//! run reports as `["Bash", "action:run_tests", "Write", "action:deploy"]`, and
//! one changed number in one config file is invisible in that. The manifest is
//! the missing half: not "the agent wrote a file" but "the agent wrote
//! `infra/kubernetes/base/configmap.yaml`".
//!
//! It is deterministic and reads only keys it recognises. No model call decides
//! what a reviewer is shown.
//!
//! # The invariant that holds up the review gate
//!
//! `per_turn_tool_delta` is only correct because its caller advances a counter
//! **before** the request may be refused — `swap_extracted_tool_count` is a
//! Redis `GETSET`, and `proxy.rs` calls it before any enforcement returns.
//!
//! That side effect is load-bearing for more than de-duplication. A detector
//! that holds a run for human review fires off this delta, so once the counter
//! has advanced past the reviewable call, the delta is empty on every later
//! request and the detector goes quiet. Without it, an approved run would meet
//! the same call in the resent history and re-pause itself forever.
//!
//! If anyone ever makes that read non-mutating, or moves it after enforcement,
//! human approval stops working — and it will look like a bug in the approval
//! flow rather than here.

use serde::{Deserialize, Serialize};

/// Where an invocation came from: the model asking, or the harness answering.
///
/// This distinction is the whole reason the manifest is trustworthy. Harnesses
/// put tool *results* back into the message history in the same shape as tool
/// *calls* — an Anthropic `tool_result` block and a `role: "tool"` message both
/// carry a name and a content payload. Without separating them, a `Read` whose
/// result happens to contain the text `file_path` becomes a change entry for a
/// file nothing wrote, and a scope check then flags work that never happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationSource {
    /// The model asked for this tool to run. Arguments are arguments.
    Call,
    /// The harness reported what a tool returned. The payload is output, and
    /// must never be read as if it were an argument.
    Result,
}

/// One tool call as it appeared in the request, with the arguments the ordering
/// rules need to classify it. The arguments used to be discarded here, which is
/// why `SCOPE_VIOLATION`'s rules named a vocabulary nothing produced.
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    pub name: String,
    pub input: serde_json::Value,
    pub source: InvocationSource,
}

/// Harnesses resend the full message history per request, so the extractor's
/// output is cumulative; the delta is its suffix beyond `prev_count`. When the
/// history has shrunk (harness compaction), which calls are new is unknowable
/// and the delta is empty: a missed observation is recoverable noise, while a
/// re-appended duplicate is amplified signal in every sequence detector.
pub fn per_turn_tool_delta<T: Clone>(prev_count: usize, extracted: &[T]) -> Vec<T> {
    if prev_count <= extracted.len() {
        extracted[prev_count..].to_vec()
    } else {
        Vec::new()
    }
}

/// Expand a per-turn delta into the sequence actually recorded: each concrete
/// call, followed by the abstract actions it performs.
///
/// Interleaved rather than kept in a parallel list, because the ordering rules
/// are about *when* something happened relative to everything else, and one
/// sequence is the only place that relation survives.
///
/// Deliberately blind to `InvocationSource`, unlike the manifest. A `Read`
/// whose *result* contains an AWS key really is a secret read, and
/// `action:secret_read` firing on it is the behaviour the detectors were tuned
/// against. Narrowing this to `Call` would silently lower firing rates across
/// the whole taxonomy.
pub fn expand_tool_actions(invocations: &[ToolInvocation]) -> Vec<String> {
    let mut out = Vec::with_capacity(invocations.len());
    for call in invocations {
        out.push(call.name.clone());
        out.extend(crate::plugins::anomaly::actions::classify(
            &call.name,
            &call.input,
        ));
    }
    out
}

pub fn extract_request_tool_invocations(body: &serde_json::Value) -> Vec<ToolInvocation> {
    let mut tool_names = Vec::new();
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                for tc in tool_calls {
                    if let Some(name) = tc
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        // OpenAI puts the arguments in a JSON *string*, so parse
                        // it; an unparseable one still yields the call itself.
                        let input = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .map(|a| match a.as_str() {
                                Some(raw) => serde_json::from_str(raw).unwrap_or_else(|_| {
                                    serde_json::Value::String(raw.to_string())
                                }),
                                None => a.clone(),
                            })
                            .unwrap_or(serde_json::Value::Null);
                        tool_names.push(ToolInvocation {
                            name: name.to_string(),
                            input,
                            source: InvocationSource::Call,
                        });
                    } else if let Some(name) = tc.get("name").and_then(|n| n.as_str()) {
                        let input = tc.get("input").cloned().unwrap_or(serde_json::Value::Null);
                        tool_names.push(ToolInvocation {
                            name: name.to_string(),
                            input,
                            source: InvocationSource::Call,
                        });
                    }
                }
            }
            if let Some(role) = msg.get("role").and_then(|r| r.as_str()) {
                if role == "tool" || role == "function" {
                    if let Some(name) = msg.get("name").and_then(|n| n.as_str()) {
                        let input = msg.get("content").cloned().unwrap_or(serde_json::Value::Null);
                        // A tool-role message is the harness reporting output.
                        tool_names.push(ToolInvocation {
                            name: name.to_string(),
                            input,
                            source: InvocationSource::Result,
                        });
                    }
                }
            }
            if let Some(content) = msg.get("content") {
                if let Some(arr) = content.as_array() {
                    for block in arr {
                        if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                            if block_type == "tool_use" || block_type == "tool_result" {
                                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                                    let input = block
                                        .get("input")
                                        .or_else(|| block.get("content"))
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Null);
                                    tool_names.push(ToolInvocation {
                                        name: name.to_string(),
                                        input,
                                        source: if block_type == "tool_use" {
                                            InvocationSource::Call
                                        } else {
                                            InvocationSource::Result
                                        },
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    tool_names
}

// ─── The change manifest ────────────────────────────────────────────────

/// Longest target string kept, in bytes.
///
/// A shell `command` argument is arbitrary, agent-chosen text, and the manifest
/// lands in a jsonb column on an append-only table — one that cannot be cleaned
/// up afterwards, because `trg_prevent_trace_mutation` rejects every UPDATE.
/// Row size must therefore not be something the agent gets to decide.
const TARGET_MAX: usize = 512;

/// Most entries recorded for one request, for the same reason.
///
/// A turn that genuinely touches more than this is already the kind of blast
/// radius a reviewer should see; at that point the count is the signal, not the
/// hundred-and-first path.
const MAX_ENTRIES: usize = 100;

/// Path fragments naming infrastructure a change can take down.
const INFRA_PATH_FRAGMENTS: &[&str] = &[
    "terraform", ".tf", "k8s/", "kubernetes/", "helm/", "dockerfile", "docker-compose", ".tfstate",
];

/// Path fragments naming the pipeline that ships everything else.
///
/// Separate from infra because editing CI is how an agent changes what every
/// *future* change is checked against — a second-order blast radius.
const CI_PATH_FRAGMENTS: &[&str] = &[".github/workflows", ".gitlab-ci", "jenkinsfile", ".circleci"];

/// Path fragments naming version control's own state.
const VCS_PATH_FRAGMENTS: &[&str] = &[".git/", ".gitignore", ".gitmodules", ".gitattributes"];

/// What a tool call did to its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOp {
    Write,
    Edit,
    Delete,
    Move,
    Execute,
    Read,
    Fetch,
    /// A tool this module has no extraction rule for.
    ///
    /// Recorded rather than dropped: a manifest that silently omits what it
    /// could not parse reads as "nothing happened", which is the more dangerous
    /// of the two failures.
    Unknown,
}

impl ChangeOp {
    /// Did this alter something, as opposed to observing it?
    ///
    /// The scope check consumes exactly this. Reading a file outside a declared
    /// scope is not a change, and folding reads in would make every scoped SOP
    /// fire constantly until someone switched the feature off.
    pub fn is_mutation(&self) -> bool {
        matches!(self, ChangeOp::Write | ChangeOp::Edit | ChangeOp::Delete | ChangeOp::Move)
    }
}

/// What kind of thing the target is, so nothing judges a shell command as if it
/// were a filesystem path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Path,
    Url,
    Command,
    /// Nothing recognisable was named.
    Opaque,
}

/// One thing an agent touched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeEntry {
    /// The harness's own tool name, case preserved, so a reviewer sees what the
    /// transcript will show them.
    pub tool: String,
    pub op: ChangeOp,
    /// The value of a recognised argument key — never the content being written.
    pub target: String,
    pub target_kind: TargetKind,
    /// Why this target is worth a reviewer's attention, if it is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub risk: Vec<String>,
    /// Size of the content the call carried, when the argument exposed it.
    /// The length is a useful signal; the content itself is not ours to store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

/// Tool names harnesses use for "create a file".
const WRITE_TOOLS: &[&str] = &["write", "write_file", "writefile", "create_file", "createfile"];
/// Tool names harnesses use for "change part of a file".
const EDIT_TOOLS: &[&str] =
    &["edit", "edit_file", "editfile", "multiedit", "apply_patch", "str_replace", "notebookedit"];
const DELETE_TOOLS: &[&str] = &["delete_file", "deletefile", "remove_file", "rm_file"];
const MOVE_TOOLS: &[&str] = &["move_file", "movefile", "rename_file", "rename"];

/// Argument keys that name a filesystem path.
const PATH_KEYS: &[&str] = &["file_path", "filepath", "path", "filename", "target_file", "notebook_path"];
/// Argument keys that carry a shell command.
const COMMAND_KEYS: &[&str] = &["command", "cmd", "script"];
/// Argument keys that name a URL.
const URL_KEYS: &[&str] = &["url", "uri"];
/// Argument keys whose value is *content*. Their length is recorded; their text
/// never is. This is the line between a manifest and a copy of the agent's work.
const CONTENT_KEYS: &[&str] =
    &["content", "file_text", "new_string", "new_str", "text", "body", "source"];

/// Read one recognised key, if the arguments are an object carrying it.
///
/// Deliberately *not* `flatten_input` from `actions.rs`. That function
/// concatenates every string value with the keys discarded and everything
/// lowercased — exactly right for substring-matching a command, and
/// structurally incapable of telling `{"file_path": "/etc/passwd"}` from
/// `{"pattern": "/etc/passwd"}`. A manifest that cannot tell those apart is
/// worse than none, because it reports edits that never happened.
fn keyed(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let map = input.as_object()?;
    for key in keys {
        if let Some(s) = map.get(*key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn content_bytes(input: &serde_json::Value) -> Option<u64> {
    let map = input.as_object()?;
    CONTENT_KEYS
        .iter()
        .filter_map(|k| map.get(*k).and_then(|v| v.as_str()))
        .map(|s| s.len() as u64)
        .max()
}

/// Truncate on a char boundary, marking that it happened.
fn clip(mut s: String) -> String {
    if s.len() <= TARGET_MAX {
        return s;
    }
    let mut cut = TARGET_MAX;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push('\u{2026}');
    s
}

/// Tag a target with why it matters.
///
/// Matched against a lowercased copy, which is what the shared fragment lists
/// were written for. The `target` itself keeps its case — paths are
/// case-sensitive where it counts, and a reviewer should see what was written.
fn classify_risk(target: &str, kind: TargetKind) -> Vec<String> {
    if kind != TargetKind::Path {
        return Vec::new();
    }
    let lower = target.to_ascii_lowercase();
    let mut risk: Vec<String> = Vec::new();
    fn hit(lower: &str, frags: &[&str]) -> bool {
        frags.iter().any(|f| lower.contains(f))
    }

    if hit(&lower, crate::plugins::anomaly::actions::SECRET_PATH_FRAGMENTS) {
        risk.push("secret_path".into());
    }
    if hit(&lower, crate::plugins::anomaly::actions::PII_PATH_FRAGMENTS) {
        risk.push("pii_path".into());
    }
    if hit(&lower, CI_PATH_FRAGMENTS) {
        risk.push("ci_path".into());
    }
    if hit(&lower, INFRA_PATH_FRAGMENTS) {
        risk.push("infra_path".into());
    }
    if hit(&lower, VCS_PATH_FRAGMENTS) {
        risk.push("vcs_path".into());
    }
    if target.starts_with('/') || target.starts_with('~') || target.contains("../") {
        risk.push("outside_repo".into());
    }
    risk
}

fn entry(tool: &str, op: ChangeOp, target: String, kind: TargetKind, bytes: Option<u64>) -> ChangeEntry {
    let target = clip(target);
    ChangeEntry {
        tool: tool.to_string(),
        op,
        risk: classify_risk(&target, kind),
        target,
        target_kind: kind,
        bytes,
    }
}

/// Derive the manifest for one turn's tool calls.
///
/// `InvocationSource::Result` entries are skipped entirely: they are the
/// harness reporting what a tool returned, and reading a file's contents as if
/// they were arguments invents changes nothing made.
pub fn manifest_from_invocations(invocations: &[ToolInvocation]) -> Vec<ChangeEntry> {
    use crate::plugins::anomaly::actions::{tool_is, FETCH_TOOLS, READ_TOOLS, SHELL_TOOLS};

    let mut out: Vec<ChangeEntry> = Vec::new();
    for call in invocations {
        if call.source != InvocationSource::Call {
            continue;
        }
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let name = call.name.as_str();
        let bytes = content_bytes(&call.input);

        // A move names two things and both matter — where it left and where it
        // landed. Recorded as two entries so each is risk-classified.
        if tool_is(name, MOVE_TOOLS) {
            let from = keyed(&call.input, &["source", "source_path", "from", "old_path"]);
            let to = keyed(&call.input, &["destination", "destination_path", "to", "new_path"]);
            if from.is_some() || to.is_some() {
                for t in [from, to].into_iter().flatten() {
                    out.push(entry(name, ChangeOp::Move, t, TargetKind::Path, None));
                }
                continue;
            }
        }

        let (op, keys, kind) = if tool_is(name, WRITE_TOOLS) {
            (ChangeOp::Write, PATH_KEYS, TargetKind::Path)
        } else if tool_is(name, EDIT_TOOLS) {
            (ChangeOp::Edit, PATH_KEYS, TargetKind::Path)
        } else if tool_is(name, DELETE_TOOLS) {
            (ChangeOp::Delete, PATH_KEYS, TargetKind::Path)
        } else if tool_is(name, SHELL_TOOLS) {
            (ChangeOp::Execute, COMMAND_KEYS, TargetKind::Command)
        } else if tool_is(name, READ_TOOLS) {
            (ChangeOp::Read, PATH_KEYS, TargetKind::Path)
        } else if tool_is(name, FETCH_TOOLS) {
            (ChangeOp::Fetch, URL_KEYS, TargetKind::Url)
        } else {
            // No rule for this tool. Say so rather than say nothing.
            out.push(entry(name, ChangeOp::Unknown, String::new(), TargetKind::Opaque, bytes));
            continue;
        };

        match keyed(&call.input, keys) {
            Some(target) => out.push(entry(name, op, target, kind, bytes)),
            // Recognised tool, unrecognised argument shape — still not silence.
            None => out.push(entry(name, op, String::new(), TargetKind::Opaque, bytes)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── per_turn_tool_delta ─────────────────────────────────────────────
    //
    // Harnesses resend the whole message history each request, so the
    // extractor's output is cumulative. Before the delta existed, that raw
    // extract was appended to the stored sequence on every turn — duplicating
    // the entire history into it each time, and quietly distorting every
    // sequence detector's input.

    #[test]
    fn tool_delta_returns_only_new_calls() {
        let extracted = vec!["Read".to_string(), "Edit".to_string(), "Bash".to_string()];
        assert_eq!(
            per_turn_tool_delta(2, &extracted),
            vec!["Bash".to_string()],
            "only the calls beyond the previous count are new"
        );
    }

    #[test]
    fn tool_delta_is_full_extract_for_a_fresh_session() {
        let extracted = vec!["Read".to_string(), "Edit".to_string()];
        assert_eq!(per_turn_tool_delta(0, &extracted), extracted);
    }

    #[test]
    fn tool_delta_is_empty_when_nothing_changed() {
        let extracted = vec!["Read".to_string()];
        assert!(per_turn_tool_delta(1, &extracted).is_empty());
    }

    #[test]
    fn tool_delta_is_empty_after_history_compaction() {
        // The history shrank below what was already reported. Which tail calls
        // are new is unknowable; guessing re-introduces the duplication this
        // function exists to remove. Missing one turn is the safe failure.
        let extracted = vec!["Bash".to_string()];
        assert!(per_turn_tool_delta(5, &extracted).is_empty());
    }

    // ── source tagging ──────────────────────────────────────────────────

    #[test]
    fn an_anthropic_tool_use_is_a_call_and_a_tool_result_is_not() {
        let body = json!({"messages": [{"role": "user", "content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "/a.rs"}},
            {"type": "tool_result", "name": "Read", "content": "file_path: /etc/passwd"},
        ]}]});
        let inv = extract_request_tool_invocations(&body);
        assert_eq!(inv.len(), 2, "both still reach the action sequence");
        assert_eq!(inv[0].source, InvocationSource::Call);
        assert_eq!(inv[1].source, InvocationSource::Result);
    }

    #[test]
    fn a_tool_role_message_is_output_not_an_argument() {
        let body = json!({"messages": [
            {"role": "tool", "name": "Read", "content": "{\"file_path\": \"/etc/shadow\"}"},
        ]});
        let inv = extract_request_tool_invocations(&body);
        assert_eq!(inv[0].source, InvocationSource::Result);
    }

    #[test]
    fn an_openai_tool_call_is_a_call_in_both_shapes() {
        let body = json!({"messages": [{"tool_calls": [
            {"function": {"name": "Write", "arguments": "{\"file_path\":\"/a.rs\"}"}},
            {"name": "Edit", "input": {"path": "/b.rs"}},
        ]}]});
        let inv = extract_request_tool_invocations(&body);
        assert_eq!(inv.len(), 2);
        assert!(inv.iter().all(|i| i.source == InvocationSource::Call));
        // The OpenAI arguments string must be parsed, not left as a string.
        assert_eq!(inv[0].input["file_path"], "/a.rs");
    }

    /// The tag must not have narrowed the action vocabulary.
    ///
    /// `classify` reads results as well as calls on purpose — a Read whose
    /// *output* contains `.env` is a secret read, and every detector's firing
    /// rate was tuned with that included. Filtering results out of
    /// `expand_tool_actions` would quietly change enforcement everywhere.
    #[test]
    fn tool_results_still_contribute_to_the_action_sequence() {
        let body = json!({"messages": [{"role": "user", "content": [
            {"type": "tool_result", "name": "Read", "content": "AWS creds in ~/.aws/credentials"},
        ]}]});
        let seq = expand_tool_actions(&extract_request_tool_invocations(&body));
        assert!(
            seq.iter().any(|t| t == "action:secret_read"),
            "a result-sourced secret read must still classify: {seq:?}"
        );
    }

    /// Gemini traffic yields nothing, and that is a known gap rather than a
    /// silent one.
    ///
    /// `extract_request_tool_invocations` reads `messages`; Gemini sends
    /// `contents[].parts[].functionCall`. Wiring it would start every sequence
    /// detector firing on Gemini sessions for the first time — a change to
    /// live enforcement that deserves its own change, not a line in this one.
    #[test]
    fn gemini_tool_calls_are_not_yet_extracted() {
        let body = json!({"contents": [{"parts": [
            {"functionCall": {"name": "Write", "args": {"file_path": "/a.rs"}}},
        ]}]});
        assert!(extract_request_tool_invocations(&body).is_empty());
    }

// ─── manifest ───────────────────────────────────────────────────────

    fn call(name: &str, input: serde_json::Value) -> ToolInvocation {
        ToolInvocation { name: name.into(), input, source: InvocationSource::Call }
    }

    /// The defect this module exists to avoid.
    ///
    /// Harnesses put tool *output* back into the history in the same shape as
    /// tool *calls*. A Read whose result happens to contain the text
    /// `file_path` must not become a change entry — that reports an edit that
    /// never happened, and the scope check then steers on fiction.
    #[test]
    fn a_tool_result_does_not_become_a_change() {
        let body = serde_json::json!({"messages": [{"role": "user", "content": [
            {"type": "tool_result", "name": "Read",
             "content": "{\"file_path\": \"/etc/shadow\", \"content\": \"root:x:0:0\"}"},
        ]}]});
        let m = manifest_from_invocations(&extract_request_tool_invocations(&body));
        assert!(m.is_empty(), "a tool result is output, not an argument: {m:?}");
    }

    /// A manifest records *what* was touched, never the content written to it.
    /// Otherwise it is a copy of the agent's work sitting in an append-only
    /// table nobody can redact.
    #[test]
    fn a_write_records_its_path_not_its_content() {
        let secret = "SUPER_SECRET_BODY_TEXT";
        let m = manifest_from_invocations(&[call(
            "Write",
            serde_json::json!({"file_path": "/repo/src/a.rs", "content": secret}),
        )]);
        assert_eq!(m[0].target, "/repo/src/a.rs");
        assert_eq!(m[0].op, ChangeOp::Write);
        assert_eq!(m[0].bytes, Some(secret.len() as u64));
        let wire = serde_json::to_string(&m).unwrap();
        assert!(!wire.contains(secret), "content must never reach the manifest");
    }

    /// Keys matter. `flatten_input` cannot tell these apart, which is why the
    /// manifest does its own extraction rather than reusing it.
    #[test]
    fn a_path_shaped_value_under_another_key_is_not_a_target() {
        let m = manifest_from_invocations(&[call(
            "Grep",
            serde_json::json!({"pattern": "/etc/passwd"}),
        )]);
        assert_eq!(m[0].op, ChangeOp::Unknown);
        assert!(m[0].target.is_empty(), "a search pattern is not a touched path");
    }

    /// Silence and "nothing happened" must not look the same.
    #[test]
    fn an_unreadable_tool_still_appears_in_the_manifest() {
        let m = manifest_from_invocations(&[call("SomeNewTool", serde_json::json!({"q": 1}))]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].op, ChangeOp::Unknown);
        assert_eq!(m[0].tool, "SomeNewTool");
    }

    #[test]
    fn a_pathological_argument_is_truncated_and_capped() {
        let huge = "x".repeat(50_000);
        let m = manifest_from_invocations(&[call("Bash", serde_json::json!({"command": huge}))]);
        assert!(m[0].target.len() <= TARGET_MAX + 4, "target must be clipped");

        let many: Vec<ToolInvocation> = (0..500)
            .map(|i| call("Write", serde_json::json!({"file_path": format!("/f{i}")})))
            .collect();
        assert_eq!(manifest_from_invocations(&many).len(), MAX_ENTRIES);
    }

    #[test]
    fn risky_paths_are_tagged_and_ordinary_ones_are_not() {
        let cases = [
            ("/repo/.env", "secret_path"),
            ("/repo/.github/workflows/deploy.yml", "ci_path"),
            ("/repo/infra/terraform/main.tf", "infra_path"),
            ("/repo/.git/config", "vcs_path"),
        ];
        for (path, tag) in cases {
            let m = manifest_from_invocations(&[call("Write", serde_json::json!({"file_path": path}))]);
            assert!(m[0].risk.iter().any(|r| r == tag), "{path} should tag {tag}: {:?}", m[0].risk);
        }
        let plain = manifest_from_invocations(&[call(
            "Write",
            serde_json::json!({"file_path": "docs/readme.md"}),
        )]);
        assert!(plain[0].risk.is_empty(), "an ordinary path carries no tags");
    }

    /// A shell command is not a path, and must never be risk-classified as one
    /// — `grep secrets.yml` would otherwise read as touching a secret.
    #[test]
    fn a_command_is_never_risk_classified_as_a_path() {
        let m = manifest_from_invocations(&[call(
            "Bash",
            serde_json::json!({"command": "grep -r credentials ./src"}),
        )]);
        assert_eq!(m[0].target_kind, TargetKind::Command);
        assert!(m[0].risk.is_empty());
    }

    #[test]
    fn a_move_records_both_ends() {
        let m = manifest_from_invocations(&[call(
            "move_file",
            serde_json::json!({"source": "/repo/a.rs", "destination": "/repo/b.rs"}),
        )]);
        assert_eq!(m.len(), 2);
        assert!(m.iter().all(|e| e.op == ChangeOp::Move));
    }

    #[test]
    fn only_mutations_report_as_mutations() {
        assert!(ChangeOp::Write.is_mutation() && ChangeOp::Delete.is_mutation());
        assert!(!ChangeOp::Read.is_mutation(), "reading is not changing");
        assert!(!ChangeOp::Execute.is_mutation(), "the command's effect is not visible to us");
    }

    /// Proves the fragment lists are *reused*, not copied. A second copy of a
    /// security-relevant list is how the two drift apart silently.
    #[test]
    fn the_manifest_does_not_copy_the_secret_fragment_list() {
        // Needles assembled at runtime, or this test's own assertion strings
        // would be the duplication it is looking for.
        let src = include_str!("manifest.rs");
        let secret_needle = ["id", "ed25519"].join("_");
        let pii_needle = ["users", "csv"].join(".");
        assert!(!src.contains(&secret_needle), "SECRET_PATH_FRAGMENTS must be imported, not duplicated");
        assert!(!src.contains(&pii_needle), "PII_PATH_FRAGMENTS must be imported, not duplicated");
    }
}
