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

/// One policy document, the roles it applies to, and anything it forbids.
#[derive(Debug, Clone, PartialEq)]
pub struct Sop {
    pub title: String,
    pub body: String,
    /// Lowercased roles this applies to. Empty means every role.
    pub roles: Vec<String>,
    /// Tool names this SOP forbids for the roles it covers.
    ///
    /// This is what makes an SOP enforceable rather than advisory. The prose
    /// tells the agent not to do something; this is the part the proxy acts on
    /// when it tries anyway — which is the entire premise, since a rule an
    /// agent can read is a rule an agent can decide to ignore.
    ///
    /// Empty by default, so an SOP forbids nothing until someone says so.
    /// Open core has no policy service to consult, and defaulting to
    /// "everything not explicitly permitted is denied" would block every tool
    /// call for every user who never wrote a policy.
    pub deny_tools: Vec<String>,
    /// Harnesses this SOP permits for the roles it covers.
    ///
    /// Empty means unrestricted. Present, it becomes an allowlist — safe here
    /// where it is not for tools, because a workspace has a handful of
    /// harnesses that someone can enumerate, not the open-ended tool surface
    /// each of them exposes.
    pub allow_harnesses: Vec<String>,
    /// The steps this SOP's task is expected to consist of — plan adherence.
    ///
    /// Distinct from `deny_tools`, and the distinction is the point.
    /// `deny_tools` is "never do this, whatever you are working on".
    /// `plan_steps` is "for the task this SOP governs, these are the steps" —
    /// a scoped allowlist rather than a global denylist.
    ///
    /// That makes it the one place an allowlist over tools is safe, for the
    /// reason the `deny_tools` comment above rules it out everywhere else:
    /// this list is empty unless an author explicitly wrote a plan, and an
    /// empty list means "no plan declared, nothing to compare against" rather
    /// than "deny everything unlisted". A workspace that never writes one is
    /// never affected.
    ///
    /// Entries may be raw tool names (`Bash`, `Write`) or the synthesised
    /// action vocabulary (`action:run_tests`, `action:deploy`), because a plan
    /// is more naturally written in terms of what the agent should *do* than
    /// which tool it happens to reach for.
    pub plan_steps: Vec<String>,
    /// Repo paths this SOP's role may change — blast radius, declared up front.
    ///
    /// The third scoped allowlist, and the same reasoning that makes
    /// `plan_steps` safe applies: empty means "no scope declared, nothing to
    /// compare against", never "deny everything unlisted". A workspace that
    /// never writes one is never affected.
    ///
    /// Where `plan_steps` says *what* the task consists of, this says *where* it
    /// may happen. They compose: a deployer whose plan is read/edit/deploy and
    /// whose scope is `infra/` is bounded on both axes.
    ///
    /// Prefix matches against the paths a request's tool calls actually named,
    /// so `packages/proxy` covers everything beneath it.
    pub scope_paths: Vec<String>,
    /// Actions that must not proceed until a human has looked.
    ///
    /// Entries are action tokens (`action:deploy`) or raw tool names. Unlike
    /// every other field here, a match does not merely record something — it
    /// holds the whole loop run until someone approves or rejects it. That is
    /// why it is declaration-only and has no heuristic behind it: nothing
    /// blocks a person's work unless a person asked for it to.
    pub review_before: Vec<String>,
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

/// Everything a front-matter block can declare, plus the body below it.
///
/// A struct rather than a tuple. This started as `(roles, body)` and grew a
/// field per policy dimension; by five, every call site was a positional
/// destructure whose correctness depended on remembering an order written down
/// in one doc comment. A field name is the cheapest possible fix, and it means
/// the next dimension is an additive change rather than a rename of ten
/// destructures.
#[derive(Debug, Default, Clone, PartialEq)]
struct FrontMatter {
    roles: Vec<String>,
    allow_harnesses: Vec<String>,
    deny_tools: Vec<String>,
    plan_steps: Vec<String>,
    scope_paths: Vec<String>,
    review_before: Vec<String>,
    body: String,
}

impl FrontMatter {
    /// A file with no usable front matter: everything is body.
    ///
    /// Used for both "no fence" and "unterminated fence". The second is the
    /// important one — a malformed fence must not silently disarm a rule its
    /// author believes is active, so the text is kept as policy prose rather
    /// than discarded.
    fn body_only(raw: &str) -> Self {
        Self { body: raw.trim().to_string(), ..Self::default() }
    }
}

/// Split optional front matter from the body.
///
/// Intentionally not a YAML parser. The directives that matter are
/// comma-separated lists, and taking a YAML dependency to read one would be a
/// poor trade — as would silently failing to load a policy because its front
/// matter had a tab in it.
fn parse_front_matter(raw: &str) -> FrontMatter {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return FrontMatter::body_only(raw);
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        return FrontMatter::body_only(raw);
    };
    let (front, body) = rest.split_at(end);

    let list = |key: &str, lower: bool| -> Vec<String> {
        front
            .lines()
            .filter_map(|l| l.trim().strip_prefix(key))
            .flat_map(|v| v.split(','))
            .map(|r| {
                let t = r.trim().trim_matches(['"', '\'', '[', ']']).to_string();
                if lower { t.to_ascii_lowercase() } else { t }
            })
            .filter(|r| !r.is_empty())
            .collect()
    };

