//! Role-scoped SOPs — resolving which policy text a given node should be told.
//!
//! In a multi-agent graph the nodes do different jobs, and the rules that
//! matter differ with the job. A reviewer needs the review policy; telling it
//! the deployment policy as well spends context on something it will never act
//! on, and dilutes the part it should follow.
//!
//! So each SOP declares the roles it applies to, and a node receives only the
//! ones matching the role it reported.
//!
//! # Where they come from
//!
//! `.intutic/sops/*.md` in the workspace, each optionally carrying YAML-ish
//! front matter:
//!
//! ```markdown
//! ---
//! roles: reviewer, deployer
//! ---
//! ## Review policy
//! - Never approve a change that removes a test.
//! ```
//!
//! A file with no `roles:` applies to every node, so an existing flat set of
//! SOPs keeps working untouched and gains scoping only when someone asks for
//! it.
//!
//! # Trust
//!
//! The role comes from a request header and is therefore unverifiable. That is
//! fine for *scoping* — the worst a lying node achieves is being shown the
//! wrong advice — but it is why SOP text must never be the thing standing
//! between an agent and a capability. Enforcement is the detectors and the
//! WASM rules, which do not consult the role. See ADR-009.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a resolved set is reused before the directory is re-read.
///
/// Reading and parsing every SOP on every request would put filesystem I/O in
/// the hot path. Thirty seconds is short enough that an edit shows up while
/// someone is still iterating on it.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Ceiling on injected policy text, in bytes.
///
/// Injected content is prepended to every request in the session, so its cost
/// is paid on each turn and grows the context the model must attend to. A
/// large SOP set silently doubling someone's token bill is a worse failure
/// than truncating advice they can still read in full on disk.
const MAX_INJECTED_BYTES: usize = 8 * 1024;

/// One policy document and the roles it applies to.
#[derive(Debug, Clone, PartialEq)]
pub struct Sop {
    pub title: String,
    pub body: String,
    /// Lowercased roles this applies to. Empty means every role.
    pub roles: Vec<String>,
}

impl Sop {
    /// Does this apply to a node reporting `role`?
    ///
    /// An unscoped SOP applies to everyone. A node that reported no role at
    /// all gets only the unscoped ones — it has not told us enough to receive
    /// anything more specific.
    pub fn applies_to(&self, role: &str) -> bool {
        if self.roles.is_empty() {
            return true;
        }
        if role.is_empty() {
            return false;
        }
        let role = role.to_ascii_lowercase();
        self.roles.iter().any(|r| *r == role)
    }
}

/// Split optional front matter from the body, returning `(roles, body)`.
///
/// Intentionally not a YAML parser. The one directive that matters is
/// `roles:`, and taking a YAML dependency to read a comma-separated list would
/// be a poor trade — as would silently failing to load a policy because its
/// front matter had a tab in it.
fn parse_front_matter(raw: &str) -> (Vec<String>, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (Vec::new(), raw.trim().to_string());
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        // An unterminated fence is malformed. Treat the whole file as body
        // rather than dropping the policy, so a typo cannot silently disarm a
        // rule the author believes is active.
        return (Vec::new(), raw.trim().to_string());
    };
    let (front, body) = rest.split_at(end);

    let roles = front
        .lines()
        .filter_map(|l| l.trim().strip_prefix("roles:"))
        .flat_map(|v| v.split(','))
        .map(|r| r.trim().trim_matches(['"', '\'', '[', ']']).to_ascii_lowercase())
        .filter(|r| !r.is_empty())
        .collect();

    (roles, body.trim_start_matches("\n---").trim().to_string())
}

fn read_dir_sops(dir: &Path) -> Vec<Sop> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sops: Vec<Sop> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_file() || path.extension()?.to_str()? != "md" {
                return None;
            }
            let raw = std::fs::read_to_string(&path).ok()?;
            let (roles, body) = parse_front_matter(&raw);
            if body.is_empty() {
                return None;
            }
            Some(Sop {
                title: path.file_stem()?.to_str()?.to_string(),
                body,
                roles,
            })
        })
        .collect();
    // Stable order, so the injected block does not reshuffle between requests
    // and defeat prompt caching upstream.
    sops.sort_by(|a, b| a.title.cmp(&b.title));
    sops
}

