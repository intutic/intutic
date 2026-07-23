//! snip_code — Multi-language code skeleton extractor for SnipCompactor.
//!
//! Three-layer dispatch:
//!   Layer 1: Language detection (heuristic scoring)
//!   Layer 2a: Rust → `syn`-based AST extraction (zero binary cost)
//!   Layer 2b: Python / TypeScript / JavaScript / Go / Java →
//!             tree-sitter WASM grammars embedded via `include_bytes!`
//!             initialized once at startup via `once_cell::Lazy`
//!             (only active when grammar .wasm files have been built;
//!              build.rs emits snip_has_LANG_grammar cfg flags)
//!   Layer 3: Regex fallback (ported from Headroom's `_SIGNATURE_PATTERNS`)
//!            activates when WASM grammar load fails or is unavailable
//!
//! TypeScript is explicitly best-effort: the grammar's C external scanner
//! is known to behave erratically under WASM. Failure is silent.

use once_cell::sync::Lazy;
use regex::Regex;

// ─── Language detection ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodeLanguage {
    Rust,
    Python,
    TypeScript,
    JavaScript,
    Go,
    Java,
    Unknown,
}

/// Heuristic language detection by token presence.
/// Returns the most likely language, or `Unknown` if ambiguous.
pub fn detect_language(text: &str) -> CodeLanguage {
    // JSON guard
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return CodeLanguage::Unknown;
    }

    let mut scores: [(CodeLanguage, i32); 6] = [
        (CodeLanguage::Rust, 0),
        (CodeLanguage::Python, 0),
        (CodeLanguage::TypeScript, 0),
        (CodeLanguage::JavaScript, 0),
        (CodeLanguage::Go, 0),
        (CodeLanguage::Java, 0),
    ];

    let rust_markers = ["fn ", "let mut ", "impl ", "pub fn ", "-> ", "match ", "::"];
    let py_markers = [
        "def ",
        "self.",
        "elif ",
        "print(",
        "async def ",
        "__init__",
        "__name__",
    ];
    let ts_markers = [
        "interface ",
        ": string",
        ": number",
        ": boolean",
        "readonly ",
        "enum ",
    ];
    let js_markers = [
        "function ",
        "const ",
        "let ",
        "var ",
        "=> {",
        "require(",
        "module.exports",
    ];
    let go_markers = [
        "func ",
        "package ",
        "import (",
        ":= ",
        "defer ",
        "goroutine",
        "chan ",
    ];
    let java_markers = [
        "public class",
        "private ",
        "protected ",
        "void ",
        "import java.",
        "extends ",
        "implements ",
    ];

    let count =
        |markers: &[&str]| -> i32 { markers.iter().map(|m| text.matches(m).count() as i32).sum() };

    scores[0].1 = count(&rust_markers);
    scores[1].1 = count(&py_markers);
    scores[2].1 = count(&ts_markers);
    scores[3].1 = count(&js_markers);
    scores[4].1 = count(&go_markers);
    scores[5].1 = count(&java_markers);

    // Prefer TypeScript over JavaScript only when TS-specific markers present
    let ts_specific = [
        ": string",
        ": number",
        ": boolean",
        "interface ",
        "readonly ",
    ];
    if !ts_specific.iter().any(|m| text.contains(m)) {
        scores[2].1 = scores[2].1.saturating_sub(2);
    }

    let best = scores
        .iter()
        .max_by_key(|s| s.1)
        .copied()
        .unwrap_or((CodeLanguage::Unknown, 0));
    if best.1 == 0 {
        CodeLanguage::Unknown
    } else {
        best.0
    }
}

// ─── Layer 2a: Rust skeleton via syn (no quote dep) ──────────────────────────

/// Format a syn Visibility as a string prefix like "pub " or "".
fn vis_prefix(vis: &syn::Visibility) -> &'static str {
    match vis {
        syn::Visibility::Public(_) => "pub ",
        syn::Visibility::Restricted(_) => "pub(...) ",
        syn::Visibility::Inherited => "",
    }
}

