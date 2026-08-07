//! The files a tool call names, read by the HOST and handed to the guest.
//!
//! # Why this exists
//!
//! A governance rule evaluating `kubectl apply -f k8s/deploy.yaml` could see the
//! *path* and nothing else. Every interesting question about a deploy — is the
//! image pinned to a digest, does the pod run as root, is a Secret being
//! mounted — lives in the file, not in the command line. So the one extension
//! point the product offers could not express the rules people actually want.
//!
//! # Why the host reads the file and not the guest
//!
//! The obvious shape — give the sandbox filesystem imports — is the wrong one.
//! A governance sandbox that can open `/etc/shadow` is a worse problem than the
//! one it was added to solve: rules arrive from a dashboard, are authored by
//! whoever can reach it, and run inside the proxy's own process. WASI is
//! deliberately not linked (`host::check_imports_resolvable` refuses
//! `wasi_snapshot_preview1` by construction) and that stays true.
//!
//! Instead the **host** decides what is readable, resolves it, reads it, and
//! exposes the bytes through one narrow import. The guest names a path; it can
//! never open one. Every guard below is applied before the sandbox is even
//! instantiated, so a rule cannot race, retry, or probe its way past them — the
//! answer for a given request is computed once and is thereafter a fixed table.
//!
//! # The guards, and what each one is for
//!
//! 1. **Referenced-only.** The candidate set is derived from *this request's*
//!    tool-call arguments ([`candidate_tokens`]). A path the agent did not name
//!    is not in the table and is refused. This is what stops a rule from using
//!    the import as a general file-read oracle.
//! 2. **Extension allowlist.** A candidate must end in a manifest extension
//!    ([`MANIFEST_EXTENSIONS`]). This is the guard that keeps `/etc/shadow`
//!    unreadable *even when a tool call names it* — belt and braces, because
//!    guard 1 is only as good as the tool-argument parsing, and that parses
//!    attacker-influenced strings.
//! 3. **No traversal.** Any `..` component is refused lexically, before the
//!    path is ever handed to the filesystem.
//! 4. **Root confinement.** Relative paths are joined onto a configured root;
//!    absolute paths are permitted only if they land inside it. The check is
//!    made against the *canonicalised* path, so a symlink pointing out of the
//!    root is caught by the same test.
//! 5. **Regular files only.** A FIFO would block the read; a device would not
//!    be a manifest.
//! 6. **Size cap.** Both the `stat` and the read itself are bounded, so a file
//!    that grows between them cannot exceed the cap.
//! 7. **Opt-in.** With no root configured there is no table at all and every
//!    read is refused. A capability like this should be off until an operator
//!    says where it may point.
//!
//! # What this costs
//!
//! * **The verdict stops being a pure function of the request.** Two identical
//!   requests can now get different answers if the file changed in between.
//!   Replay of a stored request cannot reproduce a verdict unless the tree is
//!   also reproduced. That is inherent to the feature — a rule that reads a
//!   manifest is by definition a function of the manifest — but it is a real
//!   loss against the determinism argument that keeps `env.seed` out of
//!   [`super::host::HOST_IMPORTS`]. It is mitigated, not fixed, by logging a
//!   content hash for every read so a replay discrepancy is explainable rather
//!   than merely puzzling.
//! * **The request path gains disk I/O.** Bounded (at most
//!   [`MAX_REFERENCED_FILES`] files of [`MAX_REFERENCED_FILE_BYTES`] each) and
//!   performed only when a loaded rule actually imports the function, but it is
//!   not free, and on a cold page cache or a network filesystem it is the
//!   slowest thing the governance path does. See [`read_tokens`] for why it is
//!   nevertheless done here rather than inside the sandbox.
//!
//! # What confinement does NOT close
//!
//! * **Hard links.** Guard 4 confines the *canonicalised* path, which resolves
//!   symlinks — a symlink out of the root is caught. A hard link is not a path
//!   indirection: the inode simply has a second name, and if that name is
//!   inside the root then `canonicalize` returns a confined path and the read
//!   succeeds. Verified by experiment, not assumed: a hard link placed inside
//!   the root to a file outside it returns that file's contents.
//!
//!   The precondition is write access inside the root, on the same filesystem.
//!   That is the same precondition as the symlink TOCTOU below — and an
//!   attacker who has it can put the content in the root directly, so this
//!   grants no capability they lacked. It is recorded because a threat model
//!   that lists symlink escape and omits hard links reads as though both were
//!   considered, and the next person to extend this should know which one was.
//!
//!   Closing it means comparing `st_dev`/`st_ino` against an inode allowlist,
//!   or `st_nlink == 1`, neither of which is free of false positives on a
//!   normal checkout.
//!
//! * **TOCTOU on the resolved path.** A component swapped between
//!   `canonicalize` and the read wins. Closing it needs
//!   `openat2(RESOLVE_BENEATH)`, which is Linux-only.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::context::RequestContext;

