#!/usr/bin/env bash
# chaos-e2e.sh — the agent chaos-engineering suite, end to end in the sandbox.
#
# Builds what the suite needs and runs tools/cli/chaos-e2e/run.mjs, which
# drives the real `intutic chaos run` through the MCP-proxy and gate faults
# inside the OCI sandbox and checks every report. Exits non-zero when any
# experiment does not produce what it should.
#
#   1. builds the CLI, the sync daemon and the MCP proxy (turbo);
#   2. builds the proxy binary (cargo, CARGO_TARGET_DIR or target/) and puts
#      it first on PATH;
#   3. deploys the MCP proxy with its production dependencies (pnpm deploy),
#      the build context of the suite's sandbox image;
#   4. runs the suite. Arguments are passed through to run.mjs
#      (e.g. --only stale-data, --runtime podman).
#
# Needs Docker (or Podman), Node, pnpm and a Rust toolchain. Set
# CHAOS_E2E_SKIP_BUILD=1 to reuse what is already built (dist/, the proxy
# binary and, in a reused CHAOS_E2E_WORK, the deployed MCP proxy),
# RUST_TOOLCHAIN to pick the toolchain (default: the active one) and
# CHAOS_E2E_WORK to keep the reports somewhere known.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WORK="${CHAOS_E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/intutic-chaos-e2e.XXXXXX")}"
mkdir -p "$WORK"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"

if [ "${CHAOS_E2E_SKIP_BUILD:-0}" != "1" ]; then
  echo "chaos e2e: building the CLI, the sync daemon and the MCP proxy"
  pnpm turbo run build --filter=@intutic/cli... --filter=@intutic/mcp-governance-proxy... --output-logs=errors-only

  echo "chaos e2e: building the proxy binary into $TARGET"
  if [ -n "${RUST_TOOLCHAIN:-}" ]; then
    CARGO_TARGET_DIR="$TARGET" rustup run "$RUST_TOOLCHAIN" cargo build -p intutic-proxy --bin intutic-proxy
  else
    CARGO_TARGET_DIR="$TARGET" cargo build -p intutic-proxy --bin intutic-proxy
  fi
fi

if [ ! -x "$TARGET/debug/intutic-proxy" ]; then
  echo "chaos e2e: $TARGET/debug/intutic-proxy is missing; build it or unset CHAOS_E2E_SKIP_BUILD" >&2
  exit 1
fi
export PATH="$TARGET/debug:$PATH"

echo "chaos e2e: deploying the MCP proxy with its production dependencies"
DEPLOY="$WORK/mcp-proxy"
# pnpm deploy rewrites the workspace's install-state file with the deploy's
# own settings (production only), after which every `pnpm run` in this
# checkout insists on reinstalling. Put the file back as it was.
STATE="$ROOT/node_modules/.pnpm-workspace-state-v1.json"
STATE_SAVED="$WORK/pnpm-workspace-state.json"
[ -f "$STATE" ] && cp "$STATE" "$STATE_SAVED"
restore_state() { if [ -f "$STATE_SAVED" ]; then cp "$STATE_SAVED" "$STATE"; fi; }
trap restore_state EXIT
if [ "${CHAOS_E2E_SKIP_BUILD:-0}" != "1" ] || [ ! -d "$DEPLOY" ]; then
  rm -rf "$DEPLOY"
  pnpm --filter @intutic/mcp-governance-proxy --config.ignore-scripts=true deploy --prod --legacy "$DEPLOY" > "$WORK/deploy.log" 2>&1 \
    || { echo "chaos e2e: pnpm deploy failed; see $WORK/deploy.log" >&2; exit 1; }
fi
restore_state

node "$ROOT/tools/cli/chaos-e2e/run.mjs" --mcp-proxy "$DEPLOY" --work "$WORK" "$@"
