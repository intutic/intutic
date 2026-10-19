---
title: Getting Started
description: Install Intutic, connect your AI agent, and see your first governed trace in under 5 minutes.
---

# Getting Started <Badge type="tip" text="Open-Core" />

Go from zero to your first blocked tool call in under 5 minutes.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Your IDE /  │───▶│ Intutic      │───▶│  LLM Provider    │
│  AI Agent    │◀───│ Proxy :4000  │◀───│  (OpenAI, etc.)  │
└──────┬───────┘    └──────┬───────┘    └──────────────────┘
       │ each              │
       │ tool call  ┌──────▼──────────────────────┐
┌──────▼───────┐    │ Policy: SOP front matter,   │
│  Hook gate   │    │ WASM rules, DLP, detectors  │
│  (Step 3)    │    └─────────────────────────────┘
└──────────────┘
  (all local; a decide engine, if you add one,
   is your own model on this machine or your network)
```

Everything above runs on your machine. A control plane is **optional** and not
part of open core; see [Security](/security) for what changes if you connect one.

Every LLM request from your AI agent flows through Intutic's local proxy,
where SOPs (Standard Operating Procedures) evaluate each tool call in
real time and return a verdict: **BYPASS**, **HIJACK**, **REASK** or **KILL** from the proxy, or **ENHANCE** from a control plane's evaluator.

## Prerequisites

| Requirement | Version |
|---|---|
| **Node.js** | 20.19 or later |
| **npm** | 10 or later |
| **AI coding agent** | Any of the [43 supported harnesses](/integrations/) (Cursor, Claude Code, Aider, Windsurf, Antigravity, etc.) |
| **Valkey** (or Redis) | *Optional.* 8.x — a shared, durable cache. `intutic start` provisions one if it can, and runs without it if it cannot |

That is the whole list. **Valkey is not required**, and neither is a
configuration file — the proxy runs on built-in defaults.

`intutic start` will try to give you a Valkey anyway, because it is worth
having: it makes the response cache shared across processes and lets a control
plane attach later. But if Docker is unavailable or the machine is locked down,
the proxy simply runs standalone. Bandit learning still persists, to
`~/.intutic/bandit-state.json`.

With or without Valkey, a proxy with no control plane accepts the same keys:
your provider key, which it forwards, or an Intutic virtual key, for which it
uses the provider key in its own environment.

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
```

It prints the installed version number.

::: details Alternative package managers & Standalone Binaries
```bash
# pnpm
pnpm add -g @intutic/cli @intutic/proxy

# yarn
yarn global add @intutic/cli @intutic/proxy
```