/// Largest file the host will hand to a guest.
///
/// 256 KiB is far above a Kubernetes manifest or a Terraform plan fragment and
/// far below anything that would matter against the 16 MiB store limit. A file
/// over the cap is **refused, not truncated**: a rule that scans a prefix for
/// `:latest` and does not find it would allow a deploy whose offending image
/// sits in the part that was cut off, which is a governance bypass dressed up
/// as a convenience. The refusal is distinguishable ([`ERR_TOO_LARGE`]) so a
/// rule can escalate on it rather than mistaking it for "nothing to see".
pub const MAX_REFERENCED_FILE_BYTES: usize = 256 * 1024;

/// Most files one request may make readable.
///
/// A single `kubectl apply` names one or two manifests. The cap exists so a
/// tool call carrying a hundred paths cannot turn one request into a hundred
/// reads on the hot path.
pub const MAX_REFERENCED_FILES: usize = 8;

/// Longest path string the guest may pass across the boundary.
///
/// `PATH_MAX` on Linux, and a bound on how much guest memory we will decode
/// before deciding the argument is nonsense.
pub const MAX_GUEST_PATH_BYTES: usize = 4096;

/// How much of a shell command is scanned for paths.
///
/// Tokenisation is linear, but the command string is agent-supplied and
/// unbounded; a megabyte of it on the request path is not worth the two paths
/// it might contain past this point.
const MAX_COMMAND_SCAN_BYTES: usize = 64 * 1024;

// ── Guest-visible return codes ──────────────────────────────────────────────
//
// A negative return is always a refusal and never a trap. The host must not
// abort the guest for asking a bad question: an abort would kill the whole
// evaluation, and the runner converts a failed evaluation into `Bypass` — so a
// rule that made one malformed call would silently stop enforcing everything
// else it checks. Refusals are values, deliberately.

/// The call itself was malformed: pointers outside guest memory, a negative
/// length, a path that is not UTF-8, or no `memory` export to read from.
pub const ERR_BAD_ARGS: i32 = -1;
/// The host will not read this path. Either the request's tool calls never
/// named it, or it failed a path guard (traversal, outside the root, a symlink
/// leading out of the root, not a regular file). Deliberately one code: the
/// distinction is interesting to an operator, who gets it in the log, and not
/// to the guest, which supplied the path in the first place.
pub const ERR_REFUSED: i32 = -2;
/// Named by the tool call and allowed by every guard, but not on disk. This is
/// worth telling a rule apart from a refusal — an agent applying a manifest
/// that does not exist is itself a finding.
pub const ERR_NOT_FOUND: i32 = -3;
/// Larger than [`MAX_REFERENCED_FILE_BYTES`]. No bytes are exposed.
pub const ERR_TOO_LARGE: i32 = -4;
/// `out_cap` was positive but smaller than the content. Nothing was written —
/// a partial copy would look like a short file to the guest. Call with
/// `out_cap == 0` first to learn the size.
pub const ERR_BUFFER_TOO_SMALL: i32 = -5;
/// This evaluation has used its allowance of host reads. See
/// [`MAX_READS_PER_EVALUATION`].
pub const ERR_BUDGET: i32 = -6;

/// Host reads one evaluation may make.
///
/// The 5 ms wall-clock timeout in the runner cannot preempt a synchronous
/// guest call, so the real bound on guest work is fuel — and fuel counts
/// instructions, not the bytes a host function copies on the guest's behalf. A
/// tight loop calling this import would therefore buy an unbounded memcpy for a
/// handful of fuel. This budget is the bound instead: at worst
/// 64 × 256 KiB ≈ 16 MiB of copying, which is a millisecond or two.
///
/// A rule needs two calls per file (size query, then read), so this is eight
/// times what [`MAX_REFERENCED_FILES`] can justify.
pub const MAX_READS_PER_EVALUATION: u32 = 64;

