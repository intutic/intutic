//! Blocking `/fix` and `/draw` proxy commands (open core).
//!
//! Both are intercepted pre-flight like `/intutic-predict`: the proxy answers
//! from the developer's own machine and never forwards the turn upstream. They
//! return a provider-shaped synthetic response carrying a Markdown *synthesis
//! card*, so any harness renders the reply inline.
//!
//! - **`/fix` (a.k.a. `@fix`)** — Grammarly-for-prompts. Inventories the
//!   Intutic primitives configured for this request (DLP, WASM rules, hook
//!   gate, role SOPs, budgets, loops), inlines the SOP text that applies to
//!   the caller's role, scores the request's security posture against the
//!   published rubric (`posture.rs`), and appends recommendations for whatever
//!   is missing. Deterministic and local.
//!
//! - **`/vdraw` (a.k.a. `@draw`)** — renders a text/Mermaid visualisation of
//!   the agent's guardrails, SOPs, loops/graphs and its likely trajectory for
//!   the given prompt.
//!
//! The enterprise layer (control plane) can *enhance* the `/fix` card with
//! memory-provider chunks routed through the LLM-as-judge; that call is made
//! from the control plane, not here. This module is the always-available
//! deterministic floor, and the whole of the open-core behaviour.

use crate::posture::{self, Facets};
use crate::sops::Sop;

/// Which blocking command a user turn invokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `/fix`, `@fix`, `/intutic-fix`, `@intutic fix`
    Fix,
    /// `/vdraw`, `@draw`, `/intutic-draw`, `@intutic draw`
    Draw,
}

/// Strip `<session>` / `<system-reminder>` wrappers the same way the predict
/// detector does, then classify the leading token. Returns the command and the
/// user's actual prompt (everything after the command token).
pub fn detect(text: &str) -> Option<(Command, String)> {
    let mut cleaned = text;
    loop {
        let trimmed = cleaned.trim();
        if let Some(stripped) = trimmed.strip_prefix("<session>") {
            cleaned = stripped;
        } else if trimmed.starts_with("<system-reminder>") {
            match trimmed.find("</system-reminder>") {
                Some(end) => cleaned = &trimmed[end + "</system-reminder>".len()..],
                None => break,
            }
        } else {
            break;
        }
    }
    let t = cleaned.trim();
    let lower = t.to_ascii_lowercase();

    for (prefixes, cmd) in [
        (["/fix", "@fix", "/intutic-fix", "@intutic fix"], Command::Fix),
        (["/vdraw", "@draw", "/intutic-draw", "@intutic draw"], Command::Draw),
    ] {
        for p in prefixes {
            if lower == p || lower.starts_with(&format!("{p} ")) || lower.starts_with(&format!("{p}\n")) {
                let prompt = t[p.len()..].trim().to_string();
                return Some((cmd, prompt));
            }
        }
    }
    None
}

/// Facet inventory built from what the proxy can see locally: the DLP/WASM/
/// policy config and the SOPs on disk for the caller's role.
pub struct Inventory {
    pub role: String,
    pub dlp_scan_input: bool,
    pub dlp_scan_output: bool,
    pub wasm_rule_count: u32,
    pub hook_gate: bool,
    pub policy_enforced: bool,
    pub applicable_sops: Vec<Sop>,
}

impl Inventory {
    fn to_facets(&self) -> Facets {
        let enforced = self
            .applicable_sops
            .iter()
            .filter(|s| !s.deny_tools.is_empty() || !s.allow_harnesses.is_empty())
            .count() as u32;
        Facets {
            dlp: self.dlp_scan_input || self.dlp_scan_output,
            wasm_rules: self.wasm_rule_count,
            hook_gate: self.hook_gate,
            pcas: self.policy_enforced,
            sops_total: self.applicable_sops.len() as u32,
            sops_enforced: enforced,
            harness_known: true,
            harness_config_synced: true,
            // Surfaces the proxy cannot see locally are left as "not used" so
            // they neither inflate nor deflate the local pre-check.
            ..Default::default()
        }
    }
}

