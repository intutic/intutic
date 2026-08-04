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

    # Compare like with like.
    #
    # This used to fetch commits/HEAD and compare its first 8 characters against
    # the pinned value. Every pin in GRAMMAR_PINS.toml is a *tag* — "v0.23.6"
    # against "bffb65a8" — so the equality could never hold, all five grammars
    # reported "update available" on every quarterly run, and the workflow
    # opened an issue about it every time. A check that always fires is a check
    # nobody reads. Worse, --bump would then write a commit SHA into a field the
    # file documents as a tag, and the compare URL it printed was a real GitHub
    # link, so the output looked entirely plausible.
    #
    # GRAMMAR_PINS.toml says the sha field accepts either a tag or a full commit
    # SHA, so honour both: 40 hex characters is compared against HEAD, anything
    # else against the newest upstream release tag.
    if [[ "${pinned_sha}" =~ ^[0-9a-fA-F]{40}$ ]]; then
        api_url="https://api.github.com/repos/${repo}/commits/HEAD"
        response="$(curl -sf -H "Accept: application/vnd.github.v3+json" "${api_url}" 2>/dev/null || echo '{}')"
        latest_ref="$(echo "${response}" | jq -r '.sha // "unknown"')"
        latest_date="$(echo "${response}" | jq -r '.commit.author.date // "unknown"' | cut -c1-10)"
        latest_msg="$(echo "${response}" | jq -r '.commit.message // "unknown"' | head -1 | cut -c1-60)"
    else
        # Newest release tag; fall back to the tag list for repos that publish
        # tags without GitHub Releases.
        response="$(curl -sf -H "Accept: application/vnd.github.v3+json" \
            "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null || echo '{}')"
        latest_ref="$(echo "${response}" | jq -r '.tag_name // "unknown"')"
        latest_date="$(echo "${response}" | jq -r '.published_at // "unknown"' | cut -c1-10)"
        latest_msg="$(echo "${response}" | jq -r '.name // ""' | head -1 | cut -c1-60)"

        if [ "${latest_ref}" = "unknown" ] || [ -z "${latest_ref}" ]; then
            tags_response="$(curl -sf -H "Accept: application/vnd.github.v3+json" \
                "https://api.github.com/repos/${repo}/tags" 2>/dev/null || echo '[]')"
            latest_ref="$(echo "${tags_response}" | jq -r '.[0].name // "unknown"')"
            latest_date="unknown"
            latest_msg="newest tag (repo publishes no releases)"
        fi
    fi

    if [ "${latest_ref}" = "unknown" ] || [ -z "${latest_ref}" ]; then
        echo "  ${lang}: ⚠ could not fetch upstream (rate-limited or no auth)"
        continue
    fi

    # Full-string comparison. Truncating to 8 characters made "v0.23.6" and
    # "v0.23.60" compare equal, on top of never matching a SHA in the first place.
    if [ "${pinned_sha}" = "${latest_ref}" ]; then
        echo "  ${lang}: ✅ up to date (${pinned_sha})"
    else
        UPDATES_AVAILABLE=$((UPDATES_AVAILABLE + 1))
        echo "  ${lang}: 📦 update available"
        echo "       pinned: ${pinned_sha}"
        echo "       latest: ${latest_ref} (${latest_date})"
        echo "       msg:    ${latest_msg}"
        echo "       diff:   https://github.com/${repo}/compare/${pinned_sha}...${latest_ref}"
        echo ""

        if [ "${BUMP_LANG}" = "${lang}" ]; then
            echo "  🔧 Bumping ${lang} to ${latest_ref}..."
            # Update the SHA in GRAMMAR_PINS.toml (in-place sed)
            sed -i.bak "s/^${lang}.*sha = \"${pinned_sha}\"/${lang} = { repo = \"${repo}\", sha = \"${latest_ref}\" }/" "${PINS}"
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
