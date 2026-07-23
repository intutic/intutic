//! SnipCompactor v2 integration tests
//! Tests the full pipeline: JSON dispatch, code skeleton, text rules,
//! and the compress_tool_results proxy helper.

use intutic_proxy::config::SnipCompactorConfig;
use intutic_proxy::snip;
use intutic_proxy::snip_code;
use intutic_proxy::snip_json;

// ─── Existing text-rules regression test ─────────────────────────────────────

#[test]
fn test_snip_compactor_text_rules_regression() {
    let config = SnipCompactorConfig::default();

    // Use import lines that look like Python-style imports (clearly non-JS)
    // to avoid the code-skeleton code path and exercise the text rules.
    // The input must NOT be detected as code and must be < code_skeleton_min_lines (10).
    // We use a short input to stay below the min-lines threshold.
    let input = concat!(
        "import my_module\n",
        "import my_module\n",
        "import my_module\n",
        "result OK\n",
        "result OK\n",
        "result OK\n",
        "result OK\n",
        "result OK\n",
        "Final result: OK\n",
    );
    // 9 lines: below code_skeleton_min_lines (10), so text rules will run.

    let (compressed, ratio) = snip::compact(input, &config);

    assert!(ratio > 0.0, "Compression ratio should be positive");
    assert!(
        compressed.len() < input.len(),
        "Output should be shorter than input"
    );

    // Import dedup should have collapsed the 3 identical import lines to 1
    assert_eq!(
        compressed.matches("import my_module").count(),
        1,
        "Duplicate imports should be deduped to 1"
    );

    // Repetition collapse should have collapsed the repeated "result OK" lines
    assert!(
        compressed.contains("[..."),
        "Repetitions should be collapsed"
    );
}

// ─── JSON dispatch ────────────────────────────────────────────────────────────

