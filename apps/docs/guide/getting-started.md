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
                   │ WASM Policy  │
                   │   Engine     │
                   └──────────────┘
                    (all local — no
                     network egress)
```

Everything above runs on your machine. A control plane is **optional** and not
part of open core; see [Security](/security) for what changes if you connect one.

Every LLM request from your AI agent flows through Intutic's local proxy,
where SOPs (Standard Operating Procedures) evaluate each tool call in
real time and return one of four verdicts: **BYPASS**, **ENHANCE**, **HIJACK**, or **KILL**.

## Prerequisites

| Requirement | Version |
|---|---|
| **Node.js** | 18 or later |
| **npm** | 10 or later |
| **Valkey** (or Redis) | 8.x — the proxy's policy cache and telemetry store |
| **AI coding agent** | Any of the [18 supported harnesses](/integrations/) (Cursor, Claude Code, Aider, Windsurf, Antigravity, etc.) |

The proxy needs Valkey running before it will start. If you do not already have
one:

```bash
docker run -d --name intutic-valkey -p 6379:6379 valkey/valkey:8-alpine
```

Point elsewhere with `VALKEY_URL=redis://host:port`. No configuration file is
required — the proxy runs on built-in defaults unless you supply one.

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
# 1.6.2
```

::: details Alternative package managers & Standalone Binaries
```bash
# pnpm
pnpm add -g @intutic/cli @intutic/proxy

# yarn
yarn global add @intutic/cli @intutic/proxy
```

For environments without Node.js, download single-file precompiled binaries directly from [GitHub Releases v1.6.0](https://github.com/intutic/intutic/releases/tag/v1.6.0):
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
  Workspace: wk_k8x9m2p4
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
If you are running a control plane of your own, point at it with `--dev`:
```bash
intutic login --dev
```
This uses `http://localhost:3001` instead of the hosted API. Open core does not
include a control plane, so this is only useful if you are supplying one — the
proxy itself needs no login and runs standalone without either.
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

## Step 4 — Start the proxy

### Standalone (open core)

One command. No account, no configuration file, nothing leaving your machine:

```bash
intutic start
```

```
ℹ No Valkey detected on port 6379. Trying to start one…
ℹ Docker detected — starting a Valkey container (intutic-valkey)…
✔ Valkey running in Docker (intutic-valkey) on port 6379.
ℹ Starting proxy on port 4000…
INFO intutic_proxy: Listening on 0.0.0.0:4000
```

`start` finds a Valkey for you — an existing one on 6379, else Docker, else
`valkey-server` or `redis-server` on your PATH — and then runs the proxy. If none
of those are available it tells you exactly what to install.

DLP scanning, WASM rule enforcement and policy evaluation all run locally
against that Valkey.

::: details Running the proxy yourself
`intutic start` is a convenience wrapper. To manage Valkey yourself, run the
proxy directly — it needs no configuration file:

```bash
intutic-proxy
```
:::

::: warning `intutic connect` is not this
`intutic connect` starts the **sync daemon**, which mirrors governance config
with a control plane. Open core does not include one, so that command will ask
you to authenticate against an account you have no way to create. Use it only if
you are running a control plane yourself, or on Intutic Cloud.
:::

### Connected (Cloud / self-hosted control plane)

With a control plane available, `intutic connect` additionally opens a WebSocket
for live policy updates and watches your harness configs for drift:

```bash
intutic connect
```

```
✓ Connected to workspace: my-team (wk_wR1ePE40kLNAneONnIumE)
✓ Proxy running: http://localhost:4000
✓ Sync daemon active: listening for harness changes
✓ Governance policy: 14 active SOPs, WASM hot-reload ready
```

### 3. Route Your Agent

Set your agent's base URL environment variable to point at the local Intutic proxy:

```bash
# Host only — the Anthropic SDK and Claude Code append /v1/messages themselves.
# Adding /v1 here produces /v1/v1/messages, which the proxy cannot route.
export ANTHROPIC_BASE_URL="http://localhost:4000"
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
  Auth: ✔ you@company.com (wk_k8x9m2p4)
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
