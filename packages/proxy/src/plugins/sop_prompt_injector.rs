//! SOP Prompt Injector Plugin — HLD §3.14 (Universal MCP Governance)
//!
//! Injects an SOP governance notice as a system-level message prefix on
//! every LLM request. The notice informs the LLM that it is operating under
//! active workspace SOPs, making governance context available to the model
//! for self-directed compliance.
//!
//! # Behaviour
//!
//! - Fetches active SOP rules from the Intutic control plane every 60 s
//!   (cached in a process-level `OnceLock<Mutex<CachedRules>>`).
//! - On every request: returns a `Verdict::Enhance` carrying the governance
//!   notice as additional system context.
//! - If the control plane is unreachable: injects a minimal fallback notice.
//! - Never returns `Verdict::Kill` — this plugin is informational only.
//!
//! # Plugin priority
//!
//! Priority **20** — runs after security gates (DLP at 5, budget at 10,
//! PCAS at 15) so that blocking decisions are made first.
//!
//! # TD-150: SOP Prompt Injector Plugin
//!
//! Phase 4 WS-4D D2

use std::env;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::plugins::IntuticPlugin;
use crate::wasm::context::{RequestContext, Verdict};

/// Cached SOP rules with a 60-second TTL.
struct CachedRules {
    rule_count: usize,
    fetched_at: Instant,
}

static CACHED_RULES: OnceLock<Mutex<Option<CachedRules>>> = OnceLock::new();
const CACHE_TTL: Duration = Duration::from_secs(60);

/// SOP prompt injector plugin.
pub struct SopPromptInjectorPlugin;

impl SopPromptInjectorPlugin {
    pub fn new() -> Self {
        Self
    }

    /// Return the number of active SOP rules for this workspace.
    ///
    /// Uses a process-level cache with 60-second TTL. If the control plane
    /// is unreachable or returns an error, returns `None` (fallback notice used).
    fn active_rule_count() -> Option<usize> {
        let control_plane_url = env::var("INTUTIC_CONTROL_PLANE_URL")
            .unwrap_or_else(|_| "http://localhost:3001".into());
        let workspace_id = env::var("INTUTIC_WORKSPACE_ID").unwrap_or_else(|_| "unknown".into());
        let api_key = env::var("INTUTIC_API_KEY").unwrap_or_default();

        let cache = CACHED_RULES.get_or_init(|| Mutex::new(None));

        // Check cache validity
        {
            let guard = cache.lock().ok()?;
            if let Some(ref cached) = *guard {
                if cached.fetched_at.elapsed() < CACHE_TTL {
                    return Some(cached.rule_count);
                }
            }
        }

        // Fetch fresh rules (blocking HTTP — intentionally simple for low-freq 60s refresh)
        let url = format!(
            "{}/api/v1/sop/rules?workspaceId={}&active=true",
            control_plane_url,
            urlencoding_simple(&workspace_id)
        );

        let count = match ureq_get_json_rule_count(&url, &api_key) {
            Ok(n) => n,
            Err(_) => return None,
        };

        // Store in cache
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(CachedRules {
                rule_count: count,
                fetched_at: Instant::now(),
            });
        }

        Some(count)
    }
}

impl Default for SopPromptInjectorPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl IntuticPlugin for SopPromptInjectorPlugin {
    fn name(&self) -> &str {
        "sop-prompt-injector"
    }

    fn priority(&self) -> u8 {
        20
    }

    fn evaluate(&self, _ctx: &RequestContext) -> Verdict {
        let notice = match Self::active_rule_count() {
            Some(0) => {
                // No active SOPs — minimal notice
                "[Intutic Governance] This session is monitored. No active SOP block rules.".into()
            }
            Some(n) => {
                format!(
                    "[Intutic Governance] This session is governed by {n} active SOP rule{s}. \
                     Tool calls are monitored and may be blocked for policy compliance.",
                    n = n,
                    s = if n == 1 { "" } else { "s" }
                )
            }
            None => {
                // Fallback when control plane is unreachable
                "[Intutic Governance] This session is monitored by Intutic governance proxy. \
                 Governance policies are enforced at the tool call level."
                    .into()
            }
        };

        Verdict::Enhance { context: notice }
    }
}

