# Intelligence Engine <Badge type="warning" text="Cloud / Team" />

The Intutic Intelligence Engine is an autonomous analysis layer that monitors agent trajectories in the background to automatically identify token waste patterns, suggest optimal rule modifications for developer configurations, and verify security compliance.

## Overview

As AI coding assistants interact with developer workspaces, the Intelligence Engine parses raw trace data, execution patterns, and system tool calls to optimize cost efficiency and maintain strict compliance. Access the Intelligence Engine from the **Intelligence** route in the dashboard sidebar.

---

## Token Waste Patterns

The Intelligence Engine automatically flags inefficient token spend.

### Types of Waste Detected

- **Loop Detection** — Identifies redundant tool invocations (e.g., repeatedly calling `view_file` or `run_command` with identical inputs) where the agent is stuck in an execution cycle.
- **Redundant Context** — Identifies prompts that repeatedly append massive files or logs that have not changed across execution steps.
- **Tool Misuse** — Identifies scenarios where lower-cost tools (e.g., `grep_search` or `list_dir`) could have been used instead of high-token operations.
- **Outlier Cost** — Detects anomalies where a single request consumes an excessive portion of the workspace budget.

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

## Context Gap Detection

Context Gap Detection identifies "unlinked" developer activities where agents execute tasks outside of standard compliance workflows.

### Key Capabilities

- **Orphan Command Alerts** — Flags agent tool executions that are not associated with a ticket (Linear/Jira) or pull request.
- **SOP Auto-Suggest** — Recommends new Standard Operating Procedure guidelines if recurring untracked tool sequences are detected.
- **Drift Identification** — Compares active developer harness states against global governance configurations to flag out-of-sync local policies.
