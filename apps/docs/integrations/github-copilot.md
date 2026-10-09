# GitHub Copilot

Integrate Intutic governance with [GitHub Copilot](https://github.com/features/copilot) — the AI pair programmer.

## How it works

Intutic writes active SOP governance rules into a marked section of `.github/copilot-instructions.md`, Copilot's repository-specific instructions file. Your own instructions in the file are kept. GitHub Copilot automatically loads these instructions for chat queries and inline completions, ensuring recommendations align with your guidelines. In VS Code agent mode it also installs a PreToolUse hook that refuses tool calls breaking a rule — see [Pre-tool hooks](#pre-tool-hooks-preview).

## Setup

### 1. Initialize Intutic

```bash
npx @intutic/cli init
```

The CLI detects GitHub Copilot presence (via `.git` or `.github` folders) and registers it as a harness:

```
  ✔ github-copilot → .github/copilot-instructions.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start sync

```bash
npx @intutic/cli connect
```

## What gets written

Intutic writes rules and configures:
* **Instructions:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in `.github/copilot-instructions.md`, holding the active rules and the proxy URL reference. The file is created if it does not exist; nothing outside the markers is changed. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
* **Agent-mode hook (Preview):** `.github/hooks/intutic-governance.json` (workspace) and `~/.copilot/hooks/intutic-governance.json` (user), registering the blocking gate `.intutic/hooks/github-copilot-check.js`. The Intutic gate refuses an agent tool call that names either hook file, and the sync daemon writes one back if it is deleted or loses the gate.

To undo what `intutic connect` writes here, run `intutic disconnect --harness github-copilot`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `.github/copilot-instructions.md` only the marked section is taken out. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Pre-tool hooks (Preview)

::: warning Preview feature
VS Code agent hooks are a **Preview** mechanism and the format may change
between releases. The generated gate fails **closed**: a stdin payload it does
not recognise is refused (exit 2) rather than silently allowed, so a format
shift surfaces as loud blocks — restart `intutic connect` after upgrading so it rewrites the gate.
:::

In agent mode, Copilot fires the PreToolUse hook before each tool call with
JSON on stdin (`{session_id, cwd, hook_event_name, tool_name, tool_input,
tool_use_id}`). The gate evaluates the compiled protection floor plus your
policy snapshot — including ` WHERE ` (argPattern) rules matched against the
serialized tool input — and refuses with exit code 2 (a
`"permissionDecision": "deny"` from any hook also wins). The instructions file
remains in place as an advisory layer; the hook is what enforces.
