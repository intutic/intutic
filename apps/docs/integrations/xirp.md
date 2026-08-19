# Xirp

Integrate Intutic governance with [Xirp](https://open.spotify.com/) — Spotify's macOS-only desktop orchestrator for parallel AI coding sessions, beta since 2026-08-11.

## What Xirp is (and is not)

Xirp is **not itself an AI agent**. It is a desktop orchestrator that spawns one or more ALREADY-INSTALLED CLI coding agents — Claude Code, Codex, Gemini CLI — each inside its own `tmux` session and its own `git worktree`, so a developer can run several parallel agent sessions against the same repository without their working-tree state colliding.

Per Xirp's own public FAQ, it preserves each wrapped harness's **native, unmodified configuration** — it introduces no config format of its own. That means whatever Intutic already writes for the wrapped harness (Claude Code's `.claude/settings.json`, Codex's `~/.codex/hooks.json`, etc.) is what governs a tool call made inside a Xirp-managed session — **provided that config actually reaches the git worktree Xirp creates for that session.**

## Why this integration is two things, not one

1. **Detection.** `intutic status`/`intutic init` recognise a Xirp-managed workspace (see below), so it shows up in reporting. There is no config for Intutic to write for Xirp itself — see [the governance model](#governance-model) below.
2. **Worktree propagation** (the substantive half). A `git worktree add`-created checkout has its own independent working tree — project-tier governance files (`.claude/settings.json`, `.cursor/hooks.json`, `.intutic/hooks/*`, wrapped `.mcp.json` entries, etc.) are untracked by convention, so none of them exist in a worktree by default. Before this integration, every Xirp-managed worktree session ran **completely ungoverned**, regardless of what was configured in the main checkout — the wrapped harness's own gate was never missing, it just was never THERE. The sync daemon now discovers every worktree of a watched repo each cycle (`git worktree list --porcelain`) and writes the same project-tier files into each one. This is a general fix, not Xirp-specific — it benefits any `git worktree`-based workflow. See `docs/TECH_DEBT.md` TD-390 and `services/sync-daemon/src/lib/gitWorktrees.ts`.

## Governance model

Xirp is registered as a `NO_GATE` harness with a `'delegated'` gate kind (see `services/sync-daemon/src/harness/gateKind.ts`) — the first harness of this shape in this product. That is a deliberate, different claim from "no gate exists" (aider's `'none'` kind): Xirp's tool calls ARE governed, by whichever wrapped harness's own gate is already running inside that session (`claude-code-check.js`, `codex-check.js`, etc.) — the same gate this product already lists under that harness's own row, not a second one credited to Xirp.

## Setup

### 1. Xirp detection

Xirp is macOS-only. Detection checks (in order):
- `$XIRP_HOME`, if set
- `~/.xirp`
- `/Applications/Xirp.app`

::: tip Not live-verified
Xirp is a macOS-only beta app with no CLI/npm package and no public download available in the environment this integration was built in. None of the three paths above were confirmed against a real install — they follow this codebase's own convention for comparable tools (`~/.grok`, `~/.muse`, `<Name>.app` in `/Applications`), not a confirmed Xirp source. See TD-390.
:::

There is also a separate, weaker, **probabilistic** signal: `services/sync-daemon/src/lib/processPoller.ts`'s `detectTmuxParentedAgents()` checks whether a `claude`/`codex`/`gemini` process is running as a descendant of a `tmux` server process — the shape Xirp's session management takes. This is corroborating evidence at best, never a standalone confirmation: any hand-rolled tmux-based multi-agent workflow trips the identical signal, and this function cannot and does not distinguish Xirp from one. It is exported separately rather than folded into the main process-signature list precisely so an uncertain signal is never silently blended with a certain one.

### 2. Initialize Intutic

Run `intutic connect` (or `intutic init` + `intutic start`) as normal, against the **main checkout** of the repository Xirp will manage — the worktree propagation described above is what extends coverage to every session Xirp spins up from there. No extra flag or `--harness xirp` step is needed: there is no config for Intutic to write for Xirp itself; connecting Claude Code/Codex/whatever harness you actually use inside Xirp is what matters, and it now also covers every worktree.

### 3. What gets written

- **For Xirp itself:** nothing. `tools/cli/src/harness/xirp.ts`'s `writeConfig` is a no-op by design.
- **For each wrapped harness, in every discovered worktree:** exactly what that harness's own adapter already writes in the main checkout — no new format, no Xirp-specific content.

## Worktree coverage details

- Discovery runs every sync cycle via `git worktree list --porcelain`, parsed in `gitWorktrees.ts` (real parser, not a naive line-split — the format is undocumented enough by git itself that a fixture-driven test suite backs it, including `locked`/`prunable`/`bare`/`detached` fields).
- **Locked worktrees are covered.** `git worktree lock` only protects against git's own pruning — it does not restrict writing ordinary files into the checkout, and a workflow (like Xirp's) that locks worktrees to protect a long-running session is exactly the kind most worth covering.
- **Prunable worktrees are skipped.** git itself has flagged the directory missing or invalid; writing into it would risk resurrecting a deleted worktree's folder.
- **Removal requires no cleanup logic.** The worktree list is discovered fresh every cycle, never cached — a `git worktree remove`d checkout simply stops being returned.
- Config-content writes reuse the daemon's existing `configVersion`-based write-if-changed gate; MCP server injection is unconditional per worktree but internally write-if-changed, so an unchanged worktree costs a few file reads, not a rewrite.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `xirp` |
| Config file | none (delegates entirely to the wrapped harness) |
| Gate kind | `delegated` — see `gateKind.ts` |
| Detection | `$XIRP_HOME`, `~/.xirp`, or `/Applications/Xirp.app` (macOS only); a separate probabilistic tmux-ancestry signal exists but is not folded into detection |
| Worktree coverage | `services/sync-daemon/src/lib/gitWorktrees.ts` — general, not Xirp-specific |

::: warning macOS `launchd` environment inheritance (unconfirmed for Xirp specifically)
A GUI-launched `.app` (opened from Finder/Dock/Spotlight) does **not** inherit a shell's exported environment variables the way a terminal-launched process does — that is general macOS `launchd` behavior, not something specific to this integration. If a user sets `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` (or similar) in `.zshrc`/`.bashrc` expecting Xirp's spawned tmux sessions to route through the Intutic proxy, that routing will silently **not** happen for the GUI-launched app itself unless the user also sets the variable via `launchctl setenv` (session-wide, until logout/reboot) or Xirp provides its own env-passthrough mechanism.

**Could not confirm** which of these applies to Xirp — no evidence was found (in the environment this integration was built in) of what Xirp actually does about env-var passthrough to its spawned tmux sessions. This section documents the general macOS `launchd` caveat as a risk to be aware of, not a confirmed Xirp behavior. If Xirp is launched from a terminal (`open -a Xirp` from an already-configured shell, or a CLI entry point if one exists) rather than from Finder/Dock, this caveat does not apply — inheritance follows the launching process's environment normally in that case.
:::
