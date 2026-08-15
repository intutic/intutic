//! In-memory [`LocalStore`] and null [`ControlPlaneCache`] — standalone open
//! core, no Valkey.
//!
//! `update_arm` calls [`crate::routing::reward::apply_update`], the update rule
//! that already existed in-tree as the Lua script's documented mirror. The
//! local path reuses the oracle rather than reimplementing it, so the two
//! cannot drift by construction — only by floating-point representation, which
//! `tests/reward_test.rs` bounds at 1e-12.
//!
//! ## Durability — learning only
//!
//! Constructed with [`MemoryStore::durable`], arm state and its ownership
//! markers persist to `~/.intutic/bandit-state.json` and reload on boot, so a
//! per-session CLI proxy accumulates learning across restarts and actually
//! reaches `bandit.rs`'s `total_pulls >= 20` gate. [`MemoryStore::new`] is the
//! ephemeral form used by tests.
//!
//! **Only learning persists.** Credentials, the response cache, session routing,
//! tool sequences and judged chunks are memory-only and always will be — see
//! the credentials note below. Snapshotting is a whole-file atomic replace
//! (write temp, `rename`), so a crash mid-write cannot leave a torn file; the
//! worst case is losing the most recent update, which costs one pull.
//!
//! ## Two proxies, one `$HOME`
//!
//! Atomic replace stops a *torn* file but not a *lost update*: each process
//! writes its whole view, so the last writer would otherwise erase whatever the
//! other had learned. Persisting therefore takes an exclusive `flock` on a
//! sidecar lock file and merges the on-disk state before writing.
//!
//! The merge keeps, per arm, whichever copy has more `pulls`. That is
//! convergent rather than linearizable — two processes that both advance the
//! same arm keep the further-along one instead of summing them — which is the
//! right trade here: arm state is a running estimate, and losing a handful of
//! pulls costs a little exploration, whereas summing would double-count shared
//! history and skew the posterior. Arms only one process has seen are always
//! preserved.
//!
//! Locking is Unix-only. On other platforms the merge still runs, which
//! narrows the race without closing it.
//!
//! ## What this deliberately does not have
//!
//! * **TTLs on ownership.** `ttl_secs` is accepted and ignored. The marker
//!   arbitrates between *distributed* writers; with one process there is no
//!   second writer and nothing to expire. The response cache *does* honour its
//!   TTL, because that one bounds staleness rather than ownership.
//! * **Outage counters.** Nothing reads them locally — they are a cloud-cron
//!   input, and in local mode the reward loop already learns the same failures
//!   as 0-rewards — so both the clear and the increment are no-ops.
//! * **Publish channels.** Traces and anomalies have no subscriber standalone.
//!   They are logged at debug rather than silently dropped, so `RUST_LOG=debug`
//!   still shows the trace stream.
//!
//! ## Credentials
//!
//! `workspace:credentials` holds OAuth tokens and API keys. They live in
//! process memory only and are **never** written to disk, including by the
//! durable form. That is a deliberate decision, not an omission: persisting
//! them would put long-lived provider credentials in a plaintext file under
//! `$HOME` with no key management, which is a materially worse trade than
//! re-capturing them from the next request's `Authorization` header — which is
//! where they came from in the first place. Do not let them ride along with the
//! arm state.
//!
//! @module

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{
    CachedResponse, ClaimOutcome, ControlPlaneAuth, ControlPlaneCache, FeatureFlags, HardCapStatus,
    JudgeScope, LocalStore, NotifyScope, Ownership, SessionRouting, TokenBaseline,
};
use crate::routing::bandit::BanditArmState;
use crate::routing::reward::apply_update;
use crate::telemetry::ExecutionTrace;

/// A cache entry plus the instant it stops being valid.
struct Expiring {
    value: CachedResponse,
    expires_at: Instant,
}

/// The persisted subset: learning, and nothing else. Serde field names are the
/// on-disk format — `arms` matches the shape of a `bandit:{ws}` hash so the
/// snapshot stays readable next to the Valkey representation.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Snapshot {
    #[serde(default)]
    arms: HashMap<String, HashMap<String, BanditArmState>>,
    /// Workspaces this proxy claimed local arm ownership for. `"cloud"` markers
    /// are never written here — only a control plane sets those, and a
    /// standalone proxy has none.
    #[serde(default)]
    local_owned: Vec<String>,
}

