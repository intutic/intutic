#!/usr/bin/env bash
#
# Sync client-facing code between intutic (public) and intutic-enterprise.
#
# See AGENTS.md § "Hybrid Open-Core Development Workflow".
#
# DIRECTION: public -> enterprise is now the default. Open core leads for shared
# client-facing code; enterprise consumes it. The old default (enterprise ->
# public) is still available as --to-public, for backporting an enterprise-only
# edit or a change that cannot be developed in the open.
#
# Either direction is a dry run unless you pass --apply, and either way the
# guards below are what make it safe: neither tree may be dirty, and the
# destination is never moved to an older version than it already has.
#
# Usage:
#   ./tools/scripts/sync-to-public.sh                # dry run, public -> enterprise
#   ./tools/scripts/sync-to-public.sh --apply        # write, public -> enterprise
#   ./tools/scripts/sync-to-public.sh --to-public    # dry run, enterprise -> public
#   ./tools/scripts/sync-to-public.sh --to-public --apply
#   ./tools/scripts/sync-to-public.sh --apply --allow-dirty
#   ./tools/scripts/sync-to-public.sh --apply --allow-symbol-loss   # intended removals
#
# Dry run is the default on purpose. The previous version of this script ran
# `rm -rf "$dest"` on every synced directory and then rsynced over the top, with
# no preview, no confirmation, and no checks — so anything that existed only in
# the public repo was destroyed silently, and a stale enterprise tree could walk
# published versions backwards.
set -euo pipefail

ENTERPRISE_DIR="/Users/ishangupta/intutic-enterprise"
PUBLIC_DIR="/Users/ishangupta/intutic"

APPLY=false
ALLOW_SYMBOL_LOSS=false
ALLOW_DIRTY=false
TO_PUBLIC=false
for arg in "$@"; do
  case "$arg" in
    --apply)       APPLY=true ;;
    --allow-dirty) ALLOW_DIRTY=true ;;
    --to-public)   TO_PUBLIC=true ;;
    --allow-symbol-loss) ALLOW_SYMBOL_LOSS=true ;;
    -h|--help)     sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# Resolved direction. Everything below refers to SRC/DEST rather than
# enterprise/public, so the guards and the rsync loop are direction-agnostic.
if [ "$TO_PUBLIC" = true ]; then
  SRC_DIR="$ENTERPRISE_DIR"; DEST_DIR="$PUBLIC_DIR"
  SRC_NAME="enterprise";     DEST_NAME="public"
else
  SRC_DIR="$PUBLIC_DIR";     DEST_DIR="$ENTERPRISE_DIR"
  SRC_NAME="public";         DEST_NAME="enterprise"
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# Directories copied wholesale from enterprise to public.
SYNC_PATHS=(
  packages/anomaly-taxonomy
  packages/clawde-sdk packages/gate-js packages/id packages/intutic-clawde
  packages/logger packages/mcp-proxy packages/proxy packages/shared-types
  packages/theme packages/vscode-extension packages/wasm-sdk
  services/sync-daemon
  tools/cli
  apps/docs
)

# Individual root-level files that are one document in both repos. Kept apart
# from SYNC_PATHS because a single-file rsync has no --delete and no manifest,
# so the symbol/version guards below (which iterate SYNC_PATHS) neither apply to
# nor need to see them. README.md drifted for three sweeps because it sat under
# no synced directory — the parity gate now flags that, and this closes the loop.
SYNC_FILES=(README.md)

# Trees that are shared but whose two copies each hold exclusive files —
# tools/scripts has ~20 enterprise-only scripts (deploy.sh, this script, seeders)
# and one public-only file (check-commit-messages.js). A wholesale --delete sync
# in either direction would destroy the other side's exclusives, so these sync
# with `--existing` (update only files present on BOTH sides; never create,
# never delete) — exactly the parity gate's own "a file in both must match"
# semantics. Caveat: a brand-new shared script needs one manual copy downstream
# the first time; it syncs automatically thereafter.
SYNC_INTERSECT_PATHS=(tools/scripts)

# .agents was in this list and should never have been. It carried
# .agents/AGENTS.md -- an internal working document naming this repo, its
# layout and its slice-based UAT process -- into the public tree, where it sat
# published since v1.4.0. The two skill files under .agents/skills/ are
# genuinely public and are linked from the integrations docs, but they are
# already present downstream and do not need syncing to stay that way.
#
# If a skill ever needs updating downstream, copy that file deliberately
# rather than re-adding the whole directory.

# Build residue — never meaningful to copy.
RSYNC_EXCLUDES=(
  --exclude=node_modules --exclude=dist --exclude=.turbo --exclude=target
  --exclude=.env --exclude='*.tsbuildinfo'
  --exclude=__pycache__ --exclude='*.py[cod]' --exclude=.venv
  --exclude='*.egg-info' --exclude=.pytest_cache
  --exclude=.vitepress/dist --exclude=.vitepress/cache
)

