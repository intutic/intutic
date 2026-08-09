# Codex

Integrate Intutic governance with [OpenAI Codex](https://openai.com/codex) — OpenAI's autonomous coding agent.

## How it works

Codex uses environment variables for configuration. Since Intutic can't inject env vars into a running process, it writes a `.env.intutic` file with proxy URL variables that Codex can source before starting.

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
✓ Detected harnesses:
  • codex → .env.intutic
```

### 3. Source the env file

Before starting Codex, source the generated environment file:

```bash
source .env.intutic
codex
```

### 4. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

A `.env.intutic` file with proxy URLs and metadata:

```bash
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z
# Source this file: source .env.intutic

ANTHROPIC_BASE_URL=http://localhost:4000/v1
OPENAI_BASE_URL=http://localhost:4000/v1
INTUTIC_PROXY_URL=http://localhost:4000/v1
INTUTIC_SOP_COUNT=5
```

::: tip Shell integration
Add `source .env.intutic 2>/dev/null` to your shell profile or project's `.envrc` to auto-load on every session.
:::

## Pre-tool hooks (blocking)

The `.env.intutic` routing above governs LLM egress only. Tool calls are gated
natively: the sync-daemon writes a governance gate at
`.intutic/hooks/codex-check.js` and registers it as a **PreToolUse hook** in
both `~/.codex/hooks.json` (user) and `<repo>/.codex/hooks.json` (project),
merging non-destructively so your own hooks are preserved.

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
| Config file | `.env.intutic` |
| Hook files | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `.intutic/hooks/codex-check.js` |
| Detection | `CODEX_HOME` env var or `codex` in `PATH` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