struct Cached {
    sops: Vec<Sop>,
    read_at: Instant,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

fn sops_dir() -> PathBuf {
    PathBuf::from(".intutic/sops")
}

/// All SOPs on disk, re-reading at most once per [`CACHE_TTL`].
fn all_sops() -> Vec<Sop> {
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        // A poisoned lock means another thread panicked mid-read. Falling back
        // to an uncached read keeps policy flowing rather than failing shut on
        // an unrelated fault.
        Err(p) => p.into_inner(),
    };
    if let Some(c) = guard.as_ref() {
        if c.read_at.elapsed() < CACHE_TTL {
            return c.sops.clone();
        }
    }
    let sops = read_dir_sops(&sops_dir());
    *guard = Some(Cached {
        sops: sops.clone(),
        read_at: Instant::now(),
    });
    sops
}

/// Build the governance block for a node in a given role.
///
/// Returns `None` when nothing applies, so a request with no relevant policy
/// carries no injected text at all rather than an empty header.
pub fn governance_block_for_role(role: &str) -> Option<String> {
    render(&all_sops(), role)
}

/// Rendering split out so it can be tested without touching the filesystem.
fn render(sops: &[Sop], role: &str) -> Option<String> {
    let matching: Vec<&Sop> = sops.iter().filter(|s| s.applies_to(role)).collect();
    if matching.is_empty() {
        return None;
    }

    let mut out = String::from("[Intutic Governance] Standard operating procedures in force");
    if !role.is_empty() {
        out.push_str(&format!(" for role '{role}'"));
    }
    out.push_str(":\n\n");

    let mut truncated = 0usize;
    for sop in matching {
        let section = format!("## {}\n{}\n\n", sop.title, sop.body);
        if out.len() + section.len() > MAX_INJECTED_BYTES {
            truncated += 1;
            continue;
        }
        out.push_str(&section);
    }

    if truncated > 0 {
        // Say so rather than silently dropping policy — an agent told it has
        // the full set when it does not will act with false confidence.
        out.push_str(&format!(
            "({truncated} further SOP(s) omitted to bound context size.)\n"
        ));
    }

    Some(out.trim_end().to_string())
}

