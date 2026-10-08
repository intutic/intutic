# Codex

Integrate Intutic governance with [OpenAI Codex](https://openai.com/codex) — OpenAI's autonomous coding agent.

## How it works

`intutic connect` governs Codex in two ways:

- **Proxy routing** — it sets `openai_base_url` in Codex's user config, `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), so Codex's built-in OpenAI provider sends its requests through the proxy. It also writes a `.env.intutic` file with the same proxy URLs for shells and scripts that source it.
- **A blocking gate** — a PreToolUse hook registered in `~/.codex/hooks.json` and the project's `.codex/hooks.json` (see [Pre-tool hooks](#pre-tool-hooks-blocking) below).

## Setup

### 1. Codex detection

Codex is detected by either:
- The `CODEX_HOME` environment variable being set, **or**
- The `codex` binary being found in your `PATH`

No config file needs to exist beforehand.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ codex → .env.intutic
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Run Codex

Once `intutic connect` has synced, start Codex as usual — `~/.codex/config.toml` already points it at the proxy:

```bash
codex
```

### 4. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

`openai_base_url` in Codex's user config. `intutic connect` adds or updates this one top-level line and keeps the rest of the file — MCP servers, profiles, model settings and comments — exactly as it was; a config that does not parse as TOML is left untouched:

```toml
# Set by Intutic: routes Codex's built-in OpenAI provider through the Intutic proxy.
openai_base_url = "http://localhost:4000/v1"

[mcp_servers.github]
command = "npx"
```

`openai_base_url` applies to Codex's built-in `openai` provider. If you select a custom provider with `model_provider`, set that provider's `base_url` to `http://localhost:4000/v1` yourself.

A `.env.intutic` file with proxy URLs and metadata:

```bash
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z
# Source this file: source .env.intutic

export ANTHROPIC_BASE_URL="http://localhost:4000"
export OPENAI_BASE_URL="http://localhost:4000/v1"
export INTUTIC_PROXY_URL="http://localhost:4000"
INTUTIC_SOP_COUNT=5
```

::: tip Shell integration
Add `source .env.intutic 2>/dev/null` to your shell profile or project's `.envrc` to auto-load on every session.
:::

## Pre-tool hooks (blocking)

The routing above governs LLM egress only. Tool calls are gated
natively: `intutic connect` writes a governance gate at
`.intutic/hooks/codex-check.js` and registers it as a **PreToolUse hook** in
both `~/.codex/hooks.json` (user) and `<repo>/.codex/hooks.json` (project),
merging non-destructively so your own hooks are preserved.

Codex loads hooks by default (`[features] hooks = false` turns them off). It loads the project-level file only once you have trusted the project's `.codex/` folder; the user-level registration applies everywhere.

Codex invokes the hook before each tool call with JSON on stdin
(`{tool_name, tool_use_id, tool_input}`); the gate evaluates the compiled
protection floor plus your workspace's policy snapshot — including ` WHERE `
(argPattern) rules matched against the serialized tool input — and refuses
with exit code 2, with the reason on stderr. Every decision is appended to
`.intutic/events/hook-events.jsonl` and drained to the control plane.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `codex` |
| Config file | `.env.intutic`, `~/.codex/config.toml` (`openai_base_url`) |
| Hook files | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `.intutic/hooks/codex-check.js` |
| Detection | `CODEX_HOME` env var or `codex` in `PATH` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
