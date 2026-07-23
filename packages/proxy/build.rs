// build.rs — intutic-proxy
// Emits cargo:rustc-cfg flags for each tree-sitter grammar .wasm file.
// This lets snip_code.rs use #[cfg(snip_has_LANG_grammar)] / include_bytes!
// without failing to compile when grammars haven't been built yet.
//
// Run scripts/download-grammars.sh to build the .wasm files, then
// `cargo build` will pick them up automatically.

use std::path::Path;

fn main() {
    let grammars = [
        ("python", "assets/grammars/tree-sitter-python.wasm"),
        ("typescript", "assets/grammars/tree-sitter-typescript.wasm"),
        ("javascript", "assets/grammars/tree-sitter-javascript.wasm"),
        ("go", "assets/grammars/tree-sitter-go.wasm"),
        ("java", "assets/grammars/tree-sitter-java.wasm"),
    ];

    for (lang, path) in &grammars {
        println!("cargo:rustc-check-cfg=cfg(snip_has_{}_grammar)", lang);
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let full_path = Path::new(&manifest_dir).join(path);
        if full_path.exists() {
            // Guard against LFS pointer stubs: real .wasm files are hundreds of KB.
            // An LFS pointer is ~130 bytes and starts with "version https://git-lfs".
            let metadata = std::fs::metadata(&full_path).unwrap();
            if metadata.len() < 256 {
                // Likely an LFS pointer stub — check content
                let content = std::fs::read_to_string(&full_path).unwrap_or_default();
                if content.starts_with("version https://git-lfs") {
                    panic!(
                        "\n\n[build.rs] {} grammar file appears to be a Git LFS pointer stub.\n\
                         Run: git lfs pull\n\
                         Or:  bash scripts/download-grammars.sh\n\
                         Path: {}\n",
                        lang,
                        full_path.display()
                    );
                }
            }
            println!("cargo:rustc-cfg=snip_has_{}_grammar", lang);
        }
        // Re-run build script if the grammar file changes
        println!("cargo:rerun-if-changed={}", path);
    }

    // Re-run if the lock file changes (grammar pins updated)
    println!("cargo:rerun-if-changed=assets/grammars/GRAMMAR_PINS.toml");
}
