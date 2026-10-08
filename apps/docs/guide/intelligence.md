# Intelligence Engine <Badge type="tip" text="Cloud" />

The Intutic Intelligence Engine is an autonomous analysis layer that monitors agent trajectories in the background to automatically identify token waste patterns, suggest optimal rule modifications for developer configurations, and verify security compliance.

## Overview

As AI coding assistants interact with developer workspaces, the Intelligence Engine parses raw trace data, execution patterns, and system tool calls to optimize cost efficiency and maintain strict compliance. Open it from **Labs › Intelligence** (`/labs/intelligence`; Owners, Admins and Engineering Managers). The page has three tabs: **Recommendations**, **SOP Compliance** and **Version History**. The waste and shadow-routing figures it used to carry are on the dashboard's **Overview › Spend** tab.

---

## Token Waste Patterns

The Intelligence Engine automatically flags inefficient token spend. The patterns it finds are listed under **Inefficient Spend** on **Overview › Spend**, with the wasted cost, wasted tokens and traces analyzed for the chosen period (24h, 7d or 30d).

### Types of Waste Detected

One detector ships today.

- **Oversized Prompt** *(heuristic, confidence 0.6)* — Traces whose raw input exceeds
  three times the workspace median. The excess over the median is attributed as waste.
  A legitimately large task looks identical, which is why the confidence is moderate and
  why the panel labels this **heuristic** rather than **measured**.

A second detector, **Redundant Context**, has been removed. It compared raw against
compressed input tokens, and the proxy writes those equal on every trace path, so it was
structurally incapable of firing — while shipping as *measured*, at confidence 1.0.

The compactor's real saving is now recorded and shown, but it is **not waste**, and it is
not listed with the waste patterns. It appears on **Overview › Cost & Token Efficiency**, as
a note under the **Token Spend by Compliance** chart giving the bytes trimmed from tool
output, beside the chart rather than inside it. Two reasons: the figure is
byte-denominated and the waste list is priced per token, and it is a saving already
realised, whereas the waste list shows waste still outstanding. It is also **response-side** —
the compactor runs after the model replies, so the benefit lands in the next turn's
prompt rather than reducing the request it was measured on.

Loop detection, tool misuse and outlier-cost analysis are not implemented. This page
previously described all four as shipping; the control plane writes only the
oversized-prompt pattern today, and the Inefficient Spend table says so.

::: tip Recommendations
Recommendations calculated from these patterns, to help you adjust agent context limits and prompt guidelines, are listed on the **Recommendations** tab of **Labs › Intelligence**.
:::

---

## Configuration Recommendations (SkillOpt)

SkillOpt parses agent trajectory failures and config files (like `.cursorrules`, `CLAUDE.md`, or `.github/workflows`) to recommend modifications.

### How It Works

1. **Analysis** — SkillOpt evaluates compliance logs and config drift. This runs on a nightly schedule for every workspace; a **Regenerate suggestions** button in **SkillOpt Suggestions**, on the Intelligence page's **Version History** tab, triggers the same pipeline on demand, for when you don't want to wait for the next scheduled sweep. The scheduled run remains the authoritative, unattended path — the button is a manual, on-demand trigger only.
2. **Generation** — An LLM call generates structural changes (e.g., adding rules to block specific commands or auto-inject system contexts). This step is generation, not evaluation — nothing here judges whether the result is safe.
3. **Safety Gate** — Two deterministic checks run before a recommendation is displayed, not an LLM judge: bounds checking (operation count, edit size, no wildcard deletes, no sectionless full-file replaces, and per-file-type syntax validation for JSON/YAML/Markdown), and a scan of the edit against active workspace SOPs for conflicting security language (e.g. a SOP's "must not"/"forbidden" clauses).
4. **Auto-Apply** — If enabled, recommendations with confidence scores above `0.85` are automatically queued for the sync daemon to apply (`status: 'apply_unconfirmed'`). The suggestion only reaches `applied` once the daemon acks back that the edit actually landed on disk; a queued edit the daemon fails to write (e.g. a fuzzy-match miss) ends up `apply_failed` instead.
5. **Measurement** — Every applied suggestion carries the dollar estimate that
   justified it (`estimatedSavingsUsd`, snapshotted from the originating
   recommendation) alongside an actual measured outcome, so the estimate is
   checked rather than taken on faith.

   At apply time, the workspace's current absolute waste (`wastedTokens` — see
   [Token Waste Patterns](#token-waste-patterns) above; deliberately *not* the
   percentage, which is self-referential against its own 3x-median threshold
   and can hide a real improvement) is snapshotted as the "before" figure. No
   earlier than 7 full days later, a scheduled sweep recomputes the same
   metric over the non-overlapping 7-day window that followed the apply and
   records it as the "after" figure — never sooner, and never by reading the
   `waste_patterns` table directly, since that table is a periodically
   recomputed aggregate that gets overwritten on every cycle and would no
   longer hold the original numbers by the time 7 days had passed.

   The after-window must carry at least as much oversized-prompt traffic as
   originally justified the recommendation, or the suggestion is marked
   **insufficient traffic to measure** rather than scored — a quiet workspace
   is not the same thing as a fixed one, and no delta is ever fabricated to
   fill the gap. Otherwise it is marked **measured**, with the actual
   before/after token counts shown next to the original estimate under
   **SkillOpt Suggestions** on the **Version History** tab, side by side rather than blended into one number.

   This is deliberately not split-traffic A/B testing: governance stays
   shadow-first by design (a single workspace either has an edit applied or
   it doesn't, evaluated before/after in time rather than concurrently across
   a traffic split), and cost-policy A/B is deferred until a customer actually
   asks for it.

---

## Harness Config Drift

Local harness configuration is treated as governed state, not developer preference.

### Key Capabilities

- **Snapshot & Diff** — Config captures are versioned per workspace, and each snapshot can be diffed against the one captured just before it, to show what changed in `.cursorrules`, `CLAUDE.md`, or a hooks file. Diffs and SkillOpt need the file text, which `intutic connect` uploads only when the workspace turns on **Upload config file content** (Settings › Security › Harness Config History); with it off the history records when each file changed, not how. See [Config content upload](/reference/cli#config-content-upload).
- **Local Restore** — The sync daemon watches those files with `chokidar`. If an agent modifies or deletes one, it reports the drift and rewrites the file from the synced SOPs, unless the workspace's hand-edit setting is **Record only**.

::: info Context gap detection is not part of the product
This section previously described orphan-command alerts against Linear/Jira tickets and SOP auto-suggest from untracked tool sequences. Both belonged to the Context Graph, which was removed when the product narrowed to circuit-breaker scope.
:::