/// Render the `/fix` synthesis card: primitives inventory, inlined SOPs,
/// posture pre-check and recommendations for what is missing.
pub fn render_fix_card(prompt: &str, inv: &Inventory) -> String {
    let facets = inv.to_facets();
    let result = posture::score(&facets);

    let mut out = String::new();
    out.push_str("### 🛡️ Intutic `/fix` — Prompt Enhancement\n\n");

    if prompt.is_empty() {
        out.push_str("> _No prompt text after `/fix`. Add your prompt so Intutic can enhance it._\n\n");
    } else {
        let words = prompt.split_whitespace().count();
        out.push_str(&format!(
            "**Your prompt** ({} words):\n\n> {}\n\n",
            words,
            prompt.replace('\n', "\n> ")
        ));
    }

    // Primitives inventory.
    out.push_str("#### Primitives applied to this request\n\n");
    out.push_str("| Primitive | Status |\n|---|---|\n");
    out.push_str(&format!("| Input DLP | {} |\n", on_off(inv.dlp_scan_input)));
    out.push_str(&format!("| Output DLP (incl. streaming) | {} |\n", on_off(inv.dlp_scan_output)));
    out.push_str(&format!("| WASM rules | {} |\n", if inv.wasm_rule_count > 0 { format!("✅ {} loaded", inv.wasm_rule_count) } else { "—".into() }));
    out.push_str(&format!("| Hook gate | {} |\n", on_off(inv.hook_gate)));
    out.push_str(&format!("| Policy enforcement | {} |\n", on_off(inv.policy_enforced)));
    out.push_str(&format!("| Role SOPs (`{}`) | {} |\n\n", inv.role, if inv.applicable_sops.is_empty() { "—".into() } else { format!("✅ {}", inv.applicable_sops.len()) }));

    // Inline the SOP text that applies — so the enhanced prompt carries the
    // policy the agent must follow, not just a count.
    if !inv.applicable_sops.is_empty() {
        out.push_str("#### Inlined governance for your role\n\n");
        for sop in &inv.applicable_sops {
            out.push_str(&format!("- **{}**", sop.title));
            if !sop.deny_tools.is_empty() {
                out.push_str(&format!(" — denies: `{}`", sop.deny_tools.join("`, `")));
            }
            out.push('\n');
        }
        out.push('\n');
    }

    // Posture pre-check.
    out.push_str(&format!(
        "#### Security posture pre-check — **{}/100** ({})\n\n",
        result.overall,
        band_emoji(result.band)
    ));
    out.push_str("| Facet | Score | Note | OWASP |\n|---|---|---|---|\n");
    for f in &result.facets {
        if !f.applies {
            continue;
        }
        let (llm, _agentic) = posture::rubric_for(f.facet);
        out.push_str(&format!("| {} | {} | {} | {} |\n", f.facet, f.score, f.reason, llm));
    }
    out.push('\n');

    // Recommendations for what is off.
    let recs = recommendations(inv);
    if recs.is_empty() {
        out.push_str("_Every locally-visible primitive is configured. Nothing to recommend._\n\n");
    } else {
        out.push_str("#### Recommendations\n\n");
        for r in recs {
            out.push_str(&format!("- {}\n", r));
        }
        out.push('\n');
    }

    out.push_str("_Blocking pre-check — this turn was answered locally by the Intutic proxy and not sent to your LLM provider._");
    out
}