impl Snapshot {
    /// Fold another process's snapshot into this one. Per arm the copy with
    /// more `pulls` wins; arms only the other side has are adopted wholesale.
    fn merge_from(&mut self, other: Snapshot) {
        for (workspace_id, other_arms) in other.arms {
            let mine = self.arms.entry(workspace_id).or_default();
            for (arm_key, other_arm) in other_arms {
                match mine.get(&arm_key) {
                    Some(existing) if existing.pulls >= other_arm.pulls => {}
                    _ => {
                        mine.insert(arm_key, other_arm);
                    }
                }
            }
        }
        for ws in other.local_owned {
            if !self.local_owned.contains(&ws) {
                self.local_owned.push(ws);
            }
        }
    }
}

/// Exclusive advisory lock held for the duration of a snapshot update.
///
/// Unix-only; elsewhere this is a no-op and the merge alone narrows the race.
/// Acquisition failure is not fatal — a snapshot written without the lock is
/// still atomic and still merged, just not serialised against a concurrent
/// writer.
struct FileLock {
    #[cfg(unix)]
    file: Option<std::fs::File>,
}

impl FileLock {
    fn acquire(path: &std::path::Path) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(path)
                .ok();
            if let Some(f) = &file {
                // SAFETY: `f` owns a valid fd for the duration of this call.
                if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
                    tracing::debug!("could not lock {}; proceeding unlocked", path.display());
                    return Self { file: None };
                }
            }
            Self { file }
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Self {}
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(f) = &self.file {
            use std::os::unix::io::AsRawFd;
            // SAFETY: `f` is still alive; releasing a lock we hold.
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[derive(Default)]
pub struct MemoryStore {
    arms: Mutex<HashMap<String, HashMap<String, BanditArmState>>>,
    modes: Mutex<HashMap<String, Ownership>>,
    sessions: Mutex<HashMap<String, SessionRouting>>,
    tool_sequences: Mutex<HashMap<String, Vec<String>>>,
    /// Cumulative extracted-call count per session, for per-turn deltas.
    extracted_tool_counts: Mutex<HashMap<String, u64>>,
    /// First tool signature seen per session, for drift detection.
    tool_signatures: Mutex<HashMap<String, String>>,
    credentials: Mutex<HashMap<String, HashMap<String, String>>>,
    responses: Mutex<HashMap<String, Expiring>>,
    cache_counters: Mutex<HashMap<String, HashMap<String, i64>>>,
    cache_savings: Mutex<HashMap<String, f64>>,
    session_chunks: Mutex<HashMap<String, Vec<String>>>,
    /// Loop-run spend and ceiling, keyed by run id.
    ///
    /// A run genuinely can span processes, and this map cannot see the others.
    /// But the common open-core case is one proxy on one developer's machine
    /// with no Valkey, and returning `(None, None)` there meant a workflow
    /// budget could never be exceeded no matter what the run cost — the
    /// detector's input did not exist. Aggregating what this process *can* see
    /// is a floor on the truth, and a floor that crosses the ceiling is still a
    /// real breach.
    workflow_spend: Mutex<HashMap<String, f64>>,
    workflow_budgets: Mutex<HashMap<String, f64>>,
    /// Reask trips, keyed `session|kind`.
    ///
    /// Implemented rather than stubbed, for the same reason as `workflow_spend`
    /// above: a stub returning 1 would mean an agent could be reasked forever
    /// and never escalate, so the reask verb would degrade to a steer in exactly
    /// the deployment where nobody is watching a dashboard. Standalone is one
    /// proxy process on one machine, so a process-local counter is not an
    /// approximation of the session — it *is* the session.
    ///
    /// No TTL here. The process lifetime is shorter than the one-hour window
    /// the Valkey path uses, so the restart is the expiry.
    reask_attempts: Mutex<HashMap<String, u32>>,
    /// `None` = ephemeral. Set only by [`MemoryStore::durable`].
    snapshot_path: Option<PathBuf>,
}

/// Carry standalone learning into a control-plane-backed store on first
/// connect, so upgrading from open core to Cloud does not silently reset every
/// arm to `Beta(1,1)` and drop the workspace back into cold start.
///
/// Deliberately conservative:
///
/// * **Never overwrites.** Only arms absent from the destination are seeded, so
///   a workspace the control plane already knows about is left exactly as it is.
///   Re-running this is a no-op.
/// * **Never migrates ownership.** The `reward_mode` marker is re-arbitrated by
///   `SET NX` against the real store; carrying a local claim across would let
///   this proxy believe it owns a workspace a cloud cron is already writing.
/// * **Never removes the snapshot.** Disconnecting returns you to standalone
///   with your learning intact.
///
/// Returns the number of arms seeded. Failure is logged and swallowed by the
/// caller — a migration that does not happen costs learning, which the bandit
/// re-acquires; a migration that blocks startup costs the whole proxy.
pub async fn migrate_local_learning(
    store: &std::sync::Arc<dyn LocalStore>,
    path: &std::path::Path,
) -> anyhow::Result<usize> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let snapshot: Snapshot = serde_json::from_str(&raw)?;

    let mut seeded = 0usize;
    for (workspace_id, local_arms) in snapshot.arms {
        if local_arms.is_empty() {
            continue;
        }
        let existing = store.load_arms(&workspace_id).await.unwrap_or_default();
        for (arm_key, state) in local_arms {
            if existing.contains_key(&arm_key) {
                continue;
            }
            if store.seed_arm(&workspace_id, &arm_key, &state).await.is_ok() {
                seeded += 1;
            }
        }
    }
    Ok(seeded)
}

