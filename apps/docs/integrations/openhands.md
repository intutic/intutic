# OpenHands

Integrate Intutic governance with [OpenHands](https://github.com/All-Hands-AI/OpenHands) — the open-source AI software developer platform.

## How it works

Intutic writes your SOP text to `.openhands/microagents/intutic-governance.md`, a repository microagent. It has no triggers, so OpenHands adds it to every conversation. It also merges `[llm] base_url` into your project's `config.toml`, pointing OpenHands' model calls at the Intutic proxy, and keeps everything else in that file, including comments. A PreToolUse hook in `.openhands/hooks.json` (`timeout: 10`) blocks a tool call that breaks a rule before it runs. OpenHands runs a call whose hook times out, so the gate refuses on its own after 4 seconds; see [Hook timeouts](/reference/harness-security-matrix#hook-timeouts).

## Setup

### 1. Have an OpenHands project

`intutic init` detects OpenHands when the project has OpenHands' `.openhands/` directory, or a `config.toml` with one of the tables only OpenHands' configuration uses: `[core]`, `[agent]`, `[sandbox]` or `[condenser]`. A `config.toml` without them, such as a Hugo site's, is not taken for OpenHands.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ openhands → .openhands/microagents/intutic-governance.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

The microagent is Intutic's file, rewritten whole on each sync:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file

> **Proxy URL:** `http://localhost:4000`

## Code Review Requirements

All code changes must include unit tests...
```

OpenHands loads microagents from `.openhands/microagents/` in both its V0 runtime and the V1 agent SDK, which reads that directory alongside `.agents/skills/`.

In `config.toml`, `base_url` is set in the `[llm]` table only, in the form the configured model's SDK expects; a `base_url` in another table, such as `[llm.draft_editor]`, is left alone:

```toml
[llm]
base_url = "http://localhost:4000/v1"
model = "gpt-4o"
```

Earlier versions put the SOP text in an `[intutic]` table of `config.toml`, which OpenHands does not read. `intutic connect` removes that table, and so does `intutic disconnect`.

A `config.toml` that is not valid TOML is left untouched and reported in the `intutic connect` log. If `~/.openhands/config.toml` exists, its `[llm] base_url` is pointed at the proxy the same way; Intutic does not create that file.

To undo what `intutic connect` writes here, run `intutic disconnect --harness openhands`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `openhands` |
| Rules file | `.openhands/microagents/intutic-governance.md` |
| Config file | `config.toml` |
| Detection | `.openhands/` in the workspace root, or a `config.toml` with a `[core]`, `[agent]`, `[sandbox]` or `[condenser]` table |
| Format | Markdown microagent with no triggers; TOML, merged: `[llm] base_url` |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
