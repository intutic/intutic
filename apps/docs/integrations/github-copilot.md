# GitHub Copilot

Integrate Intutic governance with [GitHub Copilot](https://github.com/features/copilot) — the AI pair programmer.

## How it works

Intutic monitors and modifies `.github/copilot-instructions.md` config in your workspace root. It writes active SOP governance rules as repository-specific instructions. GitHub Copilot automatically loads these instructions for chat queries and inline completions, ensuring recommendations align with your guidelines.

## Setup

### 1. Initialize Intutic

```bash
npx @intutic/cli init
```

The CLI detects GitHub Copilot presence (via `.git` or `.github` folders) and registers it as a harness:

```
✓ Detected harnesses:
  • github-copilot -> .github/copilot-instructions.md
```

### 2. Start sync

```bash
npx @intutic/cli connect
```

## What gets written

Intutic writes rules and configures:
* **Instructions File:** `.github/copilot-instructions.md` containing formatted markdown of all active rules and the proxy URL reference.
* **Agent-mode hook (Preview):** `.github/hooks/intutic-governance.json` (workspace) and `~/.copilot/hooks/intutic-governance.json` (user), registering the blocking gate `.intutic/hooks/github-copilot-check.js`.

## Pre-tool hooks (Preview)

::: warning Preview feature
VS Code agent hooks are a **Preview** mechanism and the format may change
between releases. The generated gate fails **closed**: a stdin payload it does
not recognise is refused (exit 2) rather than silently allowed, so a format
shift surfaces as loud blocks — re-run `intutic sync` after upgrading.
:::

In agent mode, Copilot fires the PreToolUse hook before each tool call with
JSON on stdin (`{session_id, cwd, hook_event_name, tool_name, tool_input,
tool_use_id}`). The gate evaluates the compiled protection floor plus your
policy snapshot — including ` WHERE ` (argPattern) rules matched against the
serialized tool input — and refuses with exit code 2 (a
`"permissionDecision": "deny"` from any hook also wins). The instructions file
remains in place as an advisory layer; the hook is what enforces.
