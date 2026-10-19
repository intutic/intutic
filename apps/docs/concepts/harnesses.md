---
title: Harnesses
description: How Intutic's proxy and harness gates work together to govern 43 AI coding agents without changing their source code.
---

# Harnesses <Badge type="tip" text="Open-Core" />

A **harness** is any AI coding agent that Intutic governs. Intutic currently supports [43 harnesses](/integrations/) — from IDE extensions like Cursor and Windsurf to CLI tools like Claude Code and Aider to autonomous agent frameworks like OpenHands and Goose, plus orchestrators like Spotify Xirp, DoorDash Agentic Orchestrator, and AWS Bedrock AgentCore Runtime that delegate to already-gated harnesses underneath them. A separate set of server-side platform integrations (QM, Anthropic Managed Agents, AWS Bedrock AgentCore Gateway) call Intutic directly over HTTP and have no `HarnessType` of their own — see [Integrations Hub](/integrations/#server-side-platform-integrations).

Governance works through three components that run on the developer's machine:

| Component | Language | Role |
|---|---|---|
| **Proxy** | Rust | Intercepts LLM API calls on port 4000 — DLP, metering, policy checks |
| **Gate** | Generated per harness (mostly shell or JavaScript) | Runs inside the harness before each tool call and allows or refuses it, from the policy snapshot |
| **Gate writer** | TypeScript (`intutic gates install`, `intutic start`) | Compiles `.intutic/sops/` into each harness's gate, its rules file and the policy snapshot; with a control plane, the sync daemon writes them instead and watches them for drift |

---

## Architecture

```
Developer's Machine
┌────────────────────────────────────────────────────────┐
│                                                        │     ┌────────────────┐
│  ┌──────────┐  LLM API calls  ┌──────────┐             │     │  LLM provider  │
│  │ Harness  │ ──────────────▶ │  Proxy   │ ───────────────▶  │                │
│  │ (Cursor, │ localhost:4000  │  (Rust)  │             │     └────────────────┘
│  │  Claude, │                 │  :4000   │             │
│  │  etc.)   │                 └────▲─────┘             │
│  └────┬─────┘                      │ re-reads          │
│       │ runs the gate              │ every 30 s        │
│       │ before each tool           │                   │
│       │ call; reads the     ┌──────┴─────────┐         │
│       │ rules file          │ .intutic/sops/ │         │
│       ▼                     └──────┬─────────┘         │
│  ┌──────────┐                      │ reads             │
│  │ Gate,    │  writes  ┌───────────▼───────────┐       │
│  │ rules    │◀──────── │ intutic gates install │       │     ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
│  │ file,    │          │ intutic start         │◀╌╌╌╌╌╌╌╌╌╌╌╌┆ Control plane  ┆
│  │ policy   │          │ (connected: the sync  │       │     ┆ (optional; not ┆
│  │ snapshot │          │ daemon, from the      │       │     ┆ in open core)  ┆
│  └──────────┘          │ control plane)        │       │     └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
│                        └───────────────────────┘       │
└────────────────────────────────────────────────────────┘
```

::: tip Open core runs without the control plane
The control plane, drawn dashed, is optional, and open core ships none. A
standalone install runs everything inside the box: `intutic gates install`
writes each harness's gate, rules file and policy snapshot from
`.intutic/sops/`, and `intutic start` runs the proxy and rewrites them when
`.intutic/sops/` changes. The sync daemon needs a control plane.
:::

### The flow

1. **`intutic gates install`** compiles `.intutic/sops/` into each harness's gate and rules file, in its native format, and into the policy snapshot (`~/.intutic/hooks/policy-snapshot.rules`); **`intutic start`** writes them again whenever `.intutic/sops/` changes
2. **Harness** makes an LLM API call (e.g., `POST /v1/chat/completions`)
3. **Proxy** intercepts the call at `localhost:4000` — runs DLP scanning, budget checks, and policy evaluation, with the SOPs it re-reads from `.intutic/sops/` every 30 seconds
4. **Proxy** forwards approved requests to the real LLM provider, records traces
5. **Gate** runs before each tool call the harness makes and allows or refuses it from the policy snapshot; a [`decide:` rule](/guide/decide) is asked of your self-hosted decide engine
<!-- ENTERPRISE_ONLY_START -->

With a control plane connected, the [sync daemon](#sync-daemon-typescript) writes the same files instead: it polls the control plane every 30s (or receives instant WebSocket pushes) for SOP updates, writes them into each harness's native config file format, and watches the files via chokidar — an unauthorized edit triggers an immediate rewrite and a tamper event.
<!-- ENTERPRISE_ONLY_END -->

---

## Proxy (Rust)

The proxy is a high-performance Rust proxy gateway (`@intutic/proxy`) that transparently intercepts all LLM traffic. Harnesses connect to it by setting their base URL to the proxy: `http://localhost:4000` for Anthropic SDKs (they append `/v1/messages`) and `http://localhost:4000/v1` for OpenAI-style SDKs (they append `/chat/completions` or `/responses`).

### Protocol routing

| Route | Protocol | Harnesses |
|---|---|---|
| `/v1/chat/completions` | OpenAI | Cursor (own API keys), Windsurf (through TLS interception), Continue, Cline, Roo Code, Aider |
| `/v1/messages` | Anthropic | Claude Code, Continue, Aider |
| `/v1/responses` | OpenAI Responses | OpenAI Codex |

`/v1beta/models/:model` (Gemini's own route) is refused with `400 unsupported_route`, so Antigravity's model traffic is not supported. Gemini models are served on the three routes above, translated to the Gemini API. Claude Desktop sends its model traffic to Anthropic directly and cannot be routed.

### Pre-request pipeline

Every request passes through these stages before reaching the LLM:

1. **Virtual key validation** (with a control plane) — verifies the `vk_*` workspace key; a standalone proxy forwards the provider key the harness sends
2. **Budget gate** — standalone, the machine's daily cap (`maxDailyBudgetUsd` in `~/.intutic/config.json`); with a control plane, the session and workspace spend limits in Valkey (`v2:budget:hard_block:{workspace_id}`)
3. **DLP scanner** — regex-based detection of secrets across ~20 high-precision patterns (AWS keys incl. temporary creds, GitHub classic + fine-grained tokens, Anthropic/OpenAI/GitLab/Slack/Google/Stripe/SendGrid/npm/PyPI/Hugging Face keys, Slack webhooks, DB connection credentials, JWTs, bearer tokens, private keys) plus validated PII detectors (payment cards, IBANs, SSNs; email and phone when enabled), with `redact` or `block` actions — applied to request bodies and forwarded header values; responses are scanned on the way back too, with streaming output scrubbed per SSE line
4. **WASM plugin evaluation** — custom governance plugins compiled to WebAssembly
5. **Policy check** (with a control plane) — pre-request evaluation against the control plane (3s timeout, configurable fail-open or fail-closed); a standalone proxy skips it

**SnipCompactor** — token compression: text repetition collapse, JSON array truncation, code skeleton extraction via tree-sitter — runs on the way back instead: on the tool-result text of a non-streaming response, after the response DLP scan.

### Key constants

| Constant | Value |
|---|---|
| Default port | `4000` |
| Policy check timeout | `3,000ms` |
| HTTP client timeout | `120s` |
| SnipCompactor max tool output | `8,192 tokens` |
| Valkey default | `redis://127.0.0.1:6379` |

→ Source: [packages/proxy/](https://github.com/intutic/intutic/tree/main/packages/proxy)

---

<!-- ENTERPRISE_ONLY_START -->
## Sync Daemon (TypeScript)

The sync daemon keeps harness config files in sync with SOPs from the control plane. It runs on the developer's machine as a managed process started by `intutic connect`.

### Sync loop

`intutic connect` polls the control plane every 30 seconds (`--interval` changes it) and also receives pushed updates over the WebSocket below. On each config it applies:

1. **Fetch config** — `POST /api/v1/sync/config`
2. **Refresh the gate caches** — the policy snapshot, approved review-hold bypasses and the egress policy every hook reads
3. **Compare configVersion** — if remote > local, write each recorded harness's files (see [What writes harness files](/integrations/#what-writes-harness-files)) and update the Claude Code hooks
4. **Proxy-wrap MCP servers** — on every cycle, so a server added to a harness config after `connect` started is wrapped on the next one
5. **Apply SkillOpt edits** — config edits the control plane queued for the workspace are written into the rules files and each outcome is acknowledged; when step 3 rewrote the files, every edit is applied again
6. **Refresh the decisions log** — only when the workspace turned it on, into each harness's instructions file (see [Governed Decisions Log](/guide/decisions-log)); a decisions section an earlier version put in `CLAUDE.md` is taken out on every sync
7. **Compute SHA-256 hashes** — hash each harness's config file
8. **Update integrity store** — `.intutic/integrity.json` in the workspace
9. **Report hashes** — `POST /api/v1/sync/sop-hash` for drift detection
10. **Health checks** — the local proxy and Valkey are checked and restarted if they stopped

Each poll also registers every recorded harness as an agent with its facets and records a `skill_flagged` event for each skill whose scan found something, and every fifth poll records the rules files that changed in the config history (their text only with [content upload](/reference/cli#config-content-upload) on). On startup `connect` writes the bundled `intutic-rule-author` skill if the workspace does not have it.

### Real-time updates via WebSocket

Instead of waiting for the 30s poll, the control plane can push updates instantly:

- **Endpoint:** `ws(s)://{controlPlaneUrl}/api/v1/sync/ws?token={apiKey}`
- **Heartbeat:** every 30s
- **Auto-reconnect:** exponential backoff (1s base, 30s max)
- **Events:** `config_update` (apply SOPs immediately), `active_local_sops_update`

### Config drift detection

The daemon watches all harness config files using **chokidar**:

- **Stability threshold:** 200ms (waits for write to finish)
- On `change` or `unlink` → immediately rewrites the config file, unless the workspace's hand-edit setting is **Record only**, which leaves the edit in place. Gate hook files are restored under Record only too: they are the gates, not your config
- Reports the drift to the control plane either way

All config writes are **atomic** — write to a temp file, then rename. With the **Write-protect** setting on macOS, the rules files also carry the `uchg` immutable flag between syncs, so a hand edit fails; the daemon clears the flag before it writes and sets it again afterwards.
<!-- ENTERPRISE_ONLY_END -->

## Harness files

`intutic gates install` writes each recorded harness's gate and, when a rule set targets it, its rules file, from `.intutic/sops/`; `intutic start` rewrites them when a rule set changes. See [What writes harness files](/integrations/#what-writes-harness-files).

### Config file formats

SOPs are written in each harness's native format. [Where rule sets go](/guide/how-it-works#where-rule-sets-go) lists the file for every harness:

| Format | Harnesses | Example file |
|---|---|---|
| Markdown file of Intutic's own | Claude Code, Cursor, Windsurf, Cline, Continue, OpenHands, Aider | `.cursor/rules/intutic-governance.mdc` |
| Markdown section in your own file | Codex, Muse Code, Grok Build, OpenCode, Pi, Hermes, Roo Code, dsh, OpenClaw (`AGENTS.md`); Antigravity and Gemini CLI (`GEMINI.md`); GitHub Copilot (`.github/copilot-instructions.md`); Goose (`.goosehints`) | `AGENTS.md` |
| YAML | Aider (the `read:` entry that loads its rules file) | `.aider.conf.yml` |
| Env | Codex and the SDK frameworks (proxy URLs) | `.env.intutic` |
| No instructions file | n8n, Claude Desktop, Open WebUI, Xirp, Agentic Orchestrator, AgentCore, TrueForge server, the SDK frameworks | — |
| Native hooks | Claude Code, Cursor, Windsurf, Cline, Codex, GitHub Copilot (agent mode), Antigravity, Goose, OpenHands, OpenClaw (plugin), Hermes, Pi (extension), Muse Code, Grok Build, OpenCode (plugin), dsh (plugin), n8n (workflow hook), Open WebUI (prompt filter) | Harness-specific — see the [coverage matrix](/reference/harness-security-matrix#coverage-matrix) |

→ Source: [services/sync-daemon/](https://github.com/intutic/intutic/tree/main/services/sync-daemon)

---

## Harness adapter interface

Each harness implements an adapter contract:

```typescript
// tools/cli/src/harness/types.ts

interface IHarnessAdapter {
  readonly type: HarnessType
  readonly configFileName: string
  detect(workspaceRoot: string): Promise<boolean>
  installGate?(workspaceRoot: string, proxyUrl: string): Promise<void>
  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null>
  readCurrentHash(workspaceRoot: string): Promise<string | null>
}
```

| Method | Purpose |
|---|---|
| `detect()` | Check if the harness is present (usually `fs.access` on the config file) |
| `installGate()` | Install the harness's tool-call gate and, with `intutic gates install --route`, its proxy routing. `intutic gates install` runs it for every configured harness, whether or not a rule set targets it |
| `writeConfig()` | Write the rule sets into the one file the harness reads as standing instructions, and no other; called only when a rule set targets the harness, or on a forced sync |
| `readCurrentHash()` | SHA-256 of the rules file (for drift detection) |

Which file that is comes from `HARNESS_RULES_FILES` in `@intutic/shared-types`, and the adapters write it through [rulesFiles.ts](https://github.com/intutic/intutic/blob/main/tools/cli/src/harness/rulesFiles.ts): a file of Intutic's own in a directory the harness reads every file of, or a marked section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` of a file you also write (see [Where rule sets go](/guide/how-it-works#where-rule-sets-go)). Either one starts with the same generated title (a file of Intutic's own after the harness's front matter, if it needs any), and carries no sync time, so a sync with nothing new leaves the file as it is:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file
```

In a marked section the second line reads `# DO NOT EDIT this section — managed by intutic sync daemon; edit outside the INTUTIC:RULES markers`.

→ Source: [tools/cli/src/harness/](https://github.com/intutic/intutic/tree/main/tools/cli/src/harness)

---

## Related

- [Integrations Hub](/integrations/) — All 43 harnesses with setup guides
- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/REASK/KILL verdicts
- [Getting Started](/guide/getting-started) — Install and connect your first harness
- [Core Concepts](/guide/concepts) — Workspaces, SOPs, scoring
