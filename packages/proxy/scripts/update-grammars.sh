#!/usr/bin/env bash
# scripts/update-grammars.sh
# Checks each pinned tree-sitter grammar for new upstream commits since the
# pinned SHA. Prints a summary and optionally bumps pins interactively.
#
# This is a REVIEW TOOL, not an auto-updater. Humans must review and approve
# each SHA bump. See tech debt TD-005.
#
# Cadence: run quarterly (every ~3 months).
#
# Usage:
#   cd packages/proxy
#   bash scripts/update-grammars.sh [--bump <lang>]
#
#   --bump <lang>   Interactively bump the SHA for <lang> to latest upstream HEAD
#                   after you have reviewed the changelog.
#
# Requires: git, curl (for GitHub API queries)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PINS="${REPO_DIR}/assets/grammars/GRAMMAR_PINS.toml"

check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: '$1' not found. Install: $2" >&2
        exit 1
    fi
}
check_cmd git  "install git"
check_cmd curl "brew install curl"
check_cmd jq   "brew install jq"

# ── Parse GRAMMAR_PINS.toml ────────────────────────────────────────────────────
parse_pin() { grep -E "^${1}[[:space:]]" "${PINS}" | sed -n "s/.*${2} = \"\([^\"]*\)\".*/\1/p"; }

LANGS=("python" "typescript" "javascript" "go" "java")

# ── Optional --bump flag ──────────────────────────────────────────────────────
BUMP_LANG=""
if [ "${1:-}" = "--bump" ] && [ -n "${2:-}" ]; then
    BUMP_LANG="$2"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Grammar SHA Update Review — $(date +%Y-%m-%d)                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

UPDATES_AVAILABLE=0

for lang in "${LANGS[@]}"; do
    repo="$(parse_pin "${lang}" "repo")"
    pinned_sha="$(parse_pin "${lang}" "sha")"

    if [ -z "${repo}" ]; then
        echo "  ${lang}: ⚠ not in GRAMMAR_PINS.toml, skipping"
        continue
    fi

    # Fetch latest commit SHA on default branch from GitHub API
    api_url="https://api.github.com/repos/${repo}/commits/HEAD"
    response="$(curl -sf -H "Accept: application/vnd.github.v3+json" "${api_url}" 2>/dev/null || echo '{}')"
    latest_sha="$(echo "${response}" | jq -r '.sha // "unknown"' | cut -c1-8)"
    latest_date="$(echo "${response}" | jq -r '.commit.author.date // "unknown"' | cut -c1-10)"
    latest_msg="$(echo "${response}" | jq -r '.commit.message // "unknown"' | head -1 | cut -c1-60)"

    if [ "${latest_sha}" = "unknown" ]; then
        echo "  ${lang}: ⚠ could not fetch upstream (rate-limited or no auth)"
        continue
    fi

    if [ "${pinned_sha:0:8}" = "${latest_sha:0:8}" ]; then
        echo "  ${lang}: ✅ up to date (${pinned_sha})"
    else
        UPDATES_AVAILABLE=$((UPDATES_AVAILABLE + 1))
        echo "  ${lang}: 📦 update available"
        echo "       pinned: ${pinned_sha}"
        echo "       latest: ${latest_sha} (${latest_date})"
        echo "       msg:    ${latest_msg}"
        echo "       diff:   https://github.com/${repo}/compare/${pinned_sha}...${latest_sha}"
        echo ""

        if [ "${BUMP_LANG}" = "${lang}" ]; then
            echo "  🔧 Bumping ${lang} to ${latest_sha}..."
            # Update the SHA in GRAMMAR_PINS.toml (in-place sed)
            sed -i.bak "s/^${lang}.*sha = \"${pinned_sha}\"/${lang} = { repo = \"${repo}\", sha = \"${latest_sha}\" }/" "${PINS}"
            rm -f "${PINS}.bak"
            echo "  ✅ Updated GRAMMAR_PINS.toml for ${lang}"
            echo "  ⚠  Run 'bash scripts/download-grammars.sh' to rebuild the .wasm file"
            echo "  ⚠  Run 'cargo build --release' to verify the new grammar compiles"
            echo "  ⚠  Run 'cargo test snip' to verify no regressions"
        fi
    fi
done

echo ""
if [ "${UPDATES_AVAILABLE}" -eq 0 ]; then
    echo "All grammars are up to date. Schedule next review in ~3 months."
else
    echo "${UPDATES_AVAILABLE} grammar(s) have upstream updates."
    echo ""
    echo "Review each diff link above before bumping. Then:"
    echo "  bash scripts/update-grammars.sh --bump <lang>"
    echo "  bash scripts/download-grammars.sh"
    echo "  cargo test snip"
    echo "  git add assets/grammars/ GRAMMAR_PINS.toml"
    echo "  git commit -m 'chore(snip): bump <lang> grammar to <sha>'"
    echo ""
    echo "Criteria for bumping:"
    echo "  ✓ All 'cargo test snip' tests still pass"
    echo "  ✓ TypeScript WASM smoke test result unchanged"
    echo "  ✓ No breaking grammar node_type renames in walk_tree() preserve_types"
fi