/// Where standalone learning lives. Sits beside `local_spend`'s files, which is
/// the existing precedent for proxy-owned state under `$HOME`.
/// Where trust-on-first-use tool pins live.
fn tool_pin_path() -> PathBuf {
    default_snapshot_path().with_file_name("tool-pins.json")
}

fn load_tool_pins() -> HashMap<String, String> {
    std::fs::read_to_string(tool_pin_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Whole-file atomic replace, same as the bandit snapshot: write a temporary
/// file and rename, so a crash mid-write cannot leave a truncated pin file
/// that would read as "nothing pinned" and re-baseline every workspace.
fn save_tool_pins(pins: &HashMap<String, String>) {
    let path = tool_pin_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(encoded) = serde_json::to_string_pretty(pins) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, encoded).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

pub(crate) fn default_snapshot_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".intutic").join("bandit-state.json")
}

impl MemoryStore {
    /// Ephemeral. Nothing touches disk.
    pub fn new() -> Self {
        Self::default()
    }

    /// Persists learning to `~/.intutic/bandit-state.json`, loading any
    /// existing snapshot. A missing, unreadable or corrupt snapshot starts
    /// empty rather than failing: losing learning degrades routing to the
    /// cold-start path, which is survivable, whereas refusing to boot is not.
    pub fn durable() -> Self {
        Self::durable_at(default_snapshot_path())
    }

    pub fn durable_at(path: PathBuf) -> Self {
        let store = Self {
            snapshot_path: Some(path.clone()),
            ..Self::default()
        };

        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Snapshot>(&raw) {
                Ok(snap) => {
                    let arm_count: usize = snap.arms.values().map(|w| w.len()).sum();
                    if let Ok(mut arms) = store.arms.lock() {
                        *arms = snap.arms;
                    }
                    if let Ok(mut modes) = store.modes.lock() {
                        for ws in snap.local_owned {
                            modes.insert(ws, Ownership::Local);
                        }
                    }
                    tracing::info!(
                        path = %path.display(),
                        arms = arm_count,
                        "restored standalone bandit learning"
                    );
                }
                Err(e) => tracing::warn!(
                    path = %path.display(),
                    "bandit snapshot is corrupt, starting fresh: {}", e
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!(path = %path.display(), "no bandit snapshot yet");
            }
            Err(e) => tracing::warn!(
                path = %path.display(),
                "could not read bandit snapshot, starting fresh: {}", e
            ),
        }
        store
    }