/// Environment variable naming the directory referenced files may be read from.
///
/// An env var rather than a `intutic_settings` key because the settings struct
/// is owned elsewhere; promoting this to config is the natural follow-up and
/// changes nothing here but [`resolve_root`].
pub const MANIFEST_ROOT_ENV: &str = "INTUTIC_WASM_MANIFEST_ROOT";

/// Extensions a candidate path must carry.
///
/// This is guard 2 from the module docs, and the reason it is an allowlist of
/// *extensions* rather than a denylist of sensitive paths: a denylist has to
/// enumerate every secret on every host, and an allowlist has to enumerate the
/// handful of formats a deploy manifest comes in.
///
/// `Dockerfile` and `Makefile` are deliberately absent. They have no extension,
/// and admitting extension-less basenames is exactly the weakening that puts
/// `/etc/shadow` — basename `shadow`, no extension — back in reach of a parsing
/// mistake. Adding one is a decision to make on purpose, with that in mind.
const MANIFEST_EXTENSIONS: &[&str] = &["yaml", "yml", "json", "tf", "tfvars", "hcl", "toml"];

/// Tool-argument keys whose value is a single path.
///
/// Kept here rather than shared with `manifest::PATH_KEYS`, which answers a
/// different question: that list records what a call *touched* and is allowed
/// to be generous, because being wrong there produces a noisy audit entry. This
/// list decides what may be *read*, where being wrong produces a disclosure. A
/// key belongs here only if its value is unambiguously a filesystem path.
const PATH_ARG_KEYS: &[&str] = &[
    "file_path",
    "filepath",
    "path",
    "filename",
    "target_file",
    "notebook_path",
    "manifest",
];

/// Tool-argument keys carrying a shell command to be tokenised.
const COMMAND_ARG_KEYS: &[&str] = &["command", "cmd", "script"];

/// What the host determined about one candidate path.
enum Outcome {
    Content(Vec<u8>),
    /// Refused by a guard. The `&'static str` is for the operator log; the
    /// guest only ever sees [`ERR_REFUSED`].
    Refused(&'static str),
    NotFound,
    TooLarge(u64),
}

/// The fixed table of what this request's rules may read.
///
/// Built once per request, before any sandbox is instantiated, and shared by
/// every rule that runs against that request.
pub struct ReferencedFiles {
    /// `(token exactly as the tool call spelled it, outcome)`.
    ///
    /// Keyed on the raw token rather than the resolved path so the guest asks
    /// with the same string it read out of `tool_calls`. Matching is exact:
    /// there is no normalisation step for an attacker to disagree with the
    /// resolver about.
    entries: Vec<(String, Outcome)>,
}

/// Hand-written so a `{:?}` of the store state can never spill file contents
/// into a log line. The bytes are the whole point of the feature and the last
/// thing that should end up in telemetry.
impl std::fmt::Debug for ReferencedFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut list = f.debug_list();
        for (token, outcome) in &self.entries {
            let state = match outcome {
                Outcome::Content(b) => format!("readable({} bytes)", b.len()),
                Outcome::Refused(why) => format!("refused({why})"),
                Outcome::NotFound => "not_found".to_string(),
                Outcome::TooLarge(n) => format!("too_large({n} bytes)"),
            };
            list.entry(&format_args!("{token} => {state}"));
        }
        list.finish()
    }
}

impl ReferencedFiles {
    /// No file is readable. The state for every request whose rules do not ask
    /// for files, and for every deployment with no root configured.
    pub fn empty() -> Self {
        Self { entries: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Number of candidates that actually resolved to readable bytes.
    pub fn readable_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|(_, o)| matches!(o, Outcome::Content(_)))
            .count()
    }

    /// The bytes for `requested`, or the guest-visible refusal code.
    ///
    /// Exact string match against the token the tool call carried. Anything
    /// else — a normalised variant, a traversal, a path from a different
    /// request — is simply not in the table.
    pub fn lookup(&self, requested: &str) -> Result<&[u8], i32> {
        match self.entries.iter().find(|(token, _)| token == requested) {
            Some((_, Outcome::Content(bytes))) => Ok(bytes),
            Some((_, Outcome::NotFound)) => Err(ERR_NOT_FOUND),
            Some((_, Outcome::TooLarge(_))) => Err(ERR_TOO_LARGE),
            Some((_, Outcome::Refused(_))) => Err(ERR_REFUSED),
            None => Err(ERR_REFUSED),
        }
    }

