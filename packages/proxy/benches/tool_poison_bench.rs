//! What the tool-poisoning scan costs on the request path.
//!
//! Run:
//!   cargo bench --bench tool_poison_bench
//!
//! # Why this exists before the detector ships, not after
//!
//! Phase 0 retracted a published "<5ms evaluation chain" claim and then found
//! the component it named was **165× slower** than the thing it replaced — a
//! `RegexSet` prefilter in DLP whose union had no literal prefix for memchr to
//! accelerate. The lesson was not "RegexSet is slow"; it was that this class of
//! intuition is unreliable in both directions and has to be measured.
//!
//! `ToolPoisoningDetector` runs seven regexes over every tool description on
//! every request, which is exactly the shape of the thing Phase 0 caught. So it
//! was measured before it was committed, and the answer went the other way: the
//! set beats a plain loop over the same patterns by roughly 2×.
//!
//! The cost turned out to be concentrated rather than diffuse.
//! `read-sensitive-path` and `cross-tool-shadowing` were most of the total,
//! because both open on words in nearly every tool description ("read", "open",
//! "access", "tool") — the automaton matched the cheap prefix constantly and
//! then scanned forward for a path that was almost never there. Gating each
//! pattern on a literal it already requires is another ~1.8×, and the
//! equivalence is asserted against all 10,753 corpus rows in
//! `tool_poison::tests::gating_never_changes_a_verdict`, not argued here.
//!
//! # Read the ratios, not the absolutes
//!
//! Successive runs of this benchmark on the same machine, same code, differed
//! by more than 3× depending on whether a 30B model happened to be resident —
//! 45 µs for the same forty descriptions that measured 12 µs minutes earlier.
//! Neither figure is wrong and neither is quotable. Absolute numbers here
//! describe one laptop under whatever load it had at the time.
//!
//! The ratio between two implementations measured back-to-back **in the same
//! process** is the part that transfers, which is why the gated-vs-set
//! comparison was taken that way rather than from two separate runs.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use intutic_proxy::tool_poison;

/// Real tool descriptions, not invented ones.
///
/// A benchmark over hand-written strings would measure the author's sense of
/// what a tool description looks like. These are the vendored BFCL descriptions
/// the false-positive gate uses, so the benchmark and the correctness test are
/// looking at the same text.
fn descriptions(n: usize) -> Vec<String> {
    include_str!("../tests/corpus/tooldesc/tooldesc.jsonl")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(n)
        .map(|l| {
            serde_json::from_str::<serde_json::Value>(l).expect("corpus row")["text"]
                .as_str()
                .expect("text")
                .to_string()
        })
        .collect()
}

/// A whole request's tool array. 40 is a busy MCP setup, not a worst case.
fn bench_one_request(c: &mut Criterion) {
    let tools = descriptions(40);
    c.bench_function("tool_poison/40_descriptions", |b| {
        b.iter(|| {
            for d in &tools {
                black_box(tool_poison::scan(black_box(d)));
            }
        });
    });
}

/// One oversized description.
///
/// A tool description is attacker-controlled and unbounded, so the interesting
/// question is not the median but whether a hostile server can make this
/// expensive. Linear is the answer that makes the detector safe to leave on.
fn bench_pathological(c: &mut Criterion) {
    let long = descriptions(40).join(" ").repeat(8);
    let mut group = c.benchmark_group("tool_poison_large");
    group.throughput(criterion::Throughput::Bytes(long.len() as u64));
    group.bench_function("one_large_description", |b| {
        b.iter(|| black_box(tool_poison::scan(black_box(&long))));
    });
    group.finish();
}

criterion_group!(benches, bench_one_request, bench_pathological);
criterion_main!(benches);