# Deliberate divergences. These are NOT drift, and copying them would undo a
# decision the public repo made on purpose:
#
#   packages/proxy/Cargo.lock      Cargo resolves the workspace-root lockfile;
#                                  a member lockfile is inert, so public
#                                  untracks it and pins the root one instead.
#   packages/proxy/bin/intutic-proxy
#                                  The 39MB prebuilt binary. Shipping it inside
#                                  the npm package is what broke installs on
#                                  every non-macOS machine (intutic/intutic#1);
#                                  the CLI now downloads a per-platform binary
#                                  from GitHub Releases.
#   packages/proxy/src/store/SPIKE-FINDINGS.md
#                                  Engineering record of the storage-port spike:
#                                  go/no-go criteria, measured drift, decisions
#                                  taken and rejected. Useful to whoever
#                                  maintains that code, meaningless to someone
#                                  consuming the package, so it lives here only.
#                                  Excluded rather than deleted because rsync
#                                  --delete would otherwise remove this copy the
#                                  moment it is absent downstream.
#   apps/docs/Dockerfile           Enterprise pins INTUTIC_ENTERPRISE_BUILD=false
#                                  and INTUTIC_REQUIRE_OSS=true because this repo
#                                  HAS services/control-plane and could otherwise
#                                  build a docs site full of paid-tier pages.
#                                  Public cannot: with no control-plane directory
#                                  IS_OSS is structurally true there.
#
# NOTE: rsync patterns are relative to the transfer root, which is the synced
# directory itself — not the repo root. `--exclude=packages/proxy/Cargo.lock`
# silently matches nothing when the transfer root is already packages/proxy.
# Hence the per-path lookup below rather than one flat list.
preserve_excludes_for() {
  case "$1" in
    packages/proxy) printf '%s\n' --exclude=Cargo.lock --exclude=bin/intutic-proxy --exclude=src/store/SPIKE-FINDINGS.md ;;
    apps/docs)      printf '%s\n' --exclude=Dockerfile ;;
  esac
}

# ── Guard 1: both trees committed ───────────────────────────────────────────
#
# rsync --delete rewrites the public tree. Uncommitted work there is
# unrecoverable, and an uncommitted enterprise tree means syncing something that
# was never reviewed.
check_clean() {
  local dir="$1" name="$2"
  local dirty
  dirty="$(git -C "$dir" status --porcelain | wc -l | tr -d ' ')"
  if [ "$dirty" -ne 0 ]; then
    if [ "$ALLOW_DIRTY" = true ]; then
      warn "$name has $dirty uncommitted file(s) — proceeding due to --allow-dirty"
    else
      fail "$name has $dirty uncommitted file(s). Commit or stash first, or pass --allow-dirty."
      git -C "$dir" status --short | head -10 >&2
      return 1
    fi
  else
    info "$name is clean"
  fi
}

# ── Guard 2: never move the destination's versions backwards ────────────────
#
# Whichever tree publishes a given package, overwriting it with an older
# manifest rewrites version numbers to something behind what is already live on
# the registry. Public is straight ahead of enterprise after every release, so
# in the --to-public direction this is the guard that stops a stale enterprise
# tree undoing a release; in the default direction it stops the reverse.
#
# The two trees version together — enterprise does NOT version independently.
# A mismatch means one side has drifted since the last sync, not that they are
# on separate cadences, and syncing is what resolves it. Only a strict
# *downgrade* of the destination blocks, because that is the one case where
# syncing would undo a release rather than propagate one.
version_of() {
  case "$1" in
    *.json) node -p "require('$1').version" 2>/dev/null ;;
    *.toml) grep -m1 '^version = ' "$1" 2>/dev/null | sed -E 's/.*"([^"]+)".*/\1/' ;;
  esac
}