    /// Why a path was refused, for the operator-facing log only.
    pub fn refusal_reason(&self, requested: &str) -> &'static str {
        match self.entries.iter().find(|(token, _)| token == requested) {
            Some((_, Outcome::Refused(why))) => why,
            Some((_, Outcome::NotFound)) => "does not exist",
            Some((_, Outcome::TooLarge(_))) => "exceeds the size cap",
            Some((_, Outcome::Content(_))) => "readable",
            None => "not referenced by this request's tool calls",
        }
    }
}

/// The configured root, or `None` when the capability is off.
///
/// Off is the default and is meant to be: a path-confined file read is only as
/// safe as the confinement, and there is no root this proxy could pick for an
/// operator that is right on both a developer laptop and a systemd unit whose
/// working directory is `/`.
pub fn resolve_root() -> Option<PathBuf> {
    let raw = std::env::var(MANIFEST_ROOT_ENV).ok()?;
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        let home = std::env::var("HOME").ok()?;
        return Some(PathBuf::from(home).join(rest));
    }
    Some(PathBuf::from(raw))
}

/// Paths this request's tool calls name, filtered to plausible manifests.
///
/// Pure and cheap: string work over already-parsed JSON, no I/O. Split out from
/// [`read_tokens`] so the caller can decide there is nothing to do without
/// touching a blocking pool.
pub fn candidate_tokens(ctx: &RequestContext) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for call in &ctx.tool_calls {
        let Some(map) = call.arguments.as_object() else {
            continue;
        };
        for key in PATH_ARG_KEYS {
            if let Some(value) = map.get(*key).and_then(|v| v.as_str()) {
                consider(value, &mut out);
            }
        }
        for key in COMMAND_ARG_KEYS {
            if let Some(value) = map.get(*key).and_then(|v| v.as_str()) {
                let scanned = &value[..value.len().min(MAX_COMMAND_SCAN_BYTES)];
                for token in shell_tokens(scanned) {
                    consider(&token, &mut out);
                }
            }
        }
        if out.len() >= MAX_REFERENCED_FILES {
            break;
        }
    }
    out
}

/// Add `raw` to the candidate set if it looks like a manifest path.
fn consider(raw: &str, out: &mut Vec<String>) {
    if out.len() >= MAX_REFERENCED_FILES {
        return;
    }
    let trimmed = raw.trim_matches(['"', '\'']);
    // `--values=charts/prod.yaml` is one shell word carrying one path. Only
    // option-shaped words are split, so a filename that legitimately contains
    // `=` is passed through rather than silently rewritten — the token has to
    // survive to be matched against what the guest asks for.
    let candidate = match trimmed.split_once('=') {
        Some((flag, rhs)) if flag.starts_with('-') => rhs,
        _ => trimmed,
    };

    if candidate.is_empty()
        || candidate.len() > MAX_GUEST_PATH_BYTES
        || !has_manifest_extension(candidate)
    {
        return;
    }
    if out.iter().any(|existing| existing == candidate) {
        return;
    }
    out.push(candidate.to_string());
}

fn has_manifest_extension(token: &str) -> bool {
    Path::new(token)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| {
            let lower = ext.to_ascii_lowercase();
            MANIFEST_EXTENSIONS.contains(&lower.as_str())
        })
}