    FrontMatter {
        roles: list("roles:", true),
        // Harness names are lowercase by convention (`claude-code`, `cursor`).
        allow_harnesses: list("allow_harnesses:", true),
        // Tool names keep their case — harnesses ship tools called `Bash` and
        // `Write`, and lowercasing them would stop the denylist matching.
        deny_tools: list("deny_tools:", false),
        // Same case rule as deny_tools, and for the same reason: a plan naming
        // `Bash` must match the tool the harness actually calls. Action tokens are
        // lowercase by construction, so this is safe for both.
        plan_steps: list("plan_steps:", false),
        // Paths keep their case because filesystems outside macOS care about it,
        // and a scope written `Packages/Proxy` must not silently match nothing on
        // a Linux CI runner. Comparison lowercases both sides.
        scope_paths: list("scope_paths:", false),
        // Action tokens (`action:deploy`) are lowercase by construction, but raw
        // tool names are accepted here too — see the detector — so case is kept
        // and the comparison ignores it.
        review_before: list("review_before:", false),
        body: body.trim_start_matches("\n---").trim().to_string(),
    }
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
            let fm = parse_front_matter(&raw);
            // A file carrying only a declaration and no prose is still a policy.
            // Every declarative field has to appear here: an SOP whose whole
            // content is `scope_paths:` would otherwise be dropped on load, and
            // the check that reads it would never fire — with nothing to notice,
            // because the file is on disk and looks fine.
            if fm.body.is_empty()
                && fm.deny_tools.is_empty()
                && fm.allow_harnesses.is_empty()
                && fm.plan_steps.is_empty()
                && fm.scope_paths.is_empty()
                && fm.review_before.is_empty()
            {
                return None;
            }
            Some(Sop {
                title: path.file_stem()?.to_str()?.to_string(),
                body: fm.body,
                roles: fm.roles,
                deny_tools: fm.deny_tools,
                allow_harnesses: fm.allow_harnesses,
                plan_steps: fm.plan_steps,
                scope_paths: fm.scope_paths,
                review_before: fm.review_before,
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

/// How far up the tree to look for a workspace before giving up.
///
/// Bounded so a proxy started somewhere unexpected walks a few levels rather
/// than stat-ing its way to `/`.
const MAX_ANCESTOR_WALK: usize = 12;

/// Explicit override for the SOP directory.
///
/// The walk below is right for a developer machine and useless in a cluster,
/// where the binary runs with `cwd` `/home/intutic` and no ancestor holds
/// `.intutic/sops`. This is how policy gets delivered by a mounted volume
/// instead of by an accident of the working directory.
const SOPS_DIR_ENV: &str = "INTUTIC_SOPS_DIR";

/// Where the SOP directory came from.
///
/// Kept rather than collapsed to an `Option<PathBuf>` because "which source
/// won" is the question an operator staring at an unenforced policy needs
/// answered, and the two ways of finding nothing call for different advice.
#[derive(Debug, PartialEq)]
enum SopsSource {
    /// [`SOPS_DIR_ENV`] named a directory that exists.
    Env(PathBuf),
    /// [`SOPS_DIR_ENV`] is set but names nothing readable. Deliberately does not
    /// fall through to the walk: an operator who mounted a policy volume needs
    /// to hear that it is missing, not to silently inherit whatever happens to
    /// sit above the working directory.
    EnvNotADirectory(PathBuf),
    /// Found by walking up from the working directory.
    Walk(PathBuf),
    /// No override set, and nothing above the working directory.
    NotFound,
}

impl SopsSource {
    /// The directory to read, when there is one.
    fn dir(&self) -> Option<&Path> {
        match self {
            SopsSource::Env(p) | SopsSource::Walk(p) => Some(p),
            SopsSource::EnvNotADirectory(_) | SopsSource::NotFound => None,
        }
    }

    /// How this resolution happened, for the log line.
    fn label(&self) -> &'static str {
        match self {
            SopsSource::Env(_) | SopsSource::EnvNotADirectory(_) => SOPS_DIR_ENV,
            SopsSource::Walk(_) => "cwd-ancestor-walk",
            SopsSource::NotFound => "none",
        }
    }
}

/// Locate the SOP directory, and the working directory it was resolved from.
fn resolve_sops_dir() -> (SopsSource, PathBuf) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let source = resolve_sops_dir_from(std::env::var(SOPS_DIR_ENV).ok().as_deref(), &cwd);
    (source, cwd)
}

/// The resolution itself, with both inputs passed in.
///
/// [`SOPS_DIR_ENV`] wins when set, because it is the only way to say where
/// policy lives on a host whose working directory carries no answer. The walk
/// remains the fallback, and stays the whole story on a developer machine.
///
/// Walking up rather than reading a fixed relative path, because the proxy's
/// working directory is not reliably the workspace root. `intutic connect`
/// sets `cwd` to the workspace, but `intutic start` inherits whatever
/// directory the user happened to be in, and `intutic-proxy` can be run
/// directly from anywhere. A plain `.intutic/sops` therefore resolves to
/// nothing whenever someone starts the proxy from a subdirectory — with no
/// error, since an absent directory is indistinguishable from an empty one.
///
/// Same rule a developer already expects from `.git`: the project is wherever
/// its marker is, not wherever the shell happens to be pointing.
///
/// Split from [`resolve_sops_dir`] so the tests drive the real branch order
/// without mutating the environment or working directory every other test in
/// this binary shares.
fn resolve_sops_dir_from(env_override: Option<&str>, cwd: &Path) -> SopsSource {
    // An empty or blank value is how a Kubernetes env block spells "unset";
    // honouring it would point the proxy at "" and disable the walk as well.
    if let Some(raw) = env_override.map(str::trim).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(raw);
        return if path.is_dir() {
            SopsSource::Env(path)
        } else {
            SopsSource::EnvNotADirectory(path)
        };
    }
    cwd.ancestors()
        .take(MAX_ANCESTOR_WALK)
        .map(|dir| dir.join(".intutic").join("sops"))
        .find(|candidate| candidate.is_dir())
        .map_or(SopsSource::NotFound, SopsSource::Walk)
}

