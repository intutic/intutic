#!/usr/bin/env bash
# Re-download the vendored corpora and verify them against the committed sums.
#
# The corpora are VENDORED, not fetched at test time. A test that downloads is a
# test that silently skips when the network is unavailable — and this repo's CI
# comments already name that failure: bodies that never execute while the job
# reports green. This script is for refreshing them deliberately.
#
# No pipes: a pipeline's exit status is the last command's, which would hide a
# failed download behind a successful `tee`.
set -euo pipefail

cd "$(dirname "$0")"
BASE="https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/resolve/main/possible_answer"

for f in base composite long_context miss_func miss_param; do
  curl -sSL --fail --max-time 120 -o "bfcl/BFCL_v3_multi_turn_${f}.json" \
    "${BASE}/BFCL_v3_multi_turn_${f}.json"
done

( cd bfcl && shasum -a 256 -c SHA256SUMS )
( cd notinject && shasum -a 256 -c SHA256SUMS )
echo "corpora verified"