For environments without Node.js, download single-file precompiled binaries directly from [GitHub Releases](https://github.com/intutic/intutic/releases/latest):
* 🪟 Windows (x64): `cli-win-x64.exe` / `intutic-proxy-win32-x64.exe`
* 🐧 Linux (x64): `cli-linux-x64` / `intutic-proxy-linux-x64`
* 🐧 Linux (arm64): `intutic-proxy-linux-arm64` (proxy only)
* 🍎 macOS (Apple Silicon): `cli-macos-arm64` / `intutic-proxy-darwin-arm64`
* 💻 macOS (Intel): `cli-macos-x64` / `intutic-proxy-darwin-x64`
:::

<!-- ENTERPRISE_ONLY_START -->
## Connected mode: log in first <Badge type="tip" text="Connected mode only" />

::: tip Running open core standalone? Skip this section.
`login` authenticates you with a **control plane**, which open core does not
include. Standalone needs none — `intutic start` runs the proxy with no account
at all.
:::

```bash
intutic login
```

You'll be prompted for your email and password. On success:

```
Intutic — Authentication
Control plane: https://your-control-plane.example
Email: you@company.com
Password:
ℹ Authenticating...
✔ Authenticated as you@company.com
  Workspace: wk_k8x9m2p4
```

Your credentials are stored at `~/.intutic/credentials.json` (mode `0600`),
with the API key backed by your system keychain when available.

::: tip API key authentication
For CI or headless environments, authenticate with an API key (must start with `vk_`):
```bash
intutic login --api-key vk_your_key_here
```
:::

::: tip Self-hosted control plane
Log in with its URL once; every later command, `intutic connect` included, uses it:
```bash
intutic login --control-plane-url https://intutic.internal.example
```
`INTUTIC_CONTROL_PLANE_URL` does the same per shell. See
[Choosing a control plane](/reference/cli#control-plane-url).
:::

::: details Local development
If you are running a control plane on this machine, point at it with `--dev`:
```bash
intutic login --dev
```
This uses `http://localhost:3001` instead of the hosted API. Open core does not
include a control plane, so this is only useful if you are supplying one — the
proxy itself needs no login and runs standalone without either.
:::
<!-- ENTERPRISE_ONLY_END -->

## Step 2 — Initialize your workspace

From your project root (must contain a `.git/` directory or `package.json`):

```bash
intutic init
```

This auto-detects every AI harness in your project and records them in
`~/.intutic/config.json`. It makes no network call and writes no harness
files; `intutic gates install` (Step 3) writes those. At a terminal, `init`
offers to run it for you; `--gates` or `--no-gates` answers that in a script.

```
Intutic — Workspace Initialization
✔ Workspace root: /home/dev/my-project
ℹ Detecting AI harnesses...

  ✔ cursor → /home/dev/my-project/.cursor/rules/intutic-governance.mdc
  ✔ claude-code → /home/dev/my-project/.claude/rules/intutic-governance.md
  ○ antigravity (not detected)
  ○ windsurf (not detected)
  ...

✔ Detected 2 harnesses

Install Intutic Git hooks (post-commit, post-checkout, pre-commit secret scan, post-merge)? [Y/n]:
✔ Workspace initialized.
```

The Git hooks question is only asked at a terminal. In CI or a script, pass
`--git-hooks` or `--no-git-hooks`; with neither, `init` skips the hooks.

::: details Local development
Record dev mode, so later commands use a local control plane
(`http://localhost:3001`):
```bash
intutic init --dev
```
:::

## Step 3 — Install the gates

```bash
intutic gates install
```

For each harness `init` recorded, this writes its blocking gate and, when
`.intutic/sops/` holds rule sets, its rules file. Everything comes from local
files; no control plane or account is involved. `--dry-run` shows what it would
write, and `--harness <id>` limits it to one harness. Each harness's page under
[Integrations](/integrations/) lists the files, and `intutic disconnect` takes
them out again.

The gates enforce the built-in protections, your rule sets and their
[front matter](/reference/sop-front-matter) on every tool call. A
`review_before:` hold needs a reviewer, which only a control plane provides, so
without one the gates refuse those calls.

## Step 4 — Start the proxy {#step-4-start-the-proxy}

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
INFO intutic_proxy: Listening on 127.0.0.1:4000
```

If no Valkey can be started — no Docker, no `valkey-server` on your PATH — the
proxy runs anyway:

```
ℹ No Valkey detected on port 6379. Trying to start one…
⚠ Could not start Valkey — running standalone.
ℹ Routing, policies, DLP and local spend caps all work.
ℹ Bandit learning persists to ~/.intutic; the response cache is per-process.
ℹ
ℹ To get a shared, durable cache later:
ℹ Intutic needs a Valkey (or Redis) on port 6379.
…
ℹ Starting proxy on port 4000 (standalone)…
INFO intutic_proxy: Listening on 127.0.0.1:4000
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

<!-- ENTERPRISE_ONLY_START -->
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
Intutic — Sync Daemon
  Workspace: wk_k8x9m2p4
  Control Plane: https://your-control-plane.example
  Poll Interval: 30s
  Harnesses: cursor, claude-code
…
ℹ Starting sync daemon... (Ctrl+C to stop)
…
ℹ Port 4000 is free. Spawning managed proxy gateway...
✔ Managed proxy gateway process spawned.
ℹ Applying configuration v14...
[sync] Config v14 — 14 SOPs synced
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
| Who updates arms | this proxy, deterministically | the control plane's daily reward job (deterministic, no model call), once it claims the workspace |
| Feature flags | `config.yaml` | control plane, authoritative |
| Auth & budgets | local daily spend cap | workspace virtual keys and budgets |

Arm state carries over rather than resetting: the update rule is the same in
both modes, and the two representations agree within `1e-12`. A workspace that
learned standalone keeps that learning when a control plane takes over, and the
control plane signals the handover by setting the workspace's reward mode to
`cloud`, at which point the local loop stands down within 60 seconds.
<!-- ENTERPRISE_ONLY_END -->

### Route your agent

Set your agent's base URL environment variable to point at the local Intutic proxy:

```bash
# Host only — the Anthropic SDK and Claude Code append /v1/messages themselves.
# Adding /v1 here produces /v1/v1/messages, which the proxy cannot route.
export ANTHROPIC_BASE_URL="http://localhost:4000"
```

For a harness with a config key for its base URL, such as Codex or Aider,
`intutic gates install --route` writes it for you while the proxy runs; or start
the agent with `intutic exec -- <agent>`, which sets these variables for that
process.

`intutic start` also keeps the installed gates current: when a rule set under
`.intutic/sops/` changes, it rewrites them (`intutic start --no-gates` leaves
them alone).

Now, every LLM API call and tool execution is evaluated pre-flight.

---

<!-- ENTERPRISE_ONLY_START -->
## 🛠️ Under the Hood

When you run `intutic connect`, Intutic:

1. Spawns the **Intutic Rust proxy** on port 4000 — all LLM traffic routes through it
2. Opens a **WebSocket** for real-time config updates from the control plane
3. Watches the **filesystem** for harness config drift — auto-reverts unauthorized changes
4. Runs a **30-second poll loop** as a secondary fallback (configurable with `--interval`)
5. Syncs any **offline traces** accumulated while the daemon was stopped
6. Installs each configured harness's gate (pre-tool-use hooks for Claude Code, for example) and writes the rule sets into the file each harness reads (e.g., `.cursor/rules/intutic-governance.mdc` for Cursor, `.claude/rules/intutic-governance.md` for Claude Code); it never writes `CLAUDE.md`. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go)

::: tip Background options
```bash
intutic connect --interval 10000   # 10-second poll interval
intutic connect --dev              # Local control plane
```
For a persistent system service that starts on login, see [`intutic daemon install`](/reference/cli).
:::
<!-- ENTERPRISE_ONLY_END -->

## Step 5 — Trigger your first block

Open your AI agent and ask it to do something destructive:

> _"Delete all files in /tmp"_

The proxy reads the tool call, and a shell or code-execution call carrying a
destructive operation (`rm -rf /`, `mkfs`, `dd if=`, …) is a **KILL**: the
request is refused with HTTP `403` and code `policy_denied`.

```
Request blocked by anomaly policy [TOOL_ABUSE]: Code-execution call 'Bash'
contains a destructive operation ('rm -rf /'). Per-call gates cannot see
inside a code blob; this one was read.
```

The proxy alone reads a call's arguments once the call comes back in the
conversation history, on the next request. To refuse a tool before the harness
runs it, name it in an SOP's `deny_tools`, which the proxy applies to the
model's response, or rely on the pre-tool-use gate `intutic gates install` installs.

## Step 6 — View your trace

Check the trace from the command line:

```bash
intutic traces list --limit 5
```

With no control plane connected, this reads the proxy's own trace log
(`~/.intutic/logs/traces-*.jsonl`) and shows each trace's local verdict
(`allowed`, `killed`, `reasked`, `hijacked` or `upstream_error`); connected,
it shows the control plane's enforcement action and compliance score instead.

```
Intutic — Execution Traces (local)
  No control plane connected — reading directly from ~/.intutic/logs/. No compliance score locally.
┌────────────────┬─────────────────────┬──────────────────┬────────────────┬───────────┐
│ Trace ID       │ Timestamp           │ Model            │ Verdict        │ Cost      │
├────────────────┼─────────────────────┼──────────────────┼────────────────┼───────────┤
│ 3f2a9c1e-7b... │ 2026-07-04 07:30:01 │ claude-sonnet-4… │ killed         │ $0.0000   │
│ 9d41b0a2-5c... │ 2026-07-04 07:28:44 │ claude-sonnet-4… │ allowed        │ $0.0123   │
└────────────────┴─────────────────────┴──────────────────┴────────────────┴───────────┘
Showing 2 of 2 traces (last 24 hours)
```

Drill into the blocked trace. The table shortens trace IDs; `inspect` takes
the full one, which `intutic traces list --json` prints:

```bash
intutic traces inspect 3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d
```

Or check your full system status in another terminal:

```bash
intutic status
```

```
Intutic — Workspace Status
  Email: you@company.com
  Workspace: wk_k8x9m2p4
  Control Plane: https://your-control-plane.example
  Workspace Root: /home/dev/my-project
  Dev Mode: no
  Config Version: 14

ℹ Detected harnesses:
  ✔ cursor
  ✔ claude-code
  Last Sync: 2026-07-04T07:30:13.000Z
  Tracked Files: 2

ℹ Active Running Processes:
  (none detected)

  Sync Daemon State: Running
```

## Disconnecting

`intutic disconnect` undoes `intutic gates install`<!-- ENTERPRISE_ONLY_START --> and `intutic connect`<!-- ENTERPRISE_ONLY_END -->: every harness config it changed goes back the way it was<!-- ENTERPRISE_ONLY_START -->, the background services are removed, and you are logged out<!-- ENTERPRISE_ONLY_END -->. Run it with `--dry-run` first to see each change, and `--harness <id>` to disconnect one harness. See [`intutic disconnect`](/reference/cli#intutic-disconnect) for what it restores and what it leaves.

```bash
intutic disconnect --dry-run
intutic disconnect
```

## What's next?

| Topic | Description |
|---|---|
| [**How It Works**](/guide/how-it-works) | Understand the proxy → policy engine → verdict pipeline |
| [**Enforcement Actions**](/concepts/enforcement-actions) | Deep dive into BYPASS, ENHANCE, HIJACK, REASK and KILL |
| [**Custom Filters (WASM)**](/external/wasm-rules) | Create WASM policy rules for custom tool-call filtering |
| [**Integrations**](/integrations/) | Detailed setup guides for all 43 harnesses |
| [**CLI Reference**](/reference/cli) | Complete command reference for `@intutic/cli` |