/// What to say when the resolved SOP set is empty.
///
/// Built here rather than inline at the `warn!` so a test can assert on the
/// text the code actually emits; [`report_resolution`] is the only caller.
fn empty_sops_warning(source: &SopsSource, cwd: &Path) -> String {
    let looked = match source {
        SopsSource::Env(p) => format!(
            "{SOPS_DIR_ENV}={} is a directory but holds no readable SOP files",
            p.display()
        ),
        SopsSource::EnvNotADirectory(p) => {
            format!("{SOPS_DIR_ENV}={} is not a directory", p.display())
        }
        SopsSource::Walk(p) => format!(
            "{} (found by walking up from cwd {}) holds no readable SOP files",
            p.display(),
            cwd.display()
        ),
        SopsSource::NotFound => format!(
            "no .intutic/sops directory exists at cwd {} or in its first \
             {MAX_ANCESTOR_WALK} ancestors, and {SOPS_DIR_ENV} is not set",
            cwd.display()
        ),
    };
    format!(
        "No SOPs resolved — every SOP-derived control is inert: the deny_tools, \
         plan_steps, scope_paths and review_before detectors can never fire, and no \
         governance block is injected into any request. {looked}. Point \
         {SOPS_DIR_ENV} at a directory of .md SOP files — a mounted policy volume \
         in a cluster, where the cwd walk finds nothing."
    )
}

/// Say, once, where the SOPs came from — or that there are none.
///
/// Silence is what let the empty case survive: in a cluster the walk finds
/// nothing, so `deny_tools`, `plan_steps`, `scope_paths` and `review_before`
/// all resolve to empty and every SOP-derived control does nothing, with no
/// line anywhere saying so. A user who wrote SOPs sees a governed session with
/// none of their policy in it.
/// Whether this SOP declares anything the proxy can act on.
///
/// Prose is not enforcement. A SOP with a body and no declarations is a
/// document the agent may read and ignore, which is the whole reason the
/// enforceable fields exist.
fn is_enforceable(sop: &Sop) -> bool {
    !sop.deny_tools.is_empty()
        || !sop.allow_harnesses.is_empty()
        || !sop.plan_steps.is_empty()
        || !sop.scope_paths.is_empty()
        || !sop.review_before.is_empty()
}

/// What to say when policy loaded but none of it can fire.
///
/// The gap this closes is one character wide. `review_befor:` instead of
/// `review_before:` parses fine — unknown front-matter keys are ignored, as they
/// must be for forward compatibility — and produced a green
/// "Loaded role-scoped SOPs count=1" with zero enforcement behind it. The empty
/// -set warning could never catch that, because the set was not empty.
///
/// That is the same defect this whole subsystem keeps producing, one layer in:
/// a control that looks installed and reaches nothing. Here it is worse than
/// usual, because the operator did the work — they wrote the policy, mounted it,
/// and watched it load.
fn inert_sops_warning(source: &SopsSource, titles: &[String]) -> String {
    format!(
        "{} SOP(s) loaded and NONE declares anything enforceable — every \
         SOP-derived control is inert despite policy being present. Affected: {}. \
         An SOP enforces something only through deny_tools, allow_harnesses, \
         plan_steps, scope_paths or review_before in its front matter; prose alone \
         is advisory. Check for a misspelled key — an unrecognised one is ignored \
         silently, by design, so it loads clean. Source: {}.",
        titles.len(),
        titles.join(", "),
        source.label()
    )
}

fn report_resolution(source: &SopsSource, cwd: &Path, sops: &[Sop]) {
    let count = sops.len();
    if count == 0 {
        tracing::warn!(source = source.label(), "{}", empty_sops_warning(source, cwd));
        return;
    }

    // Policy present is not policy enforced. Reported before the success line so
    // an operator scanning the boot log sees the warning, not a green count.
    let inert: Vec<String> = sops
        .iter()
        .filter(|s| !is_enforceable(s))
        .map(|s| s.title.clone())
        .collect();
    if inert.len() == count {
        tracing::warn!(source = source.label(), "{}", inert_sops_warning(source, &inert));
        return;
    }
    if !inert.is_empty() {
        // Some enforce and some do not. Not an alarm — a mixed set is normal,
        // an SOP can legitimately be reference prose — but named, because a
        // misspelling in one file of several would otherwise hide behind the
        // others' success.
        tracing::info!(
            source = source.label(),
            advisory = %inert.join(", "),
            "Some SOPs declare nothing enforceable and are advisory only"
        );
    }

    tracing::info!(
        path = %source.dir().unwrap_or(cwd).display(),
        source = source.label(),
        count,
        enforceable = count - inert.len(),
        "Loaded role-scoped SOPs"
    );
}