    /// Atomic whole-file replace, under an exclusive cross-process lock and
    /// merged with whatever is already on disk. Best-effort: a snapshot failure
    /// must never fail the request that triggered it, so errors are logged and
    /// swallowed.
    fn persist(&self) {
        let Some(path) = &self.snapshot_path else {
            return;
        };
        let mut snapshot = {
            let Ok(arms) = self.arms.lock() else { return };
            let Ok(modes) = self.modes.lock() else { return };
            Snapshot {
                arms: arms.clone(),
                local_owned: modes
                    .iter()
                    .filter(|(_, o)| **o == Ownership::Local)
                    .map(|(ws, _)| ws.clone())
                    .collect(),
            }
        };

        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                tracing::warn!("could not create {}: {}", dir.display(), e);
                return;
            }
        }

        // Held for the whole read-merge-write-rename. The lock lives on a
        // sidecar path because the snapshot itself is replaced by `rename`,
        // which would detach a lock taken on the old inode.
        let _guard = FileLock::acquire(&path.with_extension("json.lock"));

        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(on_disk) = serde_json::from_str::<Snapshot>(&raw) {
                snapshot.merge_from(on_disk);
            }
        }

        let Ok(encoded) = serde_json::to_string(&snapshot) else {
            return;
        };
        // Same-directory temp so the rename stays within one filesystem and is
        // therefore atomic; a crash leaves either the old file or the new one.
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, encoded) {
            tracing::warn!("could not write bandit snapshot: {}", e);
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            tracing::warn!("could not replace bandit snapshot: {}", e);
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Lock helper — a poisoned mutex means another thread panicked mid-update.
/// Surfacing that as an error beats masking it, on every path that returns one.
fn lock<'a, T>(m: &'a Mutex<T>, what: &str) -> anyhow::Result<std::sync::MutexGuard<'a, T>> {
    m.lock()
        .map_err(|_| anyhow::anyhow!("{what} store poisoned"))
}