/// Render the `/draw` card: a Mermaid + text picture of the agent's guardrails,
/// SOPs, loops/graphs and its likely trajectory for the prompt.
pub fn render_draw_card(prompt: &str, inv: &Inventory) -> String {
    let mut out = String::new();
    out.push_str("### 🎨 Intutic `/draw` — Agent Trajectory & Guardrails\n\n");

    if !prompt.is_empty() {
        out.push_str(&format!("**Prompt:** {}\n\n", prompt.lines().next().unwrap_or(prompt)));
    }

    out.push_str("```mermaid\nflowchart TD\n");
    out.push_str("  U[\"User prompt\"] --> P{\"Intutic proxy\"}\n");
    if inv.dlp_scan_input {
        out.push_str("  P -->|input DLP| DLP[\"Secrets redacted/blocked\"]\n  DLP --> POL\n");
    } else {
        out.push_str("  P --> POL\n");
    }
    if inv.policy_enforced || !inv.applicable_sops.is_empty() {
        out.push_str("  POL{\"Policy + SOP check\"}\n");
        for (i, sop) in inv.applicable_sops.iter().enumerate() {
            out.push_str(&format!("  POL -->|role SOP| S{i}[\"{}\"]\n", escape_mermaid(&sop.title)));
        }
    } else {
        out.push_str("  POL[\"No role SOPs configured\"]\n");
    }
    out.push_str("  POL --> LLM[\"LLM provider\"]\n");
    if inv.dlp_scan_output {
        out.push_str("  LLM -->|output DLP per SSE line| R[\"Response to agent\"]\n");
    } else {
        out.push_str("  LLM --> R[\"Response to agent\"]\n");
    }
    out.push_str("```\n\n");

    // A short textual trajectory.
    out.push_str("#### Likely trajectory\n\n");
    out.push_str("1. Prompt enters the proxy on the tool-call path.\n");
    out.push_str(&format!(
        "2. {} guardrail layer(s) evaluate the request before it leaves the machine.\n",
        [inv.dlp_scan_input, inv.wasm_rule_count > 0, inv.hook_gate, inv.policy_enforced].iter().filter(|b| **b).count()
    ));
    if inv.applicable_sops.is_empty() {
        out.push_str("3. No role SOPs constrain the trajectory — consider adding one under `.intutic/sops`.\n");
    } else {
        out.push_str(&format!("3. {} role SOP(s) constrain which tools the agent may call.\n", inv.applicable_sops.len()));
    }
    out.push_str("4. Response returns through output DLP, then to your harness.\n\n");

    out.push_str("_Blocking visualization — answered locally by the Intutic proxy, not sent to your LLM provider._");
    out
}

fn recommendations(inv: &Inventory) -> Vec<String> {
    let mut r = Vec::new();
    if !inv.dlp_scan_input {
        r.push("Enable **input DLP** (`intutic_settings.dlp.scan_input`) so secrets never leave the machine in a prompt.".to_string());
    }
    if !inv.dlp_scan_output {
        r.push("Enable **output DLP** (`scan_output`) — it also scrubs streaming responses per SSE line.".to_string());
    }
    if inv.wasm_rule_count == 0 {
        r.push("Add a **WASM rule** under `~/.intutic/wasm` to codify a custom guardrail.".to_string());
    }
    if inv.applicable_sops.is_empty() {
        r.push(format!("Write a **role SOP** for `{}` under `.intutic/sops` to constrain tool use.", inv.role));
    }
    r
}

fn on_off(b: bool) -> &'static str {
    if b { "✅ on" } else { "⚠️ off" }
}

fn band_emoji(band: &str) -> &'static str {
    match band {
        "green" => "🟢 green",
        "yellow" => "🟡 yellow",
        "orange" => "🟠 orange",
        _ => "🔴 red",
    }
}

fn escape_mermaid(s: &str) -> String {
    s.replace('"', "'").replace(['[', ']'], "")
}

// ── Synthetic provider-shaped response ────────────────────────────────

/// Which provider wire shape to emit. proxy.rs maps its private `Provider`
/// enum onto this so this module needs no visibility into it.
#[derive(Debug, Clone, Copy)]
pub enum WireProvider {
    Anthropic,
    OpenAI,
    Gemini,
}

