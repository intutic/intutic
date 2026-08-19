# Vercel AI SDK

Integrate Intutic governance with the [Vercel AI SDK](https://ai-sdk.dev/) (`ai`, v6+).

The Vercel AI SDK is governed on two independent surfaces, and — unlike almost every other harness in this catalog — **only one of them can be wired up without touching your code:**

1. **Local tool execution** — SDK-side, via `toolApproval`. Wire this into `generateText`/`streamText`/`ToolLoopAgent` and it governs every tool call.
2. **LLM egress** — **in-code only.** Read the limitation below before assuming this "just works" the way it does for every other harness.

## Known, plain limitation: no environment-variable LLM routing

Every other harness in this codebase that governs LLM egress does so by honouring `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` (or an equivalent), which `.env.intutic`/`intutic exec` sets for you with zero code changes. **The Vercel AI SDK has no such mechanism.** Its providers (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) are constructed directly in your code, and the base URL they call is a constructor option, not an environment variable the SDK reads on its own.

This means: `.env.intutic`'s `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`INTUTIC_PROXY_URL` vars are written (a workspace may run other harnesses that DO honour them, and you're free to read them yourself), but sourcing that file does **nothing** to route Vercel AI SDK's own LLM calls through the Intutic proxy. Routing requires **in-code provider construction** — every place your application constructs a model provider must point it at the proxy explicitly. `withIntuticProxy()` (below) is a small wrapper for that; it is not a way to avoid it.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • vercel-ai-sdk → .env.intutic
```

Detection requires `ai` at major version 6 or above (the `toolApproval` API this integration relies on is a v6+ surface) **and** at least one `@ai-sdk/*` provider package — `ai` alone declares the tool-loop surface but ships no model provider.

### 2. Route LLM traffic through the proxy (in code — this is the only way)

```bash
npm install @intutic/gate
```

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { withIntuticProxy } from '@intutic/gate/vercel'

// Every provider construction call site in your app needs this —
// there is no ambient env var that achieves the same effect.
const openai = withIntuticProxy(createOpenAI)({ apiKey: process.env.OPENAI_API_KEY })
const model = openai('gpt-5-mini')
```

`withIntuticProxy()` resolves the proxy URL the same way every other harness's env-writer does (`INTUTIC_PROXY_URL`, falling back to `http://localhost:4000`) and passes it as `baseURL` to whatever provider factory you give it — `createOpenAI`, `createGateway`, or any compatible `@ai-sdk/*` `create*` export.

### 3. Gate local tool execution (SDK)

The `ai` package exposes a documented pre-execution veto point — a `toolApproval` callback accepted by `generateText`, `streamText`, and `ToolLoopAgent` — which `intuticToolApproval()` implements:

```ts
import { generateText } from 'ai'
import { Gate, install } from '@intutic/gate'
import { intuticToolApproval } from '@intutic/gate/vercel'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

await generateText({
  model,
  tools,
  toolApproval: intuticToolApproval(),
})
```

On allow, this resolves to `'not-applicable'` — this gate has no opinion, and any other approval mechanism you've configured (e.g. a human-in-the-loop `'user-approval'` status for a specific tool) still applies. On deny, it resolves to `{ type: 'denied', reason }`, where `reason` is the `[Intutic Governance] BLOCKED: ...` message the SDK hands back to the model in place of a tool result — the tool's real implementation never runs.

### 4. Trace attribution

```ts
import { intuticHeaders } from '@intutic/gate'

const openai = withIntuticProxy(createOpenAI)({
  apiKey: process.env.OPENAI_API_KEY,
  headers: intuticHeaders({ sessionId: runId, harness: 'vercel-ai-sdk' }),
})
```

## What gets written

Same `.env.intutic` shape as every other SDK-gated framework — proxy URLs plus a pointer at `@intutic/gate/vercel`. **Unlike** the Python-SDK-gated family (LangChain, LangGraph, ...), sourcing this file does not route this framework's own LLM egress — see the limitation above.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires wiring the SDK into your own agent code, and `x-intutic-harness` attribution is client-supplied, not authorization. On top of that structural family, this integration is **not** "zero-code" for LLM-egress routing the way the rest of the catalog is — see the limitation above, stated plainly rather than oversold.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `vercel-ai-sdk` |
| Config file | `.env.intutic` |
| Detection | `ai` at major version ≥ 6, plus any `@ai-sdk/*` package, in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`) |
| Format | Shell environment variables (LLM-egress vars are inert for this framework unless read explicitly — see above) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/vercel`'s `intuticToolApproval()`, the `ai` package's `toolApproval` option) — no sync-daemon hook file |
| LLM-egress routing | In-code only (`@intutic/gate/vercel`'s `withIntuticProxy()`) — no environment-variable override exists for this framework |
