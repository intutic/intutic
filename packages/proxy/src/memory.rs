//! Local memory-vault search for the `/fix` command (open core).
//!
//! The enterprise `/fix` path searches cloud memory providers from the control
//! plane; this module is the local-first counterpart: a deterministic keyword
//! search over markdown vaults on the developer's own machine — Obsidian
//! (detected by its `.obsidian` marker directory), Logseq, Foam, or any plain
//! folder of notes named in `intutic_settings.memory.vaults`.
//!
//! Everything here is bounded and local: no network, no model call, hard caps
//! on files walked and bytes read, so a huge vault costs milliseconds, not a
//! hang. In blocking `/fix` the snippets never leave the machine; in
//! non-blocking mode the rewritten prompt still passes input DLP afterwards,
//! so a token pasted into a note gets redacted before egress.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// How many ancestor directories to probe for a `.obsidian` marker.
const MAX_ANCESTOR_WALK: usize = 8;
/// Hard cap on markdown files considered per search.
const MAX_FILES: usize = 2_000;
/// Skip any note larger than this — likely an export, not a note.
const MAX_FILE_BYTES: u64 = 256 * 1024;
/// How many snippets a search returns at most.
const MAX_CHUNKS: usize = 5;
/// Directories never worth walking inside a vault.
const SKIP_DIRS: [&str; 6] = [".obsidian", ".trash", ".git", "node_modules", ".logseq", ".foam"];
/// Marker directories that identify a folder as a notes vault.
const VAULT_MARKERS: [&str; 3] = [".obsidian", ".logseq", ".foam"];
/// Characters of context returned around a match.
const SNIPPET_CHARS: usize = 240;
/// Terms shorter than this are too common to discriminate on.
const MIN_TERM_LEN: usize = 4;

/// One matching passage from a vault note.
#[derive(Debug, Clone)]
pub struct VaultChunk {
    /// Display name of the vault the note came from (its directory name).
    pub vault: String,
    /// Note file stem, e.g. `architecture-decisions`.
    pub note: String,
    /// The matching passage.
    pub text: String,
    /// Relevance score; higher is better. Deterministic, no model involved.
    pub score: u32,
}

/// Should vault search run at all?
///
/// Two gates compose: the developer's own `memory.enabled` config, and the
/// workspace policy (`allowLocalMemoryVaults`) which arrives as the
/// `INTUTIC_LOCAL_VAULTS` env var set by `intutic connect` at proxy spawn —
/// "off" disables. Policy changes apply on the next connect; content never
/// leaves the machine under either setting.
pub fn vaults_allowed(config_enabled: bool, env_value: Option<&str>) -> bool {
    config_enabled && env_value != Some("off")
}

/// Expand a leading `~` against `$HOME`. Paths are user-authored config, so
/// this is the one shell-ism worth honouring.
fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}

/// Is this directory a notes vault (carries a known marker directory)?
fn is_vault(dir: &Path) -> bool {
    VAULT_MARKERS.iter().any(|m| dir.join(m).is_dir())
}

/// Vaults to search: everything configured, plus any vault found by walking up
/// from the working directory.
///
/// Auto-detection means a developer whose repo lives inside their Obsidian
/// vault gets memory with no configuration at all; `vaults` exists for the
/// common case where notes live somewhere else entirely.
pub fn discover_vaults(configured: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for raw in configured {
        let path = expand_home(raw);
        if path.is_dir() && seen.insert(path.clone()) {
            out.push(path);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for dir in cwd.ancestors().take(MAX_ANCESTOR_WALK) {
            if is_vault(dir) && seen.insert(dir.to_path_buf()) {
                out.push(dir.to_path_buf());
            }
        }
    }

    out
}

/// Distinct, lowercased query terms worth matching on.
fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= MIN_TERM_LEN)
        .map(|w| w.to_ascii_lowercase())
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

/// Collect markdown files under `root`, breadth-bounded and skipping the
/// directories that are never notes.
fn collect_notes(root: &Path, budget: &mut usize) -> Vec<PathBuf> {
    let mut notes = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if *budget == 0 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if *budget == 0 {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();

            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.') {
                    stack.push(path);
                }
                continue;
            }

            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            notes.push(path);
            *budget -= 1;
        }
    }

    notes
}

/// Extract a readable passage around the first match, on a character boundary.
fn snippet_around(body: &str, at: usize) -> String {
    let start = body[..at]
        .char_indices()
        .rev()
        .take(SNIPPET_CHARS / 2)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = body[at..]
        .char_indices()
        .take(SNIPPET_CHARS / 2)
        .last()
        .map(|(i, c)| at + i + c.len_utf8())
        .unwrap_or(body.len());

    let mut text = body[start..end].trim().replace('\n', " ");
    while text.contains("  ") {
        text = text.replace("  ", " ");
    }
    text
}