/// Build the non-streaming JSON body carrying `text` as the assistant message,
/// in the given provider's shape. Returned as a `serde_json::Value` so the
/// caller controls the HTTP framing.
pub fn non_streaming_body(provider: WireProvider, model: &str, text: &str) -> serde_json::Value {
    match provider {
        WireProvider::Anthropic => serde_json::json!({
            "id": "msg_intutic_cmd",
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
            "model": model,
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": { "input_tokens": 0, "output_tokens": 0 }
        }),
        WireProvider::Gemini => serde_json::json!({
            "candidates": [{
                "content": { "parts": [{ "text": text }], "role": "model" },
                "finishReason": "STOP"
            }],
            "usageMetadata": { "promptTokenCount": 0, "candidatesTokenCount": 0, "totalTokenCount": 0 }
        }),
        WireProvider::OpenAI => serde_json::json!({
            "id": "chatcmpl-intutic-cmd",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": text },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
        }),
    }
}

/// Build the full SSE stream body carrying `text`, in the given provider's
/// streaming shape (mirrors the predict command's framing).
pub fn streaming_body(provider: WireProvider, model: &str, text: &str) -> String {
    match provider {
        WireProvider::Anthropic => {
            let start = serde_json::json!({
                "type": "message_start",
                "message": { "id": "msg_intutic_cmd", "type": "message", "role": "assistant", "content": [], "model": model, "usage": { "input_tokens": 0, "output_tokens": 0 } }
            });
            let block_start = serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } });
            let delta = serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } });
            let block_stop = serde_json::json!({ "type": "content_block_stop", "index": 0 });
            let msg_delta = serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn", "stop_sequence": null }, "usage": { "output_tokens": 0 } });
            format!(
                "event: message_start\ndata: {start}\n\nevent: content_block_start\ndata: {block_start}\n\nevent: content_block_delta\ndata: {delta}\n\nevent: content_block_stop\ndata: {block_stop}\n\nevent: message_delta\ndata: {msg_delta}\n\nevent: message_stop\ndata: {{\"type\": \"message_stop\"}}\n\n"
            )
        }
        _ => {
            let chunk = serde_json::json!({
                "id": "chatcmpl-intutic-cmd",
                "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": serde_json::Value::Null }]
            });
            format!("data: {chunk}\n\ndata: [DONE]\n\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_fix_and_draw_with_aliases() {
        assert_eq!(detect("/fix write a loop").map(|(c, _)| c), Some(Command::Fix));
        assert_eq!(detect("@fix").map(|(c, _)| c), Some(Command::Fix));
        assert_eq!(detect("/vdraw the graph").map(|(c, _)| c), Some(Command::Draw));
        assert_eq!(detect("@draw").map(|(c, _)| c), Some(Command::Draw));
        assert_eq!(detect("@intutic fix this").map(|(c, _)| c), Some(Command::Fix));
    }

    #[test]
    fn extracts_the_prompt_after_the_token() {
        let (_, prompt) = detect("/fix   refactor the auth module").unwrap();
        assert_eq!(prompt, "refactor the auth module");
    }

    #[test]
    fn strips_wrappers_before_matching() {
        let wrapped = "<system-reminder>ignore me</system-reminder>/fix hello";
        assert_eq!(detect(wrapped).map(|(c, _)| c), Some(Command::Fix));
    }

    #[test]
    fn ordinary_text_is_not_a_command() {
        assert!(detect("please fix the bug").is_none());
        assert!(detect("draw me a diagram").is_none());
    }

    #[test]
    fn fix_card_reports_missing_primitives() {
        let inv = Inventory {
            role: "engineer".into(),
            dlp_scan_input: false,
            dlp_scan_output: false,
            wasm_rule_count: 0,
            hook_gate: false,
            policy_enforced: false,
            applicable_sops: vec![],
        };
        let card = render_fix_card("write a script", &inv);
        assert!(card.contains("Recommendations"));
        assert!(card.contains("input DLP"));
        assert!(card.contains("not sent to your LLM provider"));
    }

    #[test]
    fn draw_card_is_mermaid() {
        let inv = Inventory {
            role: "engineer".into(),
            dlp_scan_input: true,
            dlp_scan_output: true,
            wasm_rule_count: 1,
            hook_gate: true,
            policy_enforced: true,
            applicable_sops: vec![],
        };
        let card = render_draw_card("build a graph", &inv);
        assert!(card.contains("```mermaid"));
        assert!(card.contains("flowchart TD"));
    }
}
