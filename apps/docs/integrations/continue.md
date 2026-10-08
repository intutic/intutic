# Continue

Integrate Intutic governance with [Continue](https://continue.dev) — the open-source autopilot for VS Code and JetBrains.

## How it works

Intutic points Continue's OpenAI and Anthropic models at the proxy by setting their `apiBase` in `~/.continue/config.yaml`, and installs a PreToolUse gate for the Continue CLI (`cn`). Everything else in your config — other models, context providers, comments — is kept.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Continue and registers it as a harness:

```
  ✔ continue → ~/.continue/config.yaml
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

* **`~/.continue/config.yaml`:** `apiBase: http://localhost:4000/v1/` on each model whose `provider` is `openai` or `anthropic`. Models from other providers (Ollama, Gemini, …) are left alone — the proxy does not serve their APIs. A config with no such model, or one that does not parse, is left untouched and reported in the `intutic connect` log. Intutic does not set `apiKey`; keep your own.
* **`~/.continue/settings.json` and `<repo>/.continue/settings.json`:** the CLI gate registration (below).

To undo what `intutic connect` writes here, run `intutic disconnect --harness continue`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

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