# Guard 3: exported symbols the destination has and the source does not.
#
# check_clean sees uncommitted files and check_versions compares manifest version
# strings; neither has any notion of file *content*, so both pass while an rsync is
# about to delete real work. On 2026-07-30 the default direction was one command away
# from removing seven enterprise-only additions to packages/shared-types — the SCIM 2.0
# resource types, the SCIM error codes, `isServiceAccount`, the SSO recency-gate
# setting, `tokenUtilityClassifiedBy` and `TraceDagResult.currentSessionId` — every one
# of which the enterprise control plane or dashboard imports. The itemised dry run
# listed the files, but only as paths; nothing said "this deletes an exported symbol".
#
# So: compare exported identifiers per .ts file and refuse when the destination would
# lose one. Deliberate removals still go through, with --allow-symbol-loss.
exported_symbols() {
  # Two kinds of loss, because both have bitten:
  #
  #   1. Whole exports — `export const X`, `export interface X`, and so on. Losing
  #      one breaks every importer.
  #   2. Members inside an existing type — `currentSessionId` inside TraceDagResult,
  #      `isServiceAccount` inside a Zod schema. A symbol-only check misses these
  #      entirely, and they are the more common shape: enterprise usually *extends*
  #      a shared type rather than adding a new one.
  #
  # Members are matched loosely (an indented `name:` or `name?:`) and prefixed so
  # they cannot collide with a top-level symbol of the same name. Comments and
  # string contents can produce the odd false positive; that is the right direction
  # for a guard whose failure mode is deleting someone's work.
  {
    command grep -hoE '^export (declare )?(const|function|async function|interface|type|class|enum) [A-Za-z_][A-Za-z0-9_]*' "$1" 2>/dev/null \
      | awk '{print $NF}'
    command grep -hoE '^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*\??:' "$1" 2>/dev/null \
      | tr -d ' ' | sed 's/^/member:/'
  } | sort -u
}

check_symbols() {
  local losses=0
  for p in "${SYNC_PATHS[@]}"; do
    [ -d "$DEST_DIR/$p" ] || continue
    while IFS= read -r dstfile; do
      local rel srcfile missing
      rel="${dstfile#"$DEST_DIR"/}"
      srcfile="$SRC_DIR/$rel"
      # A file absent from the source is rsync --delete's business, not ours.
      [ -f "$srcfile" ] || continue
      missing="$(comm -23 <(exported_symbols "$dstfile") <(exported_symbols "$srcfile"))"
      [ -z "$missing" ] && continue
      local n shown
      n="$(echo "$missing" | wc -l | tr -d ' ')"
      # A whole new interface drags all its members into the list; show enough to
      # recognise what is at stake without burying the other files.
      shown="$(echo "$missing" | head -8 | tr '\n' ' ')"
      if [ "$n" -gt 8 ]; then
        fail "  $rel would lose $n: $shown… (+$((n - 8)) more)"
      else
        fail "  $rel would lose: $shown"
      fi
      losses=$((losses + 1))
    done < <(find "$DEST_DIR/$p" -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null)
  done

  if [ "$losses" -ne 0 ]; then
    fail "$losses file(s) in $DEST_NAME export symbols $SRC_NAME does not have."
    fail "Syncing would delete them. Port the additions to $SRC_NAME first, or pass"
    fail "--allow-symbol-loss if the removal is what you intend."
    return 1
  fi
}

check_versions() {
  local regressions=0
  local manifests=()
  for p in "${SYNC_PATHS[@]}"; do
    [ -f "$SRC_DIR/$p/package.json" ] && manifests+=("$p/package.json")
  done
  manifests+=("packages/proxy/Cargo.toml" "packages/intutic-clawde/pyproject.toml")

  for m in "${manifests[@]}"; do
    local src dst
    src="$(version_of "$SRC_DIR/$m")" || true
    dst="$(version_of "$DEST_DIR/$m")" || true
    [ -z "${src:-}" ] || [ -z "${dst:-}" ] && continue
    [ "$src" = "$dst" ] && continue
    # Regression when the destination is strictly newer than the source.
    if [ "$(printf '%s\n%s\n' "$src" "$dst" | sort -V | head -1)" = "$src" ]; then
      fail "  $m: $DEST_NAME is $dst, $SRC_NAME is $src — sync would DOWNGRADE it"
      regressions=$((regressions + 1))
    else
      info "  $m: $dst -> $src"
    fi
  done

  if [ "$regressions" -ne 0 ]; then
    fail "$regressions manifest(s) would move backwards. Bump $SRC_NAME to match the released version first."
    return 1
  fi
}

echo
info "Sync: $SRC_DIR  ->  $DEST_DIR   ($SRC_NAME -> $DEST_NAME)"
[ "$APPLY" = true ] && warn "APPLY mode — the $DEST_NAME tree will be modified" \
                    || info "DRY RUN — nothing will be written (pass --apply to write)"
echo

info "Checking working trees…"
check_clean "$SRC_DIR" "$SRC_NAME"
check_clean "$DEST_DIR" "$DEST_NAME"
echo

info "Checking versions…"
check_versions
echo

if [ "$ALLOW_SYMBOL_LOSS" = true ]; then
  warn "Skipping the exported-symbol guard (--allow-symbol-loss)"
else
  info "Checking for exported symbols only $DEST_NAME has…"
  check_symbols
fi
echo

