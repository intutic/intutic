# Windsurf

Integrate Intutic governance with [Windsurf](https://codeium.com/windsurf) — the AI-native code editor by Codeium.

## How it works

Intutic governs Windsurf in four layers:

- **Rules** — your SOPs in the project's `.windsurfrules`, which Windsurf reads as custom instructions.
- **A blocking gate** — a Cascade hook (`.intutic/hooks/windsurf-check.js`) registered for `pre_run_command`, `pre_write_code` and `pre_mcp_tool_use`. Cascade runs it before each shell command, file write and MCP tool call, and refuses the action when it exits with code 2.
- **Proxy routing** — Windsurf has no base-URL setting for Cascade's own models, so Intutic routes its HTTPS traffic through the proxy, which decrypts it with a local certificate authority (see below).
- **MCP servers** — every server in `~/.codeium/windsurf/mcp_config.json` is wrapped with the Intutic MCP governance proxy.

## Setup

### 1. Ensure .windsurfrules exists

```bash
touch .windsurfrules
```

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ windsurf → .windsurfrules
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Same markdown format as Cursor and Claude Code:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `http://localhost:4000/v1`

## SOP: Code Quality Standards
...
```

### Hooks

The gate is registered in `~/.codeium/windsurf/hooks.json` (Windsurf), `~/.codeium/hooks.json` (the Windsurf plugin for JetBrains IDEs) and the workspace's `.windsurf/hooks.json`. Cascade runs the hooks from every level, so editing the workspace file does not remove the user-level gate. Your own hooks in these files are kept.

### Proxy and certificate

`intutic connect` merges three keys into `~/.codeium/windsurf/settings.json`, keeping everything else in the file:

```json
{
  "http.proxy": "http://127.0.0.1:4000",
  "http.proxyStrictSSL": false,
  "codeium.proxy": "http://127.0.0.1:4000"
}
```

The port is the one the proxy listens on (`PORT`, 4000 by default) — the proxy accepts `CONNECT` tunnels on the same port as its API. On macOS and Windows, `intutic connect` also adds the proxy's certificate authority (`~/.intutic/ca.crt`) to the trusted roots (the login keychain on macOS) so the decrypted connection is trusted.

### JetBrains IDEs

The Windsurf plugin for JetBrains IDEs has no proxy setting of its own; it can only follow the IDE's proxy ("Detect proxy"). So in every installed JetBrains IDE **where the Windsurf plugin has saved its settings**, `intutic connect` turns on the plugin's *Detect proxy* option and sets the IDE's HTTP proxy (**Settings → Appearance & Behavior → System Settings → HTTP Proxy**) to `127.0.0.1:4000`. That IDE proxy applies to all of the IDE's HTTP traffic, not only the plugin's — plugin and update downloads go through the Intutic proxy too. JetBrains IDEs without the Windsurf plugin are not changed. To undo it, switch the IDE back to **No proxy** or **Auto-detect proxy settings**.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `windsurf` |
| Config file | `.windsurfrules` |
| Hook files | `~/.codeium/windsurf/hooks.json`, `~/.codeium/hooks.json`, `.windsurf/hooks.json`, `.intutic/hooks/windsurf-check.js` |
| Proxy settings | `~/.codeium/windsurf/settings.json`; JetBrains IDE proxy where the Windsurf plugin is set up |
| Detection | Checks for `.windsurfrules` in workspace root |
| Format | Markdown (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
