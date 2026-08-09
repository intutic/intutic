# Continue

Integrate Intutic governance with [Continue](https://continue.dev) — the open-source autopilot for VS Code and JetBrains.

## How it works

Intutic writes configuration rules directly into your `~/.continue/config.json` file. It merges the gateway models, system rules, and proxy settings into the existing configurations while preserving user-defined fields.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Continue and registers it as a harness:

```
✓ Detected harnesses:
  • continue -> ~/.continue/config.json
```

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic updates `~/.continue/config.json` to insert:
* **Models:** Sets `apiBase` to `http://localhost:4000/v1` and injects `apiKey`.
* **System Instructions:** Custom governance prompts injected as default system messages.

## Pre-tool hooks (Continue CLI only)

The Continue **CLI** (`cn`) executes PreToolUse hooks; the IDE extension does
not. The sync-daemon writes a blocking gate at
`.intutic/hooks/continue-check.js` and registers it in
`~/.continue/settings.json` (user) and `<repo>/.continue/settings.json`
(project), preserving any hooks you registered yourself.

The stdin contract is Claude-Code-compatible (`{tool_name, tool_input,
tool_use_id}`) and the gate refuses with exit code 2. It enforces the
compiled protection floor and your policy snapshot, including ` WHERE `
(argPattern) rules against the serialized tool input.

::: tip Overlap with Claude Code
The Continue CLI also reads `.claude/settings.json`, so on a machine governed
for Claude Code, `cn` may already run that gate. The dedicated registration in
Continue's own settings makes governance deliberate — and covers machines that
run Continue without Claude Code, which would otherwise have no gate at all.
Both gates evaluate the same rules, so the overlap is harmless.
:::
