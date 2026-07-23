#!/usr/bin/env bash
# scripts/download-grammars.sh
# Builds tree-sitter grammar .wasm files from pinned tags/SHAs in GRAMMAR_PINS.toml.
# Output goes to assets/grammars/ (tracked by Git LFS).
#
# Prerequisites:
#   brew install emscripten        # emcc — the C→WASM compiler
#   npm install -g tree-sitter-cli # tree-sitter build --wasm
#   git lfs install                # (already done if LFS is set up)
#
# Usage:
#   cd packages/proxy
#   bash scripts/download-grammars.sh
#
# After running:
#   git add assets/grammars/
#   git commit -m "chore(snip): update pinned tree-sitter grammar wasm files"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${REPO_DIR}/assets/grammars"
PINS="${DEST}/GRAMMAR_PINS.toml"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# ── Prerequisite checks ────────────────────────────────────────────────────────
check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: '$1' not found." >&2
        echo "  Install: $2" >&2
        exit 1
    fi
}
check_cmd emcc        "brew install emscripten"
check_cmd tree-sitter "npm install -g tree-sitter-cli"
check_cmd git         "install git"

echo "[download-grammars] emcc:         $(emcc --version 2>&1 | head -1)"
echo "[download-grammars] tree-sitter:  $(tree-sitter --version)"

# ── Parse GRAMMAR_PINS.toml ────────────────────────────────────────────────────
# Uses word-boundary match (lang followed by space or =) to avoid
# 'java' matching 'javascript'.
parse_pin() {
    local lang="$1"
    local field="$2"
    # Match lines that begin exactly with the lang name (word boundary via space/=)
    grep -E "^${lang}[[:space:]]" "${PINS}" | sed -n "s/.*${field} = \"\([^\"]*\)\".*/\1/p"
}

LANGS=("python" "typescript" "javascript" "go" "java")

mkdir -p "${DEST}"
FAILED=()
BUILT=()

for lang in "${LANGS[@]}"; do
    repo="$(parse_pin "${lang}" "repo")"
    pin="$(parse_pin "${lang}" "sha")"
    subdir="$(parse_pin "${lang}" "subdir")"   # optional; e.g. "typescript" for tree-sitter-typescript

    if [ -z "${repo}" ] || [ -z "${pin}" ]; then
        echo "[download-grammars] WARN: No pin found for '${lang}', skipping."
        continue
    fi

    echo ""
    echo "[download-grammars] ── ${lang}: ${repo}@${pin} ──────────────"

    local_dir="${WORK_DIR}/${lang}"

    # Clone directly at the pinned tag/SHA using --branch (works for tags too).
    # --depth=1 gives a single-commit shallow clone — fast, no full history needed.
    # If pin is a commit SHA (not a tag), we fall back to a full shallow clone + reset.
    if git clone --branch "${pin}" --depth=1 "https://github.com/${repo}.git" "${local_dir}" 2>&1; then
        echo "[download-grammars] Cloned ${lang} at tag/branch '${pin}'"
    else
        echo "[download-grammars] Tag clone failed, trying commit SHA fetch..." >&2
        mkdir -p "${local_dir}"
        git clone --depth=100 "https://github.com/${repo}.git" "${local_dir}" 2>&1 || {
            echo "[download-grammars] ERROR: clone failed for ${lang}, skipping." >&2
            FAILED+=("${lang}")
            continue
        }
        (
            cd "${local_dir}"
            git fetch --depth=1 origin "${pin}" 2>/dev/null || true
            git reset --hard "${pin}" 2>&1 || {
                echo "[download-grammars] ERROR: could not reset to '${pin}' for ${lang}" >&2
                exit 1
            }
        ) || { FAILED+=("${lang}"); continue; }
    fi

    # Build .wasm — use subdir if specified (e.g. tree-sitter-typescript/typescript/)
    # IMPORTANT: output_name must be absolute before cd-ing into the subdir,
    # because wasm-ld resolves -o relative to the working directory.
    output_name="$(cd "${DEST}" && pwd)/tree-sitter-${lang}.wasm"
    build_dir="${local_dir}"
    if [ -n "${subdir}" ]; then
        build_dir="${local_dir}/${subdir}"
        echo "[download-grammars] Using subdir: ${subdir}/"
    fi

    echo "[download-grammars] Building ${lang}.wasm from ${build_dir} ..."
    if (cd "${build_dir}" && tree-sitter build --wasm -o "${output_name}" 2>&1); then
        size="$(du -sh "${output_name}" | cut -f1)"
        echo "[download-grammars] ✅ ${lang}: ${output_name} (${size})"
        BUILT+=("${lang}")
    else
        echo "[download-grammars] ❌ ${lang}: WASM build failed. Removing partial output." >&2
        rm -f "${output_name}"
        FAILED+=("${lang}")
    fi
done

echo ""
if [ "${#FAILED[@]}" -gt 0 ]; then
    echo "[download-grammars] ❌ Failed grammars: ${FAILED[*]}"
    echo "[download-grammars]    These will use regex fallback. See TD-003 / TD-011."
fi
if [ "${#BUILT[@]}" -gt 0 ]; then
    echo "[download-grammars] ✅ Built: ${BUILT[*]}"
fi

echo ""
echo "[download-grammars] Files in ${DEST}:"
ls -lh "${DEST}/"*.wasm 2>/dev/null || echo "  (none)"

echo ""
echo "[download-grammars] Next steps:"
echo "  cd packages/proxy && cargo build --release   # embeds .wasm via include_bytes!"
echo "  cargo test test_td003_grammar_load_status_smoke -- --nocapture"
echo "  git add assets/grammars/"
echo "  git commit -m 'chore(snip): add pinned tree-sitter grammar wasm files'"
