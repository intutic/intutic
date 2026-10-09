# Windsurf

Integrate Intutic governance with [Windsurf](https://codeium.com/windsurf) — the AI-native code editor by Codeium.

## How it works

Intutic governs Windsurf in four layers:

- **Rules** — your SOPs in `.windsurf/rules/intutic-governance.md`, a workspace rule with `trigger: always_on`, which Cascade includes in every message. Your own rules stay in other files in `.windsurf/rules/`.
- **A blocking gate** — a Cascade hook (`.intutic/hooks/windsurf-check.js`) registered for `pre_run_command`, `pre_write_code` and `pre_mcp_tool_use`. Cascade runs it before each shell command, file write and MCP tool call, and refuses the action when it exits with code 2.
- **Proxy routing** — Windsurf has no base-URL setting for Cascade's own models, so Intutic routes its HTTPS traffic through the proxy, which decrypts it with a local certificate authority (see below).
- **MCP servers** — every server in `~/.codeium/windsurf/mcp_config.json` is wrapped with the Intutic MCP governance proxy.

## Setup

### 1. Check that Windsurf is detected

`intutic init` detects Windsurf from a `.windsurf/` directory or a `.windsurfrules` file in the project, or from `~/.codeium/windsurf`. There is usually nothing to do.

### 2. Initialize Intutic

```bash
intutic init
```

```
  ✔ windsurf → .windsurf/rules/intutic-governance.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

`.windsurf/rules/intutic-governance.md`, written when at least one SOP targets Windsurf:

```markdown
---
trigger: always_on
---

# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file

> **Proxy URL:** `http://localhost:4000`

## Code Quality Standards
...
```

Windsurf reads at most 12,000 characters of a rule file. The file is Intutic's own and is replaced on each sync. Earlier versions overwrote `.windsurfrules` whole; the first sync with this version gives you your own copy of it back. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

### Hooks

The gate is registered in `~/.codeium/windsurf/hooks.json` (Windsurf), `~/.codeium/hooks.json` (the Windsurf plugin for JetBrains IDEs) and the workspace's `.windsurf/hooks.json`. Cascade runs the hooks from every level, so editing the workspace file does not remove the user-level gate. Your own hooks in these files are kept.

### Proxy and certificate

`intutic connect` merges three keys into Windsurf's user `settings.json`, keeping everything else in the file. Windsurf keeps it where VS Code keeps its own, under the Windsurf name:

| OS | User settings file |
|----|--------------------|
| macOS | `~/Library/Application Support/Windsurf/User/settings.json` |
| Linux | `~/.config/Windsurf/User/settings.json` (or under `$XDG_CONFIG_HOME`) |
| Windows | `%APPDATA%\Windsurf\User\settings.json` |

A settings file with comments or trailing commas is not plain JSON; it is left untouched and reported in the `intutic connect` log.


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

To undo what `intutic connect` writes here, run `intutic disconnect --harness windsurf`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `windsurf` |
| Rules file | `.windsurf/rules/intutic-governance.md` |
| Hook files | `~/.codeium/windsurf/hooks.json`, `~/.codeium/hooks.json`, `.windsurf/hooks.json`, `.intutic/hooks/windsurf-check.js` |
| Proxy settings | Windsurf's user `settings.json` (see [Proxy and certificate](#proxy-and-certificate)); JetBrains IDE proxy where the Windsurf plugin is set up |
| Detection | `.windsurf/` or `.windsurfrules` in the workspace root, or `~/.codeium/windsurf` |
| Format | Markdown with `trigger: always_on` front matter (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
