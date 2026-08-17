# Governed Decisions Log <Badge type="warning" text="Cloud / Team" />

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

Enable it from **Settings → AI Routing & Proxy** (or via the settings API, `decisionsLogEnabled: true`). Once on:

1. The sync-daemon polls a bounded, workspace-scoped projection of the last ~20 decisions on its normal sync cycle.
2. `.intutic/DECISIONS.md` is written locally — the full bounded record, regenerated each cycle. This file is **not** committed to your repository (it's covered by `.gitignore`, the same as every other daemon-generated governance artifact).
3. A short, marker-delimited section (the most recent ~10 entries) is injected into your `CLAUDE.md` (or equivalent) — the file your harness already reads as project context — so your coding agent sees recent decisions without needing to know `.intutic/DECISIONS.md` exists.

Turning the setting back off stops further updates; it does not delete files a previous sync already wrote.

## Refreshing immediately after a merge

If you use Intutic's Git hooks, an optional `post-merge` hook triggers a one-shot refresh right after `git merge`, rather than waiting for the daemon's next poll. It's installed alongside Intutic's other hooks and, like all of them, never overwrites a hook that isn't Intutic's own.

## Related

- [Review Queue](/guide/decisions) — the human-in-the-loop approval flow this log records the outcomes of
- [Settings & Config](/guide/settings) — where to turn this on
- [Agent Guidelines (SOPs)](/guide/sops) — the governance rules your agent enforces, distinct from the decisions log's after-the-fact record
<!-- ENTERPRISE_ONLY_END -->
