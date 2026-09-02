use crate::paths::intutic_dir;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;

#[derive(Serialize, Deserialize, Debug)]
struct LocalSpendDelta {
    spent_usd: f64,
}

/// Today's local daily spend cap, in USD.
///
/// Delegates to `local_config`'s cached parse (Wave 6.3, audit-remediation)
/// — this used to read and parse `config.json` fresh on every call, on the
/// request path, uncached. `get_local_spend` below already documents
/// exactly this class of defect for the spend total; this function had the
/// same one for the budget cap it's compared against.
pub fn get_max_daily_budget() -> f64 {
    crate::local_config::get_max_daily_budget()
}

/// How long a cached daily total may be reused before re-reading the file.
///
/// Not zero, because re-reading was the defect. Not unbounded, because two proxy
/// processes can share one `$HOME` — the same scenario `store::memory` documents
/// for bandit state — and each appends to the same daily file. An indefinite
/// cache would make each process blind to the other's spend for the rest of the
/// day; five seconds bounds that to five seconds.
///
/// The file stays the source of truth. This is a read-through cache, not a
/// write-back one: every spend is still appended immediately, so a crash loses
/// nothing.
const SPEND_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// `(date, total, read_at)` — `date` so a day rollover invalidates regardless of
/// the TTL, which matters at midnight when the file this points at changes name.
static SPEND_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<Option<(String, f64, std::time::Instant)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

/// Sum the day's spend file. The expensive path, called rarely.
fn read_spend_from_disk(today: &str) -> f64 {
    let spend_filename = format!("local-spend-{}.jsonl", today);
    let spend_path = intutic_dir().join("logs").join(&spend_filename);
    if !spend_path.exists() {
        return 0.0;
    }

    let mut total = 0.0;
    if let Ok(content) = fs::read_to_string(&spend_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(delta) = serde_json::from_str::<LocalSpendDelta>(trimmed) {
                total += delta.spent_usd;
            }
        }
    }
    total
}

/// Today's local spend.
///
/// # Why this is cached
///
/// This is called on the request path, synchronously, inside an async handler —
/// and it used to re-read and re-parse the **entire day's** spend file every
/// time, while `add_local_spend` appends one line per request. That is O(n²) in
/// requests-per-day, and it blocks a tokio worker while it runs.
///
/// Measured (Apple M4 Pro, release), cost of one call against the file as it
/// grows through a day:
///
/// | requests so far today | one call |
/// |---|---|
/// | 100 | 14 µs |
/// | 1,000 | 37 µs |
/// | 10,000 | **275 µs** |
/// | 50,000 | **1.31 ms** |
///
/// For scale: the entire 22-detector anomaly chain with every SOP declared costs
/// **8.7 µs**. After ten thousand requests this one file read cost 32× the whole
/// policy chain, and after fifty thousand, 150× — none of it policy, all of it
/// re-summing a log.
pub fn get_local_spend() -> f64 {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    if let Ok(guard) = SPEND_CACHE.lock() {
        if let Some((date, total, read_at)) = guard.as_ref() {
            if date == &today && read_at.elapsed() < SPEND_CACHE_TTL {
                return *total;
            }
        }
    }

    let total = read_spend_from_disk(&today);
    if let Ok(mut guard) = SPEND_CACHE.lock() {
        *guard = Some((today, total, std::time::Instant::now()));
    }
    total
}

pub fn add_local_spend(amount: f64) {
    if amount <= 0.0 {
        return;
    }
    let dir = intutic_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let spend_filename = format!("local-spend-{}.jsonl", today);
    let spend_path = dir.join(&spend_filename);

    let delta = LocalSpendDelta { spent_usd: amount };
    if let Ok(line) = serde_json::to_string(&delta) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&spend_path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }

    // Fold into the cache rather than invalidating it.
    //
    // Invalidating would send the next request straight back to the file, so a
    // steady stream of requests — exactly the case that made this expensive —
    // would re-read on every one and the cache would buy nothing. This process
    // knows its own delta, so it can stay accurate without reading; the TTL
    // above is what eventually reconciles a second process's writes.
    if let Ok(mut guard) = SPEND_CACHE.lock() {
        match guard.as_mut() {
            Some((date, total, _)) if date == &today => *total += amount,
            // Different day, or nothing cached yet: leave it for the next read
            // to populate from disk rather than seeding a total that omits
            // everything written before this process started.
            _ => *guard = None,
        }
    }
}

/// Size at which the day's trace log stops accepting writes.
///
/// The file already rotates by date, which bounds how *long* one lives but not
/// how *large* it gets. A busy graph writes a trace per node per request, so a
/// single day can run away unbounded on a developer's laptop — the file is
/// under `$HOME` and nothing prunes it.
///
/// 64MB is generous for a day of local traces while staying far away from
/// filling a disk. Past it, writes are dropped rather than rotated to a
/// suffixed file: this is a local debugging aid, and silently consuming a
/// developer's disk is a worse failure than losing the tail of a very noisy
/// day.
const MAX_TRACE_LOG_BYTES: u64 = 64 * 1024 * 1024;