#[async_trait]
impl LocalStore for MemoryStore {
    async fn update_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        reward: f64,
        now_rfc3339: &str,
    ) -> anyhow::Result<()> {
        let mut arms = lock(&self.arms, "arm")?;
        let ws = arms.entry(workspace_id.to_string()).or_default();
        // Absent arm starts at Beta(1,1) with 0 pulls — the same defaults the
        // Lua script falls back to when HGET misses or the JSON is corrupt.
        let (alpha, beta, pulls) = ws
            .get(arm_key)
            .map(|a| (a.alpha, a.beta, a.pulls))
            .unwrap_or((1.0, 1.0, 0));
        let (alpha, beta, pulls) = apply_update(alpha, beta, pulls, reward);
        ws.insert(
            arm_key.to_string(),
            BanditArmState {
                alpha,
                beta,
                pulls,
                last_updated: now_rfc3339.to_string(),
            },
        );
        drop(arms);
        self.persist();
        Ok(())
    }

    async fn load_arms(
        &self,
        workspace_id: &str,
    ) -> anyhow::Result<HashMap<String, BanditArmState>> {
        Ok(lock(&self.arms, "arm")?
            .get(workspace_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn seed_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        state: &BanditArmState,
    ) -> anyhow::Result<()> {
        lock(&self.arms, "arm")?
            .entry(workspace_id.to_string())
            .or_default()
            .insert(arm_key.to_string(), state.clone());
        self.persist();
        Ok(())
    }

    async fn reward_mode(&self, workspace_id: &str) -> anyhow::Result<Option<Ownership>> {
        Ok(lock(&self.modes, "mode")?.get(workspace_id).copied())
    }

    async fn claim_local_ownership(
        &self,
        workspace_id: &str,
        _ttl_secs: u64,
    ) -> anyhow::Result<ClaimOutcome> {
        let mut modes = lock(&self.modes, "mode")?;
        if modes.contains_key(workspace_id) {
            return Ok(ClaimOutcome::Lost);
        }
        modes.insert(workspace_id.to_string(), Ownership::Local);
        drop(modes);
        self.persist();
        Ok(ClaimOutcome::Claimed)
    }

    async fn refresh_ownership(&self, _workspace_id: &str, _ttl_secs: u64) -> anyhow::Result<()> {
        Ok(())
    }

    async fn clear_outage_failures(&self, _workspace_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn record_mirror_outcome(
        &self,
        _workspace_id: &str,
        _candidate_model: &str,
        _faulted: bool,
        _measured: bool,
        _cost_usd: f64,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    async fn incr_outage_failure(
        &self,
        _workspace_id: &str,
        _arm_key: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    async fn session_routing(&self, session_id: &str) -> anyhow::Result<SessionRouting> {
        Ok(lock(&self.sessions, "session")?
            .get(session_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn set_session_locked_model(
        &self,
        session_id: &str,
        model: &str,
    ) -> anyhow::Result<()> {
        lock(&self.sessions, "session")?
            .entry(session_id.to_string())
            .or_default()
            .locked_model = Some(model.to_string());
        Ok(())
    }

    async fn clear_session_locked_model(&self, session_id: &str) -> anyhow::Result<()> {
        if let Some(sess) = lock(&self.sessions, "session")?.get_mut(session_id) {
            sess.locked_model = None;
        }
        Ok(())
    }

    async fn record_tool_sequence(
        &self,
        session_id: &str,
        new_tools: &[String],
        cap: usize,
    ) -> anyhow::Result<Vec<String>> {
        let mut sequences = lock(&self.tool_sequences, "tool-sequence")?;
        let sequence = sequences.entry(session_id.to_string()).or_default();
        if !new_tools.is_empty() {
            sequence.extend_from_slice(new_tools);
            if sequence.len() > cap {
                let start = sequence.len() - cap;
                *sequence = sequence.split_off(start);
            }
        }
        Ok(sequence.clone())
    }

    async fn swap_extracted_tool_count(&self, session_id: &str, new_count: u64) -> u64 {
        let Ok(mut counts) = lock(&self.extracted_tool_counts, "tool-count") else {
            return 0;
        };
        counts.insert(session_id.to_string(), new_count).unwrap_or(0)
    }

    async fn workspace_credential(
        &self,
        workspace_id: &str,
        fields: &[&str],
    ) -> Option<String> {
        let creds = self.credentials.lock().ok()?;
        let ws = creds.get(workspace_id)?;
        fields
            .iter()
            .find_map(|f| ws.get(*f).filter(|v| !v.is_empty()).cloned())
    }

    async fn set_workspace_credential(&self, workspace_id: &str, field: &str, value: &str) {
        if let Ok(mut creds) = self.credentials.lock() {
            creds
                .entry(workspace_id.to_string())
                .or_default()
                .insert(field.to_string(), value.to_string());
        }
    }

    async fn cached_response(&self, hash: &str) -> Option<CachedResponse> {
        let mut responses = self.responses.lock().ok()?;
        match responses.get(hash) {
            Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
            // Expired: drop it here rather than growing an unbounded map of
            // dead entries, since nothing else sweeps this.
            Some(_) => {
                responses.remove(hash);
                None
            }
            None => None,
        }
    }

    async fn store_response(
        &self,
        hash: &str,
        response: &CachedResponse,
        ttl_secs: u64,
    ) -> anyhow::Result<()> {
        lock(&self.responses, "response-cache")?.insert(
            hash.to_string(),
            Expiring {
                value: response.clone(),
                expires_at: Instant::now() + Duration::from_secs(ttl_secs),
            },
        );
        Ok(())
    }

    async fn incr_cache_counter(&self, workspace_id: &str, field: &str, by: i64) {
        if let Ok(mut counters) = self.cache_counters.lock() {
            *counters
                .entry(workspace_id.to_string())
                .or_default()
                .entry(field.to_string())
                .or_insert(0) += by;
        }
    }

    async fn add_cache_savings(&self, workspace_id: &str, amount: f64) {
        if let Ok(mut savings) = self.cache_savings.lock() {
            *savings.entry(workspace_id.to_string()).or_insert(0.0) += amount;
        }
    }

    /// No subscriber exists standalone. Logged rather than dropped so the
    /// trace stream is still observable via `RUST_LOG=debug`.
    async fn publish_trace(&self, trace: &ExecutionTrace) -> anyhow::Result<()> {
        tracing::debug!(
            trace_id = %trace.trace_id,
            workspace_id = %trace.workspace_id,
            model = %trace.model,
            verdict = %trace.verdict,
            latency_ms = trace.latency_ms,
            "execution trace (standalone: not published)"
        );
        Ok(())
    }

    async fn publish_system_anomaly(&self, workspace_id: &str, description: &str) {
        tracing::warn!(
            workspace_id = %workspace_id,
            "system anomaly (standalone: not published): {}",
            description
        );
    }

    /// Standalone has no cross-process transport, so a notification can only
    /// be logged.
    ///
    /// This is the degrade path chosen deliberately over a file-backed spool:
    /// a spool with an advisory lock gives mutual exclusion, not fan-out,
    /// ordering or liveness, and notifications are read-once and
    /// time-sensitive — getting fan-out wrong means a sibling silently never
    /// receives a KILL. Every session-scoped guarantee still holds here; only
    /// cross-node delivery is lost, and `intutic start` provisions Valkey
    /// whenever it can.
    async fn publish_notification(&self, scope: NotifyScope, id: &str, payload: &str) {
        tracing::info!(
            scope = ?scope,
            target = %id,
            "governance notification (standalone: not delivered to siblings): {}",
            payload
        );
    }

    /// No-op: membership needs state shared across processes.
    async fn touch_graph_node(&self, _workspace_id: &str, _graph_id: &str, _node_id: &str, _ttl_secs: u64) {}

    /// Always empty.
    ///
    /// Load-bearing rather than a stub: it makes graph broadcast a no-op
    /// instead of letting a single-process view be mistaken for the whole
    /// graph, which would deliver findings to one node and silently strand
    /// every other.
    async fn graph_members(&self, _workspace_id: &str, _graph_id: &str) -> Vec<String> {
        Vec::new()
    }

    /// Trust-on-first-use, persisted to disk.
    ///
    /// Durability is the whole point rather than a nicety: a pin that dies
    /// with the process is no pin at all, because a rug pull only has to wait
    /// for the proxy to restart. Kept in its own file rather than alongside
    /// the bandit snapshot — that one is a running estimate where losing an
    /// update costs a little exploration, whereas losing a pin silently
    /// re-baselines onto whatever a server is serving now.
    async fn pinned_tool_signature(
        &self,
        workspace_id: &str,
        harness: &str,
        signature: &str,
    ) -> Option<String> {
        let mut guard = self.tool_signatures.lock().ok()?;
        if guard.is_empty() {
            *guard = load_tool_pins();
        }
        // Keyed by harness as well as workspace — see the trait doc.
        //
        // This changes the on-disk key shape, so pins written by an older build
        // are not found and each harness re-pins on its next request. That is the
        // correct migration: the old key held one harness's tool set under a name
        // that claimed to cover all of them, so carrying it forward would keep
        // exactly the false positive this fixes. Re-pinning costs one
        // trust-on-first-use window per harness, which is the same window a fresh
        // install has.
        let key = format!("{workspace_id}\u{1f}{harness}");
        match guard.get(&key) {
            Some(existing) => Some(existing.clone()),
            None => {
                guard.insert(key, signature.to_string());
                save_tool_pins(&guard);
                Some(signature.to_string())
            }
        }
    }

    /// `None` — a graph spans processes, so its size is not knowable here.
    async fn graph_node_count(&self, _workspace_id: &str, _graph_id: &str) -> Option<u32> {
        None
    }

    /// `None` — no opinion, not "dead".
    ///
    /// Returning `Some(false)` here would declare every parent gone and orphan
    /// an entire graph on a store that never tracked it.
    async fn is_graph_member(&self, _workspace_id: &str, _graph_id: &str, _node_id: &str) -> Option<bool> {
        None
    }

    /// `None` — no spend signal, not zero.
    ///
    /// Zero would read as "this graph has cost nothing", which is exactly the
    /// wrong conclusion to hand a budget detector.
    async fn add_graph_spend(&self, _workspace_id: &str, _graph_id: &str, _amount: f64, _ttl_secs: u64) -> Option<f64> {
        None
    }

    async fn graph_spend(&self, _workspace_id: &str, _graph_id: &str) -> Option<f64> {
        None
    }

    /// `false` — nothing to arbitrate, because standalone has no cross-node
    /// delivery to suppress in the first place.
    async fn claim_broadcast(&self, _workspace_id: &str, _graph_id: &str, _kind: &str) -> bool {
        false
    }

    /// Aggregates what this process has seen of the run.
    ///
    /// Under-counts a run split across processes, which is the safe direction:
    /// the total can only be higher than what is recorded here, so a breach
    /// reported from this number is always a real one.
    /// Standalone has no control plane and therefore nobody to review anything.
    /// Holding a run here would block it with no way to release it.
    async fn request_loop_review(&self, _loop_run_id: &str, _reason: &str) {}

    async fn incr_reask_attempt(&self, session_id: &str, detector_id: &str) -> u32 {
        let Ok(mut m) = lock(&self.reask_attempts, "reask_attempts") else {
            // A poisoned lock must not escalate — see the trait doc.
            return 1;
        };
        let n = m
            .entry(format!("{session_id}|{detector_id}"))
            .or_insert(0);
        *n = n.saturating_add(1);
        *n
    }

    async fn loop_review_reason(&self, _loop_run_id: &str) -> Option<String> {
        None
    }

    async fn loop_review_cleared(&self, _loop_run_id: &str) -> Option<String> {
        None
    }

    async fn add_workflow_spend(&self, loop_run_id: &str, amount: f64) -> Option<f64> {
        let mut spend = lock(&self.workflow_spend, "workflow-spend").ok()?;
        let total = spend.entry(loop_run_id.to_string()).or_insert(0.0);
        *total += amount;
        Some(*total)
    }

    async fn set_workflow_budget_if_absent(&self, loop_run_id: &str, budget: f64) -> bool {
        let Ok(mut budgets) = lock(&self.workflow_budgets, "workflow-budget") else {
            return false;
        };
        if budgets.contains_key(loop_run_id) {
            return false;
        }
        budgets.insert(loop_run_id.to_string(), budget);
        true
    }

    /// `None` for the ceiling means "nobody capped this run", never "capped at
    /// zero" — the latter would refuse every request in an uncapped workflow.
    async fn workflow_budget(&self, loop_run_id: &str) -> (Option<f64>, Option<f64>) {
        let spend = lock(&self.workflow_spend, "workflow-spend")
            .ok()
            .and_then(|m| m.get(loop_run_id).copied());
        let budget = lock(&self.workflow_budgets, "workflow-budget")
            .ok()
            .and_then(|m| m.get(loop_run_id).copied());
        (spend, budget)
    }

    /// `ttl_secs` ignored — chunks are read back within the same request that
    /// wrote them, and the process boundary already bounds their lifetime.
    async fn push_session_chunk(
        &self,
        session_id: &str,
        payload: &str,
        _ttl_secs: Option<u64>,
    ) -> anyhow::Result<()> {
        lock(&self.session_chunks, "session-chunk")?
            .entry(session_id.to_string())
            .or_default()
            .push(payload.to_string());
        Ok(())
    }
}

/// Standalone: the control plane wrote nothing, so everything is absent.
///
/// Every method here is a constant. That is the finding the spike set out to
/// test — the control-plane half of the surface needs no second implementation,
/// only an honest way to say "not present", which is what lets the standalone
/// build drop Valkey entirely.
#[derive(Default)]
pub struct NullControlPlaneCache;

#[async_trait]
impl ControlPlaneCache for NullControlPlaneCache {
    async fn bandit_keywords(&self, _workspace_id: &str) -> Option<serde_json::Value> {
        None
    }

    async fn active_sop_tier(&self, _workspace_id: &str) -> Option<String> {
        None
    }

    /// `None`, not `Some(default)` — standalone there is no control plane to be
    /// authoritative, so `config.yaml` decides.
    async fn feature_flags(&self, _workspace_id: &str) -> Option<FeatureFlags> {
        None
    }

    /// `Unmanaged`, emphatically not `Rejected`. A standalone deployment has no
    /// `v2:auth:apikey:*` for any token, so returning "not found" here would
    /// 401 every request — the bug this enum exists to make impossible.
    /// Spend is still bounded, by `local_spend`'s on-disk daily cap.
    async fn auth_context(&self, _token: &str) -> ControlPlaneAuth {
        ControlPlaneAuth::Unmanaged
    }

    /// `Clear`, never `Unverifiable`. Standalone has no control plane to have
    /// set a cap, so there is nothing unverifiable about the answer — this is a
    /// definite "no cap", not a failed lookup. Standalone spend stays bounded
    /// by `local_spend`'s on-disk daily cap.
    /// Standalone open core has no control-plane budget keys; `local_spend`'s
    /// on-disk daily cap bounds spend instead.
    async fn daily_budget(&self, _workspace_id: &str) -> Option<(f64, Option<f64>)> {
        None
    }

    async fn hard_block(&self, _workspace_id: &str) -> HardCapStatus {
        HardCapStatus::Clear
    }

    async fn loop_status(&self, _loop_run_id: &str) -> Option<String> {
        None
    }

    /// No control plane means no loop registry, so no run to resolve.
    async fn active_loop_run(
        &self,
        _workspace_id: &str,
        _member_id: Option<&str>,
    ) -> Option<String> {
        None
    }

    /// Judging is a control-plane feature; standalone it is never auto-active.
    /// Explicit in-prompt invocation (`/intutic judge`) is unaffected.
    async fn auto_judge_active(&self, _scope: JudgeScope, _id: &str) -> bool {
        false
    }

    /// No control plane means no break-glass issuer, so no token can be valid.
    /// Standalone has nothing to break out of — policies come from local config.
    async fn break_glass_valid(&self, _token: &str) -> bool {
        false
    }

    async fn transition_baseline(&self, _workspace_id: &str) -> Option<String> {
        // The standalone store has no control plane behind it, so there is no fitted
        // model — the built-in table is the whole detector in local/OSS mode. That is
        // the intended tier boundary, not a gap.
        None
    }

    async fn wasm_plugins(&self, _workspace_id: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    async fn wasm_binary(&self, _sha256: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(None)
    }

    async fn predict_gate_threshold(&self, _workspace_id: &str) -> Option<f64> {
        None
    }

    async fn token_baseline(
        &self,
        _workspace_id: &str,
        _model: &str,
        _bucket: &str,
    ) -> Option<TokenBaseline> {
        None
    }

    /// Always empty. Nothing in open core writes `gov:notify:*` — the queues
    /// are filled by the control plane's corrective-prompt and cron services,
    /// so standalone is a consumer with no producer.
    async fn drain_notifications(&self, _scope: NotifyScope, _id: &str) -> Vec<String> {
        Vec::new()
    }

    /// Always `false`. No control plane means nothing ever attests a
    /// sandbox — returning anything else would make every open-core session
    /// look sandboxed regardless of reality.
    async fn is_sandbox_attested(&self, _session_id: &str) -> bool {
        false
    }
}

#[cfg(test)]
mod null_control_plane_cache_tests {
    use super::*;

    /// No control plane, no attestation — same fail-closed shape as
    /// `auto_judge_active` and `break_glass_valid` on this struct: standalone
    /// has nothing that could have attested a sandbox, so this must never be
    /// mistaken for "confirmed unattested" carrying different weight than
    /// "unknown". Both collapse to the same `false`.
    #[tokio::test]
    async fn standalone_never_attests_a_sandbox() {
        let cp = NullControlPlaneCache;
        assert!(!cp.is_sandbox_attested("ses_1").await);
    }
}

#[cfg(test)]
mod graph_tests {
    use super::*;

    /// A store that cannot track graphs must say so, not guess.
    ///
    /// The distinction is load-bearing for two detectors. `Some(false)` for
    /// liveness would orphan every node in every graph; `Some(0.0)` for spend
    /// would tell a budget detector the graph has cost nothing. Both are the
    /// wrong answer, and both are what a naive default would produce.
    #[tokio::test]
    async fn unknowable_graph_facts_are_none_not_defaults() {
        let s = MemoryStore::new();
        assert_eq!(s.is_graph_member("ws", "g", "n").await, None);
        assert_eq!(s.graph_spend("ws", "g").await, None);
        assert_eq!(s.add_graph_spend("ws", "g", 1.0, 60).await, None);
        assert!(s.graph_members("ws", "g").await.is_empty());
    }

    #[tokio::test]
    async fn workflow_budget_is_tracked_without_a_control_plane() {
        // Open core has no control plane, so nothing wrote the ceiling and this
        // store returned (None, None) unconditionally — WorkflowBudgetDetector
        // had no input it could ever act on.
        let store = MemoryStore::default();

        assert_eq!(store.workflow_budget("lr_1").await, (None, None));

        assert!(store.set_workflow_budget_if_absent("lr_1", 5.0).await);
        store.add_workflow_spend("lr_1", 2.0).await;
        store.add_workflow_spend("lr_1", 1.5).await;

        let (spend, budget) = store.workflow_budget("lr_1").await;
        assert_eq!(budget, Some(5.0));
        assert_eq!(spend, Some(3.5));
    }

    #[tokio::test]
    async fn an_existing_ceiling_is_never_overwritten() {
        // The control plane's value is the authority; a per-proxy default must
        // not quietly replace an operator's explicit budget.
        let store = MemoryStore::default();
        assert!(store.set_workflow_budget_if_absent("lr_1", 100.0).await);
        assert!(!store.set_workflow_budget_if_absent("lr_1", 5.0).await);
        assert_eq!(store.workflow_budget("lr_1").await.1, Some(100.0));
    }

    #[tokio::test]
    async fn runs_do_not_share_a_budget() {
        let store = MemoryStore::default();
        store.set_workflow_budget_if_absent("lr_1", 5.0).await;
        store.add_workflow_spend("lr_1", 4.0).await;
        assert_eq!(store.workflow_budget("lr_2").await, (None, None));
    }
}
