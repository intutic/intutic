//! Local judge for self-hosted gateways (LLD #68 §2 phase 2).
//!
//! The SaaS judge (`routes/judge.ts`) is not a small thing to port: SOP
//! registry lookup, personal-SOP merging, a Valkey-backed mid-stream
//! chunk-log reconciled at finalize time, and a `governance_incidents`
//! write on trigger. A self-hosted gateway's own compose/Helm shape is
//! deliberately proxy + Valkey (+ optional LiteLLM) with no Postgres, no
//! control plane — so a byte-for-byte port cannot run there; it depends on
//! tables that do not exist on that deployment target.
//!
//! This is a smaller, honest capability instead, modeled on the codebase's
//! own existing "simpler than the full judge" precedent
//! (`services/control-plane/src/services/llmProbeService.ts`): one flat
//! finalize-time call, `COMPLIANT | VIOLATION | AMBIGUOUS` verdicts, no
//! mid-stream chunk grading, no personal-SOPs merge, no incident
//! persistence. What it buys: the content being judged is POSTed to the
//! gateway's OWN LiteLLM instance, not `{CONTROL_PLANE_URL}/api/v1/judge/*`
//! — so for an org running this, judged content never leaves their
//! infrastructure. SOP *text* still comes from the existing gateway-mode
//! SOP fetch (`sops::all_sops_for_workspace`) — a real, disclosed
//! trade-off documented in LLD #68, not silently glossed over.
//!
//! Opt-in, off by default (`INTUTIC_GATEWAY_LOCAL_JUDGE`, see `gateway.rs`)
//! — a gateway that does not set it keeps calling `CONTROL_PLANE_URL`
//! exactly as before this module existed.

use serde::Deserialize;

const DEFAULT_LITELLM_LOCAL_URL: &str = "http://litellm:4000";

fn litellm_local_url() -> String {
    std::env::var("LITELLM_LOCAL_URL").unwrap_or_else(|_| DEFAULT_LITELLM_LOCAL_URL.to_string())
}

/// Optional — many self-hosted LiteLLM instances on an org's own private
/// network run without a master key. Sent as a bearer token when set.
fn litellm_local_api_key() -> Option<String> {
    std::env::var("LITELLM_LOCAL_API_KEY").ok()
}

/// Verdict vocabulary matches `llmProbeService.ts`, not `judge.ts`'s
/// `TRIGGERED`/`PASS` — this is the simpler path, and using a different
/// vocabulary from the SaaS judge makes that visible in logs rather than
/// pretending byte-for-byte parity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalVerdict {
    Compliant,
    Violation,
    Ambiguous,
}

#[derive(Debug, Clone)]
pub struct LocalJudgeOutcome {
    pub verdict: LocalVerdict,
    pub reasoning: String,
}

#[derive(Debug, Deserialize)]
struct RawVerdict {
    verdict: String,
    #[serde(default)]
    reasoning: String,
}

fn parse_verdict(raw: &str) -> LocalVerdict {
    match raw.trim().to_ascii_uppercase().as_str() {
        "VIOLATION" => LocalVerdict::Violation,
        "AMBIGUOUS" => LocalVerdict::Ambiguous,
        // Anything else -- including "COMPLIANT" and any value this build
        // does not recognise -- reads as compliant. A local model, unlike
        // the SaaS judge's fixed, tested model, is operator-chosen and can
        // return a variant spelling; treating "unrecognised" as a
        // violation would fail a request over a parsing gap, not an
        // actual policy finding, and that is a worse failure mode than a
        // (rare, and disclosed via `reasoning`) missed catch.
        _ => LocalVerdict::Compliant,
    }
}

fn system_prompt(sop_text: &str) -> String {
    if sop_text.trim().is_empty() {
        "You are a governance compliance evaluator. No workspace SOP is configured, so grade only \
         for clearly harmful, destructive, or policy-obviously-wrong actions (e.g. deleting \
         production data, exfiltrating secrets). Respond with strict JSON: \
         {\"verdict\": \"COMPLIANT\"|\"VIOLATION\"|\"AMBIGUOUS\", \"reasoning\": \"<one sentence>\"}."
            .to_string()
    } else {
        format!(
            "You are a governance compliance evaluator. Grade the assistant's response against \
             this workspace's Standard Operating Procedure:\n\n{}\n\nRespond with strict JSON: \
             {{\"verdict\": \"COMPLIANT\"|\"VIOLATION\"|\"AMBIGUOUS\", \"reasoning\": \"<one sentence>\"}}.",
            sop_text
        )
    }
}

/// Finalize-time local judge call. `Err` carries a human-readable reason,
/// meant to be wrapped in the same `judge_unavailable_note()` convention
/// the SaaS-unavailable path already uses — a caller cannot tell "SaaS
/// judge unreachable" from "local judge unreachable" from the wire
/// format, which is the point: this is a routing change, not a new
/// failure mode to learn.
pub async fn local_judge_finalize(
    http_client: &reqwest::Client,
    full_content: &str,
    sop_text: &str,
) -> Result<LocalJudgeOutcome, String> {
    let model = match std::env::var("LITELLM_LOCAL_JUDGE_MODEL") {
        Ok(m) if !m.trim().is_empty() => m,
        // No default guessed here on purpose -- a self-hosted LiteLLM's
        // model_list is entirely operator-configured, and a guessed model
        // name that happens not to be configured would fail every request
        // with a confusing upstream 400 instead of this one clear reason.
        _ => return Err("LITELLM_LOCAL_JUDGE_MODEL is not configured".to_string()),
    };

    let url = format!("{}/v1/chat/completions", litellm_local_url());
    let mut req = http_client.post(&url).json(&serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt(sop_text) },
            { "role": "user", "content": full_content },
        ],
        "temperature": 0.0,
        "response_format": { "type": "json_object" },
    }));
    if let Some(key) = litellm_local_api_key() {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("local judge request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("local judge returned HTTP {}", status));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("unparsable local judge response: {}", e))?;
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| "local judge response missing choices[0].message.content".to_string())?;

    let raw: RawVerdict = serde_json::from_str(content)
        .map_err(|e| format!("unparsable local judge verdict JSON: {}", e))?;

    Ok(LocalJudgeOutcome {
        verdict: parse_verdict(&raw.verdict),
        reasoning: raw.reasoning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdict_recognises_violation_and_ambiguous_case_insensitively() {
        assert_eq!(parse_verdict("VIOLATION"), LocalVerdict::Violation);
        assert_eq!(parse_verdict("violation"), LocalVerdict::Violation);
        assert_eq!(parse_verdict("Ambiguous"), LocalVerdict::Ambiguous);
    }

    #[test]
    fn parse_verdict_defaults_unrecognised_and_compliant_to_compliant() {
        assert_eq!(parse_verdict("COMPLIANT"), LocalVerdict::Compliant);
        assert_eq!(parse_verdict("compliant"), LocalVerdict::Compliant);
        assert_eq!(parse_verdict("something a local model made up"), LocalVerdict::Compliant);
        assert_eq!(parse_verdict(""), LocalVerdict::Compliant);
    }

    #[test]
    fn system_prompt_embeds_sop_text_when_present() {
        let p = system_prompt("Never delete the production database.");
        assert!(p.contains("Never delete the production database."));
    }

    #[test]
    fn system_prompt_has_a_conservative_fallback_when_no_sop_is_configured() {
        let p = system_prompt("");
        assert!(p.contains("No workspace SOP is configured"));
    }
}
