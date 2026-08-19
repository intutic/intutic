# Mastra

Integrate Intutic governance with [Mastra](https://mastra.ai/) agents.

Mastra is governed on two independent surfaces:

1. **LLM egress** — point the model client's `baseURL` at the Intutic proxy (or launch under `intutic exec`). Every LLM call crosses the proxy and is governed like any other harness.
2. **Local tool execution** — Mastra tools run as plain objects inside *your own* Node.js process. No config or hook file can gate them, so the blocking gate ships SDK-side, in `@intutic/gate/mastra`.

## How it works

The `mastra` adapter is detected when `package.json` declares an `@mastra/core` dependency (any version). Like every other SDK-gated framework in this codebase, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • mastra → .env.intutic
```

### 2. Route LLM traffic through the proxy

Source the generated env file, launch under `intutic exec`, or set the model provider's `baseURL` explicitly — Mastra reads whatever base URL the provider you construct is given.

### 3. Gate local tool execution (SDK)

```bash
npm install @intutic/gate
```

Mastra exposes a documented pre-execution veto point — an `Agent`'s `hooks.beforeToolCall` — which `intuticHooks()` implements:

```ts
import { Agent } from '@mastra/core/agent'
import { Gate, install } from '@intutic/gate'
import { intuticHooks } from '@intutic/gate/mastra'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const agent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  model: 'openai/gpt-5-mini',
  tools: { deleteTool, shellTool },
  hooks: intuticHooks(),
})
```

On deny, `beforeToolCall` returns `{ proceed: false, output }` — Mastra skips the tool's real `execute` entirely and hands `output` back to the model in its place. The default `output` shape is `{ error: true, message, code, incidentId? }`; if one of your tools declares a strict Zod `outputSchema`, pass a `denialOutput` shaper so the refusal still validates:

```ts
intuticHooks({
  denialOutput: ({ toolName, refusal }) => ({ deleted: false, reason: refusal.message }),
})
```

This hook runs for every tool in the agent's assembled tool dictionary — natively defined tools and MCP-sourced tools (registered through `@mastra/mcp`) alike, since both are merged into the same tool record before hooks wrap it.

### 4. Trace attribution

```ts
import { intuticHeaders } from '@intutic/gate'

// pass intuticHeaders({ sessionId: runId, harness: 'mastra' }) as defaultHeaders
// on whatever client/provider you construct for the model
```

## What gets written

Same shape as every other SDK-gated framework's `.env.intutic` — proxy URLs plus a pointer at `@intutic/gate/mastra`'s `intuticHooks()`.

## Known bypass: per-call `hooks` override, not merge

**This is Mastra's own documented behaviour, not an Intutic defect — but it is a real gap operators need to know about.** `new Agent({ hooks: intuticHooks() })` installs this gate at the agent level. However, if any caller of that agent's `.generate()`/`.stream()` passes its own `hooks` option — even `{}`, or a `hooks` object with no `beforeToolCall` — Mastra **replaces** the agent-level hooks wholesale for that call. There is no merging: the agent-level `intuticHooks()` silently does not run, with no error and no warning.

If your application code passes call-level `hooks` anywhere, compose this gate into that call's hooks yourself:

```ts
const intutic = intuticHooks()
await agent.generate(prompt, {
  hooks: {
    beforeToolCall: async (ctx) => {
      const denied = await intutic.beforeToolCall(ctx)
      if (denied) return denied
      return myOwnBeforeToolCall(ctx)
    },
  },
})
```

Confirmed against a real install (`@mastra/core@1.59.0`): `Agent.getConfiguredToolHooks()`'s own doc comment states "Run-level hooks override these ... callers that need to preserve the configured hooks must read and compose them explicitly." See `docs/TECH_DEBT.md` TD-380 and `@intutic/gate/mastra`'s module doc for the full record.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do"). In short: there is no sync-daemon hook file, argument-level gating requires wiring the SDK into your own agent code, and `x-intutic-harness` attribution is client-supplied, not authorization. On top of that structural family, Mastra adds the per-call-hooks-override bypass above, which is specific to this framework's own hook design.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `mastra` |
| Config file | `.env.intutic` |
| Detection | `@mastra/core` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`) |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/mastra`'s `intuticHooks()`, Mastra's `Agent.hooks.beforeToolCall`) — no sync-daemon hook file; see the per-call-hooks-override bypass above |
