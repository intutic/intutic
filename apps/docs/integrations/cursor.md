# Cursor

Integrate Intutic governance with [Cursor](https://cursor.sh) — the AI-powered code editor.

## How it works

Intutic governs Cursor in three layers:

- **Rules** — your SOPs in `.cursor/rules/intutic-governance.mdc`, a project rule with `alwaysApply: true`, which Cursor adds to every request. Your own rules stay in other files in `.cursor/rules/`.
- **A blocking gate** — `.intutic/hooks/cursor-check.js`, registered in Cursor's hooks for `beforeShellExecution` (every shell command), `beforeMCPExecution` (every MCP tool call) and `preToolUse` with the matcher `Write|Delete` (file writes and deletions). It refuses with exit code 2, and is registered with `timeout: 10` and `failClosed: true`, so a gate that crashes or times out blocks the call too. The gate refuses on its own after 9 seconds.
- **MCP servers** — every server in `.cursor/mcp.json` and in Cursor's global settings is wrapped with the Intutic MCP governance proxy.

## Setup

### 1. Check that Cursor is detected

`intutic init` detects Cursor from a `.cursor/` directory or a `.cursorrules` file in the project, or from `~/.cursor`, which installing Cursor creates. There is usually nothing to do.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ cursor → .cursor/rules/intutic-governance.mdc
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

`.cursor/rules/intutic-governance.mdc`, written when at least one SOP targets Cursor:

```markdown
---
description: Intutic governance rules
alwaysApply: true
---

# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file

> **Proxy URL:** `http://localhost:4000`

## Code Review Requirements

All code changes must include unit tests...

---

## Security Policy

Never commit secrets or API keys...
```

The file is Intutic's own and is replaced on each sync; keep your own rules in other files in `.cursor/rules/`, or as SOP files in `.intutic/sops/` (see [SOP Front Matter](/reference/sop-front-matter)). Earlier versions overwrote `.cursorrules` whole; the first sync with this version gives you your own copy of it back. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

### Hooks

The gate is merged into `.cursor/hooks.json` (project) and `~/.cursor/hooks.json` (user); your own hooks in those files are kept:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "node \"/path/to/project/.intutic/hooks/cursor-check.js\"", "timeout": 10, "failClosed": true }],
    "beforeMCPExecution": [{ "command": "node \"/path/to/project/.intutic/hooks/cursor-check.js\"", "timeout": 10, "failClosed": true }],
    "preToolUse": [{ "command": "node \"/path/to/project/.intutic/hooks/cursor-check.js\"", "matcher": "Write|Delete", "timeout": 10, "failClosed": true }]
  }
}
```

A machine-wide copy (`/Library/Application Support/Cursor/hooks.json` on macOS, `/etc/cursor/hooks.json` on Linux) is written only by `intutic enterprise install`, which needs administrator rights.

### Proxy routing

Set Cursor's **OpenAI Base URL** override (Settings → Models) to `http://localhost:4000/v1` to send requests for your own API keys through the proxy. Cursor's built-in models are served from Cursor's backend and do not use this setting.

To undo what `intutic connect` writes here, run `intutic disconnect --harness cursor`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `cursor` |
| Rules file | `.cursor/rules/intutic-governance.mdc` |
| Hook files | `.cursor/hooks.json`, `~/.cursor/hooks.json`, `.intutic/hooks/cursor-check.js` |
| Detection | `.cursor/` or `.cursorrules` in the workspace root, or `~/.cursor` |
| Format | Markdown with `alwaysApply: true` front matter (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