/// Format a syn Signature as a human-readable string without quote.
/// Produces: `[async] fn name[<...>](params) [-> ...]`
fn format_sig(sig: &syn::Signature) -> String {
    let mut s = String::new();
    if sig.asyncness.is_some() {
        s.push_str("async ");
    }
    s.push_str("fn ");
    s.push_str(&sig.ident.to_string());
    if !sig.generics.params.is_empty() {
        s.push_str("<...>");
    }
    s.push('(');
    let params: Vec<String> = sig
        .inputs
        .iter()
        .map(|arg| match arg {
            syn::FnArg::Receiver(r) => {
                let mut p = String::new();
                if r.reference.is_some() {
                    p.push('&');
                }
                if r.mutability.is_some() {
                    p.push_str("mut ");
                }
                p.push_str("self");
                p
            }
            syn::FnArg::Typed(pt) => match pt.pat.as_ref() {
                syn::Pat::Ident(pi) => pi.ident.to_string(),
                _ => "_".to_string(),
            },
        })
        .collect();
    s.push_str(&params.join(", "));
    s.push(')');
    if let syn::ReturnType::Type(_, _) = &sig.output {
        s.push_str(" -> _");
    }
    s
}

/// Format a syn Path (e.g. trait name) as a dotted string.
fn format_path(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|seg| {
            let name = seg.ident.to_string();
            if matches!(seg.arguments, syn::PathArguments::None) {
                name
            } else {
                format!("{}<...>", name)
            }
        })
        .collect::<Vec<_>>()
        .join("::")
}

