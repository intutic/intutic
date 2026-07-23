# Cline

Integrate Intutic governance with [Cline](https://github.com/cline/cline) — the VS Code extension for autonomous agentic coding.

## How it works

Intutic writes governance rules into `.cline/hooks/hooks.json` inside your project root, which Cline executes prior to executing tools (PreToolUse hooks). If a policy is violated, the hook returns exit code 2 to block the tool execution. Governance text rules are written separately as the `.clinerules` flat file.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Cline and registers it as a harness:

```
✓ Detected harnesses:
  • cline -> .cline/hooks/hooks.json
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic generates the Cline PreToolUse hook configuration and hook scripts:
* **Config file:** `.cline/hooks/hooks.json`
* **Rules file:** `.clinerules` (flat file with governance SOP text)
* **Hook script:** `.cline/hooks/intutic-check.js` (referenced by `hooks.json` to inspect shell commands, file edits, and MCP tool calls)

## Proxy routing

To route Cline's LLM requests through the local proxy:
1. Open the Cline panel in VS Code.
2. Click the gear icon to open Settings.
3. Set **API Provider** to `OpenAI Compatible`.
4. Set **Base URL** to `http://localhost:4000/v1`.
5. Enter your Intutic API Key.
