# Governed Decisions Log <Badge type="tip" text="Cloud" />

<!-- ENTERPRISE_ONLY_START -->
The Governed Decisions Log is a versioned, auto-maintained record of governance decisions — surfaced directly as context your coding agent's harness reads, so agents work with an up-to-date picture of what's already been decided instead of repeating a question a human already answered.

## What you'll learn

- What is (and isn't) recorded in the log
- How to turn it on for a workspace
- Where the log lives, and how your agent sees it
- The token-cost trade-off, and why it's opt-in

::: warning Scope boundary
This is **governance-decision records only** — adjudications, approved/rejected decisions, resolved incidents, and settings changes. It is **not** conversational memory, session history, or general-purpose context management. Intutic does not manage your agent's full conversational context; that's a different kind of product, and one this feature deliberately does not attempt.
:::

## What's recorded

Each entry in the log is a one-line summary of one governance event:

| Source | What shows up |
|--------|---------------|
| **Decisions** | Approved/rejected [Review Queue](/guide/decisions) decisions |
| **Incidents** | Resolved governance incidents — category and severity, not the full incident narrative |
| **Settings changes** | Which workspace settings changed, and by whom (key names only, never values) |
| **Detector-finding adjudications** | A detector finding ruled TRUE_POSITIVE or FALSE_POSITIVE — the pattern name, never any quoted model output |

Summaries are rendered server-side, deliberately kept to structural facts rather than free text. Two categories are never included, full stop:

- **Break-glass override tokens** — never appear in any digest, log, or synced file.
- **Response-injection echo snippets** — the bounded, DLP-scrubbed excerpt of model output some detector findings carry stays behind the dedicated OWNER/ADMIN-only endpoint it has always lived behind. The log records that a finding was adjudicated and what pattern it matched, never the quoted text.

## Turning it on

The Governed Decisions Log is **off by default**. A growing, auto-written context file is token spend your workspace's agents pay on every request that reads it — that's not something Intutic imposes without an explicit opt-in.

There is no dashboard toggle for it. Enable it through the settings API, with `decisionsLogEnabled: true` in `PUT /api/v1/workspace/settings`. Once on:

1. The sync-daemon polls a bounded, workspace-scoped projection of the last ~20 decisions on its normal sync cycle.
2. `.intutic/DECISIONS.md` is written locally — the full bounded record, regenerated each cycle. This file is **not** committed to your repository (it's covered by `.gitignore`, the same as every other daemon-generated governance artifact).
3. The 10 most recent entries go where each connected harness reads its standing instructions, so your coding agent sees recent decisions without needing to know `.intutic/DECISIONS.md` exists. The column "Decisions log goes to" in [Where rule sets go](/guide/how-it-works#where-rule-sets-go) lists the place for every harness:
   - **A file of Intutic's own** next to the rules file, for harnesses that read a rules directory: `.claude/rules/intutic-decisions.md` for Claude Code, `.cursor/rules/intutic-decisions.mdc` for Cursor, and so on, with the same always-apply front matter as the rules file. Aider gets `.intutic/aider-decisions.md`, listed under `read:` in `.aider.conf.yml`.
   - **A marked section of its own** (`<!-- INTUTIC:DECISIONS_LOG:START -->` … `<!-- INTUTIC:DECISIONS_LOG:END -->`) in a file you also write, apart from the rules section: `AGENTS.md` (one section for Codex, OpenCode, Grok Build, Muse Code, Pi, Hermes, Roo Code and dsh), `GEMINI.md`, `.github/copilot-instructions.md`, `.goosehints`, and the `AGENTS.md` of OpenClaw's agent workspace. Nothing outside the markers changes.
   - **Nowhere**, for a harness that reads no instructions file (n8n, Claude Desktop, Open WebUI, the SDK frameworks, ...). The dashboard's Compliance Scope card for it says the decisions log does not reach it.

Turning the setting back off stops further updates; it does not delete files a previous sync already wrote.

## Claude Code

Claude Code gets the log from `.claude/rules/intutic-decisions.md`. The file has no `paths:` front matter, so Claude Code loads it at launch, with the priority of `.claude/CLAUDE.md`, whether or not your project has a `CLAUDE.md`. Intutic never creates or writes `CLAUDE.md`: under Claude Code's default setting, a project `CLAUDE.md` stops it reading `AGENTS.md`, so creating one would hide your team's `AGENTS.md` from it.

Claude Code also reads the workspace's `AGENTS.md` when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in its working directory or above it. When it does and the workspace's `AGENTS.md` carries the decisions section for another harness, Claude Code reads the log there, and Intutic leaves `.claude/rules/intutic-decisions.md` out so it is not read twice. The same goes for a rule set aimed at both Claude Code and an `AGENTS.md` reader: it reaches Claude Code through `AGENTS.md` alone. When a `CLAUDE.md` appears or goes, the next sync moves the content to match.

Claude Code's **Project instructions** setting changes when it reads `AGENTS.md`. You can opt in to `claude-md-and-agents-md` from `/config` (or under `pluginConfigs` in `~/.claude/settings.json`) so it reads your `CLAUDE.md` and `AGENTS.md` together; Intutic reads that choice from `~/.claude/settings.json` and follows it. A project's own settings cannot change it. See [Claude Code's AGENTS.md documentation](https://code.claude.com/docs/en/memory#agentsmd).

Earlier versions put the log in a section of `CLAUDE.md`. The next sync takes that section out and leaves the rest of your `CLAUDE.md` as it was; a `CLAUDE.md` an earlier version created that holds nothing else is removed.

## Refreshing immediately after a merge

If you use Intutic's Git hooks, an optional `post-merge` hook triggers a one-shot refresh right after `git merge`, rather than waiting for the daemon's next poll. It's installed alongside Intutic's other hooks and, like all of them, never overwrites a hook that isn't Intutic's own.

## Related

- [Review Queue](/guide/decisions) — the human-in-the-loop approval flow this log records the outcomes of
- [Settings & Config](/guide/settings) — where to turn this on
- [Agent Guidelines (SOPs)](/guide/sops) — the governance rules your agent enforces, distinct from the decisions log's after-the-fact record
<!-- ENTERPRISE_ONLY_END -->
