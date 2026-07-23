---
title: Getting Started
description: Install Intutic, connect your AI agent, and see your first governed trace in under 5 minutes.
---

# Getting Started <Badge type="tip" text="Open-Core" />

Go from zero to your first blocked tool call in under 5 minutes.

```
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Your IDE /  │───▶│ Intutic      │───▶│  LLM Provider    │
│  AI Agent    │◀───│ Proxy :4000  │◀───│  (OpenAI, etc.)  │
└─────────────┘    └──────┬───────┘    └──────────────────┘
                          │
                   ┌──────▼───────┐
                   │ Control Plane│
                   │    :3001     │
                   └──────────────┘
```

Every LLM request from your AI agent flows through Intutic's local proxy,
where SOPs (Standard Operating Procedures) evaluate each tool call in
real time and return one of four verdicts: **BYPASS**, **ENHANCE**, **HIJACK**, or **KILL**.

## Prerequisites

| Requirement | Version |
|---|---|
| **Node.js** | 18 or later |
| **npm** | 10 or later |
| **AI coding agent** | Any of the [18 supported harnesses](/integrations/) (Cursor, Claude Code, Aider, Windsurf, Antigravity, etc.) |

## Step 1 — Install the CLI & Native Proxy Gateway

```bash
# Install global CLI and native Rust proxy binary
npm install -g @intutic/cli @intutic/proxy

# Or run the native proxy directly on-demand
npx @intutic/proxy
```

Verify:

```bash
intutic --version
# @intutic/cli 1.5.0
```

::: details Alternative package managers & Standalone Binaries
```bash
# pnpm
pnpm add -g @intutic/cli @intutic/proxy

# yarn
yarn global add @intutic/cli @intutic/proxy
```

For environments without Node.js, download single-file precompiled binaries directly from [GitHub Releases v1.5.0](https://github.com/intutic/intutic/releases/tag/v1.5.0):
* 🪟 Windows (x64): `cli-win-x64.exe`
* 🐧 Linux (x64): `cli-linux-x64`
* 🍎 macOS (Apple Silicon): `cli-macos-arm64` / `intutic-proxy-darwin-arm64`
* 💻 macOS (Intel): `cli-macos-x64`
:::

## Step 2 — Log in

```bash
intutic login
```

You'll be prompted for your email and password. On success:

```
╭─ Intutic — Authentication ─╮
Control plane: https://api.intutic.ai

✔ Authenticated as you@company.com
  Workspace: ws_k8x9m2p4
  Role: admin
```

Your credentials are stored at `~/.intutic/credentials.json` (mode `0600`),
with the API key backed by your system keychain when available.

::: tip API key authentication
For CI or headless environments, authenticate with an API key (must start with `vk_`):
```bash
intutic login --api-key vk_your_key_here
```
:::

::: details Local development
Point at a local control plane with `--dev`:
```bash
intutic login --dev
```
This uses `http://localhost:3001` instead of the hosted API.
:::

## Step 3 — Initialize your workspace

From your project root (must contain a `.git/` directory or `package.json`):

```bash
intutic init
```

This auto-detects every AI harness in your project and writes a local
config file at `~/.intutic/config.json`.

```
╭─ Intutic — Workspace Initialization ─╮
✔ Workspace root: /home/dev/my-project

Detecting AI harnesses...

  ✔ cursor       → .cursorrules
  ✔ claude-code  → CLAUDE.md
  ○ windsurf     (not detected)
  ○ aider        (not detected)
  ...

✔ Detected 2 harnesses
✔ Authenticated as you@company.com

Would you like to install Git sync hooks (post-commit, post-checkout)? [Y/n]:
✔ Workspace initialized.
```

::: details Local development
Register against a local control plane:
```bash
intutic init --dev
```
:::

## Step 4 — Connect and start the daemon

Start the sync daemon:

```bash
intutic connect
```

This starts the Intutic Rust proxy on port 4000, opens a WebSocket for
real-time policy updates, and discovers all local agent tools.

You'll see confirmation:

```
✓ Connected to workspace: my-team (ws_wR1ePE40kLNAneONnIumE)
✓ Proxy running: http://localhost:4000
✓ Sync daemon active: listening for harness changes
✓ Governance policy: 14 active SOPs, WASM hot-reload ready
```

### 3. Route Your Agent

Set your agent's base URL environment variable to point at the local Intutic proxy:

```bash
export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
```

Now, every LLM API call and tool execution is evaluated pre-flight.

---

## 🛠️ Under the Hood

When you run `intutic connect`, Intutic:

1. Spawns the **Intutic Rust proxy** on port 4000 — all LLM traffic routes through it
2. Opens a **WebSocket** for real-time config updates from the control plane
3. Watches the **filesystem** for harness config drift — auto-reverts unauthorized changes
4. Runs a **30-second poll loop** as a secondary fallback (configurable with `--interval`)
5. Syncs any **offline traces** accumulated while the daemon was stopped
6. Writes harness-specific config (e.g., `.cursor/rules/intutic.mdc` for Cursor, pre-tool-use hooks for Claude Code)

::: tip Background options
```bash
intutic connect --interval 10000   # 10-second poll interval
intutic connect --dev              # Local control plane
```
For a persistent system service that starts on login, see [`intutic daemon install`](/reference/cli).
:::

## Step 5 — Trigger your first block

Open your AI agent and ask it to do something a default SOP would catch:

> _"Delete all files in /tmp"_

The proxy intercepts the tool call, evaluates it against your SOPs,
and returns a **KILL** verdict — the destructive action never executes.

```
┌─────────────────────────────────────────────────────┐
│  KILL — SOP: filesystem-safety                      │
│                                                     │
│  Blocked: rm -rf /tmp/*                             │
│  Reason: Recursive deletion outside project root    │
│          is prohibited by filesystem-safety SOP.    │
│                                                     │
│  Session: ses_7x2k9m    Trace: tr_p4n8q1            │
└─────────────────────────────────────────────────────┘
```

## Step 6 — View your trace

Check the trace from the command line:

```bash
intutic traces list --limit 5
```

```
ID           Harness       Timestamp             Tool Calls  Verdicts           Status
tr_p4n8q1    cursor        2026-07-04 07:30:01   1           KILL: 1            blocked
tr_m3k7n2    cursor        2026-07-04 07:28:44   3           BYPASS: 3          complete
```

Drill into the blocked trace:

```bash
intutic traces inspect tr_p4n8q1
```

Or check your full system status in another terminal:

```bash
intutic status
```

```
╭─ Intutic — Workspace Status ─╮
  Auth: ✔ you@company.com (ws_k8x9m2p4)
  Workspace root: /home/dev/my-project
  Harnesses: cursor ✔, claude-code ✔
  Daemon: running (PID 48291)
  Last sync: 12s ago
  SOPs: 5 active
```

## What's next?

| Topic | Description |
|---|---|
| [**How It Works**](/guide/how-it-works) | Understand the proxy → policy engine → verdict pipeline |
| [**Enforcement Actions**](/concepts/enforcement-actions) | Deep dive into BYPASS, ENHANCE, HIJACK, and KILL |
| [**Custom Filters (WASM)**](/external/wasm-rules) | Create WASM policy rules for custom tool-call filtering |
| [**Integrations**](/integrations/) | Detailed setup guides for all 18 harnesses |
| [**CLI Reference**](/reference/cli) | Complete command reference for `@intutic/cli` |