pub fn log_offline_trace(trace: &serde_json::Value) {
    let dir = intutic_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let trace_filename = format!("traces-{}.jsonl", today);
    let trace_path = dir.join(&trace_filename);

    // Checked before opening, so an oversized file costs one stat rather than
    // an open and a write.
    if let Ok(meta) = fs::metadata(&trace_path) {
        if meta.len() >= MAX_TRACE_LOG_BYTES {
            return;
        }
    }

    if let Ok(line) = serde_json::to_string(trace) {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&trace_path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the tests in this module against `local_config.rs`'s.
    ///
    /// They share two pieces of process-global state: this module's own
    /// `SPEND_CACHE` static, and `HOME` — which each sets to its own
    /// directory so it does not touch a developer's real `~/.intutic`. Run
    /// concurrently, one test's `HOME` (and cache entry) leaks into the
    /// other's assertions.
    ///
    /// This was a real flake, not a hypothetical: the tests passed alone and
    /// failed on every parallel run, and it only surfaced when an unrelated
    /// test file changed the thread scheduling. Hoisted to
    /// `crate::test_support::HOME_LOCK` (rather than staying a module-private
    /// static) once `local_config.rs` needed the exact same `HOME`-mutating
    /// pattern — a second private lock could not see this one, so the same
    /// flake would have resurfaced across modules instead of within one.
    use crate::test_support::HOME_LOCK;

    /// Take the lock, tolerating a previous test having panicked while holding it.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn test_local_spend_functions() {
        let _lock = guard();
        // Reset the shared cache so this test starts from a known state whatever
        // ran before it. get_max_daily_budget delegates to local_config's own
        // cache now, which must also be reset — otherwise this test can read
        // a value local_config cached under a previous test's HOME.
        if let Ok(mut g) = SPEND_CACHE.lock() {
            *g = None;
        }
        crate::local_config::reset_cache_for_test();
        std::env::set_var("HOME", "/tmp/intutic_test_home");
        let dir = intutic_dir();
        let _ = fs::remove_dir_all(&dir);

        // Max budget defaults
        assert_eq!(get_max_daily_budget(), 10.0);
        assert_eq!(get_local_spend(), 0.0);

        // 1. Set local config limit (camelCase)
        let _ = fs::create_dir_all(&dir);
        let config_path = dir.join("config.json");
        fs::write(&config_path, r#"{"maxDailyBudgetUsd": 25.50}"#).unwrap();

        // local_config's own 60s TTL means the default read just above is
        // still cached — reset before each rewrite, exactly the shape a real
        // 60-second wait would eventually produce on its own.
        crate::local_config::reset_cache_for_test();
        assert_eq!(get_max_daily_budget(), 25.50);

        // 2. Set local config limit (snake_case alias)
        fs::write(&config_path, r#"{"max_daily_budget_usd": 15.75}"#).unwrap();

        crate::local_config::reset_cache_for_test();
        assert_eq!(get_max_daily_budget(), 15.75);

        // 3. Add some spend
        add_local_spend(5.25);
        assert_eq!(get_local_spend(), 5.25);

        // 4. Add more spend
        add_local_spend(2.50);
        assert_eq!(get_local_spend(), 7.75);

        // 5. The cache must not make a spend invisible to this process.
        //
        // `add_local_spend` folds its own delta into the cache rather than
        // invalidating it, so a steady stream of requests stays accurate without
        // re-reading. If it invalidated instead, the next call would go to disk
        // and the O(n²) read this cache exists to remove would come straight
        // back on exactly the busy path that motivated it.
        for _ in 0..10 {
            add_local_spend(0.10);
        }
        assert!(
            (get_local_spend() - 8.75).abs() < 1e-9,
            "every spend this process recorded must be visible immediately",
        );

        // 6. The file stays the source of truth.
        //
        // The cache is read-through, never write-back: a crash must lose
        // nothing. Reading the file directly must agree with what the cache
        // reports, or the durability story is a fiction.
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(
            (read_spend_from_disk(&today) - 8.75).abs() < 1e-9,
            "the file must hold every spend, not just the cache",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A day rollover must invalidate regardless of the TTL.
    ///
    /// The cached total points at a file whose *name* changes at midnight. A
    /// TTL-only check would keep serving yesterday's total for up to five
    /// seconds into the new day — small, but it is the one moment the budget is
    /// supposed to reset, so it would report a developer as still capped.
    #[test]
    fn a_day_rollover_invalidates_the_cache() {
        let _lock = guard();
        std::env::set_var("HOME", "/tmp/intutic_rollover_home");
        let dir = intutic_dir();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(dir.join("logs"));

        // Seed the cache as if yesterday had spend, with a fresh timestamp so
        // the TTL alone would happily serve it.
        if let Ok(mut g) = SPEND_CACHE.lock() {
            *g = Some(("1999-12-31".to_string(), 99.0, std::time::Instant::now()));
        }

        assert_eq!(
            get_local_spend(),
            0.0,
            "a stale date must force a re-read even well inside the TTL",
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
