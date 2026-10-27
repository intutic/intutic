#!/usr/bin/env bash
# Re-renders assets/demo.gif from a real run: one SOP, three tool calls through the
# Claude Code hook gate that `intutic init --gates` installs. No account, no model.
# Only the "agent ->" labels are narration; every verdict is the gate's own output.
#
#   bash assets/demo/record.sh [path-to-intutic-cli-bin-dir]
#
# Needs: node, asciinema (3.x), agg, and the intutic CLI on PATH (or in the given bin dir).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 1 ] && export PATH="$1:$PATH"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export HOME="$WORK/home" INTUTIC_SKIP_GLOBAL_HOOKS=1 TERM=xterm-256color
mkdir -p "$HOME" "$WORK/proj/.intutic/sops" "$WORK/proj/k8s"
cd "$WORK/proj"
git init -q
touch CLAUDE.md k8s/catalogue.yaml
cp "$HERE/catalogue-ticket.md" .intutic/sops/catalogue-ticket.md
intutic init --no-git-hooks --gates >/dev/null 2>&1

export DEMO_PROJECT="$WORK/proj"
asciinema rec --window-size 72x24 --overwrite -q -c "bash $HERE/session.sh" "$WORK/demo.cast"
agg --font-family Menlo --font-size 20 --theme dracula --idle-time-limit 3 --fps-cap 12 \
  --last-frame-duration 3 "$WORK/demo.cast" "$HERE/../demo.gif"
echo "wrote assets/demo.gif ($(wc -c <"$HERE/../demo.gif") bytes, intutic $(intutic --version))"
