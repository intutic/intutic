#!/usr/bin/env bash
# Rebuild the Rego fixtures. Needs OPA (on the PATH, or INTUTIC_OPA_BIN) and a
# built CLI (pnpm --filter @intutic/cli build). Run from anywhere.
#
# - examples/*.wasm: built by `intutic rules build`, metadata included, so the
#   tests exercise exactly what users get.
# - conformance.wasm and unsupported_builtin.wasm: raw `opa build` output with
#   no metadata, the other shape a host accepts.
# - conformance.expected.json: `opa eval` on conformance.input.json, the oracle
#   both hosts' builtins are tested against. Never edit it by hand.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
opa="${INTUTIC_OPA_BIN:-opa}"
cli=(node "$repo/tools/cli/dist/cli.js")
work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT

raw() { # <rego> <entrypoint> <out>
  "$opa" build -t wasm -e "$2" "$1" -o "$work/bundle.tar.gz"
  tar -xzf "$work/bundle.tar.gz" -C "$work" /policy.wasm
  mv "$work/policy.wasm" "$3"
}

cd "$here"
INTUTIC_OPA_BIN="$opa" "${cli[@]}" rules build --rego examples/block_destructive_shell.rego \
  --entrypoint intutic/shell/deny --risk-tier critical --out examples/block_destructive_shell.wasm
INTUTIC_OPA_BIN="$opa" "${cli[@]}" rules build --rego examples/hold_prod_deploys.rego \
  --entrypoint intutic/deploy/decision --risk-tier high --out examples/hold_prod_deploys.wasm
INTUTIC_OPA_BIN="$opa" "${cli[@]}" rules build --rego examples/deny_writes_outside_repo.rego \
  --entrypoint intutic/paths/deny --risk-tier medium --out examples/deny_writes_outside_repo.wasm
raw conformance.rego conformance/results conformance.wasm
raw unsupported_builtin.rego unsupported/deny unsupported_builtin.wasm
"$opa" eval -d conformance.rego -i conformance.input.json 'data.conformance.results' --format json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).result[0].expressions[0].value,null,2)+"\n"))' \
  > conformance.expected.json
"$opa" version | head -1
