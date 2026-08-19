# Anthropic Managed Agents

Integrate Intutic governance with [Anthropic's Managed Agents](https://platform.claude.com/docs/en/agents-and-tools/managed-agents/overview) (public beta since 2026-04-08) — a "session" that Anthropic itself hosts and executes, rather than your own process running the tool-call loop.

::: warning Not detected by `intutic init` / `intutic connect` — no `HarnessType` for this
Managed Agents is architecturally different from every framework in this directory: your code does not execute tool calls directly, so there is no local process, config file, or hook file for `intutic init`/`intutic connect` to write. It is also not detectable the way `strands-agents` or `@openai/agents` are: those are dedicated framework packages whose presence in `requirements.txt`/`package.json` implies "this repo runs an agent tool loop." `anthropic` / `@anthropic-ai/sdk`, by contrast, is used for plain Messages API calls in the overwhelming majority of the codebases that depend on it — its presence says nothing about whether Managed Agents specifically is in use. Auto-detecting this integration from a manifest would therefore be near-meaningless signal, unlike every other SDK-gated adapter in this directory. This page is a wiring guide for your own backend code, the same shape as [Strands](/integrations/strands) or [OpenAI Agents](/integrations/openai-agents) — just with no CLI step.
:::

## Why this is different from every other adapter

Every other SDK-gated adapter in this directory (Strands, OpenAI Agents, LangChain, ...) attaches a hook INSIDE your process's tool-call loop: the gate runs, then the tool body runs, in the same call stack. Managed Agents has no such loop on your side — Anthropic runs it. Your backend receives a stream (or webhook notification) of session **events** and must respond to the ones that pause:

- **`agent.tool_use`** (built-in agent-toolset tools — bash, edit, read, write, glob, grep, web_fetch, web_search) and **`agent.mcp_tool_use`** (MCP-server tools) both carry `evaluated_permission: "allow" | "ask" | "deny"`. A call the server evaluated to `"ask"` — e.g. because the tool's `permission_policy` is `always_ask` — **pauses the whole session** until your backend sends a `user.tool_confirmation` event (`result: "allow" | "deny"` + an optional `deny_message`). Anthropic's own docs: "Denied tools do not run." This is a real, verified pre-execution veto — not an audit log.
- **`agent.custom_tool_use`** — a tool YOUR code implements — has no `evaluated_permission` and no pause concept at all: it always executes in whichever client is listening for its name. This is the one surface that looks like every other adapter in this directory (a local function call you can wrap).
- Self-hosted sessions run built-in agent-toolset tools inside your own `EnvironmentWorker` sandbox — but that sandbox is built on the SAME `agent.tool_use` / confirmation mechanism, so it is covered the same way as a hosted session. What differs is only where the tool BODY executes, not how the pre-execution veto works.

`IntuticSessionConfirmer` (both SDKs) is the piece that answers the pauses: it evaluates `Gate.guard()` and turns the verdict into the real `user.tool_confirmation` wire shape.

## Coverage at a glance

| Surface | Pauses? | How Intutic governs it |
|---|---|---|
| `agent.tool_use` (built-in tools), hosted session | Only if the tool's `permission_policy` is `always_ask` | `IntuticSessionConfirmer` answers the pause with a `Gate.guard()` verdict |
| `agent.tool_use`, **self-hosted** `EnvironmentWorker` | Same as hosted — identical mechanism | Same — `IntuticSessionConfirmer` does not care where the tool body runs |
| `agent.mcp_tool_use` (MCP tools) | Only if the MCP toolset's `permission_policy` is `always_ask` (Anthropic's docs say this is the toolset default — verify against your account) | Same as `agent.tool_use` |
| `agent.custom_tool_use` (your own tools) | Never — no `permission_policy` concept | `wrapManagedAgentsCustomTool`/`wrapManagedAgentsCustomTools` (TS) or `@guard` applied **before** `@beta_tool` (Python) — see below |
| A tool configured `always_allow` | Never | **Not governed by Intutic at all** — the call never reaches your backend as an event to answer. This is an architectural ceiling, not a bug: see [TD-425](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md). Configure the tools you want gated as `always_ask`. |
| The sandbox tool BODY (self-hosted) | N/A | **Not governed** — once a call is allowed, what the tool implementation does inside your `EnvironmentWorker` is outside this adapter's reach, same posture as every adapter toward a framework's built-in tool bodies. |

## Setup — TypeScript

```bash
npm install @intutic/gate @anthropic-ai/sdk
```

### 1. Configure your session's tools to pause

When creating (or updating) the session, set `permission_policy: { type: "always_ask" }` on the tools/toolsets you want Intutic to see. A tool left `always_allow` never reaches Intutic — see the coverage table above.

### 2. Wire the confirmer