/// Prepend a governance block to a request body, in whatever shape the
/// protocol expects.
///
/// Returns whether the body was modified, so the caller only pays to
/// re-serialise when there was something to add.
///
/// Prepending rather than appending is deliberate: the caller's own system
/// prompt is the more specific instruction and should be read last, closest to
/// the task. Governance is the frame it sits inside.
pub fn inject_into_body(
    body: &mut serde_json::Value,
    protocol: &crate::protocol::Protocol,
    block: &str,
) -> bool {
    use crate::protocol::Protocol;
    use serde_json::Value;

    let Some(obj) = body.as_object_mut() else {
        return false;
    };

    match protocol {
        // `system` is a string or an array of content blocks, depending on
        // which SDK produced the request. Both shapes have to survive: coercing
        // an array to a string would discard per-block cache_control markers
        // and silently disable the caller's prompt caching.
        Protocol::Anthropic => match obj.get_mut("system") {
            Some(Value::String(existing)) => {
                *existing = format!("{block}\n\n{existing}");
            }
            Some(Value::Array(blocks)) => {
                blocks.insert(
                    0,
                    serde_json::json!({ "type": "text", "text": block }),
                );
            }
            _ => {
                obj.insert("system".into(), Value::String(block.to_string()));
            }
        },

        Protocol::OpenAIChatCompletions => {
            let Some(Value::Array(messages)) = obj.get_mut("messages") else {
                return false;
            };
            messages.insert(
                0,
                serde_json::json!({ "role": "system", "content": block }),
            );
        }

        // The Responses API carries its system text in `instructions`.
        Protocol::OpenAIResponses => match obj.get_mut("instructions") {
            Some(Value::String(existing)) => {
                *existing = format!("{block}\n\n{existing}");
            }
            _ => {
                obj.insert("instructions".into(), Value::String(block.to_string()));
            }
        },

        Protocol::Gemini => {
            let existing = obj
                .get("systemInstruction")
                .and_then(|v| v.get("parts"))
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let mut parts = vec![serde_json::json!({ "text": block })];
            parts.extend(existing);
            obj.insert(
                "systemInstruction".into(),
                serde_json::json!({ "parts": parts }),
            );
        }

        // An unrecognised shape gets nothing. Guessing where system text
        // belongs risks corrupting a body we do not understand, and a
        // malformed request is a worse outcome than an un-injected one.
        Protocol::Unknown => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sop(title: &str, roles: &[&str]) -> Sop {
        Sop {
            title: title.into(),
            body: format!("- rule for {title}"),
            roles: roles.iter().map(|r| r.to_string()).collect(),
        }
    }

    #[test]
    fn unscoped_sops_apply_to_everyone() {
        let s = sop("general", &[]);
        assert!(s.applies_to("reviewer"));
        assert!(s.applies_to(""), "including a node that reported no role");
    }

    #[test]
    fn scoped_sops_only_reach_their_role() {
        let s = sop("deploy", &["deployer"]);
        assert!(s.applies_to("deployer"));
        assert!(s.applies_to("DEPLOYER"), "role match is case-insensitive");
        assert!(!s.applies_to("reviewer"));
    }

    #[test]
    fn a_roleless_node_gets_only_unscoped_policy() {
        // It has not said enough about itself to be handed role-specific
        // rules, and guessing would show the wrong policy to the wrong node.
        assert!(!sop("deploy", &["deployer"]).applies_to(""));
    }

    #[test]
    fn front_matter_is_split_from_body() {
        let (roles, body) = parse_front_matter("---\nroles: reviewer, Deployer\n---\n## Policy\n- x");
        assert_eq!(roles, vec!["reviewer", "deployer"]);
        assert_eq!(body, "## Policy\n- x");
    }

    #[test]
    fn a_file_without_front_matter_is_all_body() {
        let (roles, body) = parse_front_matter("## Policy\n- x");
        assert!(roles.is_empty());
        assert_eq!(body, "## Policy\n- x");
    }

    #[test]
    fn malformed_front_matter_keeps_the_policy() {
        // An unterminated fence is a typo. Dropping the file would silently
        // disarm a rule its author believes is active.
        let (roles, body) = parse_front_matter("---\nroles: reviewer\n## Policy");
        assert!(roles.is_empty());
        assert!(body.contains("## Policy"));
    }

    #[test]
    fn bracketed_yaml_list_form_is_accepted() {
        let (roles, _) = parse_front_matter("---\nroles: [reviewer, deployer]\n---\nbody");
        assert_eq!(roles, vec!["reviewer", "deployer"]);
    }

    #[test]
    fn render_selects_by_role() {
        let sops = vec![sop("general", &[]), sop("deploy", &["deployer"])];
        let out = render(&sops, "deployer").unwrap();
        assert!(out.contains("## general"));
        assert!(out.contains("## deploy"));
        assert!(out.contains("for role 'deployer'"));

        let out = render(&sops, "reviewer").unwrap();
        assert!(out.contains("## general"));
        assert!(!out.contains("## deploy"), "deploy policy is not this node's");
    }

    #[test]
    fn render_returns_none_when_nothing_applies() {
        // No policy means no injected text at all, not an empty header.
        assert!(render(&[sop("deploy", &["deployer"])], "reviewer").is_none());
        assert!(render(&[], "anything").is_none());
    }

    #[test]
    fn oversized_sop_sets_are_bounded_and_say_so() {
        let big: Vec<Sop> = (0..40)
            .map(|i| Sop {
                title: format!("sop-{i:02}"),
                body: "x".repeat(500),
                roles: vec![],
            })
            .collect();
        let out = render(&big, "any").unwrap();
        assert!(out.len() <= MAX_INJECTED_BYTES + 200, "stays near the cap");
        assert!(
            out.contains("omitted to bound context size"),
            "truncation must be stated, not silent"
        );
    }

    #[test]
    fn ordering_is_stable_across_reads() {
        // The injected block is prepended to every request; reshuffling it
        // would break upstream prompt caching for no benefit.
        let dir = std::env::temp_dir().join(format!("intutic-sops-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["zebra", "alpha", "middle"] {
            std::fs::write(dir.join(format!("{name}.md")), format!("- {name}")).unwrap();
        }
        let a = read_dir_sops(&dir);
        let b = read_dir_sops(&dir);
        assert_eq!(a, b);
        assert_eq!(
            a.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "middle", "zebra"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        assert!(read_dir_sops(Path::new("/nonexistent/intutic/sops")).is_empty());
    }
}

#[cfg(test)]
mod injection_tests {
    use super::*;
    use crate::protocol::Protocol;

    const BLOCK: &str = "[Intutic Governance] rules";

    #[test]
    fn anthropic_string_system_is_prepended_not_replaced() {
        let mut b = serde_json::json!({"system": "You are helpful."});
        assert!(inject_into_body(&mut b, &Protocol::Anthropic, BLOCK));
        let s = b["system"].as_str().unwrap();
        assert!(s.starts_with(BLOCK));
        assert!(
            s.contains("You are helpful."),
            "the caller's own prompt must survive"
        );
    }

    #[test]
    fn anthropic_block_array_keeps_its_structure() {
        // Coercing this to a string would discard cache_control markers and
        // silently disable the caller's prompt caching.
        let mut b = serde_json::json!({
            "system": [{"type": "text", "text": "Original", "cache_control": {"type": "ephemeral"}}]
        });
        assert!(inject_into_body(&mut b, &Protocol::Anthropic, BLOCK));
        let arr = b["system"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["text"], BLOCK);
        assert_eq!(arr[1]["text"], "Original");
        assert_eq!(
            arr[1]["cache_control"]["type"], "ephemeral",
            "cache markers must be preserved"
        );
    }

    #[test]
    fn anthropic_without_a_system_field_gains_one() {
        let mut b = serde_json::json!({"messages": []});
        assert!(inject_into_body(&mut b, &Protocol::Anthropic, BLOCK));
        assert_eq!(b["system"], BLOCK);
    }

    #[test]
    fn openai_gets_a_leading_system_message() {
        let mut b = serde_json::json!({"messages": [{"role": "user", "content": "hi"}]});
        assert!(inject_into_body(&mut b, &Protocol::OpenAIChatCompletions, BLOCK));
        let m = b["messages"].as_array().unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], BLOCK);
        assert_eq!(m[1]["content"], "hi", "the user turn is untouched");
    }

    #[test]
    fn openai_without_messages_is_left_alone() {
        // Nothing sensible to do, and inventing a messages array would send a
        // request the caller never wrote.
        let mut b = serde_json::json!({"model": "gpt-4"});
        assert!(!inject_into_body(&mut b, &Protocol::OpenAIChatCompletions, BLOCK));
        assert!(b.get("messages").is_none());
    }

    #[test]
    fn responses_api_uses_instructions() {
        let mut b = serde_json::json!({"instructions": "Be terse."});
        assert!(inject_into_body(&mut b, &Protocol::OpenAIResponses, BLOCK));
        let s = b["instructions"].as_str().unwrap();
        assert!(s.starts_with(BLOCK));
        assert!(s.contains("Be terse."));
    }

    #[test]
    fn gemini_prepends_a_system_instruction_part() {
        let mut b = serde_json::json!({
            "systemInstruction": {"parts": [{"text": "Original"}]}
        });
        assert!(inject_into_body(&mut b, &Protocol::Gemini, BLOCK));
        let parts = b["systemInstruction"]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], BLOCK);
        assert_eq!(parts[1]["text"], "Original");
    }

    #[test]
    fn gemini_without_a_system_instruction_gains_one() {
        let mut b = serde_json::json!({"contents": []});
        assert!(inject_into_body(&mut b, &Protocol::Gemini, BLOCK));
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], BLOCK);
    }

    #[test]
    fn a_non_object_body_is_refused() {
        let mut b = serde_json::json!(["not", "an", "object"]);
        assert!(!inject_into_body(&mut b, &Protocol::Anthropic, BLOCK));
    }
}

#[cfg(test)]
mod unknown_protocol_test {
    use super::*;
    use crate::protocol::Protocol;

    #[test]
    fn unknown_protocol_bodies_are_left_untouched() {
        let original = serde_json::json!({"something": "unfamiliar"});
        let mut b = original.clone();
        assert!(!inject_into_body(&mut b, &Protocol::Unknown, "block"));
        assert_eq!(b, original, "an unparsed body must not be mutated");
    }
}