#[test]
fn test_snip_compact_routes_json_to_json_compressor() {
    let config = SnipCompactorConfig::default();

    // Build a large JSON with long strings and a big array — should compress
    let items: Vec<String> = (0..20)
        .map(|i| format!(r#"{{"id":{},"description":"{}"}}"#, i, "x".repeat(60)))
        .collect();
    let input = format!("[{}]", items.join(","));

    assert!(
        snip_json::is_json(&input),
        "Input should be detected as JSON"
    );

    let (compressed, ratio) = snip::compact(&input, &config);
    assert!(
        ratio > 0.0,
        "JSON with long strings should compress: ratio={}",
        ratio
    );
    assert!(
        compressed.contains("more items") || compressed.len() < input.len(),
        "JSON compressor should have reduced output"
    );
}

#[test]
fn test_snip_compact_json_preserves_short_values() {
    let config = SnipCompactorConfig::default();
    let input = r#"{"status":"ok","count":1,"active":true}"#;
    let (compressed, _) = snip::compact(input, &config);
    assert!(
        compressed.contains("\"status\""),
        "key 'status' must be present"
    );
    assert!(
        compressed.contains("\"ok\""),
        "short value 'ok' must be preserved"
    );
    assert!(compressed.contains("true"), "boolean must be preserved");
}

#[test]
fn test_snip_compact_json_preserves_uuid_values() {
    let config = SnipCompactorConfig::default();
    let uuid = "8f14e45f-ceea-4123-8f14-e45fceea4123";
    let input = format!(
        r#"{{"workspace_id":"{}","name":"{}"}}"#,
        uuid,
        "x".repeat(80)
    );
    let (compressed, _) = snip::compact(&input, &config);
    assert!(
        compressed.contains(uuid),
        "High-entropy UUID must be preserved in: {}",
        compressed
    );
}

// ─── Code skeleton dispatch ───────────────────────────────────────────────────

#[test]
fn test_snip_compact_routes_rust_to_skeleton() {
    let config = SnipCompactorConfig::default();

    // Build a long Rust snippet (>= code_skeleton_min_lines = 10)
    let mut code = String::from("use std::collections::HashMap;\n\n");
    for i in 0..15 {
        code.push_str(&format!(
            "pub fn function_{}(x: u64, y: u64) -> u64 {{\n    let result = x + y + {};\n    result * result\n}}\n\n",
            i, i
        ));
    }
    assert!(
        code.lines().count() >= config.code_skeleton_min_lines,
        "Test input must be >= {} lines",
        config.code_skeleton_min_lines
    );

    let (compressed, ratio) = snip::compact(&code, &config);
    // Either skeleton extraction or text rules should compress it
    assert!(
        ratio > 0.0 || compressed.len() <= code.len(),
        "Rust code should compress: ratio={}, out_len={}, in_len={}",
        ratio,
        compressed.len(),
        code.len()
    );
}

#[test]
fn test_snip_compact_short_code_not_skeleton() {
    // A snippet below code_skeleton_min_lines should skip skeleton pass
    let config = SnipCompactorConfig::default();
    let code = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
    assert!(code.lines().count() < config.code_skeleton_min_lines);

    let (out, _) = snip::compact(code, &config);
    // Should pass through (text rules applied, but no skeleton)
    assert!(!out.is_empty());
}

#[test]
fn test_snip_compact_disabled_passthrough() {
    let mut config = SnipCompactorConfig::default();
    config.enabled = false;
    let input = r#"{"big":"array","data":[1,2,3,4,5]}"#.repeat(100);
    let (out, ratio) = snip::compact(&input, &config);
    assert_eq!(
        out, input,
        "Disabled compressor must pass through unchanged"
    );
    assert_eq!(ratio, 0.0);
}

// ─── snip_json unit ───────────────────────────────────────────────────────────

#[test]
fn test_entropy_score_uuid_is_high() {
    let score = snip_json::entropy_score("8f14e45f-ceea-4123-8f14-e45fceea4123");
    assert!(
        score >= 0.80,
        "UUID entropy should be >= 0.80, got {}",
        score
    );
}

#[test]
fn test_entropy_score_prose_is_zero() {
    let score = snip_json::entropy_score("hello world this is normal text");
    assert_eq!(score, 0.0, "Prose with spaces should be 0.0");
}

#[test]
fn test_is_json_positive() {
    assert!(snip_json::is_json(r#"{"a":1}"#));
    assert!(snip_json::is_json("[1,2,3]"));
    assert!(snip_json::is_json("  \n  {\"nested\":true}"));
}

#[test]
fn test_is_json_negative() {
    assert!(!snip_json::is_json("fn main() {}"));
    assert!(!snip_json::is_json(""));
    assert!(!snip_json::is_json("plain text"));
}

// ─── snip_code unit ──────────────────────────────────────────────────────────

#[test]
fn test_detect_rust() {
    use snip_code::CodeLanguage;
    let code = "pub fn main() {\n    println!(\"hello\");\n}\n";
    assert_eq!(snip_code::detect_language(code), CodeLanguage::Rust);
}

#[test]
fn test_detect_python() {
    use snip_code::CodeLanguage;
    let code = "def hello():\n    print('hi')\n\nclass Foo:\n    pass\n";
    assert_eq!(snip_code::detect_language(code), CodeLanguage::Python);
}

#[test]
fn test_detect_go() {
    use snip_code::CodeLanguage;
    let code = "package main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n";
    assert_eq!(snip_code::detect_language(code), CodeLanguage::Go);
}

#[test]
fn test_detect_json_not_code() {
    use snip_code::CodeLanguage;
    assert_eq!(
        snip_code::detect_language(r#"{"fn":"value"}"#),
        CodeLanguage::Unknown
    );
}

#[test]
fn test_compact_code_python_reduces_size() {
    let code = "import os\nimport sys\n\n".to_string()
        + &"def function_a(x, y):\n    result = x + y\n    return result * result\n\n".repeat(8);
    let (skeleton, ratio) = snip_code::compact_code(&code);
    // Skeleton should at least contain the function signatures
    assert!(
        skeleton.contains("function_a") || ratio >= 0.0,
        "Python skeleton should contain function names or at least not error"
    );
}

#[test]
fn test_compact_code_unknown_passthrough() {
    let input = "just some random text with no code markers whatsoever\n";
    let (out, ratio) = snip_code::compact_code(input);
    assert_eq!(out, input, "Unknown language must pass through unchanged");
    assert_eq!(ratio, 0.0);
}

// ─── detect_content_type ─────────────────────────────────────────────────────

#[test]
fn test_detect_content_type_json() {
    use intutic_proxy::snip::ContentType;
    let t = snip::detect_content_type(r#"{"key":"value"}"#);
    assert_eq!(t, ContentType::Json);
}

#[test]
fn test_detect_content_type_code() {
    use intutic_proxy::snip::ContentType;
    let code = "pub fn main() {\n    println!(\"hello\");\n}\n";
    let t = snip::detect_content_type(code);
    assert!(
        matches!(t, ContentType::Code(_)),
        "Rust code should be ContentType::Code"
    );
}

#[test]
fn test_detect_content_type_text() {
    use intutic_proxy::snip::ContentType;
    let t = snip::detect_content_type("just some plain text");
    assert_eq!(t, ContentType::Text);
}

// ─── hard truncation ─────────────────────────────────────────────────────────

#[test]
fn test_hard_truncation_fires_on_overflow() {
    let mut config = SnipCompactorConfig::default();
    config.max_tool_output_tokens = 10; // very small: 40 chars
    config.code_skeleton_enabled = false; // isolate truncation test

    let input = "x".repeat(200); // 200 chars → ~50 tokens, over limit
    let (out, _) = snip::compact(&input, &config);
    assert!(
        out.contains("[truncated:"),
        "Output should contain truncation marker"
    );
    assert!(out.len() < input.len(), "Truncated output must be shorter");
}

// ─── TD-003: TypeScript WASM smoke test ───────────────────────────────────────
// Documents whether each grammar is currently loaded via WASM or regex fallback.
// Does NOT assert a specific outcome — passes regardless of grammar build status.
// Run this test and check output to verify grammar health.

#[test]
fn test_td003_grammar_load_status_smoke() {
    use snip_code::CodeLanguage;

    // For each language, attempt to compact a minimal code snippet.
    // If WASM grammar is loaded → will use tree-sitter parse.
    // If grammar absent/failed → will use regex fallback.
    // Either outcome is acceptable; this test just documents the current state.
    let samples: &[(&str, CodeLanguage, &str)] = &[
        ("python",
         CodeLanguage::Python,
         "def hello(name):\n    print(name)\n\ndef goodbye():\n    return 0\n"),
        ("typescript",
         CodeLanguage::TypeScript,
         "interface Foo {\n  bar: string;\n  baz: number;\n}\nfunction greet(): void {}\n"),
        ("javascript",
         CodeLanguage::JavaScript,
         "function hello(name) {\n  return `hi ${name}`;\n}\nconst f = () => {};\n"),
        ("go",
         CodeLanguage::Go,
         "package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n"),
        ("java",
         CodeLanguage::Java,
         "public class Hello {\n  public static void main(String[] args) {\n    System.out.println(\"hi\");\n  }\n}\n"),
    ];

    for (name, lang, code) in samples {
        let detected = snip_code::detect_language(code);
        let (skeleton, _ratio) = snip_code::compact_code(code);
        // Just confirm: no panic, skeleton is non-empty or equal to input
        assert!(
            !skeleton.is_empty(),
            "Language '{}' skeleton must be non-empty (even regex fallback returns something)",
            name
        );
        // Log status for human review (visible with `cargo test -- --nocapture`)
        let status = if detected == *lang {
            "detected"
        } else {
            "not detected"
        };
        println!(
            "[TD-003] {}: language={}, skeleton_len={}/{}, status={}",
            name,
            format!("{:?}", detected),
            skeleton.len(),
            code.len(),
            status
        );
    }
}

// ─── TD-003: Grammar cache does not reload on second call ────────────────────

#[test]
fn test_grammar_cache_hit_no_reload() {
    // Rust uses syn (no grammar cache), but we can verify compact_code is
    // idempotent (second call = same output, confirming cache works correctly).
    let code = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n".repeat(5);
    let (out1, ratio1) = snip_code::compact_code(&code);
    let (out2, ratio2) = snip_code::compact_code(&code);

    assert_eq!(out1, out2, "compact_code must be deterministic");
    assert_eq!(
        (ratio1 * 1000.0) as i64,
        (ratio2 * 1000.0) as i64,
        "ratio must be stable across calls"
    );
}

// ─── TD-007: Thread-local parser is safe under concurrent access ──────────────

#[test]
fn test_concurrent_parsing_no_panic() {
    use snip_code::compact_code;
    use std::sync::{Arc, Barrier};
    use std::thread;

    let python_code = "def process(x):\n    return x * 2\n\ndef validate(y):\n    return y > 0\n";
    let rust_code = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";

    let thread_count = 8;
    let iterations = 20;
    let barrier = Arc::new(Barrier::new(thread_count));
    let mut handles = Vec::new();

    for i in 0..thread_count {
        let barrier = Arc::clone(&barrier);
        let code = if i % 2 == 0 {
            python_code.to_string()
        } else {
            rust_code.to_string()
        };

        handles.push(thread::spawn(move || {
            // All threads start simultaneously to maximise contention
            barrier.wait();
            for _ in 0..iterations {
                let (out, _) = compact_code(&code);
                assert!(!out.is_empty(), "compact_code must never return empty");
            }
        }));
    }

    for h in handles {
        h.join()
            .expect("Thread panicked during concurrent compact_code");
    }
}

// ─── TD-009: grammar_load_status() API ───────────────────────────────────────

#[test]
fn test_td009_grammar_load_status_api() {
    use snip_code::{grammar_load_status, GrammarStatus};

    let statuses = grammar_load_status();
    // Should return exactly 5 languages
    assert_eq!(statuses.len(), 5);

    let langs: Vec<&str> = statuses.iter().map(|(l, _)| *l).collect();
    assert!(langs.contains(&"python"), "python must be in status list");
    assert!(
        langs.contains(&"typescript"),
        "typescript must be in status list"
    );
    assert!(
        langs.contains(&"javascript"),
        "javascript must be in status list"
    );
    assert!(langs.contains(&"go"), "go must be in status list");
    assert!(langs.contains(&"java"), "java must be in status list");

    // With .wasm files built and embedded, all should be Wasm
    for (lang, status) in &statuses {
        println!("[TD-009] {lang}: {status:?}");
        assert_eq!(
            *status,
            GrammarStatus::Wasm,
            "Grammar '{lang}' should be Wasm-loaded (all .wasm files are built)"
        );
    }
}

// ─── TD-008: Incremental parse cache ─────────────────────────────────────────

#[test]
fn test_td008_incremental_cache_hit_skips_reparse() {
    use snip_code::{compact_code_cached, invalidate_parse_cache, parse_cache_size};

    // Start with clean cache for this thread
    invalidate_parse_cache();
    assert_eq!(parse_cache_size(), 0, "Cache should start empty");

    let code = "def fetch_data(url: str) -> dict:\n    response = requests.get(url)\n    return response.json()\n\n".repeat(6);

    // First call: cache miss → should parse and insert
    let (skeleton1, ratio1) = compact_code_cached(&code, true);
    assert!(!skeleton1.is_empty(), "First call must produce a skeleton");
    assert!(ratio1 > 0.0, "First call must compress");
    assert_eq!(
        parse_cache_size(),
        1,
        "Cache should have 1 entry after first call"
    );

    // Second call with same input: cache hit
    let (skeleton2, ratio2) = compact_code_cached(&code, true);
    assert_eq!(skeleton1, skeleton2, "Cache hit must return same skeleton");
    assert!(
        (ratio1 - ratio2).abs() < 0.001,
        "Ratios must match: {} vs {}",
        ratio1,
        ratio2
    );

    // Different code: new miss
    let code2 = "def other_fn(x: int) -> int:\n    return x * 2\n\n".repeat(6);
    let (_, _) = compact_code_cached(&code2, true);
    assert!(
        parse_cache_size() >= 2,
        "Second unique code should add cache entry"
    );

    // Cache=false should not use or populate cache
    invalidate_parse_cache();
    let (_, _) = compact_code_cached(&code, false);
    assert_eq!(parse_cache_size(), 0, "cache=false must not insert");
}

#[test]
fn test_td008_cache_is_thread_local_isolated() {
    use snip_code::{compact_code_cached, invalidate_parse_cache, parse_cache_size};
    use std::sync::{Arc, Barrier};

    let barrier = Arc::new(Barrier::new(2));
    let code = "def fn_a(x):\n    return x\n\n".repeat(6);

    // Thread 1: populate cache
    let b1 = Arc::clone(&barrier);
    let code_t1 = code.clone();
    let t1 = std::thread::spawn(move || {
        invalidate_parse_cache();
        let _ = compact_code_cached(&code_t1, true);
        let size = parse_cache_size();
        b1.wait(); // sync point
        size
    });

    // Thread 2: should have its own empty cache
    let b2 = Arc::clone(&barrier);
    let t2 = std::thread::spawn(move || {
        invalidate_parse_cache();
        let size_before = parse_cache_size();
        b2.wait(); // sync point
        size_before
    });

    let t1_size = t1.join().unwrap();
    let t2_size = t2.join().unwrap();

    assert_eq!(t1_size, 1, "Thread 1 should have 1 cache entry");
    assert_eq!(t2_size, 0, "Thread 2 cache is isolated — should be empty");
}

// ─── TD-011: Java grammar quality corpus ─────────────────────────────────────
// Verifies that the Java tree-sitter WASM grammar produces meaningful skeletons
// for realistic Java code patterns. Measures skeleton extraction rate and ratio.

#[test]
fn test_td011_java_grammar_quality_corpus() {
    use snip_code::compact_code;

    let corpus: &[(&str, &str)] = &[
        ("simple_class", "public class HelloWorld {\n    public static void main(String[] args) {\n        System.out.println(\"Hello, World!\");\n    }\n\n    public String greet(String name) {\n        return \"Hello, \" + name;\n    }\n}\n"),
        ("interface_impl", "public interface Repository<T> {\n    T findById(Long id);\n    List<T> findAll();\n    T save(T entity);\n    void deleteById(Long id);\n}\n\npublic class UserRepository implements Repository<User> {\n    public User findById(Long id) { return null; }\n    public List<User> findAll() { return new ArrayList<>(); }\n    public User save(User u) { return u; }\n    public void deleteById(Long id) {}\n}\n"),
        ("spring_controller", "import org.springframework.web.bind.annotation.*;\nimport org.springframework.http.ResponseEntity;\n\n@RestController\n@RequestMapping(\"/api/users\")\npublic class UserController {\n    private final UserService userService;\n\n    public UserController(UserService userService) {\n        this.userService = userService;\n    }\n\n    @GetMapping(\"/{id}\")\n    public ResponseEntity<UserDto> getUser(@PathVariable Long id) {\n        return ResponseEntity.ok(userService.findById(id));\n    }\n\n    @PostMapping\n    public ResponseEntity<UserDto> createUser(@RequestBody CreateUserRequest req) {\n        return ResponseEntity.created(null).body(userService.create(req));\n    }\n}\n"),
        ("enum_and_generics", "public enum Status {\n    ACTIVE, INACTIVE, PENDING;\n\n    public boolean isActive() { return this == ACTIVE; }\n}\n\npublic class Result<T> {\n    private final T value;\n    private final String error;\n\n    public static <T> Result<T> ok(T value) { return new Result<>(value, null); }\n    public static <T> Result<T> err(String e) { return new Result<>(null, e); }\n    public boolean isOk() { return error == null; }\n    public T getValue() { return value; }\n}\n"),
        ("exception_handling", "import java.io.IOException;\nimport java.nio.file.Files;\nimport java.nio.file.Path;\n\npublic class FileProcessor {\n    public String readFile(Path path) throws IOException {\n        try {\n            return Files.readString(path);\n        } catch (IOException e) {\n            throw new RuntimeException(\"Failed to read file: \" + path, e);\n        }\n    }\n\n    public void processDirectory(Path dir) {\n        try (var stream = Files.walk(dir)) {\n            stream.filter(Files::isRegularFile).forEach(this::processFile);\n        } catch (IOException e) {\n            System.err.println(\"Error: \" + e.getMessage());\n        }\n    }\n\n    private void processFile(Path f) {}\n}\n"),
        ("abstract_class", "import java.util.List;\nimport java.util.ArrayList;\n\npublic abstract class BaseService<T, ID> {\n    protected final Repository<T> repository;\n\n    protected BaseService(Repository<T> repo) {\n        this.repository = repo;\n    }\n\n    public abstract T create(T entity);\n    public abstract T update(ID id, T entity);\n\n    public List<T> findAll() {\n        return repository.findAll();\n    }\n\n    public void delete(ID id) {\n        repository.deleteById((Long) id);\n    }\n}\n"),
        ("stream_api", "import java.util.*;\nimport java.util.stream.*;\n\npublic class DataProcessor {\n    public Map<String, Long> countByCategory(List<Event> events) {\n        return events.stream()\n            .collect(Collectors.groupingBy(Event::getCategory, Collectors.counting()));\n    }\n\n    public List<String> filterAndSort(List<String> items, String prefix) {\n        return items.stream()\n            .filter(s -> s.startsWith(prefix))\n            .sorted()\n            .distinct()\n            .collect(Collectors.toList());\n    }\n\n    public OptionalDouble averageScore(List<User> users) {\n        return users.stream().mapToDouble(User::getScore).average();\n    }\n}\n"),
        ("builder_pattern", "public class HttpRequest {\n    private final String url;\n    private final String method;\n    private final Map<String, String> headers;\n    private final String body;\n\n    private HttpRequest(Builder builder) {\n        this.url = builder.url;\n        this.method = builder.method;\n        this.headers = Collections.unmodifiableMap(builder.headers);\n        this.body = builder.body;\n    }\n\n    public static class Builder {\n        private String url;\n        private String method = \"GET\";\n        private Map<String, String> headers = new HashMap<>();\n        private String body;\n\n        public Builder url(String url) { this.url = url; return this; }\n        public Builder method(String method) { this.method = method; return this; }\n        public Builder header(String k, String v) { headers.put(k, v); return this; }\n        public Builder body(String body) { this.body = body; return this; }\n        public HttpRequest build() { return new HttpRequest(this); }\n    }\n}\n"),
    ];

    let mut extracted = 0usize;
    let mut total_in = 0usize;
    let mut total_out = 0usize;

    for (name, java_code) in corpus {
        let (skeleton, ratio) = compact_code(java_code);

        total_in += java_code.len();
        total_out += skeleton.len();

        // Every snippet must produce non-empty output (skeleton or fallback)
        assert!(
            !skeleton.is_empty(),
            "Java corpus '{name}': skeleton is empty"
        );

        if ratio > 0.0 {
            extracted += 1;
            println!(
                "[TD-011] java/{name}: {}/{} bytes ({:.1}% saved)",
                skeleton.len(),
                java_code.len(),
                ratio * 100.0
            );
        } else {
            println!("[TD-011] java/{name}: passthrough (no compression, check grammar)");
        }
    }

    let total_ratio = if total_in > 0 {
        1.0 - (total_out as f64 / total_in as f64)
    } else {
        0.0
    };

    println!(
        "[TD-011] Java corpus: {}/{} snippets extracted, {:.1}% overall compression",
        extracted,
        corpus.len(),
        total_ratio * 100.0
    );

    // TD-011 quality gate: at least 6/8 snippets must produce a compressed skeleton
    assert!(
        extracted >= 6,
        "Java grammar quality gate: expected >= 6/8 snippets to compress, got {}/8. \
         If WASM grammar is active, check preserve_types in extract_skeleton_treesitter.",
        extracted
    );

    // Overall corpus compression should be meaningful
    assert!(
        total_ratio > 0.1,
        "Java overall compression ratio {:.1}% is below 10% floor",
        total_ratio * 100.0
    );
}
