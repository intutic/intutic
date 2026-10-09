---
title: Harnesses
description: How Intutic's proxy and sync daemon work together to govern 43 AI coding agents without changing their source code.
---

# Harnesses <Badge type="tip" text="Open-Core" />

A **harness** is any AI coding agent that Intutic governs. Intutic currently supports [43 harnesses](/integrations/) — from IDE extensions like Cursor and Windsurf to CLI tools like Claude Code and Aider to autonomous agent frameworks like OpenHands and Goose, plus orchestrators like Spotify Xirp, DoorDash Agentic Orchestrator, and AWS Bedrock AgentCore Runtime that delegate to already-gated harnesses underneath them. A separate set of server-side platform integrations (QM, Anthropic Managed Agents, AWS Bedrock AgentCore Gateway) call Intutic directly over HTTP and have no `HarnessType` of their own — see [Integrations Hub](/integrations/#server-side-platform-integrations).

Governance works through two components that run on the developer's machine:

| Component | Language | Role |
|---|---|---|
| **Proxy** | Rust | Intercepts LLM API calls on port 4000 — DLP, metering, policy checks |
| **Sync Daemon** | TypeScript | Syncs SOPs from the control plane → harness config files, detects drift |

---

## Architecture

```
Developer's Machine                              Cloud
┌──────────────────────────────────────┐    ┌──────────────┐
│                                      │    │              │
│  ┌──────────┐   LLM API calls       │    │  Control     │
│  │ Harness  │ ──────────────────────────▶ │  Plane       │
│  │ (Cursor, │   via localhost:4000   │    │  (:3001)     │
│  │  Claude, │                        │    │              │
│  │  etc.)   │                        │    │  ┌────────┐  │
│  └────┬─────┘                        │    │  │ SOPs   │  │
│       │ reads                        │    │  │ Traces │  │
│       ▼                              │    │  │ Budgets│  │
│  ┌──────────┐     ┌──────────────┐   │    │  └────────┘  │
│  │ Config   │◀────│ Sync Daemon  │◀──────▶│              │
│  │ Files    │     │ (sync loop + │   │    └──────────────┘
│  │          │     │  WebSocket)  │   │       ▲
│  └──────────┘     └──────────────┘   │       │
│       ▲                              │       │
│       │ watches for drift            │    Policy checks
│       │                              │    + telemetry
│       │           ┌──────────────┐   │       │
│       └───────────│ Proxy (Rust) │───────────┘
│                   │ :4000        │   │
│                   └──────────────┘   │
└──────────────────────────────────────┘
```

::: tip Open-core runs the left-hand column only
The Cloud column is optional. Open core ships no control plane, so a standalone
install runs the harness, proxy, config files and sync daemon entirely on the
developer's machine — steps 4 and 5 below apply only once you connect one.
:::

### The flow

1. **Harness** makes an LLM API call (e.g., `POST /v1/chat/completions`)
2. **Proxy** intercepts the call at `localhost:4000` — runs DLP scanning, budget checks, and policy evaluation
3. **Proxy** forwards approved requests to the real LLM provider, records traces
4. **Sync Daemon** polls the control plane every 30s (or receives instant WebSocket pushes) for SOP updates
5. **Sync Daemon** writes SOPs into each harness's native config file format
6. **Sync Daemon** watches config files via chokidar — unauthorized edits trigger immediate rewrite + tamper event

---

## Proxy (Rust)

The proxy is a high-performance Rust proxy gateway (`@intutic/proxy`) that transparently intercepts all LLM traffic. Harnesses connect to it by setting their base URL to the proxy: `http://localhost:4000` for Anthropic SDKs (they append `/v1/messages`) and `http://localhost:4000/v1` for OpenAI-style SDKs (they append `/chat/completions` or `/responses`).

### Protocol routing

| Route | Protocol | Harnesses |
|---|---|---|
| `/v1/chat/completions` | OpenAI | Cursor (own API keys), Windsurf (through TLS interception), Continue, Cline, Roo Code, Aider |
| `/v1/messages` | Anthropic | Claude Code, Continue, Aider |
| `/v1/responses` | OpenAI Responses | OpenAI Codex |

`/v1beta/models/:model` (Gemini) is routed but not translated, so Gemini traffic — Antigravity's included — is not supported. Claude Desktop sends its model traffic to Anthropic directly and cannot be routed.

### Pre-request pipeline

Every request passes through these stages before reaching the LLM:

1. **Virtual key validation** — verifies the `vk_*` workspace key
2. **Budget gate** — checks session and workspace spend limits against Valkey (`v2:budget:hard_block:{workspace_id}`)
3. **DLP scanner** — regex-based detection of secrets across ~20 high-precision patterns (AWS keys incl. temporary creds, GitHub classic + fine-grained tokens, Anthropic/OpenAI/GitLab/Slack/Google/Stripe/SendGrid/npm/PyPI/Hugging Face keys, Slack webhooks, DB connection credentials, JWTs, bearer tokens, private keys) plus validated PII detectors (payment cards, IBANs, SSNs; email and phone when enabled), with `redact` or `block` actions — applied to request bodies and forwarded header values; responses are scanned on the way back too, with streaming output scrubbed per SSE line
4. **SnipCompactor** — token compression: text repetition collapse, JSON array truncation, code skeleton extraction via tree-sitter
5. **WASM plugin evaluation** — custom governance plugins compiled to WebAssembly
6. **Policy check** — pre-request evaluation against the control plane (3s timeout, configurable fail-open or fail-closed)

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
8. **Report hashes** — `POST /api/v1/sync/sop-hash` for drift detection
9. **Update integrity store** — `.intutic/integrity.json` in the workspace
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

### Config file formats

SOPs are written in each harness's native format. [Where rule sets go](/guide/how-it-works#where-rule-sets-go) lists the file for every harness:

| Format | Harnesses | Example file |
|---|---|---|
| Markdown file of Intutic's own | Claude Code, Cursor, Windsurf, Cline, Continue, OpenHands, Aider | `.cursor/rules/intutic-governance.mdc` |
| Markdown section in your own file | Codex, Muse Code, Grok Build, OpenCode, Pi, Hermes, Roo Code, dsh, OpenClaw (`AGENTS.md`); Antigravity and Gemini CLI (`GEMINI.md`); GitHub Copilot (`.github/copilot-instructions.md`); Goose (`.goosehints`) | `AGENTS.md` |
| YAML | Aider (the `read:` entry that loads its rules file) | `.aider.conf.yml` |
| Env | Codex and the SDK frameworks (proxy URLs) | `.env.intutic` |
| No instructions file | n8n, Claude Desktop, Open WebUI, Xirp, Agentic Orchestrator, AgentCore, the SDK frameworks | — |
| Native hooks | Claude Code, Cursor, Windsurf, Cline, Codex, GitHub Copilot (agent mode), Antigravity, Goose, OpenHands, OpenClaw (plugin), Hermes, Pi (extension), Muse Code, Grok Build, OpenCode (plugin), dsh (plugin), n8n (workflow hook) | Harness-specific — see the [coverage matrix](/reference/harness-security-matrix#coverage-matrix) |

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
| `installGate()` | Install the harness's tool-call gate and its proxy routing. `intutic connect` runs it for every configured harness, whether or not a rule set targets it |
| `writeConfig()` | Write the rule sets into the one file the harness reads as standing instructions, and no other; called only when a rule set targets the harness |
| `readCurrentHash()` | SHA-256 of the rules file (for drift detection) |

Which file that is comes from `HARNESS_RULES_FILES` in `@intutic/shared-types`, and the adapters write it through [rulesFiles.ts](https://github.com/intutic/intutic/blob/main/tools/cli/src/harness/rulesFiles.ts): a file of Intutic's own in a directory the harness reads every file of, or a marked section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` of a file you also write (see [Where rule sets go](/guide/how-it-works#where-rule-sets-go)). Either one starts with the same generated header, and carries no sync time, so a sync with nothing new leaves the file as it is:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file
```

→ Source: [tools/cli/src/harness/](https://github.com/intutic/intutic/tree/main/tools/cli/src/harness)

---

## Related

- [Integrations Hub](/integrations/) — All 43 harnesses with setup guides
- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/KILL verdicts
- [Getting Started](/guide/getting-started) — Install and connect your first harness
- [Core Concepts](/guide/concepts) — Workspaces, SOPs, scoring
