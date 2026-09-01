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
| **AI coding agent** | Any of the [41 supported harnesses](/integrations/) (Cursor, Claude Code, Aider, Windsurf, Antigravity, etc.) |
| **Valkey** (or Redis) | *Optional.* 8.x — a shared, durable cache. `intutic start` provisions one if it can, and runs without it if it cannot |

That is the whole list. **Valkey is not required**, and neither is a
configuration file — the proxy runs on built-in defaults.

`intutic start` will try to give you a Valkey anyway, because it is worth
having: it makes the response cache shared across processes and lets a control
plane attach later. But if Docker is unavailable or the machine is locked down,
the proxy simply runs standalone. Bandit learning still persists, to
`~/.intutic/bandit-state.json`.

Already have a Valkey elsewhere? Point at it with `VALKEY_URL=redis://host:port`.

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
# 1.6.3
```

::: details Alternative package managers & Standalone Binaries
```bash
# pnpm
pnpm add -g @intutic/cli @intutic/proxy

# yarn
yarn global add @intutic/cli @intutic/proxy
```

For environments without Node.js, download single-file precompiled binaries directly from [GitHub Releases](https://github.com/intutic/intutic/releases/latest):
* 🪟 Windows (x64): `cli-win-x64.exe`
* 🐧 Linux (x64): `cli-linux-x64`
* 🍎 macOS (Apple Silicon): `cli-macos-arm64` / `intutic-proxy-darwin-arm64`
* 💻 macOS (Intel): `cli-macos-x64`
:::

## Step 2 — Log in <Badge type="tip" text="Connected mode only" />

::: tip Running open core standalone? Skip to [Step 4](#step-4-start-the-proxy).
`login` and `init` register you with a **control plane**, which open core does
not include. Standalone needs neither — `intutic start` runs the proxy with no
account at all.
:::

```bash
intutic login
```

You'll be prompted for your email and password. On success:

```
╭─ Intutic — Authentication ─╮
Control plane: https://your-control-plane.example

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

If no Valkey can be started — no Docker, no `valkey-server` on your PATH — the
proxy runs anyway:

```
⚠ Could not start Valkey — running standalone.
ℹ Routing, policies, DLP and local spend caps all work.
ℹ Bandit learning persists to ~/.intutic; the response cache is per-process.
ℹ Starting proxy on port 4000 (standalone)…
INFO intutic_proxy: Listening on 0.0.0.0:4000
```

DLP scanning, WASM rule enforcement, policy evaluation and intelligent routing
all run locally either way. What Valkey adds is a response cache shared between
processes, and the ability for a control plane to attach.

::: details What standalone gives up
Nothing that requires a control plane was ever available in open core, so
standalone loses only:

- **A shared response cache.** Each proxy process caches for itself.
- **Cross-process bandit state.** Learning still persists across restarts via
  `~/.intutic/bandit-state.json`, but two proxies on one machine learn
  separately rather than pooling.

Provider credentials are held in memory only and never written to disk in
either mode.
:::

::: details Running the proxy yourself
`intutic start` is a convenience wrapper. To manage Valkey yourself, run the
proxy directly — it needs no configuration file:

```bash
intutic-proxy
```

Force standalone even when a Valkey is running:

```bash
INTUTIC_STANDALONE=1 intutic-proxy
```
:::

::: warning `intutic connect` is not this
`intutic connect` starts the **sync daemon**, which mirrors governance config
with a control plane. Open core does not include one, so that command will ask
you to authenticate against an account you have no way to create. Use it only if
you are running a control plane yourself.
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

::: warning Connected mode requires Valkey
This is the one case where Valkey is not optional. It holds the auth and budget
cache the control plane writes, so a managed proxy that could not reach it would
have no way to validate a virtual key — and rather than let requests through
unauthenticated, the proxy refuses to start.

Standalone has no such cache to lose, which is why `intutic start` degrades
happily and `intutic connect` does not.
:::

### Attaching a control plane

Nothing to migrate and nothing to rewrite. `intutic connect` sets
`CONTROL_PLANE_URL`, and from that point the control plane is authoritative:

| | Standalone | Connected |
|---|---|---|
| Bandit arm state | `~/.intutic/bandit-state.json` | `bandit:{workspaceId}` in Valkey |
| Who updates arms | this proxy, deterministically | the control plane's judge, if it claims the workspace |
| Feature flags | `config.yaml` | control plane, authoritative |
| Auth & budgets | local daily spend cap | workspace virtual keys and budgets |

Arm state carries over rather than resetting: the update rule is the same in
both modes, and the two representations agree within `1e-12`. A workspace that
learned standalone keeps that learning when a control plane takes over, and the
control plane signals the handover by setting the workspace's reward mode to
`cloud`, at which point the local loop stands down within 60 seconds.

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
| [**Integrations**](/integrations/) | Detailed setup guides for all 41 harnesses |
| [**CLI Reference**](/reference/cli) | Complete command reference for `@intutic/cli` |
