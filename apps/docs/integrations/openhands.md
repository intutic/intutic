# OpenHands

Integrate Intutic governance with [OpenHands](https://github.com/All-Hands-AI/OpenHands) — the open-source AI software developer platform.

## How it works

Intutic merges two things into your project's `config.toml`, which OpenHands reads for configuration: `[llm] base_url`, pointing OpenHands' model calls at the Intutic proxy, and an `[intutic]` table with the proxy URL and your SOP text. Everything else in the file, including comments, is kept. It also writes a PreToolUse hook to `.openhands/hooks.json`, which blocks a tool call that breaks a rule before it runs.

## Setup

### 1. Have an OpenHands project

`intutic init` detects OpenHands when the project has OpenHands' `.openhands/` directory, or a `config.toml` with one of the tables only OpenHands' configuration uses: `[core]`, `[agent]`, `[sandbox]` or `[condenser]`. A `config.toml` without them, such as a Hugo site's, is not taken for OpenHands.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ openhands → config.toml
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

In `config.toml`, `base_url` is set in the `[llm]` table only, in the form the configured model's SDK expects; a `base_url` in another table, such as `[llm.draft_editor]`, is left alone. The `[intutic]` table is replaced whole on each sync:

```toml
[llm]
base_url = "http://localhost:4000/v1"
model = "gpt-4o"

[intutic]
proxy_url = "http://localhost:4000"
instructions = """
## Code Review Requirements

All code changes must include unit tests...
"""
```

A `config.toml` that is not valid TOML is left untouched and reported in the `intutic connect` log. If `~/.openhands/config.toml` exists, its `[llm] base_url` is pointed at the proxy the same way; Intutic does not create that file.

To undo what `intutic connect` writes here, run `intutic disconnect --harness openhands`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `openhands` |
| Config file | `config.toml` |
| Detection | `.openhands/` in the workspace root, or a `config.toml` with a `[core]`, `[agent]`, `[sandbox]` or `[condenser]` table |
| Format | TOML, merged: `[llm] base_url` and an `[intutic]` table with `proxy_url` and `instructions` |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