/// Extract a Rust code skeleton using the `syn` AST.
/// Returns `None` on parse failure (triggers regex fallback).
pub fn extract_rust_skeleton(code: &str) -> Option<String> {
    let ast: syn::File = syn::parse_str(code).ok()?;
    let mut out = String::new();

    for item in &ast.items {
        match item {
            syn::Item::Use(u) => {
                // Reconstruct `use` line from source span — simplest: just note it
                let _ = u;
                out.push_str("use ...;\n");
            }
            syn::Item::Fn(f) => {
                let vis = vis_prefix(&f.vis);
                let sig = format_sig(&f.sig);
                out.push_str(&format!("{}{} {{ // [body omitted]\n}}\n", vis, sig));
            }
            syn::Item::Struct(s) => {
                let vis = vis_prefix(&s.vis);
                out.push_str(&format!("{}struct {} {{ ... }}\n", vis, s.ident));
            }
            syn::Item::Enum(e) => {
                let vis = vis_prefix(&e.vis);
                let variants: Vec<String> =
                    e.variants.iter().map(|v| v.ident.to_string()).collect();
                out.push_str(&format!(
                    "{}enum {} {{ {} }}\n",
                    vis,
                    e.ident,
                    variants.join(", ")
                ));
            }
            syn::Item::Trait(t) => {
                let vis = vis_prefix(&t.vis);
                out.push_str(&format!(
                    "{}trait {} {{ // [body omitted]\n}}\n",
                    vis, t.ident
                ));
            }
            syn::Item::Impl(imp) => {
                let self_ty = match imp.self_ty.as_ref() {
                    syn::Type::Path(tp) => format_path(&tp.path),
                    _ => "Self".to_string(),
                };
                let trait_part = if let Some((_, tr, _)) = &imp.trait_ {
                    format!("{} for ", format_path(tr))
                } else {
                    String::new()
                };
                out.push_str(&format!("impl {}{} {{\n", trait_part, self_ty));
                for impl_item in &imp.items {
                    if let syn::ImplItem::Fn(method) = impl_item {
                        let vis = vis_prefix(&method.vis);
                        let sig = format_sig(&method.sig);
                        out.push_str(&format!(
                            "    {}{} {{ // [body omitted]\n    }}\n",
                            vis, sig
                        ));
                    }
                }
                out.push_str("}\n");
            }
            syn::Item::Mod(m) => {
                out.push_str(&format!("mod {};\n", m.ident));
            }
            syn::Item::Type(t) => {
                let vis = vis_prefix(&t.vis);
                out.push_str(&format!("{}type {} = _;\n", vis, t.ident));
            }
            syn::Item::Const(c) => {
                let vis = vis_prefix(&c.vis);
                out.push_str(&format!("{}const {}: _ = _;\n", vis, c.ident));
            }
            _ => { /* skip macros, extern crate, etc. */ }
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ─── Layer 2b: Multi-language via tree-sitter WASM ───────────────────────────
//
// Grammar bytes are conditionally embedded at compile time.
// build.rs emits `snip_has_LANG_grammar` cfg flags when the corresponding
// .wasm file exists in assets/grammars/.
// When a flag is absent (grammars not yet built), the byte slice is &[]
// and LanguageCache falls back to regex for that language.

macro_rules! grammar_bytes {
    ($cfg_flag:tt, $path:literal) => {{
        #[cfg($cfg_flag)]
        {
            include_bytes!($path)
        }
        #[cfg(not($cfg_flag))]
        {
            &[] as &[u8]
        }
    }};
}

static PYTHON_GRAMMAR_WASM: &[u8] = grammar_bytes!(
    snip_has_python_grammar,
    "../assets/grammars/tree-sitter-python.wasm"
);
static TYPESCRIPT_GRAMMAR_WASM: &[u8] = grammar_bytes!(
    snip_has_typescript_grammar,
    "../assets/grammars/tree-sitter-typescript.wasm"
);
static JAVASCRIPT_GRAMMAR_WASM: &[u8] = grammar_bytes!(
    snip_has_javascript_grammar,
    "../assets/grammars/tree-sitter-javascript.wasm"
);
static GO_GRAMMAR_WASM: &[u8] = grammar_bytes!(
    snip_has_go_grammar,
    "../assets/grammars/tree-sitter-go.wasm"
);
static JAVA_GRAMMAR_WASM: &[u8] = grammar_bytes!(
    snip_has_java_grammar,
    "../assets/grammars/tree-sitter-java.wasm"
);

/// Cache of loaded tree-sitter Language objects, initialized once at startup.
struct LanguageCache {
    python: Option<tree_sitter::Language>,
    typescript: Option<tree_sitter::Language>, // best-effort: C scanner may fail
    javascript: Option<tree_sitter::Language>,
    go: Option<tree_sitter::Language>,
    java: Option<tree_sitter::Language>,
}

// Safety: Language holds an immutable grammar table pointer; safe to share across threads.
unsafe impl Send for LanguageCache {}
unsafe impl Sync for LanguageCache {}

impl LanguageCache {
    fn init() -> Self {
        LanguageCache {
            python: Self::load("python", PYTHON_GRAMMAR_WASM),
            typescript: Self::load("typescript", TYPESCRIPT_GRAMMAR_WASM),
            javascript: Self::load("javascript", JAVASCRIPT_GRAMMAR_WASM),
            go: Self::load("go", GO_GRAMMAR_WASM),
            java: Self::load("java", JAVA_GRAMMAR_WASM),
        }
    }

    fn load(name: &str, bytes: &[u8]) -> Option<tree_sitter::Language> {
        if bytes.is_empty() {
            tracing::debug!(
                "snip_code: grammar '{}' not embedded — regex fallback active",
                name
            );
            return None;
        }
        match Self::load_wasm(name, bytes) {
            Ok(lang) => {
                tracing::info!("snip_code: grammar '{}' loaded via WASM", name);
                Some(lang)
            }
            Err(e) => {
                tracing::warn!(
                    "snip_code: grammar '{}' WASM load failed ({}) — regex fallback active",
                    name,
                    e
                );
                None
            }
        }
    }

    fn load_wasm(
        name: &str,
        bytes: &[u8],
    ) -> Result<tree_sitter::Language, Box<dyn std::error::Error>> {
        // Use tree_sitter's re-exported wasmtime to avoid version mismatch
        let engine = tree_sitter::wasmtime::Engine::default();
        let mut store = tree_sitter::WasmStore::new(&engine)?;
        let language = store.load_language(name, bytes)?;
        Ok(language)
    }

    fn get(&self, lang: CodeLanguage) -> Option<&tree_sitter::Language> {
        match lang {
            CodeLanguage::Python => self.python.as_ref(),
            CodeLanguage::TypeScript => self.typescript.as_ref(),
            CodeLanguage::JavaScript => self.javascript.as_ref(),
            CodeLanguage::Go => self.go.as_ref(),
            CodeLanguage::Java => self.java.as_ref(),
            _ => None,
        }
    }
}

static LANG_CACHE: Lazy<LanguageCache> = Lazy::new(LanguageCache::init);

// ─── TD-009: Public grammar status API ───────────────────────────────────────

/// Runtime WASM load status for a single grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrammarStatus {
    /// Grammar bytes are embedded and loaded successfully via wasmtime.
    Wasm,
    /// Grammar bytes not embedded (cfg flag absent) or wasmtime load failed;
    /// regex fallback is active.
    RegexFallback,
}

/// Returns the runtime grammar load status for each supported language.
///
/// Call this at startup (e.g., in the health-check route) to surface
/// which languages have WASM active vs regex fallback. Also useful in
/// the TD-003 smoke test and observability dashboards.
///
/// # Example
/// ```no_run
/// for (lang, status) in intutic_proxy::snip_code::grammar_load_status() {
///     println!("{lang}: {status:?}");
/// }
/// ```
pub fn grammar_load_status() -> Vec<(&'static str, GrammarStatus)> {
    // Touch LANG_CACHE to ensure it's initialized (Lazy evaluation).
    let cache = &*LANG_CACHE;
    vec![
        (
            "python",
            if cache.python.is_some() {
                GrammarStatus::Wasm
            } else {
                GrammarStatus::RegexFallback
            },
        ),
        (
            "typescript",
            if cache.typescript.is_some() {
                GrammarStatus::Wasm
            } else {
                GrammarStatus::RegexFallback
            },
        ),
        (
            "javascript",
            if cache.javascript.is_some() {
                GrammarStatus::Wasm
            } else {
                GrammarStatus::RegexFallback
            },
        ),
        (
            "go",
            if cache.go.is_some() {
                GrammarStatus::Wasm
            } else {
                GrammarStatus::RegexFallback
            },
        ),
        (
            "java",
            if cache.java.is_some() {
                GrammarStatus::Wasm
            } else {
                GrammarStatus::RegexFallback
            },
        ),
    ]
}

// ─── TD-007: Per-thread Parser pool ──────────────────────────────────────────
// tree_sitter::Parser is !Send + !Sync, so we store one per thread.
// RefCell gives exclusive borrow within the closure — no deadlock risk because
// parse calls never recurse. This eliminates per-request Parser allocation under
// high concurrency (100+ RPS with large code tool outputs).
thread_local! {
    static THREAD_PARSER: std::cell::RefCell<tree_sitter::Parser> =
        std::cell::RefCell::new(tree_sitter::Parser::new());
}

// ─── TD-008: Optional incremental parse tree cache ────────────────────────────
// When enabled (SnipCompactorConfig::code_skeleton_incremental_cache), we cache
// the last tree-sitter parse result per thread, keyed on (CodeLanguage, hash(code)).
// This avoids re-parsing identical code blocks — e.g., the same file returned by
// multiple consecutive tool calls in one LLM turn.
//
// Activation criteria (activate after 30-day telemetry review, TD-008):
//   - p99 code input > 50 KB  AND
//   - same-content hit rate > 20% of skeleton-extraction calls
//
// Default: OFF (false). Set `code_skeleton_incremental_cache: true` in config.yaml.

use std::collections::HashMap;

/// Cache entry: (content_hash, CodeLanguage) → skeleton output string.
/// Keyed by (lang, hash) not just hash to handle the unlikely hash collision
/// between two different-language snippets.
type ParseCacheMap = HashMap<(u64, u8), String>;

/// Max entries per thread — evict oldest on overflow.
const PARSE_CACHE_MAX_ENTRIES: usize = 32;

thread_local! {
    /// Incremental skeleton cache — thread-local, no locking needed.
    static PARSE_CACHE: std::cell::RefCell<ParseCacheMap> =
        std::cell::RefCell::new(HashMap::new());
}

fn lang_cache_key(lang: CodeLanguage) -> u8 {
    match lang {
        CodeLanguage::Python => 0,
        CodeLanguage::TypeScript => 1,
        CodeLanguage::JavaScript => 2,
        CodeLanguage::Go => 3,
        CodeLanguage::Java => 4,
        CodeLanguage::Rust => 5,
        CodeLanguage::Unknown => 255,
    }
}

/// FNV-1a 64-bit hash of a string — fast, zero-allocation, no deps.
fn fnv1a_hash(s: &str) -> u64 {
    const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
    const FNV_PRIME: u64 = 1_099_511_628_211;
    let mut h = FNV_OFFSET;
    for byte in s.bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Look up a cached skeleton. Returns `Some(skeleton)` on cache hit.
fn cache_get(lang: CodeLanguage, hash: u64) -> Option<String> {
    PARSE_CACHE.with(|cell| cell.borrow().get(&(hash, lang_cache_key(lang))).cloned())
}

/// Insert a new skeleton into the cache, evicting one random entry if full.
fn cache_insert(lang: CodeLanguage, hash: u64, skeleton: String) {
    PARSE_CACHE.with(|cell| {
        let mut map = cell.borrow_mut();
        if map.len() >= PARSE_CACHE_MAX_ENTRIES {
            // Evict the first key found (deterministic-enough for our purposes)
            if let Some(k) = map.keys().next().copied() {
                map.remove(&k);
            }
        }
        map.insert((hash, lang_cache_key(lang)), skeleton);
    })
}

/// Invalidate all cache entries for the current thread.
/// Call this between requests if you want strict correctness (e.g., in tests).
#[allow(dead_code)]
pub fn invalidate_parse_cache() {
    PARSE_CACHE.with(|cell| cell.borrow_mut().clear());
}

/// Returns the current thread's parse cache hit/miss counts since process start.
/// Exposed for telemetry — use `snip_code::parse_cache_stats()` in health routes.
pub fn parse_cache_size() -> usize {
    PARSE_CACHE.with(|cell| cell.borrow().len())
}

/// Extract skeleton using tree-sitter WASM.
/// Returns `None` when grammar unavailable or parse fails.
fn extract_skeleton_treesitter(code: &str, lang: CodeLanguage) -> Option<String> {
    let language = LANG_CACHE.get(lang)?;

    // Borrow the thread-local parser, reset language, parse.
    let tree = THREAD_PARSER.with(|cell| {
        let mut parser = cell.borrow_mut();
        // set_language returns Err only if language version mismatches — very unlikely
        // since we embed the grammar. On mismatch, fallback to regex (return None).
        parser.set_language(language).ok()?;
        parser.parse(code, None)
    })?;
    let root = tree.root_node();

    let preserve_types: &[&str] = match lang {
        CodeLanguage::Python => &[
            "function_definition",
            "async_function_definition",
            "class_definition",
            "import_statement",
            "import_from_statement",
            "decorated_definition",
        ],
        CodeLanguage::TypeScript | CodeLanguage::JavaScript => &[
            "function_declaration",
            "method_definition",
            "arrow_function",
            "class_declaration",
            "import_statement",
            "export_statement",
            "interface_declaration",
            "type_alias_declaration",
            "lexical_declaration",
        ],
        CodeLanguage::Go => &[
            "function_declaration",
            "method_declaration",
            "type_declaration",
            "import_declaration",
        ],
        CodeLanguage::Java => &[
            "class_declaration",
            "method_declaration",
            "field_declaration",
            "import_declaration",
            "interface_declaration",
        ],
        _ => return None,
    };

    let body_types: &[&str] = &[
        "block",
        "statement_block",
        "compound_statement",
        "function_body",
        "class_body",
    ];

    let mut out = String::new();
    walk_tree(code, &root, preserve_types, body_types, &mut out, 0);

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn walk_tree(
    source: &str,
    node: &tree_sitter::Node,
    preserve: &[&str],
    bodies: &[&str],
    out: &mut String,
    depth: usize,
) {
    let kind = node.kind();

    if bodies.contains(&kind) {
        out.push_str(" { // [body omitted]\n");
        out.push_str(&format!("{}}}\n", "  ".repeat(depth)));
        return;
    }

    if preserve.contains(&kind) {
        let start = node.start_byte();
        let end = node.end_byte().min(source.len());
        let node_src = &source[start..end];
        let sig_end = node_src.find('{').unwrap_or(node_src.len());
        let sig = node_src[..sig_end].trim();
        if !sig.is_empty() {
            out.push_str(&format!("{}{}", "  ".repeat(depth), sig));
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            walk_tree(source, &child, preserve, bodies, out, depth + 1);
        }
        if !sig.is_empty() {
            out.push('\n');
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_tree(source, &child, preserve, bodies, out, depth);
    }
}

// ─── Layer 3: Regex fallback ──────────────────────────────────────────────────

fn build_patterns(lang: CodeLanguage) -> Vec<Regex> {
    let raw: &[&str] = match lang {
        CodeLanguage::Python => &[
            r"(?m)^\s*(async\s+)?def\s+\w+\s*\([^)]*\)\s*(->.*)?:",
            r"(?m)^\s*class\s+\w+(\([^)]*\))?:",
            r"(?m)^\s*@\w+(\([^)]*\))?\s*$",
            r"(?m)^import .+$",
            r"(?m)^from .+ import .+$",
        ],
        CodeLanguage::JavaScript => &[
            r"(?m)^\s*(async\s+)?function\s+\w+\s*\([^)]*\)",
            r"(?m)^\s*class\s+\w+(\s+extends\s+\w+)?",
            r"(?m)^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\([^)]*\)\s*=>",
            r"(?m)^(import|export)\s+.+$",
        ],
        CodeLanguage::TypeScript => &[
            r"(?m)^\s*(async\s+)?function\s+\w+\s*(<[^>]+>)?\s*\([^)]*\)",
            r"(?m)^\s*class\s+\w+(<[^>]+>)?(\s+extends\s+\w+)?",
            r"(?m)^\s*interface\s+\w+(<[^>]+>)?",
            r"(?m)^\s*type\s+\w+(<[^>]+>)?\s*=",
            r"(?m)^\s*(const|let)\s+\w+\s*:\s*\w+",
            r"(?m)^(import|export)\s+.+$",
        ],
        CodeLanguage::Go => &[
            r"(?m)^\s*func\s+(\([^)]+\)\s+)?\w+\s*\([^)]*\)",
            r"(?m)^\s*type\s+\w+\s+(struct|interface)",
            r"(?m)^package\s+\w+$",
            r"(?m)^import\s+",
        ],
        CodeLanguage::Rust => &[
            r"(?m)^\s*(pub(\s*\([^)]*\))?\s+)?(async\s+)?fn\s+\w+(<[^>]+>)?\s*\([^)]*\)",
            r"(?m)^\s*(pub(\s*\([^)]*\))?\s+)?struct\s+\w+",
            r"(?m)^\s*(pub(\s*\([^)]*\))?\s+)?enum\s+\w+",
            r"(?m)^\s*(pub(\s*\([^)]*\))?\s+)?trait\s+\w+",
            r"(?m)^\s*(pub(\s*\([^)]*\))?\s+)?impl(<[^>]+>)?\s+\w+",
            r"(?m)^use\s+.+;$",
        ],
        CodeLanguage::Java => &[
            r"(?m)^\s*(public|private|protected)?(\s+static)?\s+\w+\s+\w+\s*\([^)]*\)",
            r"(?m)^\s*(public\s+)?(class|interface|enum|abstract\s+class)\s+\w+",
            r"(?m)^import\s+[\w.]+;$",
            r"(?m)^package\s+[\w.]+;$",
        ],
        CodeLanguage::Unknown => &[],
    };
    raw.iter().filter_map(|p| Regex::new(p).ok()).collect()
}

pub fn extract_skeleton_regex(code: &str, lang: CodeLanguage) -> String {
    let patterns = build_patterns(lang);
    if patterns.is_empty() {
        return code.to_string();
    }
    let matched: Vec<&str> = code
        .lines()
        .filter(|line| patterns.iter().any(|re| re.is_match(line)))
        .collect();

    if matched.is_empty() {
        code.lines().take(20).collect::<Vec<_>>().join("\n")
    } else {
        matched.join("\n")
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Compress a code snippet to its structural skeleton.
/// Returns `(skeleton, ratio)`. Falls back to `(original, 0.0)` if unknown language.
pub fn compact_code(text: &str) -> (String, f64) {
    compact_code_cached(text, false)
}

/// Variant of `compact_code` with optional incremental parse cache (TD-008).
///
/// When `use_cache` is true, the skeleton for identical code blocks is returned
/// from a per-thread LRU cache instead of re-running tree-sitter. Enable only
/// when telemetry confirms p99 code input > 50 KB and hit rate > 20%.
pub fn compact_code_cached(text: &str, use_cache: bool) -> (String, f64) {
    let lang = detect_language(text);
    if lang == CodeLanguage::Unknown {
        return (text.to_string(), 0.0);
    }

    // TD-008: Cache lookup before any parsing work
    let hash = if use_cache { fnv1a_hash(text) } else { 0 };
    if use_cache {
        if let Some(cached) = cache_get(lang, hash) {
            tracing::debug!(
                snip.cache = "hit",
                snip.lang = format!("{:?}", lang),
                "snip_code.parse_cache.hit"
            );
            let ratio = if !text.is_empty() && cached.len() < text.len() {
                1.0 - (cached.len() as f64 / text.len() as f64)
            } else {
                0.0
            };
            return (cached, ratio);
        }
    }

    let skeleton = match lang {
        CodeLanguage::Rust => extract_rust_skeleton(text)
            .or_else(|| Some(extract_skeleton_regex(text, CodeLanguage::Rust))),
        other => extract_skeleton_treesitter(text, other)
            .or_else(|| Some(extract_skeleton_regex(text, other))),
    };

    let skeleton = match skeleton {
        Some(s) if !s.is_empty() => s,
        _ => return (text.to_string(), 0.0),
    };

    let original_len = text.len() as f64;
    let skeleton_len = skeleton.len() as f64;
    let ratio = if original_len > 0.0 && skeleton_len < original_len {
        1.0 - (skeleton_len / original_len)
    } else {
        0.0
    };

    // TD-008: Populate cache on miss
    if use_cache && ratio > 0.0 {
        tracing::debug!(
            snip.cache = "miss",
            snip.lang = format!("{:?}", lang),
            "snip_code.parse_cache.miss"
        );
        cache_insert(lang, hash, skeleton.clone());
    }

    (skeleton, ratio)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_rust() {
        assert_eq!(
            detect_language("pub fn main() {\n    println!(\"hi\");\n}\n"),
            CodeLanguage::Rust
        );
    }

    #[test]
    fn test_detect_python() {
        assert_eq!(
            detect_language("def hello(name):\n    print(name)\n"),
            CodeLanguage::Python
        );
    }

    #[test]
    fn test_detect_go() {
        assert_eq!(
            detect_language("package main\n\nfunc main() {\n}\n"),
            CodeLanguage::Go
        );
    }

    #[test]
    fn test_detect_java() {
        assert_eq!(
            detect_language(
                "public class Hello {\n    public static void main(String[] args) {}\n}\n"
            ),
            CodeLanguage::Java
        );
    }

    #[test]
    fn test_detect_typescript() {
        assert_eq!(
            detect_language("interface User {\n    name: string;\n    age: number;\n}\n"),
            CodeLanguage::TypeScript
        );
    }

    #[test]
    fn test_detect_unknown_for_json() {
        assert_eq!(detect_language(r#"{"key":"value"}"#), CodeLanguage::Unknown);
    }

    #[test]
    fn test_rust_skeleton_fn_signature() {
        let code = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
        let skeleton = extract_rust_skeleton(code).unwrap_or_default();
        assert!(skeleton.contains("pub "), "visibility must be present");
        assert!(skeleton.contains("fn add"), "fn name must be present");
        assert!(!skeleton.contains("a + b"), "body must be omitted");
    }

    #[test]
    fn test_rust_skeleton_struct() {
        let code = "pub struct Config {\n    pub enabled: bool,\n}\n";
        let skeleton = extract_rust_skeleton(code).unwrap_or_default();
        assert!(skeleton.contains("Config"), "struct name must be present");
    }

    #[test]
    fn test_rust_skeleton_enum_variants() {
        let code = "enum Status {\n    Active,\n    Inactive,\n    Pending,\n}\n";
        let skeleton = extract_rust_skeleton(code).unwrap_or_default();
        assert!(skeleton.contains("Active"), "enum variant must be present");
        assert!(
            skeleton.contains("Inactive"),
            "enum variant must be present"
        );
    }

    #[test]
    fn test_rust_skeleton_impl_methods() {
        let code = "impl Foo {\n    pub fn bar(&self) -> u32 {\n        42\n    }\n}\n";
        let skeleton = extract_rust_skeleton(code).unwrap_or_default();
        assert!(skeleton.contains("impl Foo"), "impl header must be present");
        assert!(skeleton.contains("fn bar"), "method name must be present");
        assert!(!skeleton.contains("42"), "body must be omitted");
    }

    #[test]
    fn test_rust_skeleton_invalid_input_no_panic() {
        let _ = extract_rust_skeleton("def hello(): pass"); // Python — syn will fail, returns None
    }

    #[test]
    fn test_regex_fallback_python_defs() {
        let code = "def greet(name):\n    return f'hello {name}'\n\ndef goodbye():\n    pass\n";
        let skeleton = extract_skeleton_regex(code, CodeLanguage::Python);
        assert!(
            skeleton.contains("def greet"),
            "def signature must be captured"
        );
        assert!(!skeleton.contains("return"), "body should not appear");
    }

    #[test]
    fn test_regex_fallback_go_func() {
        let code = "package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n";
        let skeleton = extract_skeleton_regex(code, CodeLanguage::Go);
        assert!(skeleton.contains("func Add") || skeleton.contains("package main"));
    }

    #[test]
    fn test_regex_fallback_ts_interface() {
        let code = "interface Foo {\n    bar: string;\n    baz: number;\n}\n";
        let skeleton = extract_skeleton_regex(code, CodeLanguage::TypeScript);
        assert!(skeleton.contains("interface Foo"));
    }

    #[test]
    fn test_compact_code_rust_reduces_size() {
        let code = "pub fn heavy(x: u64) -> u64 {\n".to_string()
            + &"    let _ = x * x;\n".repeat(30)
            + "    x\n}\n";
        let (_, ratio) = compact_code(&code);
        assert!(ratio > 0.0, "Rust code with large body should compress");
    }

    #[test]
    fn test_compact_code_unknown_passthrough() {
        let input = "just some plain text";
        let (out, ratio) = compact_code(input);
        assert_eq!(out, input);
        assert_eq!(ratio, 0.0);
    }

    #[test]
    fn test_compact_code_json_not_detected_as_code() {
        let input = r#"{"fn": "not a rust function"}"#;
        let (out, ratio) = compact_code(input);
        assert_eq!(out, input);
        assert_eq!(ratio, 0.0);
    }
}