RSYNC_FLAGS=(-a --delete "${RSYNC_EXCLUDES[@]}")
[ "$APPLY" = false ] && RSYNC_FLAGS+=(--dry-run)
# --delete rather than the old `rm -rf "$dest"`: rsync honours the excludes
# above, so deliberate public-only state survives instead of being wiped and
# then partially restored.
RSYNC_FLAGS+=(--itemize-changes)

content=0
metadata=0
for p in "${SYNC_PATHS[@]}"; do
  src="$SRC_DIR/$p"; dest="$DEST_DIR/$p"
  [ -d "$src" ] || { warn "$p missing in $SRC_NAME — skipping"; continue; }
  mkdir -p "$dest"
  preserve=()
  while IFS= read -r line; do [ -n "$line" ] && preserve+=("$line"); done < <(preserve_excludes_for "$p")
  # ${arr[@]+"${arr[@]}"} — expanding an empty array under `set -u` is an error
  # in bash 3.2, which is what ships on macOS. Most paths have no preserves.
  out="$(rsync "${RSYNC_FLAGS[@]}" ${preserve[@]+"${preserve[@]}"} "$src/" "$dest/" \
          | grep -vE '^\.d|^$|^sending|^total|^sent ' || true)"
  [ -z "$out" ] && continue

  # Separate real edits from mtime-only touches. `-a` preserves timestamps, so a
  # file whose bytes match but whose mtime differs is still "transferred" — and
  # listing those alongside genuine changes buries the signal. Only the first
  # kind is worth a reviewer's attention.
  real="$(echo "$out"    | grep -vE '^>f\.\.t' || true)"
  touch_only="$(echo "$out" | grep -cE '^>f\.\.t' || true)"

  if [ -n "$real" ]; then
    echo "  $p"
    echo "$real" | sed 's/^/      /'
    content=$((content + $(echo "$real" | wc -l | tr -d ' ')))
  fi
  metadata=$((metadata + touch_only))
done

# Root files (SYNC_FILES): single-file transfers, no --delete, no preserves.
for f in "${SYNC_FILES[@]}"; do
  src="$SRC_DIR/$f"; dest="$DEST_DIR/$f"
  [ -f "$src" ] || { warn "$f missing in $SRC_NAME — skipping"; continue; }
  out="$(rsync "${RSYNC_FLAGS[@]}" "$src" "$dest" \
          | grep -vE '^\.d|^$|^sending|^total|^sent ' || true)"
  [ -z "$out" ] && continue
  real="$(echo "$out"    | grep -vE '^>f\.\.t' || true)"
  touch_only="$(echo "$out" | grep -cE '^>f\.\.t' || true)"
  if [ -n "$real" ]; then
    echo "  $f"
    echo "$real" | sed 's/^/      /'
    content=$((content + $(echo "$real" | wc -l | tr -d ' ')))
  fi
  metadata=$((metadata + touch_only))
done

# Intersection trees (SYNC_INTERSECT_PATHS): --existing so only files present on
# BOTH sides update; nothing is created or deleted (each repo keeps its
# exclusives). No --delete, so RSYNC_FLAGS is rebuilt without it here.
INTERSECT_FLAGS=(-a --existing --itemize-changes "${RSYNC_EXCLUDES[@]}")
[ "$APPLY" = false ] && INTERSECT_FLAGS+=(--dry-run)
for p in "${SYNC_INTERSECT_PATHS[@]}"; do
  src="$SRC_DIR/$p"; dest="$DEST_DIR/$p"
  [ -d "$src" ] || { warn "$p missing in $SRC_NAME — skipping"; continue; }
  out="$(rsync "${INTERSECT_FLAGS[@]}" "$src/" "$dest/" \
          | grep -vE '^\.d|^$|^sending|^total|^sent |^cd' || true)"
  [ -z "$out" ] && continue
  real="$(echo "$out"    | grep -vE '^>f\.\.t' || true)"
  touch_only="$(echo "$out" | grep -cE '^>f\.\.t' || true)"
  if [ -n "$real" ]; then
    echo "  $p (intersection)"
    echo "$real" | sed 's/^/      /'
    content=$((content + $(echo "$real" | wc -l | tr -d ' ')))
  fi
  metadata=$((metadata + touch_only))
done

echo
[ "$metadata" -gt 0 ] && info "$metadata file(s) differ only by timestamp (identical content) — not listed."

if [ "$content" -eq 0 ]; then
  info "No content differences. The repos are in sync."
  [ "$APPLY" = false ] && [ "$metadata" -gt 0 ] && \
    info "Running --apply would only realign timestamps."
elif [ "$APPLY" = true ]; then
  info "Sync complete — $content file(s) changed."
  warn "Review before committing: git -C $DEST_DIR status"
else
  warn "$content file(s) have real content differences. Re-run with --apply to write them."
fi