/// Minimal URL encoding for the workspace ID (replaces spaces with %20).
fn urlencoding_simple(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".into(),
            '&' => "%26".into(),
            '+' => "%2B".into(),
            _ => c.to_string(),
        })
        .collect()
}

/// Perform a blocking HTTP GET and return the count of rules in the response JSON.
///
/// Uses only `std::net` to avoid adding a heavy HTTP dep — this is a small
/// JSON payload on a fast local network.
fn ureq_get_json_rule_count(url: &str, api_key: &str) -> Result<usize, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let parsed_url = url.parse::<String>().map_err(|e| e.to_string())?;

    // Extract host + path from URL manually (avoid url crate dep)
    let without_scheme = parsed_url
        .strip_prefix("http://")
        .or_else(|| parsed_url.strip_prefix("https://"))
        .ok_or_else(|| format!("Unsupported scheme: {}", parsed_url))?;

    let slash_pos = without_scheme.find('/').unwrap_or(without_scheme.len());
    let host_port = &without_scheme[..slash_pos];
    let path = if slash_pos < without_scheme.len() {
        &without_scheme[slash_pos..]
    } else {
        "/"
    };

    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{}:80", host_port)
    };

    let mut stream = TcpStream::connect(&addr).map_err(|e| format!("Connection failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        path, host_port, api_key
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);

    // Skip headers
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
    }

    // Read body
    let mut body = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => body.push_str(&line),
            Err(_) => break,
        }
    }

    // Parse rule count from JSON: {"ok":true,"rules":[...]}
    // Simple string search — avoids serde_json dep at this site
    let rules_count = count_json_array_items(&body, "rules");
    Ok(rules_count)
}

/// Count JSON array items by finding `"key":[...]` and counting top-level commas.
/// Fast, allocation-light approximation — good enough for a rule count.
fn count_json_array_items(json: &str, key: &str) -> usize {
    let search = format!("\"{}\":[", key);
    let start = match json.find(&search) {
        Some(pos) => pos + search.len(),
        None => return 0,
    };
    let slice = &json[start..];
    if slice.starts_with(']') {
        return 0;
    }
    // Count items by depth-0 commas
    let mut depth = 0usize;
    let mut count = 1usize;
    for ch in slice.chars() {
        match ch {
            '[' | '{' => depth += 1,
            ']' | '}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            ',' if depth == 0 => count += 1,
            _ => {}
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_json_array_items_empty() {
        assert_eq!(count_json_array_items(r#"{"rules":[]}"#, "rules"), 0);
    }

    #[test]
    fn count_json_array_items_one() {
        assert_eq!(
            count_json_array_items(
                r#"{"rules":[{"id":"r1","toolPattern":"Bash","action":"block","reason":"no bash"}]}"#,
                "rules"
            ),
            1
        );
    }

    #[test]
    fn count_json_array_items_three() {
        assert_eq!(
            count_json_array_items(
                r#"{"rules":[{"id":"r1"},{"id":"r2"},{"id":"r3"}]}"#,
                "rules"
            ),
            3
        );
    }

    #[test]
    fn urlencoding_simple_preserves_normal() {
        assert_eq!(urlencoding_simple("ws_abc123"), "ws_abc123");
    }

    #[test]
    fn urlencoding_simple_encodes_spaces() {
        assert_eq!(urlencoding_simple("my workspace"), "my%20workspace");
    }

    #[test]
    fn plugin_returns_enhance_verdict() {
        let plugin = SopPromptInjectorPlugin::new();
        let ctx = crate::wasm::context::RequestContext {
            session_id: "s1".into(),
            workspace_id: "ws1".into(),
            virtual_key_prefix: "vk1".into(),
            model: "claude-3-5-sonnet".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 100,
            budget_remaining_usd: 5.0,
            risk_tier: crate::wasm::context::RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: vec![],
        };
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Enhance { .. }));
    }
}