/// Score one note against the query terms, returning its best passage.
///
/// Distinct terms matched dominates raw hit count: a note mentioning both
/// "postgres" and "migration" once beats one that says "postgres" ten times.
fn score_note(path: &Path, terms: &[String]) -> Option<(u32, String)> {
    let body = std::fs::read_to_string(path).ok()?;
    let haystack = body.to_ascii_lowercase();

    let mut distinct = 0u32;
    let mut hits = 0u32;
    let mut first_match: Option<usize> = None;

    for term in terms {
        let mut found = false;
        let mut from = 0usize;
        while let Some(rel) = haystack[from..].find(term.as_str()) {
            let at = from + rel;
            found = true;
            hits += 1;
            first_match = Some(first_match.map_or(at, |cur: usize| cur.min(at)));
            from = at + term.len();
            if hits > 64 {
                break; // bounded: a term repeated endlessly adds nothing
            }
        }
        if found {
            distinct += 1;
        }
    }

    if distinct == 0 {
        return None;
    }
    let at = first_match.unwrap_or(0);
    Some((distinct * 10 + hits.min(10), snippet_around(&body, at)))
}

/// Search the developer's local vaults for passages relevant to `query`.
///
/// Returns at most [`MAX_CHUNKS`] passages, best first. An empty result is the
/// normal case for a developer with no vault, and costs one failed directory
/// probe.
pub fn search(query: &str, configured: &[String]) -> Vec<VaultChunk> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Vec::new();
    }

    let mut budget = MAX_FILES;
    let mut scored: Vec<VaultChunk> = Vec::new();

    for vault in discover_vaults(configured) {
        let vault_name = vault
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "vault".to_string());

        for note in collect_notes(&vault, &mut budget) {
            if let Some((score, text)) = score_note(&note, &terms) {
                scored.push(VaultChunk {
                    vault: vault_name.clone(),
                    note: note
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    text,
                    score,
                });
            }
        }
    }

    scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.note.cmp(&b.note)));
    scored.truncate(MAX_CHUNKS);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_policy_off_beats_local_config_on() {
        assert!(vaults_allowed(true, None));
        assert!(vaults_allowed(true, Some("on")));
        assert!(!vaults_allowed(true, Some("off")), "workspace policy must win");
        assert!(!vaults_allowed(false, None), "developer's own config still counts");
    }

    /// Build a throwaway vault; returns its root.
    fn make_vault(tag: &str, marker: Option<&str>, notes: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("intutic-vault-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        if let Some(m) = marker {
            std::fs::create_dir_all(root.join(m)).unwrap();
        }
        for (name, body) in notes {
            std::fs::write(root.join(name), body).unwrap();
        }
        root
    }

    #[test]
    fn finds_the_relevant_note_and_ranks_it_first() {
        let vault = make_vault(
            "rank",
            Some(".obsidian"),
            &[
                ("infra.md", "We run postgres with pgbouncer. Migrations go through the pipeline."),
                ("lunch.md", "Team likes ramen on Thursdays."),
            ],
        );
        let hits = search("postgres migration policy", &[vault.to_string_lossy().into_owned()]);
        assert!(!hits.is_empty(), "expected a match");
        assert_eq!(hits[0].note, "infra");
        assert!(hits[0].text.contains("postgres"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_note_matching_two_terms_outranks_one_matching_one() {
        let vault = make_vault(
            "distinct",
            Some(".obsidian"),
            &[
                ("both.md", "postgres migration checklist"),
                ("one.md", "postgres postgres postgres postgres"),
            ],
        );
        let hits = search("postgres migration", &[vault.to_string_lossy().into_owned()]);
        assert_eq!(hits[0].note, "both", "distinct-term coverage must beat repetition");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn no_vault_and_no_match_return_nothing_rather_than_erroring() {
        assert!(search("anything at all", &["/nonexistent/intutic/vault".into()]).is_empty());
        let vault = make_vault("empty", Some(".obsidian"), &[("x.md", "unrelated prose")]);
        assert!(search("postgres migration", &[vault.to_string_lossy().into_owned()]).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn short_query_terms_are_ignored_so_the_and_of_do_not_match_everything() {
        let vault = make_vault("stop", Some(".obsidian"), &[("n.md", "the and of a to it is")]);
        assert!(search("the and of", &[vault.to_string_lossy().into_owned()]).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn marker_directories_and_dotfolders_are_not_walked() {
        let vault = make_vault("skip", Some(".obsidian"), &[("real.md", "postgres migration")]);
        // A note hidden inside the marker dir must not be returned.
        std::fs::write(vault.join(".obsidian").join("cache.md"), "postgres migration cache").unwrap();
        let hits = search("postgres migration", &[vault.to_string_lossy().into_owned()]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note, "real");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn oversized_notes_are_skipped() {
        let big = "postgres migration ".repeat(20_000); // > 256 KiB
        let vault = make_vault("big", Some(".obsidian"), &[("huge.md", big.as_str())]);
        assert!(search("postgres migration", &[vault.to_string_lossy().into_owned()]).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_configured_folder_needs_no_marker_directory() {
        let vault = make_vault("plain", None, &[("notes.md", "postgres migration runbook")]);
        let hits = search("postgres migration", &[vault.to_string_lossy().into_owned()]);
        assert_eq!(hits.len(), 1, "explicitly configured folders are vaults by decree");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn snippets_do_not_split_multibyte_characters() {
        let body = format!("{} postgres migration {}", "é".repeat(200), "ü".repeat(200));
        let vault = make_vault("utf8", Some(".obsidian"), &[("u.md", body.as_str())]);
        let hits = search("postgres migration", &[vault.to_string_lossy().into_owned()]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("postgres"));
        let _ = std::fs::remove_dir_all(&vault);
    }
}
