# TrueForge

Integrate Intutic governance with [TrueForge](https://github.com/truefoundry/trueforge) (TrueFoundry, MIT) — an open-source agent-runtime library. Intutic supports **both** of TrueForge's deployment modes, each with its own `HarnessType` and its own gate mechanism:

- **Embedded** (`HarnessType.TRUEFORGE`) — another team's Node.js process imports `@truefoundry/trueforge-core` directly. Covered below in [Embedded mode](#embedded-mode).
- **Standalone/hosted server** (`HarnessType.TRUEFORGE_SERVER`) — TrueForge runs as its own server (`npx @truefoundry/trueforge`, Docker Compose, or the Helm chart). Covered below in [Server mode (standalone/hosted)](#server-mode-standalone-hosted).

Both modes share the same underlying approval mechanism — TrueForge's async `tool.approval_required`/`user.tool_approval` turn contract — but differ in WHERE the gate runs: SDK-side in your own process for embedded mode, or out-of-process in `services/trueforge-bridge` (an Intutic-operated service) for server mode, since nobody embeds a gate library into a third-party OSS server process. See [`harness-security-matrix.md`](/reference/harness-security-matrix) rows 41–42 for how these two trust shapes are scored differently.

## Embedded mode

TrueForge (embedded) is governed on two independent surfaces:

1. **LLM egress** — point TrueForge's model-provider config (`baseUrl`) at the Intutic proxy. Every LLM call crosses the proxy and is governed like any other harness.
2. **Tool-call approval** — TrueForge pauses a turn with a `tool.approval_required` event before running a tool your `require_approval_for_tools` selector covers. `@intutic/gate/trueforge`'s `intuticApprovalResponder()` answers that pause with a real `Gate.guard()` verdict.

### How it works

The `trueforge` adapter is detected when `package.json` declares an `@truefoundry/trueforge-core` dependency (any version). Like every other SDK-gated framework in this codebase, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

**Important, confirmed against a real install (`@truefoundry/trueforge-core@0.1.4`):** unlike Mastra's `beforeToolCall` or the Vercel AI SDK's `toolApproval`, TrueForge has **no synchronous, in-process approval callback** you register once and forget. The only approval mechanism it exposes — embedded or run as a standalone server — is an async turn/event contract: a turn pauses with a `tool.approval_required` required action, and you answer it by starting a *new* turn carrying a `user.tool_approval` input item. `intuticApprovalResponder()` is the piece that evaluates pending requests through the gate; **driving the turn/event loop itself is your own application code**, not something this adapter turns on for you. See [What the adapter does NOT do](#what-the-adapter-does-not-do).

### Setup

#### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • trueforge → .env.intutic
```

#### 2. Route LLM traffic through the proxy

TrueForge's core LLM layer is built on the Vercel AI SDK's provider-construction shape (`VercelAIProviderConfig`, with an explicit `baseUrl` field) — there is no environment variable it reads automatically. Set `baseUrl` when you construct the model provider config:

```ts
const providerConfig = {
  provider: { type: 'openai', name: 'my-openai' },
  model: { id: 'gpt-4o', name: 'gpt-4o' },
  name: 'gpt-4o',
  baseUrl: process.env.INTUTIC_PROXY_URL, // or your hosted proxy
  apiKey: process.env.OPENAI_API_KEY!,
  headers: {},
}
```

If your embedding host exposes TrueForge's own settings API (`PUT /api/v1/settings/model-providers`), point that at the proxy instead — same effect, different call site.

#### 3. Gate tool-call approval (SDK)

```bash
npm install @intutic/gate
```

```ts
import { Gate, install } from '@intutic/gate'
import { intuticApprovalResponder } from '@intutic/gate/trueforge'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const respond = intuticApprovalResponder()

// Your own turn-driving loop (illustrative — see the caveats below):
for await (const event of turn.stream()) {
  // ... handle other event types ...
}

// When the turn's stored record shows a pending `tool.approval_required`
// required action, resolve each `{id, source_event_id}` back to the real
// tool name + arguments yourself (e.g. via turn.listEvents()), then:
const pendingRequests = pendingApprovals.map((p) => ({
  threadId: p.threadId,
  toolCallId: p.id,
  toolName: resolvedToolName(p),
  input: resolvedToolInput(p),
}))

const input = await respond(pendingRequests)

const nextTurn = await session.createTurn({
  turn_id: newTurnId(),
  input,
  previous_turn_id: pausedTurn.id,
  signal,
  resolver,
})
```

Decision mapping per pending request:

- gate allows → `{ status: 'allow' }`
- gate denies → `{ status: 'deny', reason }` — the `[Intutic Governance] BLOCKED: ...` message
- the gate itself crashes → `{ status: 'deny', reason: '... gate crashed ...' }` — fails **closed**, so a broken gate never silently lets a call through

### What gets written

Same shape as every other SDK-gated framework's `.env.intutic` — proxy URLs plus a pointer at `@intutic/gate/trueforge`'s `intuticApprovalResponder()`:

```bash
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-08-29T00:00:00Z
# Source this file: source .env.intutic

export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
export OPENAI_BASE_URL="http://localhost:4000/v1"
export INTUTIC_PROXY_URL="http://localhost:4000/v1"
export INTUTIC_SOP_COUNT=5

# These env vars govern LLM egress only. TrueForge (embedded) tools run in
# your own Node.js process, where no config or hook file can gate them — the
# blocking tool gate ships SDK-side:
#   npm install @intutic/gate
#   import { intuticApprovalResponder } from '@intutic/gate/trueforge'
# intuticApprovalResponder() answers tool.approval_required pauses with a
# real Gate.guard() verdict, producing user.tool_approval items for your
# next session.createTurn() call.
```

Note the env vars above are written for consistency with every other harness's `.env.intutic`, but — like Mastra and the Vercel AI SDK — TrueForge's core LLM layer does not read `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` automatically; you still have to pass `baseUrl` into the provider config yourself (step 2 above).

### What the adapter does NOT do

Stated plainly, because the gaps are structural:

- **This section covers embedded mode only.** TrueForge run as its own standalone or hosted server (`npx @truefoundry/trueforge`, Docker Compose, or the Helm chart) is a different `HarnessType` with a different gate mechanism — see [Server mode (standalone/hosted)](#server-mode-standalone-hosted) below, not this section.
- **There is no sync-daemon hook file.** Every hook-based harness has an on-disk config the daemon writes a pre-tool gate into; TrueForge (embedded) has none — tools run inside your own process. The daemon cannot gate what it cannot reach from disk.
- **TrueForge has no synchronous approval callback.** Confirmed against a real install: there is nothing shaped like Mastra's `beforeToolCall` or the Vercel AI SDK's `toolApproval` anywhere in `@truefoundry/trueforge-core`. `intuticApprovalResponder()` only evaluates the pending requests you hand it — building and driving the turn/event loop that detects a pause, resolves the real tool name and arguments from the referenced `model.message` event, and starts the next turn with the answer is your own application code, not something this adapter provides or verifies for you.
- **Coverage depends on your `require_approval_for_tools` selector.** TrueForge's own MCP tool-selector policy (`@all` / `@write` / `@destructive` / a specific tool name) controls which tool calls even emit a `tool.approval_required` pause in the first place — a narrower selector means some tool calls never pause at all, and this gate never sees them. This is TrueForge's own default-scoped design, not an Intutic gap, but it means the gate's real coverage is exactly as broad as the selector you configure.
- **Attribution is client-supplied.** There is no `x-intutic-harness` wiring specific to this adapter yet; scope your proxy client headers the same way you would for any other in-code provider construction.

### Config details

| Property | Value |
|----------|-------|
| Harness type | `trueforge` |
| Config file | `.env.intutic` |
| Detection | `@truefoundry/trueforge-core` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`) |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/trueforge`'s `intuticApprovalResponder()`, TrueForge's `tool.approval_required`/`user.tool_approval` turn contract) — no sync-daemon hook file, no synchronous callback; embedded-library mode only |

## Server mode (standalone/hosted)

TrueForge run as its own standalone or hosted server — `npx @truefoundry/trueforge`, its Docker Compose stack, or its Helm chart — is a separate process nobody embeds a gate library into. `HarnessType.TRUEFORGE_SERVER` governs it via a new out-of-process gate service, `services/trueforge-bridge`, on the same two surfaces as embedded mode:

1. **LLM egress** — same mechanism as embedded mode, configured once at the server level instead of per embedding host: `PUT /api/v1/settings/model-providers` with `baseUrl` pointed at the Intutic proxy.
2. **Tool-call approval** — `services/trueforge-bridge` subscribes to each watched session's turn stream, and when a turn pauses with `tool.approval_required`, resolves the pending call, evaluates it, and answers with a real verdict — the same governance decision embedded mode's `Gate.guard()` would produce, reached a different way (see [How it works](#how-it-works-1)).

### How it works

Unlike every other harness in this catalog, `TRUEFORGE_SERVER` is **not detected by `intutic init`'s repo scan** — there is no `package.json` dependency or config file to find, because this is an operator-configured *deployment*, not a library your repo depends on. There is no `writeConfig` step and no `.env.intutic` for this row. Instead, an operator deploys `services/trueforge-bridge` (its own Docker image; see `infra/kubernetes/base/trueforge-bridge/` and `tools/helm/intutic/values.yaml` for the Kubernetes/Helm shape) and points it at their running TrueForge server via env vars.

**Confirmed against the real TrueForge source** (`packages/trueforge-core/src/core/events/schema.ts`, `packages/trueforge/src/routes/turnRoutes.ts`), not assumed: the standalone server exposes the exact same async turn/event contract the embedded package does — a turn pauses with a `tool.approval_required` event naming each pending call only as `{id, source_event_id}` (all fields **snake_case** on the actual wire JSON; the published `@truefoundry/trueforge-sdk` TS client's camelCase property names, e.g. `sourceEventId`, are a client-side naming convenience its generator applies on top of that same snake_case JSON — a real, worth-stating distinction since `services/trueforge-bridge` speaks plain HTTP directly rather than depending on that SDK package). There is **no webhook** — TrueForge never pushes anything to an external system, so the bridge must actively subscribe to (or poll) the turn stream; it cannot be notified.

The bridge:

1. Watches each configured session's current turn over SSE (`GET /{session_id}/turns/{turn_id}/subscribe`), or polls `GET /{session_id}/turns/{turn_id}/events` as a fallback.
2. On `tool.approval_required`, resolves each pending call's `source_event_id` back to the real tool name and arguments via the referenced `model.message` event's `tool_calls[]`.
3. Evaluates the call through the same `packages/gate-js` machinery embedded mode uses — `soprules.ts`'s SOP argPattern rules, then `POST /api/v1/hook-gate` — fail-closed on any transport/parse error, matching every other gate-js adapter's convention.
4. Resumes the turn: `POST /{session_id}/turns` with `previous_turn_id` chained to the paused turn and a `user.tool_approval` input item carrying the verdict.

### Setup

#### 1. Deploy the bridge

```bash
docker build -f services/trueforge-bridge/Dockerfile -t intutic-trueforge-bridge .
```

or apply the Kubernetes manifests in `infra/kubernetes/base/trueforge-bridge/` (Deployment, Service, ConfigMap), or set the `trueforgeBridge` values block in `tools/helm/intutic/values.yaml` for a Helm-based install. These are enterprise deployment artifacts; see `services/trueforge-bridge/README.md` for the full env var reference.

#### 2. Configure the bridge

| Var | Required | Description |
|---|---|---|
| `TRUEFORGE_BASE_URL` | yes | Base URL of your TrueForge server. |
| `INTUTIC_API_KEY` | yes | Intutic workspace API key — used for the `POST /api/v1/hook-gate` call. |
| `INTUTIC_WORKSPACE_ID` | yes | Intutic workspace id. |
| `TRUEFORGE_API_KEY` | no | Bearer token for the TrueForge server, if its own OIDC is configured. |
| `INTUTIC_CONTROL_PLANE_URL` | no | Defaults to Intutic's hosted control plane; set explicitly for a self-hosted deployment. |
| `TRUEFORGE_SESSION_IDS` | no | Comma-separated session ids to watch. Empty means: discover via `GET /api/v1/sessions` at startup. |

The bridge refuses to start if `TRUEFORGE_BASE_URL`, `INTUTIC_API_KEY`, or `INTUTIC_WORKSPACE_ID` is missing — an unconfigured bridge that starts anyway and silently governs nothing would be worse than one that fails loudly at boot.

#### 3. Route LLM traffic through the proxy

```bash
curl -X PUT "$TRUEFORGE_BASE_URL/api/v1/settings/model-providers" \
  -H "Content-Type: application/json" \
  -d '{"baseUrl": "'"$INTUTIC_PROXY_URL"'", ...}'
```

Same mechanical routing as embedded mode (step 2 there) — TrueForge's LLM layer reads no env var for this, so the base URL has to be set explicitly, now at the server level rather than per embedding host.

#### 4. Set your MCP server's approval selector to `@all`

This is the step embedded mode does not need an operator to think about (an embedding host wires its own approval loop), and it is the single most consequential setting for how much of your traffic this gate actually sees — see the caveat below.

### What gets written

Nothing, on the TrueForge side — `TRUEFORGE_SERVER` writes no config file (see [How it works](#how-it-works-1)). What "gets written" instead is the bridge's own decision log: every allow/deny verdict is logged structurally (`@intutic/logger`) and reported to the control plane exactly like any other harness's hook-gate call, so a blocked TrueForge tool call shows up on the dashboard the same way a blocked Claude Code or Cursor call does.

### What the adapter does NOT do

Stated plainly, because the gaps are structural — and some of them are more consequential here than in embedded mode, since there is no embedding host controlling the wiring:

- **Coverage depends entirely on your MCP server's approval-tool-selector.** TrueForge's own per-MCP-server config (`McpServerApprovalToolSelector`: `"@all" | "@write" | "@destructive" | <tool name>`) controls whether a tool call ever emits `tool.approval_required` in the first place. An operator who registers an MCP server without `@all` (or an equivalently broad selector) gets tool calls that never pause and that this bridge never sees at all — not a delayed or degraded check, an invisible one. This is TrueForge's own default-scoped design, not a bridge defect, but it is the load-bearing caveat of this entire integration: **the bridge's real coverage is exactly as broad as the selector each MCP server is configured with.**
- **This is a weaker trust boundary than every other Hook (A) mark in this catalog.** Every other in-process or SDK-side gate this product ships runs co-resident with, or embedded in, the harness's own process. This gate runs in a wholly SEPARATE process (`services/trueforge-bridge`) reacting to a pull-only event stream over the network — see [`harness-security-matrix.md`](/reference/harness-security-matrix) row 42, which marks this distinction explicitly rather than reusing the existing ✅/⚠️ symbols without comment.
- **There is no webhook.** TrueForge never pushes anything to the bridge; the bridge must keep its SSE subscription (or poll) alive. A bridge that is down, disconnected, or slow to reconnect misses pauses for that window — same operational risk as any other pull-based watcher, stated here rather than left implicit.
- **Session discovery is intentionally simple.** The bridge watches a configured list of session ids, or discovers sessions via `GET /api/v1/sessions` at startup — it does not dynamically track sessions created after startup unless re-deployed or re-configured to include them.
- **Attribution is the bridge's own, not the calling agent's.** Verdicts are reported under `harnessType: 'trueforge-server'`; there is no finer per-agent/per-thread attribution beyond what the resolved tool call and thread id already carry.

### Config details

| Property | Value |
|----------|-------|
| Harness type | `trueforge-server` |
| Config file | none — not detected by `intutic init`; this is an operator-configured deployment |
| Detection | none (operator-configured; see `HarnessType.TRUEFORGE_SERVER`'s doc comment in `packages/shared-types/src/enums.ts`) |
| Tool gate | Out-of-process (`GateKind: 'bridge'`) — `services/trueforge-bridge`, an Intutic-operated service watching TrueForge's `tool.approval_required`/`user.tool_approval` turn contract over HTTP/SSE; reuses `packages/gate-js`'s `soprules.ts` and `POST /api/v1/hook-gate`, fail-closed |
| Deployment | `services/trueforge-bridge/Dockerfile`; `infra/kubernetes/base/trueforge-bridge/`; `tools/helm/intutic/values.yaml`'s `trueforgeBridge` block |
