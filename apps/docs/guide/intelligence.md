# Intelligence Engine <Badge type="warning" text="Cloud / Team" />

The Intutic Intelligence Engine is an autonomous analysis layer that monitors agent trajectories in the background to automatically identify token waste patterns, suggest optimal rule modifications for developer configurations, and verify security compliance.

## Overview

As AI coding assistants interact with developer workspaces, the Intelligence Engine parses raw trace data, execution patterns, and system tool calls to optimize cost efficiency and maintain strict compliance. Access the Intelligence Engine from the **Intelligence** route in the dashboard sidebar.

---

## Token Waste Patterns

The Intelligence Engine automatically flags inefficient token spend.

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
not on this page. It appears on the dashboard's efficiency tab as *tool output trimmed*,
in **bytes**, beside the token chart rather than inside it. Two reasons: the figure is
byte-denominated and everything here is priced per token, and it is a saving already
realised, whereas this page lists waste still outstanding. It is also **response-side** —
the compactor runs after the model replies, so the benefit lands in the next turn's
prompt rather than reducing the request it was measured on.

Loop detection, tool misuse and outlier-cost analysis are not implemented. This page
previously described all four as shipping.

::: tip Waste Classification
Telemetry is classified under the **Waste Patterns** tab on the Intelligence page. Recommendations are automatically calculated to help you adjust agent context limits and prompt guidelines.
:::

---

## Configuration Recommendations (SkillOpt)

SkillOpt parses agent trajectory failures and config files (like `.cursorrules`, `CLAUDE.md`, or `.github/workflows`) to recommend modifications.

### How It Works

1. **Analysis** — SkillOpt evaluates compliance logs and config drift.
2. **Generation** — It generates structural changes (e.g., adding rules to block specific commands or auto-inject system contexts).
3. **Safety Gate** — Recommendations undergo LLM-as-judge safety evaluations before they are displayed.
4. **Auto-Apply** — If enabled, recommendations with confidence scores above `0.85` are automatically applied to the workspace harnesses via the sync daemon.

---

## Harness Config Drift

Local harness configuration is treated as governed state, not developer preference.

### Key Capabilities

- **Snapshot & Diff** — Config captures are versioned per workspace, and any two snapshots can be diffed to show exactly what changed in `.cursorrules`, `CLAUDE.md`, or a hooks file.
- **Local Restore** — The sync daemon watches those files with `chokidar`, raises a `config_tamper` event, and rewrites the file from the integrity baseline if an agent modifies or deletes it.

::: info Context gap detection is not part of the product
This section previously described orphan-command alerts against Linear/Jira tickets and SOP auto-suggest from untracked tool sequences. Both belonged to the Context Graph, which was removed when the product narrowed to circuit-breaker scope.
:::