/// Split a command into shell words.
///
/// Enough of a shell to find the operands: quotes group, whitespace and the
/// metacharacters that end a word separate. Deliberately does **not** expand
/// globs, variables or command substitution — expanding `*.yaml` would make the
/// host read files the call never literally named, which is precisely the
/// property guard 1 exists to keep. An unexpanded `*.yaml` simply fails to
/// resolve and the guest is told so.
fn shell_tokens(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in command.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                ';' | '|' | '&' | '<' | '>' | '(' | ')' | '`' => {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                }
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            },
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Resolve and read every candidate. **Blocking** — call it on a blocking pool.
///
/// # Why the read happens here and not behind a host call
///
/// The runner gives a guest a 5 ms budget. A cold-cache read of a manifest is
/// tens to hundreds of microseconds and, on a network filesystem, unbounded, so
/// doing the I/O inside the sandbox would either blow that budget or make it
/// meaningless. Pre-reading keeps the budget covering exactly what it was
/// written to cover — guest execution — and turns the host import into a memcpy
/// out of a table that was already in memory.
///
/// The cost is that the work is done whether or not the rule ends up asking for
/// it: a rule that imports the function and then returns early on some cheaper
/// condition still paid for the read. That is the trade, and it is the right
/// way round, because the alternative is an I/O-shaped hole in a latency budget
/// on the request path.
pub fn read_tokens(tokens: Vec<String>, root: &Path) -> ReferencedFiles {
    if tokens.is_empty() {
        return ReferencedFiles::empty();
    }

    // Canonicalise the root per batch rather than once per process: the root is
    // operator-configured and may be created after the proxy starts, and a
    // cached failure would disable the feature until a restart.
    let canonical_root = match std::fs::canonicalize(root) {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                root = %root.display(),
                error = %e,
                "{MANIFEST_ROOT_ENV} does not resolve — every referenced-file read will be refused"
            );
            return ReferencedFiles {
                entries: tokens
                    .into_iter()
                    .map(|t| (t, Outcome::Refused("the configured manifest root does not resolve")))
                    .collect(),
            };
        }
    };

    let entries = tokens
        .into_iter()
        .map(|token| {
            let outcome = read_one(&canonical_root, &token);
            match &outcome {
                Outcome::Content(bytes) => tracing::debug!(
                    path = %token,
                    bytes = bytes.len(),
                    // A content hash, not the content. Enough to explain why a
                    // replay of the same request produced a different verdict,
                    // without copying a manifest into telemetry.
                    sha256_prefix = %hex::encode(&Sha256::digest(bytes)[..8]),
                    "referenced file exposed to WASM rules"
                ),
                other => tracing::debug!(
                    path = %token,
                    reason = %match other {
                        Outcome::Refused(why) => *why,
                        Outcome::NotFound => "does not exist",
                        Outcome::TooLarge(_) => "exceeds the size cap",
                        Outcome::Content(_) => unreachable!(),
                    },
                    "referenced file withheld from WASM rules"
                ),
            }
            (token, outcome)
        })
        .collect();

    ReferencedFiles { entries }
}

/// Convenience for callers that have a context in hand. Blocking, as
/// [`read_tokens`] is.
pub fn prefetch(ctx: &RequestContext, root: &Path) -> ReferencedFiles {
    read_tokens(candidate_tokens(ctx), root)
}

