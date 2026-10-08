# eve <Badge type="warning" text="Preview" />

Integrate Intutic governance with [eve](https://github.com/vercel/eve) — Vercel's filesystem-first framework for **durable backend AI agents** (npm `eve`). An eve agent is a directory: `agent/` with `instructions.md`, `agent/tools/*.ts`, `agent/connections/*.ts`, `agent/hooks/*.ts`, which eve builds by walking the tree and compiles to Vercel Functions (with a local dev TUI).

::: warning PREVIEW — breaking changes possible
eve is a pre-1.0, fast-moving product (built against `eve@0.39.1`; 0.71.0 shipped about six weeks later). `@intutic/gate/eve` is verified against a **pinned** real install of `eve@0.71.0` — its shipped type definitions and its runtime `defineTool`/`defineMcpClientConnection`/`defineHook` machinery — not against docs alone, matching the churn-shield posture the [dsh](/integrations/dsh) integration established. It was also run end to end on a self-hosted `eve build` + `eve start` server (local Workflow world, local sandbox) with a scripted model and no account or keys, on both 0.39.1 and 0.71.0. eve 0.71 requires `ai` 7.0.105 or later. The results are in the sections below. A preview product can still change its `approval` contract or hook event shapes out from under a pinned integration. See TD-410/TD-411/TD-412 in [TECH_DEBT.md](https://github.com/intutic/intutic/blob/main/docs/TECH_DEBT.md) for exactly what was confirmed and what remains open.
:::

eve is governed on three surfaces — two enforcing, one observing — and, like the [Vercel AI SDK](/integrations/vercel-ai-sdk) it is built on (`ai` v7), **LLM-egress routing is in-code only, and eve's default routing path cannot be proxied at all** (see the limitation below).

## How it works

eve's own pre-execution veto point is the `approval` property: every authored tool (`defineTool`) and every MCP/OpenAPI connection (`defineMcpClientConnection`/`defineOpenAPIConnection`) accepts an approval policy — an async function receiving `{ toolName, toolInput, approvedTools, callId, abortSignal }` plus the session context, returning an AI SDK 7 approval status. `{ type: 'denied', reason }` vetoes the call before it runs and hands `reason` to the model in place of a tool result; `'user-approval'` durably parks the run for a human; `'not-applicable'` continues without a prompt.

**There is no agent-level default approval field** (verified against eve's shipped types — the agent definition carries none), so governance is attached per tool and per connection. That is not an Intutic workaround: a shared policy function reused across tools and connections is eve's own documented [multi-tenant approvals pattern](https://github.com/vercel/eve/blob/main/docs/patterns/multi-tenant-approvals.md) — `@intutic/gate/eve` exports exactly that shape.

## Setup

### 1. Detection

An eve app is detected by a **compound** check — both must hold:

- `eve` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`), **and**
- the characteristic `agent/` directory at the workspace root.

Either alone is deliberately not enough (`agent/` is too generic a directory name, and a bare `eve` dependency is not an eve app).

```bash
intutic init
```

```
  ✔ eve → .env.intutic
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Gate authored tools (SDK)

```bash
npm install @intutic/gate
```

```ts
// agent/tools/refund_charge.ts
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { intuticApproval } from '@intutic/gate/eve'

export default defineTool({
  description: 'Refund a charge.',
  inputSchema: z.object({ chargeId: z.string(), amount: z.number() }),
  approval: intuticApproval(),
  async execute(input) {
    return refund(input)
  },
})
```

Install the gate once, process-wide (e.g. from `agent.ts` or a shared `agent/lib/` module):

```ts
import { Gate, install } from '@intutic/gate'
install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
```

On allow, `intuticApproval()` resolves to `'not-applicable'` — eve's own "no prompt needed" value, the same behaviour as an omitted `approval`. On deny, it resolves to `{ type: 'denied', reason }` with the `[Intutic Governance] BLOCKED: ...` message; the tool's `execute` never runs.

Observed on a live `eve start` server (`eve@0.39.1` and `eve@0.71.0`, same results):

- eve calls the policy before `execute`. On a denial the model receives an `execution-denied` result that carries the BLOCKED reason.
- If the gate crashes with a non-refusal error, the policy throws and eve reports the turn as `failed`. The tool never runs, and eve parks the session so the user can retry.
- When a call parked for `'user-approval'` is resumed, eve calls the policy again before executing it, including after a server restart. A human approval therefore cannot override a policy that has since started denying the call: the resumed call is refused.

Want eve's human-in-the-loop flow **on top of** governance? Pass `{ onAllow: 'user-approval' }` — deny stays deny, but every governance-allowed call still parks for a person. For conditional flows (eve's `once()`, your own tenant policy), compose:

```ts
import { once } from 'eve/tools/approval'
import { intuticApproval } from '@intutic/gate/eve'

const intutic = intuticApproval()

// inside defineTool({ ... }):
approval: async (ctx) => {
  const verdict = await intutic(ctx)
  if (typeof verdict === 'object' && verdict?.type === 'denied') return verdict
  return once()(ctx) // your own flow decides the rest
},
```

`intuticApproval()` deliberately never resolves `'approved'`: that status asserts an affirmative sign-off this gate did not make (Intutic's allow is "no objection"), and auto-approving would bypass any human flow you meant to keep.

### 3. Gate MCP / OpenAPI connections

A connection's single `approval` gates **all** of that connection's tools:

```ts
// agent/connections/support.ts
import { defineMcpClientConnection } from 'eve/connections'
import { intuticConnectionApproval } from '@intutic/gate/eve'

export default defineMcpClientConnection({
  url: 'https://support.example.com/mcp',
  description: 'Support tickets.',
  approval: intuticConnectionApproval(),
})
```

Connection tool names arrive **qualified** (`support__add_internal_note` — connection slug + `__` + remote tool name, eve's own convention), and the qualified name is what the gate evaluates — SOP rules and snapshot `tool:` subjects must match it. The prefix is deliberately not stripped: two connections' same-named remote tools must not collapse into one rule target.

### 4. Audit eve's human-approval lifecycle (observe-only)

```ts
// agent/hooks/intutic-audit.ts
import { defineHook } from 'eve/hooks'
import { intuticAuditHooks } from '@intutic/gate/eve'

export default defineHook(intuticAuditHooks())
```

This subscribes to eve's `input.requested`/`approval.candidate`/`approval.settled`/`input.resolved` stream events and maps them onto Intutic's event vocabulary: an **approved** settlement emits `tool_allowed`. A responder's **cancel** (`approval.settled`) or **deny** (`input.resolved`) emits `tool_blocked`, labelled as a human veto, not a gate refusal. Other candidate or resolution outcomes emit `tool_flagged`: `rejected`/`failed`/`timed-out`/`stale`, and `ignored`/`invalid`/`cancelled`. An `input.resolved` outcome of `cancelled` (new in 0.71) means the request was withdrawn unanswered, because its turn was cancelled or the run relaying it ended; nobody decided it, so it is flagged rather than recorded as a veto. Three notes:

- eve hooks are **observe-only by eve's own contract** — they fire after events are durably recorded and cannot veto or rewrite a tool call. (Since 0.39.1 a hook can call `ctx.cancel()` to cancel the whole running turn; `intuticAuditHooks()` never does.) This is telemetry for the dashboard, not enforcement; enforcement is step 2/3.
- eve's `approval.candidate`/`approval.settled` events themselves **do not carry the tool name or input** (verified against the shipped protocol types) — but `intuticAuditHooks()` also subscribes to eve's third hookable event, `input.requested`, which fires once per batch of human-input requests and carries `requestId` AND `action.toolName` together for each one (confirmed against the shipped `InputRequest` zod schema). It emits a real, tool-identified `tool_flagged` at request time, and best-effort caches `requestId -> toolName` in memory so the LATER `approval.candidate`/`approval.settled`/`input.resolved` events also attribute to the real tool name — as long as that cache is still warm (same process, not yet evicted). When it is not — a genuinely long-parked, cross-restart approval, which eve's own docs confirm can survive a process restart — settlement falls back to the synthetic tool name `eve:approval` with the request id in the reason, exactly the prior behaviour, never worse.
- **Both approval forms are audited at settlement.** In `eve@0.39.1` and `eve@0.71.0`, `approval.candidate` and `approval.settled` are emitted only for the configuration form, `approval: { request, response }`. A bare policy function, such as `approval: intuticApproval(...)`, settles through `input.resolved` instead, which carries the request id and outcome but no responder. `intuticAuditHooks()` reads both. The configuration form fires both events for the same request, `approval.settled` first, and the hook records that settlement once, from `approval.settled`, which also names the responder. The configuration form, with the gate as the request policy, looks like this:

  ```ts
  approval: {
    request: intuticApproval({ onAllow: 'user-approval' }),
    // decide whether ctx.response.principal may answer; since eve 0.71 this also
    // runs for a cancel (ctx.response.decision is 'approve' | 'cancel')
    response: async (ctx) => ({ status: 'allowed' }),
  },
  ```

  A pending call in this form is answered with structured `inputResponses` (`{ requestId, optionId: 'approve' }`). eve 0.39.1 did not accept a text "approve" for it; that was not re-checked on 0.71. In live runs on both versions the events arrived in this order: `input.requested` when the call parked, then `approval.candidate` (`pending`), `approval.settled` and `input.resolved` when the responder answered. In the same process, the settlement was attributed to the real tool name. After a SIGKILL and restart between the two, it was attributed to `eve:approval`, as described above. `input.requested` was not re-delivered after the restart. A bare-policy approval resumed after a restart was recorded the same way, as one `tool_allowed` under `eve:approval`.

## Known, plain limitation: LLM egress

eve selects models in `agent.ts` (`defineAgent({ model })`) two ways, and only one is governable:

1. **AI Gateway model id string** (the default; e.g. `model: "anthropic/claude-opus-4.8"`, `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` credentials). The gateway's wire protocol is **not something the Intutic proxy parses** — gateway-routed LLM traffic is not governed by the proxy, full stop. Documented, not glossed over: see TD-412.
2. **A provider-authored `LanguageModel` built in code** (`createOpenAI(...)` etc.). This is the plain Vercel AI SDK path, and the same helper applies — there is no env-var base-URL override:

```ts
// agent.ts
import { defineAgent } from 'eve'
import { createOpenAI } from '@ai-sdk/openai'
import { withIntuticProxy } from '@intutic/gate/eve' // re-export of @intutic/gate/vercel's helper

const openai = withIntuticProxy(createOpenAI)({ apiKey: process.env.OPENAI_API_KEY })

export default defineAgent({
  model: openai('gpt-5-mini'),
})
```

The `.env.intutic` this integration writes says the same thing in its pointer comment rather than pretending the base-URL vars route eve on their own.

## What gets written

Same `.env.intutic` shape as every other JS/TS SDK-gated framework — proxy URLs plus a pointer at `@intutic/gate/eve`. Sourcing it does **not** route eve's own LLM egress (see the limitation above) and does not gate tools — the blocking gate is the `approval` policies you attach in `agent/`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus eve-specific ones, stated plainly:

- **No agent-level attach point.** A tool or connection whose definition omits `approval: intuticApproval(...)` is unguarded — there is no global default field to set and no build-step rewriting of your `agent/` directory. Coverage is exactly the tools/connections you attach it to.
- **Framework default tools** (eve's built-in bash/file tools, `ask_question`, etc.) ship with their own definitions; gating one means overriding it in `agent/tools/` with an `approval` attached.
- **Verified live on a self-hosted server only.** The checks above ran on `eve build` + `eve start` with the default local Workflow world (`.eve/.workflow-data`), the just-bash sandbox, and a scripted `LanguageModel`, with no account or keys. Not exercised: a Vercel deployment (Vercel Workflow world, Vercel Sandbox and its snapshot and network policy), a real model provider or the AI Gateway, and `intuticConnectionApproval()` against a live MCP connection (TD-411).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `eve` |
| Config file | `.env.intutic` |
| Detection | `eve` in `package.json` **AND** an `agent/` directory at the workspace root (compound — either alone does not detect) |
| Format | Shell environment variables (LLM-egress vars are inert for eve's own model calls — see the limitation above) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/eve`'s `intuticApproval()` / `intuticConnectionApproval()` on eve's per-tool/per-connection `approval` policies) — no sync-daemon hook file |
| Audit | `intuticAuditHooks()` on eve's `input.requested`/`approval.candidate`/`approval.settled`/`input.resolved` hook events — observe-only, real tool-name attribution when the in-memory `requestId -> toolName` cache is warm, falling back to request-scoped (synthetic `eve:approval`) attribution when it is not. A bare policy settles through `input.resolved`, the `{ request, response }` form through both `approval.settled` and `input.resolved`; each settlement is recorded once |
| LLM-egress routing | In-code direct-provider path only (`withIntuticProxy(...)`); AI Gateway routing (eve's default) is not proxy-governable — TD-412 |
| Status | **Preview** — pinned verification against `eve@0.71.0` (previously 0.39.1); see TD-410 |