/// Resolve and report the SOP set now, at startup.
///
/// Called from `main` so the warning above lands in the boot log where an
/// operator reads it. Left to the first request instead, it appears minutes
/// later interleaved with traffic, which is not where anyone looks when asking
/// why their policy never fires.
pub fn report_at_startup() {
    let _ = all_sops();
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

    let (source, cwd) = resolve_sops_dir();
    let sops = source.dir().map(read_dir_sops).unwrap_or_default();

    if guard.is_none() {
        report_resolution(&source, &cwd, &sops);
    }

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

/// Every SOP loaded from disk, for inventory surfaces like the `/fix` command
/// that report what governance is configured rather than enforce it.
pub fn loaded_sops() -> Vec<Sop> {
    all_sops()
}

/// Tool names forbidden for a node in this role, from every SOP that applies.
///
/// Empty means nothing is forbidden — the default, and the correct one. Open
/// core has no policy service to ask, so treating an empty policy as
/// "deny everything unlisted" would block every tool call for every user who
/// never wrote one.
pub fn denied_tools_for_role(role: &str) -> Vec<String> {
    collect_denies(&all_sops(), role)
}

/// Harnesses permitted for this role. Empty means unrestricted.
pub fn allowed_harnesses_for_role(role: &str) -> Vec<String> {
    collect_harnesses(&all_sops(), role)
}

/// The declared plan for this role — the steps its task is expected to consist of.
///
/// Empty means no SOP covering this role declared one, which is the default and must
/// stay indistinguishable from "unconstrained". Plan adherence is opt-in: a workspace
/// that never writes a plan is never measured against one.
/// The path scope in force for `role`. Empty means unrestricted.
///
/// Sorted and deduped, unlike `collect_plan_steps` — this is a set of
/// boundaries, and two SOPs naming the same directory should not make it count
/// twice. Order carries nothing.
fn collect_scope_paths(sops: &[Sop], role: &str) -> Vec<String> {
    let mut out: Vec<String> = sops
        .iter()
        .filter(|s| s.applies_to(role))
        .flat_map(|s| s.scope_paths.iter().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

pub fn scope_paths_for_role(role: &str) -> Vec<String> {
    collect_scope_paths(&all_sops(), role)
}

/// The actions requiring human review for `role`. Empty means none — this
/// feature does nothing at all until someone declares something.
fn collect_review_before(sops: &[Sop], role: &str) -> Vec<String> {
    let mut out: Vec<String> = sops
        .iter()
        .filter(|s| s.applies_to(role))
        .flat_map(|s| s.review_before.iter().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

pub fn review_before_for_role(role: &str) -> Vec<String> {
    collect_review_before(&all_sops(), role)
}

pub fn plan_steps_for_role(role: &str) -> Vec<String> {
    collect_plan_steps(&all_sops(), role)
}

fn collect_plan_steps(sops: &[Sop], role: &str) -> Vec<String> {
    // Deliberately NOT deduped or sorted, unlike the deny/harness collectors. A plan is
    // a sequence; sorting it would destroy the only ordering information it carries,
    // and dedup would collapse a step legitimately performed twice. The current check
    // is set-membership, but the ordering is preserved so an order-aware check can be
    // added later without changing the data.
    sops.iter()
        .filter(|s| s.applies_to(role))
        .flat_map(|s| s.plan_steps.iter().cloned())
        .collect()
}

fn collect_harnesses(sops: &[Sop], role: &str) -> Vec<String> {
    let mut out: Vec<String> = sops
        .iter()
        .filter(|s| s.applies_to(role))
        .flat_map(|s| s.allow_harnesses.iter().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn collect_denies(sops: &[Sop], role: &str) -> Vec<String> {
    let mut out: Vec<String> = sops
        .iter()
        .filter(|s| s.applies_to(role))
        .flat_map(|s| s.deny_tools.iter().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
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
            deny_tools: Vec::new(),
            allow_harnesses: Vec::new(),
            plan_steps: Vec::new(),
            scope_paths: Vec::new(),
            review_before: Vec::new(),
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
        let fm = parse_front_matter("---\nroles: reviewer, Deployer\n---\n## Policy\n- x");
        let roles = fm.roles;
        let body = fm.body;
        assert_eq!(roles, vec!["reviewer", "deployer"]);
        assert_eq!(body, "## Policy\n- x");
    }

    #[test]
    fn a_file_without_front_matter_is_all_body() {
        let fm = parse_front_matter("## Policy\n- x");
        let roles = fm.roles;
        let body = fm.body;
        assert!(roles.is_empty());
        assert_eq!(body, "## Policy\n- x");
    }

    #[test]
    fn malformed_front_matter_keeps_the_policy() {
        // An unterminated fence is a typo. Dropping the file would silently
        // disarm a rule its author believes is active.
        let fm = parse_front_matter("---\nroles: reviewer\n## Policy");
        let roles = fm.roles;
        let body = fm.body;
        assert!(roles.is_empty());
        assert!(body.contains("## Policy"));
    }

    #[test]
    fn bracketed_yaml_list_form_is_accepted() {
        let fm = parse_front_matter("---\nroles: [reviewer, deployer]\n---\nbody");
        let roles = fm.roles;
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
                deny_tools: vec![],
                allow_harnesses: vec![],
                plan_steps: Vec::new(),
                scope_paths: Vec::new(),
                review_before: Vec::new(),
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

#[cfg(test)]
mod discovery_tests {
    use super::*;

    /// The proxy's working directory is not reliably the workspace root:
    /// `intutic start` inherits whatever directory the user was in. Resolution
    /// therefore has to walk up, or SOPs silently never load for anyone who
    /// starts the proxy from a subdirectory.
    #[test]
    fn sops_are_found_from_a_subdirectory() {
        let root = std::env::temp_dir().join(format!("intutic-walk-{}", std::process::id()));
        let sops = root.join(".intutic").join("sops");
        let deep = root.join("packages").join("thing").join("src");
        std::fs::create_dir_all(&sops).unwrap();
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(sops.join("p.md"), "- rule").unwrap();

        // The cwd is passed in rather than set, so this drives the real
        // resolver without mutating global state other tests share.
        assert_eq!(
            resolve_sops_dir_from(None, &deep),
            SopsSource::Walk(sops.clone())
        );
        assert_eq!(read_dir_sops(&sops).len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn no_workspace_anywhere_resolves_to_nothing() {
        let orphan = std::env::temp_dir().join(format!("intutic-none-{}", std::process::id()));
        std::fs::create_dir_all(&orphan).unwrap();
        let source = resolve_sops_dir_from(None, &orphan);
        if let Some(d) = source.dir() {
            assert!(
                !d.starts_with(&orphan),
                "nothing under the orphan directory should have matched"
            );
        }
        std::fs::remove_dir_all(&orphan).ok();
    }

    /// Capture what a closure logs.
    ///
    /// Asserting on the emitted event rather than on a string the code merely
    /// computes — a warning that is built and never handed to `tracing` is
    /// exactly the silence this change exists to end. The subscriber is
    /// thread-local, so parallel tests do not see each other's output.
    fn capture_logs(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Buf {
            type Writer = Buf;
            fn make_writer(&'a self) -> Buf {
                self.clone()
            }
        }

        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        let bytes = buf.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    /// In a cluster the binary runs with `cwd` `/home/intutic`, nothing above it
    /// holds `.intutic/sops`, and so every SOP-derived control resolves to
    /// nothing. That is survivable; being silent about it is not — it is why the
    /// condition went unnoticed. The warning has to name what it disabled and
    /// where it looked, or it is no better than the silence.
    /// The warning is emitted by `all_sops`, not merely emittable.
    ///
    /// Every other test in this module calls `report_resolution` directly, so
    /// they stay green if `all_sops` stops calling it — and the operator loses
    /// the only runtime signal that every SOP-derived detector is disabled.
    /// Measured: replacing that one call with a no-op left 463 of 463 lib tests
    /// passing and produced no compiler warning.
    ///
    /// Source-pinned because the call is guarded by a cache-miss branch and
    /// sits behind a process-wide `OnceLock`, so a behavioural test would have
    /// to defeat the cache to observe it — and would then be pinning the cache
    /// rather than the reporting. `guide/sops.md` tells operators that the
    /// absence of this warning means SOPs were found; this is what makes that
    /// sentence true.
    #[test]
    fn all_sops_reports_what_it_resolved() {
        let src = include_str!("sops.rs");
        let body = src
            .split_once("fn all_sops")
            .expect("all_sops was renamed; this pin is stale")
            .1;
        // Bounded to the function body, so a call from anywhere else in the
        // file cannot satisfy it.
        let body = &body[..body.find("\n}").unwrap_or(body.len())];
        assert!(
            body.contains("report_resolution("),
            "all_sops no longer reports how it resolved policy, so an empty SOP set \
             is silent again and every SOP-derived detector disables without a word"
        );
    }

    /// Build a SOP the way `read_dir_sops` does — through the real front-matter
    /// parser — so a change to the grammar breaks these tests instead of letting
    /// them pass against a hand-built struct the loader would never produce.
    fn sop_from_raw(title: &str, raw: &str) -> Sop {
        let fm = parse_front_matter(raw);
        Sop {
            title: title.into(),
            body: fm.body,
            roles: fm.roles,
            deny_tools: fm.deny_tools,
            allow_harnesses: fm.allow_harnesses,
            plan_steps: fm.plan_steps,
            scope_paths: fm.scope_paths,
            review_before: fm.review_before,
        }
    }

    fn enforcing_sop(title: &str) -> Sop {
        sop_from_raw(title, "---\nreview_before: action:deploy\n---\n# body\n")
    }

    /// The SOP the Kubernetes manifests actually ship must be enforceable.
    ///
    /// `infra/kubernetes/base/proxy/sops/` is projected into the proxy pod as a
    /// ConfigMap volume, and it is the only policy that pod will ever see. A
    /// one-character typo in its front matter would load clean and enforce
    /// nothing — the exact case the warning above exists for — so the shipped
    /// artifact is pinned here rather than left to a boot log nobody re-reads.
    ///
    /// Read at RUNTIME, not with `include_str!`, and gated on the manifest
    /// directory existing.
    ///
    /// `infra/` is enterprise-only — it is not in the open-core sync set — so a
    /// compile-time include reaches outside the crate and breaks the public
    /// build outright. It did: `cargo test` in the open-core repo failed with
    /// "couldn't read .../infra/kubernetes/base/proxy/sops/...". The pin is
    /// about an artifact that exists in exactly one of the two repositories, so
    /// it has to ask whether that artifact is there.
    ///
    /// Gated on the DIRECTORY, never on the file. Skipping when the directory is
    /// absent is honest — open core ships no cluster manifest, so there is
    /// nothing to protect. Skipping when the *file* is absent would not be: that
    /// is precisely the rename this test exists to catch, and it would pass in
    /// silence.
    #[test]
    fn the_shipped_cluster_sop_declares_something_enforceable() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../infra/kubernetes/base/proxy/sops");
        if !dir.is_dir() {
            // Open core. No manifest, nothing to pin.
            return;
        }
        let path = dir.join("ship-steps-need-a-human.md");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{} exists but {} could not be read ({e}) — the ConfigMap generator \
                 reads this exact path, so the proxy pod would mount no policy at all",
                dir.display(),
                path.display()
            )
        });
        let sop = sop_from_raw("ship-steps-need-a-human", &raw);
        assert!(
            is_enforceable(&sop),
            "the SOP mounted into the cluster proxy declares nothing the proxy can act on, \
             so every SOP-derived control is inert there despite policy being present"
        );
        // Specifically the declaration the file is named for. `is_enforceable`
        // alone would still pass if review_before were misspelled and some other
        // key happened to be present.
        assert!(
            !sop.review_before.is_empty(),
            "ship-steps-need-a-human must declare review_before, or it holds nothing"
        );
    }

    /// Policy present, nothing enforceable — the one-character failure.
    #[test]
    fn a_sop_that_declares_nothing_enforceable_warns_rather_than_loading_clean() {
        // `review_befor:` instead of `review_before:`. Unknown keys are ignored
        // by design, for forward compatibility, so this parses and loads. Before
        // this warning existed it produced a green "Loaded role-scoped SOPs
        // count=1" and enforced nothing at all.
        let sop = sop_from_raw(
            "Ship steps need a human",
            "---\nreview_befor: action:deploy\n---\n# Ship steps need a human\n",
        );
        assert!(!is_enforceable(&sop), "the fixture must be the inert case");

        let logged = capture_logs(|| {
            report_resolution(
                &SopsSource::Env(PathBuf::from("/etc/intutic-sops")),
                Path::new("/home/intutic"),
                std::slice::from_ref(&sop),
            )
        });
        assert!(logged.contains("WARN"), "an inert SOP set must warn: {logged}");
        assert!(
            logged.contains("Ship steps need a human"),
            "the warning must name the file an operator has to go and fix: {logged}"
        );
    }

    /// A mixed set is normal and must not raise an alarm — but the advisory ones
    /// are still named, or a misspelling in one file hides behind the others.
    #[test]
    fn a_mixed_sop_set_names_the_advisory_ones_without_warning() {
        let inert = sop_from_raw("Reference only", "---\ntitle: notes\n---\n# prose\n");
        let logged = capture_logs(|| {
            report_resolution(
                &SopsSource::Env(PathBuf::from("/etc/intutic-sops")),
                Path::new("/home/intutic"),
                &[enforcing_sop("enforced"), inert],
            )
        });
        assert!(!logged.contains("WARN"), "a mixed set is not a fault: {logged}");
        assert!(logged.contains("Reference only"), "name the advisory ones: {logged}");
    }

    #[test]
    fn an_empty_sop_set_warns_and_names_what_it_disabled() {
        let cwd = Path::new("/home/intutic");
        let logged = capture_logs(|| report_resolution(&SopsSource::NotFound, cwd, &[]));

        assert!(
            logged.contains("WARN"),
            "an inert policy path must be a warning, not an info line: {logged}"
        );
        for detector in ["deny_tools", "plan_steps", "scope_paths", "review_before"] {
            assert!(
                logged.contains(detector),
                "the warning must name the {detector} detector it disabled: {logged}"
            );
        }
        assert!(
            logged.contains(".intutic/sops"),
            "the warning must name the directory it looked for: {logged}"
        );
        assert!(
            logged.contains("/home/intutic"),
            "the warning must name the cwd it searched from: {logged}"
        );
        assert!(
            logged.contains(SOPS_DIR_ENV),
            "the warning must name the override that fixes it: {logged}"
        );
    }

    /// A directory that resolved and parsed is not a fault, and must not warn —
    /// a warning on every boot is one nobody reads on the boot that matters.
    #[test]
    fn a_populated_sop_set_reports_which_source_won_without_warning() {
        let logged = capture_logs(|| {
            // Enforceable on purpose: a set that declares nothing now warns, and
            // this test is about the source line rather than about that.
            report_resolution(
                &SopsSource::Env(PathBuf::from("/etc/intutic/sops")),
                Path::new("/home/intutic"),
                &[enforcing_sop("a"), enforcing_sop("b"), enforcing_sop("c")],
            )
        });
        assert!(!logged.contains("WARN"), "loading SOPs is not a fault: {logged}");
        assert!(
            logged.contains(SOPS_DIR_ENV),
            "the load line must say which source won: {logged}"
        );
        assert!(logged.contains("/etc/intutic/sops"), "{logged}");
    }

    /// The whole point of the override: on a host whose cwd ancestry carries no
    /// answer, policy arrives on a mounted volume. It has to beat the walk even
    /// when the walk would have found something, or a stray `.intutic/sops`
    /// under the container's home directory would quietly outrank the mount.
    #[test]
    fn the_env_override_wins_over_the_cwd_walk() {
        let root = std::env::temp_dir().join(format!("intutic-sopsrc-{}", std::process::id()));
        let walked = root.join("workspace").join(".intutic").join("sops");
        let mounted = root.join("mnt").join("policy");
        let deep = root.join("workspace").join("packages").join("thing");
        std::fs::create_dir_all(&walked).unwrap();
        std::fs::create_dir_all(&mounted).unwrap();
        std::fs::create_dir_all(&deep).unwrap();

        assert_eq!(
            resolve_sops_dir_from(None, &deep),
            SopsSource::Walk(walked.clone()),
            "with no override the walk must still resolve"
        );
        assert_eq!(
            resolve_sops_dir_from(Some(mounted.to_str().unwrap()), &deep),
            SopsSource::Env(mounted.clone()),
            "the override must win even where the walk would have succeeded"
        );

        // A blank value is how a Kubernetes env block spells "unset". Honouring
        // it would point the proxy at "" and take the fallback away too.
        assert_eq!(
            resolve_sops_dir_from(Some("   "), &deep),
            SopsSource::Walk(walked.clone()),
            "a blank override is not an override"
        );

        // A set-but-wrong path does NOT fall back to the walk: an operator who
        // mounted a volume needs to hear that it is missing.
        let missing = root.join("mnt").join("absent");
        assert_eq!(
            resolve_sops_dir_from(Some(missing.to_str().unwrap()), &deep),
            SopsSource::EnvNotADirectory(missing),
            "a set-but-wrong override must be reported, not silently replaced"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod deny_tests {
    use super::*;

    fn with_denies(roles: &[&str], denies: &[&str]) -> Sop {
        Sop {
            title: "policy".into(),
            body: "- prose".into(),
            roles: roles.iter().map(|r| r.to_string()).collect(),
            deny_tools: denies.iter().map(|d| d.to_string()).collect(),
            allow_harnesses: Vec::new(),
            plan_steps: Vec::new(),
            scope_paths: Vec::new(),
            review_before: Vec::new(),
        }
    }

    #[test]
    fn deny_tools_parse_from_front_matter() {
        let fm = parse_front_matter("---\nroles: deployer\ndeny_tools: Bash, rm\n---\n- prose");
        let roles = fm.roles;
        let deny = fm.deny_tools;
        let body = fm.body;
        assert_eq!(roles, vec!["deployer"]);
        assert_eq!(deny, vec!["Bash", "rm"]);
        assert_eq!(body, "- prose");
    }

    #[test]
    fn tool_names_keep_their_case() {
        // Harnesses ship tools called `Bash` and `Write`. Lowercasing the
        // denylist the way roles are lowercased would stop it matching.
        let fm = parse_front_matter("---\ndeny_tools: Bash, WebFetch\n---\nx");
        let deny = fm.deny_tools;
        assert_eq!(deny, vec!["Bash", "WebFetch"]);
    }

    #[test]
    fn denies_are_collected_per_role_and_deduped() {
        let sops = vec![
            with_denies(&[], &["rm"]),
            with_denies(&["deployer"], &["kubectl", "rm"]),
            with_denies(&["reviewer"], &["git-push"]),
        ];
        assert_eq!(collect_denies(&sops, "deployer"), vec!["kubectl", "rm"]);
        assert_eq!(collect_denies(&sops, "reviewer"), vec!["git-push", "rm"]);
        // A node with no role still inherits the unscoped bans.
        assert_eq!(collect_denies(&sops, ""), vec!["rm"]);
    }

    #[test]
    fn no_policy_means_nothing_is_denied() {
        // The critical default. Open core has no policy service, so an empty
        // policy must mean "no restrictions" — treating it as "deny everything
        // unlisted" would block every tool call for every user who never wrote
        // one.
        assert!(collect_denies(&[], "deployer").is_empty());
        assert!(collect_denies(&[with_denies(&[], &[])], "deployer").is_empty());
    }

    #[test]
    fn a_deny_only_sop_is_still_loaded() {
        // A file that is nothing but a denylist has no prose body, and must
        // not be discarded for it.
        let fm = parse_front_matter("---\ndeny_tools: rm\n---\n");
        let deny = fm.deny_tools;
        let body = fm.body;
        assert!(body.is_empty());
        assert_eq!(deny, vec!["rm"]);
    }
}

#[cfg(test)]
mod harness_policy_tests {
    use super::*;

    #[test]
    fn allow_harnesses_parse_and_lowercase() {
        let fm = parse_front_matter("---\nroles: reviewer\nallow_harnesses: Claude-Code, cursor\n---\nx");
        let roles = fm.roles;
        let harnesses = fm.allow_harnesses;
        assert_eq!(roles, vec!["reviewer"]);
        assert_eq!(harnesses, vec!["claude-code", "cursor"]);
    }

    #[test]
    fn harnesses_are_collected_per_role() {
        let sops = vec![
            Sop {
                title: "a".into(),
                body: "x".into(),
                roles: vec!["reviewer".into()],
                deny_tools: vec![],
                allow_harnesses: vec!["claude-code".into()],
                plan_steps: Vec::new(),
                scope_paths: Vec::new(),
                review_before: Vec::new(),
            },
            Sop {
                title: "b".into(),
                body: "x".into(),
                roles: vec!["deployer".into()],
                deny_tools: vec![],
                allow_harnesses: vec!["cursor".into()],
                plan_steps: Vec::new(),
                scope_paths: Vec::new(),
                review_before: Vec::new(),
            },
        ];
        assert_eq!(collect_harnesses(&sops, "reviewer"), vec!["claude-code"]);
        assert_eq!(collect_harnesses(&sops, "deployer"), vec!["cursor"]);
        // A role no SOP restricts stays unrestricted.
        assert!(collect_harnesses(&sops, "planner").is_empty());
    }
}

#[cfg(test)]
mod plan_step_tests {
    use super::*;

    #[test]
    fn plan_steps_parse_and_keep_their_case() {
        // Case is preserved in storage so a finding names the step the way its
        // author wrote it; the detector compares case-insensitively.
        let fm = parse_front_matter(
            "---\nroles: deployer\nplan_steps: Read, Edit, action:run_tests, action:deploy\n---\n## Policy",
        );
        let plan = fm.plan_steps;
        let body = fm.body;
        assert_eq!(plan, vec!["Read", "Edit", "action:run_tests", "action:deploy"]);
        assert_eq!(body, "## Policy");
    }

    #[test]
    fn an_sop_with_no_plan_declares_none() {
        let fm = parse_front_matter("---\nroles: reviewer\n---\nx");
        let plan = fm.plan_steps;
        assert!(plan.is_empty(), "absent must mean absent, never 'allow nothing'");
    }

    /// Ordering is preserved on purpose. The set comparison does not need it,
    /// but an order-aware check later would, and a collector that sorted would
    /// have destroyed the information before anyone could use it.
    #[test]
    fn collection_preserves_declared_order() {
        let sops = vec![
            Sop {
                title: "deploy".into(),
                body: "x".into(),
                roles: vec!["deployer".into()],
                deny_tools: vec![],
                allow_harnesses: vec![],
                plan_steps: vec!["Read".into(), "Edit".into(), "action:deploy".into()],
                scope_paths: Vec::new(),
                review_before: Vec::new(),
            },
            Sop {
                title: "review".into(),
                body: "x".into(),
                roles: vec!["reviewer".into()],
                deny_tools: vec![],
                allow_harnesses: vec![],
                plan_steps: vec!["Grep".into()],
                scope_paths: Vec::new(),
                review_before: Vec::new(),
            },
        ];
        assert_eq!(
            collect_plan_steps(&sops, "deployer"),
            vec!["Read", "Edit", "action:deploy"]
        );
        assert_eq!(collect_plan_steps(&sops, "reviewer"), vec!["Grep"]);
    }

    /// A node that declared no role gets only unscoped SOPs — same rule as
    /// every other collector here, and worth pinning because a plan leaking
    /// across roles would flag a reviewer for not deploying.
    #[test]
    fn a_plan_does_not_leak_across_roles() {
        let sops = vec![Sop {
            title: "deploy".into(),
            body: "x".into(),
            roles: vec!["deployer".into()],
            deny_tools: vec![],
            allow_harnesses: vec![],
            plan_steps: vec!["action:deploy".into()],
            scope_paths: Vec::new(),
            review_before: Vec::new(),
        }];
        assert!(collect_plan_steps(&sops, "reviewer").is_empty());
        assert!(collect_plan_steps(&sops, "").is_empty());
    }

    /// An SOP whose only content is a plan must survive the empty-body guard.
    /// It is the natural way to write one, and dropping it would make the
    /// feature silently do nothing.
    #[test]
    fn a_plan_only_sop_is_not_discarded() {
        let dir = std::env::temp_dir().join(format!("intutic-plan-sop-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join("plan.md"),
            "---\nroles: deployer\nplan_steps: Read, action:deploy\n---\n",
        )
        .unwrap();

        let sops = read_dir_sops(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(sops.len(), 1, "a body-less SOP carrying a plan must load");
        assert_eq!(sops[0].plan_steps, vec!["Read", "action:deploy"]);
    }
}

#[cfg(test)]
mod scope_and_review_tests {
    use super::*;

    #[test]
    fn scope_paths_parse_and_keep_their_case() {
        // Case is preserved because filesystems outside macOS care about it and
        // a reviewer should see the scope as written; comparison lowercases.
        let fm = parse_front_matter(
            "---\nroles: deployer\nscope_paths: packages/proxy, Infra/K8s\n---\n## Policy",
        );
        assert_eq!(fm.scope_paths, vec!["packages/proxy", "Infra/K8s"]);
        assert_eq!(fm.body, "## Policy");
    }

    #[test]
    fn review_before_parses_action_tokens_and_tool_names() {
        let fm = parse_front_matter(
            "---\nroles: deployer\nreview_before: action:deploy, Bash\n---\nx",
        );
        assert_eq!(fm.review_before, vec!["action:deploy", "Bash"]);
    }

    #[test]
    fn an_sop_declaring_neither_has_both_empty() {
        let fm = parse_front_matter("---\nroles: reviewer\n---\nx");
        assert!(fm.scope_paths.is_empty(), "absent must mean absent, never 'deny everything'");
        assert!(fm.review_before.is_empty(), "nothing is held until someone asks for it");
    }

    #[test]
    fn an_unterminated_fence_is_body_not_a_silently_empty_policy() {
        // A typo must not disarm a rule its author believes is active.
        let fm = parse_front_matter("---\nscope_paths: packages/proxy\n## Policy");
        assert!(fm.scope_paths.is_empty());
        assert!(fm.body.contains("## Policy"));
    }

    #[test]
    fn scopes_do_not_leak_across_roles() {
        let sops = vec![Sop {
            title: "deploy".into(),
            body: "x".into(),
            roles: vec!["deployer".into()],
            deny_tools: vec![],
            allow_harnesses: vec![],
            plan_steps: vec![],
            scope_paths: vec!["infra".into()],
            review_before: vec!["action:deploy".into()],
        }];
        assert!(collect_scope_paths(&sops, "reviewer").is_empty());
        assert!(collect_review_before(&sops, "reviewer").is_empty());
        assert_eq!(collect_scope_paths(&sops, "deployer"), vec!["infra"]);
    }

    #[test]
    fn scopes_from_several_sops_are_merged_and_deduped() {
        let mk = |scope: &str| Sop {
            title: scope.into(),
            body: "x".into(),
            roles: vec![],
            deny_tools: vec![],
            allow_harnesses: vec![],
            plan_steps: vec![],
            scope_paths: vec![scope.to_string()],
            review_before: vec![],
        };
        let sops = vec![mk("packages/proxy"), mk("infra"), mk("packages/proxy")];
        assert_eq!(collect_scope_paths(&sops, "anyone"), vec!["infra", "packages/proxy"]);
    }

    /// An SOP whose only content is a scope must survive the empty-body guard.
    /// It is the natural way to write one, and dropping it would make the check
    /// silently do nothing.
    #[test]
    fn a_scope_only_sop_is_not_discarded() {
        let dir = std::env::temp_dir().join(format!("intutic-scope-sop-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("scope.md"), "---\nroles: deployer\nscope_paths: infra\n---\n").unwrap();
        let sops = read_dir_sops(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(sops.len(), 1, "a body-less SOP carrying a scope must load");
        assert_eq!(sops[0].scope_paths, vec!["infra"]);
    }

    #[test]
    fn a_review_before_only_sop_is_not_discarded() {
        let dir = std::env::temp_dir().join(format!("intutic-rev-sop-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("hold.md"), "---\nreview_before: action:deploy\n---\n").unwrap();
        let sops = read_dir_sops(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(sops.len(), 1, "a body-less SOP carrying a hold must load");
        assert_eq!(sops[0].review_before, vec!["action:deploy"]);
    }
}

#[cfg(test)]
mod cross_language_fixture_tests {
    use super::*;

    /// Both gates must read the same directive the same way.
    ///
    /// `review_before:` is parsed twice — here in Rust for the proxy, and again
    /// in TypeScript by the sync daemon for the pre-execution hook. There is no
    /// shared parser and no shared schema, so nothing but agreement holds them
    /// together. Two parsers for one directive is exactly how a rule ends up
    /// enforced at one gate and silently ignored at the other.
    ///
    /// This reads the same fixture file the daemon's test reads. Awkward
    /// whitespace and quoting are deliberate: those are what the two would
    /// disagree about first.
    #[test]
    fn the_shared_fixture_parses_as_both_gates_expect() {
        let raw = include_str!("../tests/fixtures/review-before-sop.md");
        let fm = parse_front_matter(raw);

        assert_eq!(fm.review_before, vec!["action:deploy", "action:publish", "Bash"]);
        assert_eq!(fm.scope_paths, vec!["packages/proxy", "infra/"]);
        assert_eq!(fm.roles, vec!["deployer"]);
        assert!(fm.body.starts_with("## Deploy policy"));
    }
}
