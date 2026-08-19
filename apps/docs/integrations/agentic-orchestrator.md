# Agentic Orchestrator

Integrate Intutic governance with [DoorDash's Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator) (`agentico`) — a public, open-source (Apache-2.0) desktop app + CLI that turns a feature prompt into a multi-phase AI coding workflow.

::: tip Live-verified, not just README-read
Unlike several recent harness integrations (Muse Code, Grok Build, Xirp), this one's core facts were confirmed by actually downloading and running the real released binary (`agentico` v0.152.0, darwin_arm64) during this integration's research — `agentico --version`, `agentico --help`, and `agentico server --help` all matched what's documented below. See TD-397 for the one real gap this research surfaced.
:::

## What Agentic Orchestrator is (and is not)

Agentic Orchestrator is **not itself an AI agent**. It is a desktop app (with a companion CLI, `agentico`) that turns a high-level feature prompt into a checkpointed engineering workflow — knowledge-base build, inquiry, research, design, roadmap planning, phase implementation, review, and PR publish — supervised from one workspace. The actual model-driving work is delegated to **already-installed CLI backends**: Claude Code, Codex, and OpenCode (confirmed via `agentico server --help`'s `--providers` flag: `Available: claude, codex, opencode`). Each feature runs in its own `git worktree` under `~/.agentic-orchestrator/worktrees/` (confirmed via the project's own README), so several features can proceed concurrently without colliding in the main checkout.

This is the same "wraps other already-gated CLI harnesses" shape as [Xirp](/integrations/xirp) — but cross-platform (macOS **and** Linux, via Homebrew, a prebuilt binary, or `go install`) rather than Xirp's macOS-only beta, and with a real, confirmed default config path rather than a guessed one.

## Why this integration is detection-only

1. **Detection.** `intutic status`/`intutic init` recognise an Agentic-Orchestrator-managed workspace, so it shows up in reporting.
2. **Worktree propagation.** No new code was needed here — [O1's worktree propagation fix](/integrations/xirp#worktree-coverage-details) (`services/sync-daemon/src/lib/gitWorktrees.ts`) is general, not Xirp-specific: it discovers every worktree of a watched repo each sync cycle via `git worktree list --porcelain`, regardless of where under the filesystem that worktree lives. Agentic Orchestrator's `~/.agentic-orchestrator/worktrees/<feature>/<repo>` worktrees are picked up by the exact same mechanism.

There is no config format of Agentic Orchestrator's own for Intutic to write. `config.yaml`'s `defaults.models.*` keys select **which model** each workflow phase uses — they are not an LLM base-URL / API-routing surface. Routing is each wrapped backend's own concern, exactly as it already is when that backend runs standalone.

## Governance model

Agentic Orchestrator is registered as a `NO_GATE` harness with a `'delegated'` gate kind (see `services/sync-daemon/src/harness/gateKind.ts`) — the same classification Xirp introduced, reused rather than reinvented. A tool call made inside an Agentic-Orchestrator-managed session is governed by whichever wrapped backend's own gate is already running (`claude-code-check.js`, `codex-check.js`) — the same gate this product already lists under that backend's own row, not a second one credited to Agentic Orchestrator.

::: warning Real gap, not merely unconfirmed: OpenCode
Unlike Xirp — where every wrapped backend (Claude Code, Codex, Gemini CLI) is a fully gated Intutic harness — one of Agentic Orchestrator's three wrapped backends, **OpenCode, has no adapter or gate anywhere in this product today.** A feature run with `--providers opencode` (or the default auto-join behavior, when the `opencode` CLI is installed and authenticated) has **zero** Intutic governance — not "delegated to an existing gate" the way a Claude Code- or Codex-backed feature is, but genuinely ungoverned, the same as running any other unsupported harness directly. Restrict `agentico server --providers claude,codex` to avoid this gap until OpenCode itself gets an Intutic integration. See [TD-397](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md).
:::

## Setup

### 1. Agentic Orchestrator detection

Detection checks (in order), cross-platform:
- `~/.agentic-orchestrator` (confirmed default home directory — holds `config.yaml`, the `features/` state dir, and `worktrees/`)
- the `agentico` binary found in your `PATH`
- (macOS only) `/Applications/Agentico.app`, the desktop app bundle

No environment-variable override for either the config or state-dir path is documented anywhere in the binary's own `--help` output (only the explicit `--config`/`--state-dir` flags) — unlike Xirp's guessed `$XIRP_HOME`, this was directly confirmed by running the real binary, not assumed.

### 2. Initialize Intutic

Run `intutic connect` (or `intutic init` + `intutic start`) as normal, against the **main checkout** of the repository Agentic Orchestrator will manage — worktree propagation extends coverage to every feature worktree it spins up from there. No extra flag or `--harness agentic-orchestrator` step is needed: there is no config for Intutic to write for Agentic Orchestrator itself; connecting Claude Code and/or Codex (the two backends this product can actually gate) is what matters.

### 3. What gets written

- **For Agentic Orchestrator itself:** nothing. `tools/cli/src/harness/agenticOrchestrator.ts`'s `writeConfig` is a no-op by design, matching Xirp's exact pattern.
- **For each gated wrapped backend, in every discovered worktree:** exactly what that backend's own adapter already writes in the main checkout — no new format, no Agentic-Orchestrator-specific content.
- **For OpenCode:** nothing, ever — no adapter exists (see the gap above).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `agentic-orchestrator` |
| Config file | none (delegates entirely to the wrapped backend) |
| Gate kind | `delegated` — see `gateKind.ts` |
| Detection | `~/.agentic-orchestrator`, `agentico` on `PATH`, or (macOS only) `/Applications/Agentico.app` |
| Wrapped backends | Claude Code, Codex (gated), OpenCode (**not gated** — TD-397) |
| Worktree coverage | `services/sync-daemon/src/lib/gitWorktrees.ts` — general, not harness-specific; already covers `~/.agentic-orchestrator/worktrees/*` with no changes |

## Source

- Project: [`doordash-oss/agentic-orchestrator`](https://github.com/doordash-oss/agentic-orchestrator) (Go, Apache-2.0)
- Binary: `agentico` — confirmed real by downloading and running the actual GitHub release artifact (v0.152.0, darwin_arm64) during this integration's research