```ts
import { Anthropic } from '@anthropic-ai/sdk'
import { Gate, install } from '@intutic/gate'
import { IntuticSessionConfirmer } from '@intutic/gate/managed-agents'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
const client = new Anthropic()

// Right after creating a session, or on a poll/cron loop:
const confirmer = new IntuticSessionConfirmer(client, session.id)
await confirmer.poll() // answers every currently-pending tool_use/mcp_tool_use pause
```

Webhook-driven (recommended for production — no persistent connection needed):

```ts
app.post('/webhooks/anthropic', (req, res) => {
  const event = client.beta.webhooks.unwrap(req.rawBody, { headers: req.headers })
  if (event.data.type === 'session.requires_action') {
    void new IntuticSessionConfirmer(client, event.data.id).poll()
  }
  res.sendStatus(200)
})
```

Or a live stream for a short-lived session (see the module doc for why this is not a reconnecting production loop — [TD-428](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md)):

```ts
for await (const sent of confirmer.watch()) {
  console.log(sent.tool_use_id, sent.result) // 'allow' | 'deny'
}
```

### 3. Gate your custom tools

`agent.custom_tool_use` never pauses (see above), so it is gated at the point YOUR code executes it — not through `IntuticSessionConfirmer`. `BetaRunnableTool` (the shape `SessionToolRunner`/`EnvironmentWorker` dispatch against) exposes `run(args, context)`, not `execute(input)`, so the package's generic `wrapTools()` cannot wrap it directly (it throws rather than silently skipping — but still needs the right helper):

```ts
import { wrapManagedAgentsCustomTools } from '@intutic/gate/managed-agents'

const tools = wrapManagedAgentsCustomTools([myCustomTool, ...builtinTools])
```

## Setup — Python

```bash
pip install intutic-clawde anthropic
```

No optional extra is needed — unlike the framework adapters (`intutic-clawde[strands]`, etc.), this adapter never imports `anthropic` at runtime; it duck-types the client object it's given.

### 1. Configure your session's tools to pause

Same as the TypeScript section above — set `permission_policy` to `always_ask` on whichever tools/toolsets you want Intutic to see.

### 2. Wire the confirmer

```python
from anthropic import Anthropic
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.managed_agents import IntuticSessionConfirmer

install(Gate(GateConfig()))
client = Anthropic()

confirmer = IntuticSessionConfirmer(client, session.id)
confirmer.poll()  # answers every currently-pending tool_use/mcp_tool_use pause
```

Webhook-driven:

```python
@app.post("/webhooks/anthropic")
def handle_webhook(request):
    event = client.beta.webhooks.unwrap(request.body, headers=request.headers)
    if event.data.type == "session.requires_action":
        IntuticSessionConfirmer(client, event.data.id).poll()
    return "", 200
```

Or a live stream (same non-reconnecting caveat as the TS side):

```python
for sent in confirmer.watch():
    print(sent["tool_use_id"], sent["result"])  # 'allow' | 'deny'
```

### 3. Gate your custom tools — decorator order matters

`agent.custom_tool_use` never pauses, so gate it at the point your code executes it: apply `@guard` **directly to the underlying function, before** `@beta_tool` wraps it. Applying `guard_tools()`'s generic `.func`-patch AFTER `@beta_tool` has already wrapped the function is a **silent no-op** — verified against `anthropic`'s real source; `BetaFunctionTool.call()` invokes a pydantic-validated copy of the function captured at construction time, not the `.func` attribute `guard_tools()` patches. See [TD-427](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md).

```python
from anthropic.lib.tools import beta_tool
from intutic_clawde.gate import guard

@beta_tool
@guard                      # innermost: gate wraps the raw function first
def read_internal_doc(doc_id: str) -> str:
    ...
```

## Fail-closed posture

Matches every other Intutic adapter: no gate configured, or an unexpected exception out of `Gate.guard()`, both produce a `"deny"` confirmation — never a silently-allowed, unevaluated call.

## LLM egress and ZDR

Routing your OWN calls to the Messages API through the Intutic proxy is unrelated to this integration — set `ANTHROPIC_BASE_URL` as usual. Managed Agents itself is **not currently eligible for ZDR/HIPAA**, and the Intutic proxy's own wire-shape parser does not understand the Managed Agents "sessions" protocol — this adapter closes the governance-side gap (the confirmation veto), not raw proxy passthrough for session traffic.

## Known gaps

See `docs/TECH_DEBT.md` entries TD-425 through TD-429 for the coverage boundaries (`always_allow` tools are invisible to Intutic; built-in tools' default `permission_policy` is not encoded in the SDK — verify live), the Python custom-tool decorator-order gotcha, `watch()`'s non-reconnecting scope, and this integration's beta-product churn shield.
