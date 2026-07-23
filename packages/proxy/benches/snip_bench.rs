//! Criterion benchmarks for SnipCompactor v2.
//!
//! Run:
//!   cargo bench --bench snip_bench
//!   cargo bench --bench snip_bench -- --output-format bencher 2>&1 | tee docs/benchmarks/snip_v2_baseline.txt
//!
//! Budget targets (from implementation plan):
//!   JSON compact:          < 500µs  for 50 KB blob
//!   Rust skeleton (syn):   < 1ms    for 500-line file
//!   Code regex fallback:   < 200µs  for 500-line file
//!   Text rules:            < 100µs  for 4 KB plain text
//!   Language detection:    < 10µs   per call

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use intutic_proxy::{
    config::SnipCompactorConfig,
    snip,
    snip_code::{compact_code, detect_language},
    snip_json::{compact_json, is_json, JsonCompactConfig},
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// Generate a realistic JSON blob with mixed value types (keys, UUIDs, arrays, long strings).
fn make_json_blob(size_kb: usize) -> String {
    let entry_count = size_kb * 5; // ~200 bytes per entry
    let mut s = String::from("[\n");
    for i in 0..entry_count {
        s.push_str(&format!(
            r#"  {{"id":"550e8400-e29b-41d4-a716-44665544{:04x}","name":"user_{i}","bio":"{}","active":true,"score":{i},"tags":["alpha","beta","gamma","delta","epsilon"]}},"#,
            i,
            "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor"
        ));
    }
    s.push_str("\n]");
    s
}

/// Generate a realistic Rust source file with N functions.
fn make_rust_source(fn_count: usize) -> String {
    let mut s = String::from("use std::collections::HashMap;\nuse std::sync::Arc;\n\n");
    for i in 0..fn_count {
        s.push_str(&format!(
            r#"/// Function {i} — does important processing.
pub async fn process_item_{i}(input: &str, config: &Config, cache: Arc<HashMap<String, String>>) -> Result<String, Error> {{
    let _x = input.trim();
    let _y = config.max_retries;
    let _z = cache.get("key").map(|v| v.clone()).unwrap_or_default();
    // Multi-line body with realistic code
    for _ in 0..10 {{
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }}
    Ok(format!("result_{{}}", _x))
}}

"#
        ));
    }
    s
}

/// Generate a Python source file with N functions.
fn make_python_source(fn_count: usize) -> String {
    let mut s = String::from("import os\nimport sys\nfrom typing import Optional, List\n\n");
    for i in 0..fn_count {
        s.push_str(&format!(
            r#"def process_item_{i}(input_str: str, config: dict, cache: Optional[dict] = None) -> str:
    """Process item {i} with given configuration."""
    x = input_str.strip()
    y = config.get("max_retries", 3)
    z = cache.get("key") if cache else None
    for _ in range(10):
        x = x.lower()
    return f"result_{{x}}"

"#
        ));
    }
    s
}

/// 4 KB realistic plain text (logs, stack traces, repeated lines).
fn make_plain_text() -> String {
    let mut s = String::new();
    for i in 0..20 {
        s.push_str(&format!(
            "[INFO]  2024-01-15 12:{i:02}:00 Request received id=req_{i}\n"
        ));
    }
    for _ in 0..10 {
        s.push_str("    at java.lang.Thread.run(Thread.java:748)\n");
        s.push_str("    at java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1149)\n");
    }
    s.push_str("import React from 'react';\n".repeat(5).as_str());
    s.push_str("Processing complete.\n".repeat(8).as_str());
    s
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

fn bench_json_compact(c: &mut Criterion) {
    let mut group = c.benchmark_group("json_compact");

    for size_kb in [1, 10, 50, 100] {
        let blob = make_json_blob(size_kb);
        let cfg = JsonCompactConfig {
            max_array_items: 3,
            max_string_value_chars: 20,
            entropy_threshold: 0.85,
        };

        group.throughput(Throughput::Bytes(blob.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size_kb}KB")),
            &blob,
            |b, blob| {
                b.iter(|| compact_json(black_box(blob), black_box(&cfg)));
            },
        );
    }
    group.finish();
}

fn bench_rust_skeleton(c: &mut Criterion) {
    let mut group = c.benchmark_group("rust_skeleton");

    for fn_count in [10, 50, 100] {
        let source = make_rust_source(fn_count);
        let line_count = source.lines().count();

        group.throughput(Throughput::Bytes(source.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{fn_count}fns_{line_count}lines")),
            &source,
            |b, source| {
                b.iter(|| compact_code(black_box(source)));
            },
        );
    }
    group.finish();
}

fn bench_python_skeleton_regex(c: &mut Criterion) {
    let mut group = c.benchmark_group("python_skeleton_regex");

    for fn_count in [10, 50, 100] {
        let source = make_python_source(fn_count);

        group.throughput(Throughput::Bytes(source.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{fn_count}fns")),
            &source,
            |b, source| {
                b.iter(|| compact_code(black_box(source)));
            },
        );
    }
    group.finish();
}

fn bench_text_rules(c: &mut Criterion) {
    let mut group = c.benchmark_group("text_rules");
    let text = make_plain_text();
    let config = SnipCompactorConfig::default();

    group.throughput(Throughput::Bytes(text.len() as u64));
    group.bench_function("4kb_mixed", |b| {
        b.iter(|| snip::compact(black_box(&text), black_box(&config)));
    });
    group.finish();
}

fn bench_language_detection(c: &mut Criterion) {
    let mut group = c.benchmark_group("language_detection");

    let samples = [
        (
            "rust_fn",
            "pub fn main() {\n    println!(\"hello\");\n    let x: u32 = 42;\n    impl Foo {}\n}\n",
        ),
        (
            "python_def",
            "def hello(name):\n    print(name)\nclass Foo:\n    pass\n",
        ),
        ("json_obj", r#"{"key": "value", "arr": [1, 2, 3]}"#),
        (
            "plain_text",
            "Just some plain text with no code markers at all.",
        ),
    ];

    for (name, text) in &samples {
        group.bench_function(*name, |b| {
            b.iter(|| detect_language(black_box(text)));
        });
    }
    group.finish();
}

fn bench_is_json(c: &mut Criterion) {
    let json_text = r#"{"key": "value"}"#;
    let plain_text = "This is not JSON";

    c.bench_function("is_json_positive", |b| {
        b.iter(|| is_json(black_box(json_text)));
    });
    c.bench_function("is_json_negative", |b| {
        b.iter(|| is_json(black_box(plain_text)));
    });
}

fn bench_full_pipeline(c: &mut Criterion) {
    let mut group = c.benchmark_group("full_pipeline");
    let config = SnipCompactorConfig::default();

    let inputs = [
        ("json_10kb", make_json_blob(10)),
        ("rust_100fn", make_rust_source(100)),
        ("python_50fn", make_python_source(50)),
        ("plain_4kb", make_plain_text()),
    ];

    for (name, text) in &inputs {
        group.throughput(Throughput::Bytes(text.len() as u64));
        group.bench_function(*name, |b| {
            b.iter(|| snip::compact(black_box(text), black_box(&config)));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_json_compact,
    bench_rust_skeleton,
    bench_python_skeleton_regex,
    bench_text_rules,
    bench_language_detection,
    bench_is_json,
    bench_full_pipeline,
);
criterion_main!(benches);
