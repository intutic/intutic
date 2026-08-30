//! `judge_finalize_deadline_ms()`'s own env-var parsing — split into its own
//! file, deliberately, from `judge_finalize_deadline_test.rs`'s integration
//! test.
//!
//! ## Why this is its own file
//!
//! Both this test and `judge_finalize_deadline_test.rs`'s async integration
//! test set the SAME process-global `JUDGE_FINALIZE_DEADLINE_MS` env var.
//! `cargo test` runs every test in a binary concurrently by default, and
//! this repo's own test files already carry this exact warning for
//! `OPENAI_UPSTREAM_URL`/`CONTROL_PLANE_URL` (see `judge_stream_test.rs`'s
//! module doc) — this file originally shared a file with that integration
//! test on the theory that "it only touches a var nothing else in the
//! workspace sets," which was true only until the sibling test in the SAME
//! file started setting that same var. The race: this test's cleanup
//! (`remove_var` at the end, or any of its intermediate `set_var` calls)
//! can interleave with the integration test's `set_var(..., "500")`,
//! silently resetting it to unset — which falls back to the 5000ms
//! default, well above that test's 3-second mock delay, so the deadline
//! never fires and the test's timing assertion fails. Reproduced exactly
//! this way in CI (passed locally, failed in CI — a scheduling-dependent
//! race, not an environment difference). One process-global-env-mutating
//! test per file is the fix, same convention `judge_stream_test.rs` and
//! `local_judge_test.rs` already use for their own env vars.

#[test]
fn judge_finalize_deadline_ms_parses_unset_disabled_and_explicit() {
    std::env::remove_var("JUDGE_FINALIZE_DEADLINE_MS");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(5000),
        "unset must default to 5000ms"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "0");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        None,
        "explicit 0 must disable the deadline"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "-100");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        None,
        "a negative value must disable the deadline, same as 0"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "2500");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(2500),
        "a positive value must be used verbatim"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "not-a-number");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(5000),
        "unparseable must fall back to the default, same as unset — never to unbounded"
    );

    std::env::remove_var("JUDGE_FINALIZE_DEADLINE_MS");
}
