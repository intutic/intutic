---
title: Harnesses
description: How Intutic's proxy and sync daemon work together to govern 18 AI coding agents without changing their source code.
---

# Harnesses <Badge type="tip" text="Open-Core" />

A **harness** is any AI coding agent that Intutic governs. Intutic currently supports [18 harnesses](/integrations/) — from IDE extensions like Cursor and Windsurf to CLI tools like Claude Code and Aider to autonomous agent frameworks like OpenHands and Goose.

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

### The flow

1. **Harness** makes an LLM API call (e.g., `POST /v1/chat/completions`)
2. **Proxy** intercepts the call at `localhost:4000` — runs DLP scanning, budget checks, and policy evaluation
3. **Proxy** forwards approved requests to the real LLM provider, records traces
4. **Sync Daemon** polls the control plane every 30s (or receives instant WebSocket pushes) for SOP updates
5. **Sync Daemon** writes SOPs into each harness's native config file format
6. **Sync Daemon** watches config files via chokidar — unauthorized edits trigger immediate rewrite + tamper event

---

## Proxy (Rust)

The proxy is a high-performance Rust proxy gateway (`@intutic/proxy`) that transparently intercepts all LLM traffic. Harnesses connect to it by setting their base URL environment variable to `http://localhost:4000`.

### Protocol routing

| Route | Protocol | Harnesses |
|---|---|---|
| `/v1/chat/completions` | OpenAI | Cursor, Windsurf, Continue, Cline, Roo Code |
| `/v1/messages` | Anthropic | Claude Code, Claude Desktop |
| `/v1/responses` | Codex | OpenAI Codex |
| `/v1beta/models/:model` | Gemini | Antigravity |

### Pre-request pipeline

Every request passes through these stages before reaching the LLM:

1. **Virtual key validation** — verifies the `vk_*` workspace key
2. **Budget gate** — checks session and workspace spend limits against Valkey (`v2:budget:hard_block:{workspace_id}`)
3. **DLP scanner** — regex-based detection of secrets (AWS keys, GitHub tokens, bearer tokens, private keys, SSNs) with `redact` or `block` actions
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

→ Source: [packages/proxy/](../../../packages/proxy/)

---

## Sync Daemon (TypeScript)

The sync daemon keeps harness config files in sync with SOPs from the control plane. It runs on the developer's machine as a managed process started by `intutic connect`.

### Sync loop

Every 30 seconds (configurable via `pollIntervalMs`):

1. **Fetch config** — `POST /api/v1/sync/config` (15s timeout)
2. **Compare configVersion** — if remote > local → write SOPs to harness files
3. **Apply SkillOpt edits** — if any `appliedEdits` present from the SOP optimizer
4. **Compute SHA-256 hashes** — hash each config file
5. **Report hashes** — `POST /api/v1/sync/sop-hash` for drift detection
6. **Update integrity store** — writes to `~/.intutic/integrity.json`
7. **Config capture** — every 5th iteration (~2.5 min): upload configs to `POST /api/v1/config/capture`
8. **Compliance probes** — detect proxy bypass attempts

### Real-time updates via WebSocket

Instead of waiting for the 30s poll, the control plane can push updates instantly:

- **Endpoint:** `ws(s)://{controlPlaneUrl}/api/v1/sync/ws?token={apiKey}`
- **Heartbeat:** every 30s
- **Auto-reconnect:** exponential backoff (1s base, 30s max)
- **Events:** `config_update` (apply SOPs immediately), `active_local_sops_update`

### Config drift detection

The daemon watches all harness config files using **chokidar**:

- **Stability threshold:** 200ms (waits for write to finish)
- On `change` or `unlink` → immediately rewrites the config file (unless `alert-only` enforcement tier)
- Appends a `config_tamper` event to the hook-events log
- Reports the tamper to the control plane

All config writes are **atomic** — write to a temp file, then rename. On macOS, optional `uchg` immutable flag support prevents casual editing.

### Config file formats

SOPs are written in each harness's native format:

| Format | Harnesses | Example file |
|---|---|---|
| Markdown | Cursor, Claude Code, Windsurf, GitHub Copilot | `.cursorrules` |
| JSON | Antigravity | `.gemini/settings.json` |
| YAML | Aider | `.aider.conf.yml` |
| TOML | OpenHands | `config.toml` |
| Env | Codex | `.env.intutic` |
| Native hooks | Cline, Roo Code, Continue, Claude Desktop, Goose | Harness-specific |

→ Source: [services/sync-daemon/](../../../services/sync-daemon/)

---

## Harness adapter interface

Each harness implements a three-method adapter contract:

```typescript
// tools/cli/src/harness/types.ts

interface IHarnessAdapter {
  readonly type: HarnessType
  readonly configFileName: string
  detect(workspaceRoot: string): Promise<boolean>
  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null>
  readCurrentHash(workspaceRoot: string): Promise<string | null>
}
```

| Method | Purpose |
|---|---|
| `detect()` | Check if the harness is present (usually `fs.access` on the config file) |
| `writeConfig()` | Write SOPs to the harness's native config format (atomic write) |
| `readCurrentHash()` | SHA-256 of current config file (for drift detection) |

The `createMarkdownAdapter()` factory in [base.ts](../../../tools/cli/src/harness/base.ts) generates adapters for markdown-based harnesses (Cursor, Claude Code, Windsurf). All adapters share the same auto-generated header:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-07-04T12:15:00Z
```

→ Source: [tools/cli/src/harness/](../../../tools/cli/src/harness/)

---

## Related

- [Integrations Hub](/integrations/) — All 18 harnesses with setup guides
- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/KILL verdicts
- [Getting Started](/guide/getting-started) — Install and connect your first harness
- [Core Concepts](/guide/concepts) — Workspaces, SOPs, scoring
