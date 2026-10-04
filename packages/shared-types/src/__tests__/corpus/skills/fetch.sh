#!/usr/bin/env bash
# Re-download the vendored benign-skill corpus and verify it against the
# committed sums. Same discipline as packages/proxy/tests/corpus/fetch.sh:
#
# The corpus is VENDORED, not fetched at test time. A test that downloads is a
# test that silently skips when the network is unavailable. This script exists
# to refresh the corpus deliberately, and to let a reviewer reproduce it
# byte-for-byte from the pinned upstream commits in MANIFEST.tsv.
#
# Every file comes from raw.githubusercontent.com at a PINNED commit SHA, never
# a branch name, so a re-run fetches the same bytes or fails the checksum.
#
# No pipes: a pipeline's exit status is the last command's, which would hide a
# failed download behind a successful downstream command.
set -euo pipefail

cd "$(dirname "$0")"

while IFS=$'\t' read -r dest repo commit src; do
  case "$dest" in '#'*|'') continue ;; esac
  mkdir -p "$(dirname "$dest")"
  curl -sSL --fail --retry 3 --max-time 60 -o "$dest" \
    "https://raw.githubusercontent.com/${repo}/${commit}/${src}"
done < MANIFEST.tsv

if [ "${1:-}" = "--write-sums" ]; then
  # Only after a deliberate refresh (new commits pinned in MANIFEST.tsv), and
  # only after re-reviewing every scanner hit — see PROVENANCE.md.
  find . -type f \( -name 'SKILL.md' -o -path './LICENSES/*' \) -print0 > .files.tmp
  xargs -0 shasum -a 256 < .files.tmp > SHA256SUMS.unsorted
  LC_ALL=C sort -k2 SHA256SUMS.unsorted > SHA256SUMS
  rm -f SHA256SUMS.unsorted .files.tmp
fi

shasum -a 256 -c --quiet SHA256SUMS
echo "skill corpus verified"