/// Apply guards 3–6 to one candidate and read it.
///
/// Ordered so nothing touches the filesystem until the lexical checks pass: a
/// `..` path is refused without a `stat`, so the import cannot be used to probe
/// for the existence of files outside the root.
fn read_one(canonical_root: &Path, token: &str) -> Outcome {
    if token.is_empty() || token.contains('\0') {
        return Outcome::Refused("is empty or contains a NUL byte");
    }

    let path = Path::new(token);
    for component in path.components() {
        match component {
            Component::ParentDir => return Outcome::Refused("contains a `..` component"),
            // Windows drive/UNC prefixes. Refused rather than reasoned about;
            // the proxy's deployment target is Unix and a half-understood path
            // grammar is how confinement checks get bypassed.
            Component::Prefix(_) => return Outcome::Refused("carries a platform path prefix"),
            _ => {}
        }
    }

    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };

    // Resolves every symlink in the chain, so the confinement test below covers
    // symlink escape as well as literal paths. It is also the last point at
    // which the answer is a snapshot: a component swapped after this call is
    // the residual TOCTOU noted in the module docs — closing it needs
    // `openat2(RESOLVE_BENEATH)`, which is Linux-only.
    let resolved = match std::fs::canonicalize(&joined) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::NotFound,
        Err(_) => return Outcome::Refused("could not be resolved"),
    };

    if !resolved.starts_with(canonical_root) {
        return Outcome::Refused("resolves outside the configured manifest root");
    }

    // `symlink_metadata` on an already-canonical path is the same answer as
    // `metadata` unless a component changed underneath us, in which case the
    // paranoid reading is the one to take.
    let meta = match std::fs::symlink_metadata(&resolved) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::NotFound,
        Err(_) => return Outcome::Refused("could not be inspected"),
    };
    if !meta.is_file() {
        return Outcome::Refused("is not a regular file");
    }
    if meta.len() > MAX_REFERENCED_FILE_BYTES as u64 {
        return Outcome::TooLarge(meta.len());
    }

    let file = match std::fs::File::open(&resolved) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::NotFound,
        Err(_) => return Outcome::Refused("could not be opened"),
    };

    // Bounded independently of the `stat` above: the file may have grown
    // between the two, and `read_to_end` on an unbounded reader is how a
    // /proc-style endless file turns a governance check into an OOM.
    let mut buf = Vec::with_capacity(meta.len() as usize);
    let mut limited = file.take(MAX_REFERENCED_FILE_BYTES as u64 + 1);
    if limited.read_to_end(&mut buf).is_err() {
        return Outcome::Refused("could not be read");
    }
    if buf.len() > MAX_REFERENCED_FILE_BYTES {
        return Outcome::TooLarge(buf.len() as u64);
    }

    Outcome::Content(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A context with the given tool calls and nothing else that matters.
    ///
    /// Built from a legacy-shaped payload rather than a struct literal on
    /// purpose: `RequestContext` has thirty fields, none of which this module
    /// reads, and a literal would need editing every time one is added.
    fn ctx_with(tool_calls: serde_json::Value) -> RequestContext {
        serde_json::from_value(json!({
            "session_id": "ses_1",
            "workspace_id": "ws_1",
            "virtual_key_prefix": "vk_1",
            "model": "claude-sonnet-4",
            "tools": [],
            "tool_calls": tool_calls,
            "estimated_input_tokens": 10,
            "budget_remaining_usd": 1.0,
            "risk_tier": "Low",
            "dlp_findings": [],
            "tool_sequence": []
        }))
        .expect("fixture context should deserialise")
    }

    fn call(name: &str, arguments: serde_json::Value) -> serde_json::Value {
        json!({ "id": "call_1", "name": name, "arguments": arguments })
    }

    /// A scratch root, unique per test so the suite can run in parallel.
    /// `tag` is unique per call site, which is what keeps concurrent tests from
    /// deleting each other's directories.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("intutic-wasm-reffiles-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── candidate derivation ────────────────────────────────────────────────

    /// The motivating case: the path lives inside a shell command, not in a
    /// structured argument.
    #[test]
    fn a_manifest_named_by_a_deploy_command_is_a_candidate() {
        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": "kubectl apply -f k8s/deploy.yaml" })
        )]));
        assert_eq!(candidate_tokens(&ctx), vec!["k8s/deploy.yaml".to_string()]);
    }

    #[test]
    fn structured_path_arguments_are_candidates_too() {
        let ctx = ctx_with(json!([call(
            "Read",
            json!({ "file_path": "infra/main.tf" })
        )]));
        assert_eq!(candidate_tokens(&ctx), vec!["infra/main.tf".to_string()]);
    }

    #[test]
    fn a_flag_with_an_equals_sign_still_yields_the_path() {
        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": "helm template --values=charts/prod.yaml ." })
        )]));
        assert_eq!(candidate_tokens(&ctx), vec!["charts/prod.yaml".to_string()]);
    }

    #[test]
    fn quotes_and_shell_separators_do_not_hide_a_path() {
        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": "cd infra && kubectl apply -f \"k8s/deploy.yaml\"; echo done" })
        )]));
        assert_eq!(candidate_tokens(&ctx), vec!["k8s/deploy.yaml".to_string()]);
    }

    /// Guard 2. This is the check that keeps the import from becoming a
    /// general file-read oracle when the tool-argument parsing is wrong.
    #[test]
    fn a_path_without_a_manifest_extension_is_never_a_candidate() {
        for command in [
            "cat /etc/shadow",
            "kubectl apply -f /etc/passwd",
            "cp ~/.aws/credentials /tmp/x",
            "kubectl apply -f Dockerfile",
        ] {
            let ctx = ctx_with(json!([call("Bash", json!({ "command": command }))]));
            assert!(
                candidate_tokens(&ctx).is_empty(),
                "{command} produced candidates: {:?}",
                candidate_tokens(&ctx)
            );
        }
    }

    #[test]
    fn candidates_are_deduped_and_capped() {
        let many: Vec<String> = (0..40).map(|i| format!("m{i}.yaml")).collect();
        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": format!("kubectl apply -f {} -f {}", many.join(" -f "), many[0]) })
        )]));
        let tokens = candidate_tokens(&ctx);
        assert_eq!(tokens.len(), MAX_REFERENCED_FILES);
        let mut sorted = tokens.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), tokens.len(), "candidates must be deduped");
    }

    /// Globs are not expanded, so a rule cannot use one to reach a file the
    /// call did not literally name.
    #[test]
    fn a_glob_is_taken_literally_and_simply_fails_to_resolve() {
        let root = scratch("glob");
        std::fs::write(root.join("a.yaml"), b"kind: Pod").unwrap();
        let files = read_tokens(vec!["*.yaml".to_string()], &root);
        assert_eq!(files.lookup("*.yaml"), Err(ERR_NOT_FOUND));
        // …and the file that a shell would have expanded to stays unreachable.
        assert_eq!(files.lookup("a.yaml"), Err(ERR_REFUSED));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── path guards ─────────────────────────────────────────────────────────

    #[test]
    fn a_referenced_manifest_inside_the_root_is_readable() {
        let root = scratch("read");
        std::fs::create_dir_all(root.join("k8s")).unwrap();
        std::fs::write(root.join("k8s/deploy.yaml"), b"image: app:latest").unwrap();

        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": "kubectl apply -f k8s/deploy.yaml" })
        )]));
        let files = prefetch(&ctx, &root);
        assert_eq!(files.lookup("k8s/deploy.yaml"), Ok(&b"image: app:latest"[..]));
        assert_eq!(files.readable_count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 1. The file exists, is inside the root, and has an allowed
    /// extension — and is still refused, because this request did not name it.
    #[test]
    fn a_path_the_tool_call_did_not_name_is_refused() {
        let root = scratch("unreferenced");
        std::fs::write(root.join("deploy.yaml"), b"kind: Deployment").unwrap();
        std::fs::write(root.join("secrets.yaml"), b"token: hunter2").unwrap();

        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": "kubectl apply -f deploy.yaml" })
        )]));
        let files = prefetch(&ctx, &root);
        assert!(files.lookup("deploy.yaml").is_ok());
        assert_eq!(files.lookup("secrets.yaml"), Err(ERR_REFUSED));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 3, in its serious form: the traversal is in the *tool call*, so it
    /// is genuinely referenced and has to be stopped by the path guard rather
    /// than by not being in the table.
    #[test]
    fn a_referenced_traversal_is_refused_without_touching_the_filesystem() {
        let root = scratch("traversal");
        let outside = root.parent().unwrap().join(format!(
            "intutic-wasm-outside-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&outside, b"secret: yes").unwrap();

        let token = format!("../{}", outside.file_name().unwrap().to_str().unwrap());
        let ctx = ctx_with(json!([call(
            "Bash",
            json!({ "command": format!("kubectl apply -f {token}") })
        )]));
        assert_eq!(candidate_tokens(&ctx), vec![token.clone()], "must be a candidate to be a real test");

        let files = prefetch(&ctx, &root);
        assert_eq!(files.lookup(&token), Err(ERR_REFUSED));
        assert_eq!(files.refusal_reason(&token), "contains a `..` component");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 4 for the absolute case.
    #[test]
    fn an_absolute_path_outside_the_root_is_refused() {
        let root = scratch("absolute");
        let outside = root.parent().unwrap().join(format!(
            "intutic-wasm-abs-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&outside, b"secret: yes").unwrap();

        let token = outside.to_str().unwrap().to_string();
        let files = read_tokens(vec![token.clone()], &root);
        assert_eq!(files.lookup(&token), Err(ERR_REFUSED));

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An absolute path that lands inside the root is fine — confinement is
    /// about where it points, not how it is spelled. The other half of the test
    /// above; without it, "refuse every absolute path" would also pass.
    #[test]
    fn an_absolute_path_inside_the_root_is_readable() {
        let root = scratch("absolute-inside");
        std::fs::write(root.join("in.yaml"), b"kind: Pod").unwrap();
        let token = std::fs::canonicalize(root.join("in.yaml"))
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let files = read_tokens(vec![token.clone()], &root);
        assert_eq!(files.lookup(&token), Ok(&b"kind: Pod"[..]));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 4 for the symlink case: the name is confined, the target is not.
    #[cfg(unix)]
    #[test]
    fn a_symlink_leading_out_of_the_root_is_refused() {
        let root = scratch("symlink");
        let outside = root.parent().unwrap().join(format!(
            "intutic-wasm-linked-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&outside, b"secret: yes").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("deploy.yaml")).unwrap();

        let files = read_tokens(vec!["deploy.yaml".to_string()], &root);
        assert_eq!(files.lookup("deploy.yaml"), Err(ERR_REFUSED));
        assert_eq!(
            files.refusal_reason("deploy.yaml"),
            "resolves outside the configured manifest root"
        );

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlink that stays inside the root is allowed — repos use them, and
    /// refusing every symlink would be a different, wrong rule.
    #[cfg(unix)]
    #[test]
    fn a_symlink_staying_inside_the_root_is_readable() {
        let root = scratch("symlink-inside");
        std::fs::write(root.join("real.yaml"), b"kind: Pod").unwrap();
        std::os::unix::fs::symlink(root.join("real.yaml"), root.join("alias.yaml")).unwrap();
        let files = read_tokens(vec!["alias.yaml".to_string()], &root);
        assert_eq!(files.lookup("alias.yaml"), Ok(&b"kind: Pod"[..]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_is_not_a_readable_manifest() {
        let root = scratch("dir");
        std::fs::create_dir_all(root.join("charts.yaml")).unwrap();
        let files = read_tokens(vec!["charts.yaml".to_string()], &root);
        assert_eq!(files.lookup("charts.yaml"), Err(ERR_REFUSED));
        assert_eq!(files.refusal_reason("charts.yaml"), "is not a regular file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_file_is_a_clean_refusal_not_a_panic() {
        let root = scratch("missing");
        let files = read_tokens(vec!["nope.yaml".to_string()], &root);
        assert_eq!(files.lookup("nope.yaml"), Err(ERR_NOT_FOUND));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Guard 6. The cap holds by withholding the file, not by handing over a
    /// prefix — a rule scanning a truncated manifest for a violation and not
    /// finding one would allow the deploy.
    #[test]
    fn an_oversized_file_is_capped_and_no_prefix_leaks() {
        let root = scratch("oversize");
        let big = vec![b'y'; MAX_REFERENCED_FILE_BYTES + 1024];
        std::fs::write(root.join("big.yaml"), &big).unwrap();
        let files = read_tokens(vec!["big.yaml".to_string()], &root);
        assert_eq!(files.lookup("big.yaml"), Err(ERR_TOO_LARGE));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The boundary, so the cap is not off by one in the direction that refuses
    /// legitimate manifests.
    #[test]
    fn a_file_exactly_at_the_cap_is_readable() {
        let root = scratch("at-cap");
        let exact = vec![b'y'; MAX_REFERENCED_FILE_BYTES];
        std::fs::write(root.join("exact.yaml"), &exact).unwrap();
        let files = read_tokens(vec!["exact.yaml".to_string()], &root);
        assert_eq!(files.lookup("exact.yaml").map(|b| b.len()), Ok(exact.len()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_root_that_does_not_exist_refuses_everything_without_panicking() {
        let files = read_tokens(
            vec!["deploy.yaml".to_string()],
            Path::new("/nonexistent/intutic-manifest-root"),
        );
        assert_eq!(files.lookup("deploy.yaml"), Err(ERR_REFUSED));
    }

    /// The default. A deployment that has not opted in has no root, so the
    /// registry never builds a table and every read is refused.
    #[test]
    fn the_capability_is_off_when_no_root_is_configured() {
        let empty = ReferencedFiles::empty();
        assert!(empty.is_empty());
        assert_eq!(empty.lookup("k8s/deploy.yaml"), Err(ERR_REFUSED));
    }

    /// Contents must never reach a log line through a stray `{:?}`.
    #[test]
    fn debug_does_not_print_file_contents() {
        let root = scratch("debug");
        std::fs::write(root.join("d.yaml"), b"apiKey: super-secret-value").unwrap();
        let files = read_tokens(vec!["d.yaml".to_string()], &root);
        let rendered = format!("{files:?}");
        assert!(!rendered.contains("super-secret-value"), "{rendered}");
        assert!(rendered.contains("d.yaml") && rendered.contains("readable"), "{rendered}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
