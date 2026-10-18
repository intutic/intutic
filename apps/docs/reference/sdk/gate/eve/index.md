[@intutic/gate](../index.md) / eve

# @intutic/gate/eve

eve adapter: `intuticApproval()`, `intuticConnectionApproval()`,
`intuticAuditHooks()`.

`@intutic/gate/eve` — a framework-specific specialization of the same idea
`wrapTools.ts` implements generically (see that file's module doc): wrap the
framework's own veto point around this package's `Gate.guard()`.

eve (npm `eve`, github.com/vercel/eve) is Vercel's filesystem-first
framework for durable backend AI agents: an agent is a directory (`agent/`
with `instructions.md`, `agent/tools/*.ts`, `agent/connections/*.ts`,
`agent/hooks/*.ts`, ...) that eve builds by walking the tree. It is a
pre-1.0 PREVIEW product (integrated at 0.39.1, re-verified at 0.71.0; very active) —
this adapter carries a churn shield (structural copies of eve's types,
re-checked against the real ones on every eve upgrade), the same posture
the dsh integration established.

## The veto mechanism — CONFIRMED against a real install, not assumed

`eve@0.71.0` is installed as a devDependency of this package and its
shipped `.d.ts` files were read directly (not inferred from docs alone;
first against 0.39.1, re-read for 0.71.0 — paths below are 0.71.0's).
eve's per-tool veto point is the `approval` property on a tool definition
(`dist/src/tools/definition.d.ts`), and the same `Approval` type is
accepted per-connection by `defineMcpClientConnection` /
`defineOpenAPIConnection` (`dist/src/public/definitions/connections/
{mcp,openapi}.d.ts`), gating ALL of that connection's tools. There is NO
agent-level default approval field (`agent.d.ts` carries zero approval
fields — verified) — attaching a shared policy per tool/connection is
eve's own documented multi-tenant pattern
(`docs/patterns/multi-tenant-approvals.md`), and exactly the shape this
adapter exports.

The confirmed policy contract (`dist/src/approval/definition.d.ts`,
re-exported by `dist/src/public/definitions/approval.d.ts` and
`eve/tools/approval`):

```ts
export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
  readonly abortSignal: AbortSignal                 // added after 0.39.1; unused here
  readonly approvedTools: ReadonlySet<string>
  readonly callId: string
  readonly toolInput?: ApprovalToolInput<TInput>   // Readonly<TInput> | TInput; CAN be undefined
  readonly toolName: string
}
export type ApprovalStatus = undefined | boolean
  | 'not-applicable' | 'approved' | 'denied' | 'user-approval'
  | { readonly type: 'not-applicable'; readonly reason?: never }
  | { readonly type: 'approved'; readonly reason?: string }
  | { readonly type: 'denied'; readonly reason?: string }
  | { readonly type: 'user-approval'; readonly reason?: never }
export type ApprovalPolicy<TInput = Record<string, unknown>> =
  (ctx: ApprovalContext<TInput>) => ApprovalStatus | Promise<ApprovalStatus>
```

These are AI SDK 7 approval statuses (eve is built on `ai` v7 — the same
family `vercel.ts` documents). `'denied'` / `{ type: 'denied', reason }`
vetoes the call before execution; `reason` reaches the model in place of a
tool result. `'not-applicable'` (and `undefined`) means "continue without a
prompt"; `'user-approval'` parks the run durably for a human. The boolean
forms are back-compat for eve's earlier predicate shape: `true` is treated
as `'user-approval'` and `false` as `'not-applicable'` (confirmed in
`docs/tools/human-in-the-loop.md`) — this adapter never RETURNS booleans,
but its structural [EveApprovalStatus](#eveapprovalstatus) copy includes them so the type
stays field-for-field faithful to the real union.

## Allow-shape: why `'not-applicable'` and not `'approved'`

Unlike the Vercel AI SDK's `toolApproval` (a separate, whole-run config
that coexists with per-tool mechanisms), eve's `approval` IS the tool's one
approval policy — whatever this function returns is the whole decision for
that call. On allow this adapter returns `'not-applicable'` by default:
eve's own "no prompt needed, continue" value, matching the semantics of an
omitted `approval` (`never()`). It deliberately does NOT return
`'approved'`: that value asserts an affirmative approval decision this gate
did not make (Intutic's allow is "no objection", not "signed off"), and its
interaction with eve's `approvedTools` bookkeeping (`once()` keys off that
set) is not something this adapter verified. Callers who want eve's human
flow ON TOP of the governance gate set `{ onAllow: 'user-approval' }` —
"governance has no objection; still ask a person" — or compose manually
(see [intuticApproval](#intuticapproval)).

## Audit hooks — observe-only, and honestly scoped

eve's hook surface (`agent/hooks/*.ts`, `dist/src/public/definitions/
hook.d.ts`) exposes `approval.candidate` / `approval.settled` stream
events. Handlers are OBSERVE-ONLY by eve's own contract ("fire after eve
has accepted and durably recorded each event ... cannot inject model
context") — [intuticAuditHooks](#intuticaudithooks) is telemetry, not enforcement; the
enforcement surface is [intuticApproval](#intuticapproval). (Since 0.39.1 a hook may
call `ctx.cancel()` to cancel the whole running turn, but it still cannot
veto or rewrite one tool call, and it runs after the event is recorded;
this adapter never calls it.) LOAD-BEARING caveat,
verified against `dist/src/protocol/message.d.ts`: these two events carry
`requestId`/`responderPrincipalId`/`turnId`/`stepIndex` but NOT the tool
name or input.

Recovering the tool name: `intuticApproval()` and `intuticAuditHooks()` are
both plain functions exported from this one module and cannot be assumed to
run in the same process at settlement time — eve's own docs state a parked
approval survives a process restart verbatim ("the process can restart and
the parked turn survives", `docs/tools/human-in-the-loop.md`), so a
`requestId -> toolName` map populated at approval-decision time and read
back later inside the hook would silently degrade for exactly the durable,
long-parked approvals this mechanism exists for — the worst kind of fix,
correct in local testing and quietly wrong in the deployments that matter
most. That map was NOT built.

What WAS found and built instead needs no cross-call memory at all: eve
ships a THIRD hookable event, `input.requested` (confirmed in the same
`HookEventMap`, `dist/src/public/definitions/hook.d.ts`), fired once when a
batch of human-input requests is created — including every `kind:
'tool-approval'` request `intuticApproval()`'s `'user-approval'` return
value produces. Each request in that ONE event already carries
`requestId` AND `action.toolName` TOGETHER (`InputRequest`,
`dist/src/shared/input.d.ts`'s `inputRequestSchema` — confirmed by
the shipped zod schema, not just prose; corroborated by
`docs/tools/human-in-the-loop.md`'s explicit statement that "`toolName` and
`requestId` identify the action and request"). [intuticAuditHooks](#intuticaudithooks)
now subscribes to it too: it emits a real, tool-identified `tool_flagged`
event at REQUEST time (closing the "no tool identity" gap unconditionally,
with no process-boundary risk — the whole payload arrives in one event),
and best-effort caches `requestId -> toolName` in memory so the LATER
`approval.candidate`/`approval.settled` events attribute to the real tool
name too WHEN this cache is still warm (same-process, or a short-lived
pause). When it is not — a genuinely long-parked, cross-restart approval —
settlement still falls back to the synthetic [EVE\_APPROVAL\_TOOL\_NAME](#eve-approval-tool-name),
exactly the pre-existing behaviour, never worse. Closing that residual gap
would take a persistent (non-memory) correlation store.

A live `eve start` run showed that `approval.candidate`/
`approval.settled` fire ONLY for the `approval: { request, response }`
form. The bare form this adapter documents (`approval: intuticApproval()`)
settles through a fourth hookable event, `input.resolved` (`HookEventMap`,
payload `InputResolvedStreamEvent` in `dist/src/protocol/message.d.ts`:
`resolutions[]` of `{ kind, outcome, requestId, response? }`, no tool name).
[intuticAuditHooks](#intuticaudithooks) subscribes to it as well, so bare-policy
settlements are audited, with the same cache-or-synthetic tool naming; the
`{ request, response }` form fires both events and is recorded once. eve
0.71 added the `'cancelled'` outcome: a pending request withdrawn because
its turn was cancelled (or the relaying run ended) before anyone answered.

## LLM egress — documented honestly, not oversold

eve routes models through the Vercel AI Gateway by default (a gateway model
id string in `agent.ts`'s `defineAgent({ model })`, `AI_GATEWAY_API_KEY` /
`VERCEL_OIDC_TOKEN` credentials — confirmed in `docs/agent-config.md` and
`docs/getting-started.mdx`). The AI Gateway wire protocol is NOT something
the Intutic proxy parses, so gateway-routed egress is ungoverned by the
proxy — full stop. The governable path is eve's
other documented option: passing a provider-authored `LanguageModel`
(`createOpenAI(...)` etc.) to `defineAgent({ model })`, where the
`withIntuticProxy()` helper — implemented once in `vercel.ts` and
re-exported here — applies exactly as it does for the plain Vercel AI SDK.
As with that framework, there is no env-var base-URL override: routing is
in-code, per provider-construction call site.

## Interfaces

### EveApprovalCandidateEvent

Structural copy of eve's `ApprovalCandidateStreamEvent` — the
 `approval.candidate` payload (`dist/src/protocol/message.d.ts`). Note:
 no tool name/input fields exist on this event (see module doc).

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-data"></a> `data` | `readonly` | `object` |
| `data.candidateId` | `readonly` | `string` |
| `data.outcome` | `readonly` | `"failed"` \| `"stale"` \| `"pending"` \| `"rejected"` \| `"timed-out"` |
| `data.reason?` | `readonly` | `string` |
| `data.requestId` | `readonly` | `string` |
| `data.responderPrincipalId` | `readonly` | `string` |
| `data.sequence` | `readonly` | `number` |
| `data.stepIndex` | `readonly` | `number` |
| `data.turnId` | `readonly` | `string` |
| <a id="property-type"></a> `type` | `readonly` | `"approval.candidate"` |

***

### EveApprovalContext

Structural copy of the slice of eve's `ApprovalContext` this adapter
 reads (`toolName`, `toolInput`). The real context is wider — it extends
 `SessionContext` and also carries `approvedTools`/`callId`/`abortSignal`
 — so the real type is assignable to this one, which is what makes a policy declared
 against this slice assignable to eve's own `ApprovalPolicy`.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-toolinput"></a> `toolInput?` | `readonly` | `unknown` | Parsed tool input. eve documents this CAN be undefined; a non-object is also possible for non-record input schemas — see renderEveToolInput's handling. |
| <a id="property-toolname"></a> `toolName` | `readonly` | `string` | Final runtime tool name. Path-derived for authored tools (`agent/tools/refund_charge.ts` → `refund_charge`); QUALIFIED for connection tools (`billing__updateSubscription`) — see [intuticConnectionApproval](#intuticconnectionapproval). |

***

### EveApprovalSettledEvent

Structural copy of eve's `ApprovalSettledStreamEvent` — the terminal
 durable settlement for one approval request.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-data-1"></a> `data` | `readonly` | `object` |
| `data.outcome` | `readonly` | `"approved"` \| `"cancelled"` |
| `data.requestId` | `readonly` | `string` |
| `data.responderPrincipalId` | `readonly` | `string` |
| `data.sequence` | `readonly` | `number` |
| `data.stepIndex` | `readonly` | `number` |
| `data.turnId` | `readonly` | `string` |
| <a id="property-type-1"></a> `type` | `readonly` | `"approval.settled"` |

***

### EveAuditHookDefinition

The `{ events }` object [intuticAuditHooks](#intuticaudithooks) returns — structurally
 a valid eve `HookDefinition`, accepted by `defineHook` as-is.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-events"></a> `events` | `readonly` | `object` |
| `events.approval.candidate` | `readonly` | (`event`, `ctx`) => `Promise`\<`void`\> |
| `events.approval.settled` | `readonly` | (`event`, `ctx`) => `Promise`\<`void`\> |
| `events.input.requested` | `readonly` | (`event`, `ctx`) => `Promise`\<`void`\> |
| `events.input.resolved` | `readonly` | (`event`, `ctx`) => `Promise`\<`void`\> |

***

### EveHookContext

Structural slice of eve's `HookContext` this adapter reads. The real
 context is wider (extends `SessionContext`, `agent.name` required) — the
 real type is assignable to this one.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-agent"></a> `agent?` | `readonly` | `object` |
| `agent.name` | `readonly` | `string` |
| <a id="property-session"></a> `session` | `readonly` | `object` |
| `session.id` | `readonly` | `string` |

***

### EveInputRequest

Structural copy of one element of eve's `InputRequestedStreamEvent.data.requests`
(`InputRequest`, `dist/src/shared/input.d.ts`'s `inputRequestSchema`,
read from the shipped zod schema, not just its `.d.ts`) — narrowed to the
fields this module reads. Unlike [EveApprovalCandidateEvent](#eveapprovalcandidateevent) /
[EveApprovalSettledEvent](#eveapprovalsettledevent), this DOES carry the real tool name
(`action.toolName`) alongside `requestId`, in the same object.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-action"></a> `action?` | `readonly` | `object` | Required in the real shipped schema for every `kind`; kept optional here since this module only trusts it for `kind: 'tool-approval'` and a structural copy should not assume more than it reads. |
| `action.callId` | `readonly` | `string` | - |
| `action.input?` | `readonly` | `unknown` | - |
| `action.toolName` | `readonly` | `string` | - |
| <a id="property-kind"></a> `kind` | `readonly` | `"question"` \| `"session-limit"` \| `"tool-approval"` | - |
| <a id="property-requestid"></a> `requestId` | `readonly` | `string` | - |

***

### EveInputRequestedEvent

Structural copy of eve's `InputRequestedStreamEvent` — a REAL hookable
 `HookEventMap` key (`'input.requested'`, `dist/src/public/definitions/
 hook.d.ts`), fired once per batch of pending human-input requests.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-data-2"></a> `data` | `readonly` | `object` |
| `data.requests` | `readonly` | readonly [`EveInputRequest`](#eveinputrequest)[] |
| `data.sequence` | `readonly` | `number` |
| `data.stepIndex` | `readonly` | `number` |
| `data.turnId` | `readonly` | `string` |
| <a id="property-type-2"></a> `type` | `readonly` | `"input.requested"` |

***

### EveInputResolution

Structural copy of one element of eve's `InputResolvedStreamEvent.data.
resolutions` (`InputResolution`, `dist/src/protocol/message.d.ts`): the
server-accepted terminal outcome of one human-input request. Like
`approval.settled` it carries no tool name — only `requestId`.
`'cancelled'` was added after 0.39.1 (present in 0.71.0): the request was
withdrawn, unanswered, because its turn was cancelled or the run relaying
it ended — nobody decided, so it audits as `tool_flagged`, not a veto.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-kind-1"></a> `kind` | `readonly` | `"question"` \| `"session-limit"` \| `"tool-approval"` |
| <a id="property-outcome"></a> `outcome` | `readonly` | `"invalid"` \| `"approved"` \| `"denied"` \| `"cancelled"` \| `"answered"` \| `"ignored"` |
| <a id="property-requestid-1"></a> `requestId` | `readonly` | `string` |
| <a id="property-response"></a> `response?` | `readonly` | `object` |
| `response.optionId?` | `readonly` | `string` |
| `response.requestId` | `readonly` | `string` |
| `response.text?` | `readonly` | `string` |

***

### EveInputResolvedEvent

Structural copy of eve's `InputResolvedStreamEvent` — a hookable
 `HookEventMap` key (`'input.resolved'`), fired once per batch of resolved
 human-input requests. It is how a BARE approval policy
 (`approval: intuticApproval(...)`) settles: eve emits `approval.candidate`/
 `approval.settled` only for the `{ request, response }` form (observed on
 a live `eve start` server).

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-data-3"></a> `data` | `readonly` | `object` |
| `data.resolutions` | `readonly` | readonly [`EveInputResolution`](#eveinputresolution)[] |
| `data.sequence` | `readonly` | `number` |
| `data.stepIndex` | `readonly` | `number` |
| `data.turnId` | `readonly` | `string` |
| <a id="property-type-3"></a> `type` | `readonly` | `"input.resolved"` |

***

### IntuticApprovalOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |
| <a id="property-onallow"></a> `onAllow?` | `"not-applicable"` \| `"user-approval"` | Status returned when the gate ALLOWS the call. - `'not-applicable'` (default): continue without a human prompt — eve's own "no prompt needed" value, the same behaviour as an omitted `approval` (`never()`). Use when Intutic governance is the only approval layer this tool needs. - `'user-approval'`: park the run durably for a person even though governance has no objection — the "governance gate + human sign-off" stack, equivalent to composing with eve's `always()`. `'approved'` is deliberately not offered — see the module doc's "Allow-shape" section. For anything more conditional (e.g. eve's `once()`, or your own tenant policy), compose manually: `import { once } from 'eve/tools/approval' const intutic = intuticApproval() // inside defineTool({ ... }): approval: async (ctx) => { const verdict = await intutic(ctx) if (typeof verdict === 'object' && verdict?.type === 'denied') return verdict return once()(ctx) // your own flow decides the rest },` |

***

### IntuticAuditHooksOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-client"></a> `client?` | [`GateClient`](../core/classes/GateClient.md) | Fixed control-plane client. When omitted, one client is built per eve session via `GateClient.fromEnv({ harness: 'eve', sessionId })` using the eve session id off the hook context — eve's durable session IS the meaningful attribution unit here, unlike dsh (whose plugin mounts before any session exists and settles for one process-wide id). Passing a client pins every event to THAT client's own session id instead. |

## Type Aliases

### EveApprovalPolicy

```ts
type EveApprovalPolicy = (ctx) => Promise<EveApprovalStatus>;
```

The policy function shape this adapter returns — assignable to eve's
 `ApprovalPolicy` (and therefore to a tool definition's `approval` field
 and a connection's `approval` field, both of which accept `Approval =
 ApprovalPolicy | ApprovalConfiguration`).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ctx` | [`EveApprovalContext`](#eveapprovalcontext) |

#### Returns

`Promise`\<[`EveApprovalStatus`](#eveapprovalstatus)\>

***

### EveApprovalStatus

```ts
type EveApprovalStatus = 
  | undefined
  | boolean
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | {
  reason?: never;
  type: "not-applicable";
}
  | {
  reason?: string;
  type: "approved";
}
  | {
  reason?: string;
  type: "denied";
}
  | {
  reason?: never;
  type: "user-approval";
};
```

Structural copy of eve's `ApprovalStatus` — this package does not depend
 on `eve` at runtime, so the shape is declared here rather than imported.
 Confirmed field-for-field against `eve@0.71.0`'s
 `dist/src/approval/definition.d.ts` (see module doc; unchanged since
 0.39.1), including
 the boolean back-compat forms this adapter itself never returns.

## Variables

### EVE\_APPROVAL\_TOOL\_NAME

```ts
const EVE_APPROVAL_TOOL_NAME: "eve:approval" = 'eve:approval';
```

Synthetic tool name used by [intuticAuditHooks](#intuticaudithooks) — eve's
 `approval.candidate`/`approval.settled` events do not carry the real tool
 name (verified against `dist/src/protocol/message.d.ts`; see module doc).

## Functions

### intuticApproval()

```ts
function intuticApproval(opts?): EveApprovalPolicy;
```

Builds an approval policy matching eve's `ApprovalPolicy` signature, for
direct use as a tool definition's `approval` field:

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

(Install the gate once, process-wide, e.g. in `agent.ts`:
`install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))`.)

Resolves to `'not-applicable'` on allow (or `opts.onAllow` — see
[IntuticApprovalOptions.onAllow](#property-onallow)) and to `{ type: 'denied', reason }`
on refusal — `reason` is the `[Intutic Governance] BLOCKED: ...` message,
handed back to the model in place of a tool result; the tool's `execute`
never runs.

Requires a `Gate` — either passed via `{ gate }` here, or installed
process-wide with `install(new Gate(...))`. A call with neither throws,
refusing to run the tool unguarded rather than silently skipping
enforcement — same posture as `wrapTool`/`intuticHooks`/
`intuticToolApproval`. A non-refusal crash inside the gate is re-thrown
rather than mapped to a denial — eve's own approval docs direct policies to
"throw or deny, never silently allow", and a thrown policy fails the turn
(fail closed), matching vercel.ts's posture for the same status family.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticApprovalOptions`](#intuticapprovaloptions) |

#### Returns

[`EveApprovalPolicy`](#eveapprovalpolicy)

***

### intuticAuditHooks()

```ts
function intuticAuditHooks(opts?): EveAuditHookDefinition;
```

Observe-only audit emitter for eve's human-approval lifecycle, shaped for
`agent/hooks/`:

```ts
// agent/hooks/intutic-audit.ts
import { defineHook } from 'eve/hooks'
import { intuticAuditHooks } from '@intutic/gate/eve'

export default defineHook(intuticAuditHooks())
```

Maps eve's approval stream events onto Intutic's gate event vocabulary
(the same `tool_allowed`/`tool_blocked`/`tool_flagged` names `gate.ts`
emits, so the dashboard renders both sources on one timeline):

- `input.requested`, one `kind: 'tool-approval'` request → `tool_flagged`,
  under the REAL tool name (`request.action.toolName`) — a genuinely new
  signal this adapter did not emit before: a call is now pending human
  approval. See the module doc for why this event, not a
  process-memory map, is what closes "no tool identity" here.
- `approval.settled` `outcome: 'approved'` → `tool_allowed` — a human
  explicitly approved the parked call.
- `approval.settled` `outcome: 'cancelled'` → `tool_blocked` — the request
  was settled without approval; the call never ran. This is a HUMAN veto
  recorded for audit, not an Intutic-gate refusal (the reason string says
  so), and like every `tool_blocked` it creates an incident row.
- `approval.candidate` non-`'pending'` outcomes (`rejected`/`failed`/
  `timed-out`/`stale`) → `tool_flagged` — a responder's attempt to answer
  went somewhere worth an operator's attention. `'pending'` (a candidate
  simply being created) is routine lifecycle and deliberately NOT emitted.
- `input.resolved`, one `kind: 'tool-approval'` resolution — the
  settlement of a BARE approval policy, for which eve emits no
  `approval.settled` — → `tool_allowed` for `'approved'`, `tool_blocked`
  (a human veto, as above) for `'denied'`, and `tool_flagged` for any
  other outcome (`'ignored'`/`'invalid'`, and `'cancelled'` — withdrawn
  unanswered with its turn, not a human decision).

The `{ request, response }` approval form fires BOTH `approval.settled` and
`input.resolved` for the same request (in that order, observed live); each
settlement is recorded once, by whichever of the two arrives first — the
richer `approval.settled`, which also names the responder, in practice.

`approval.candidate`/`approval.settled` attribute to the REAL tool name
when this instance's in-memory `requestId -> toolName` cache (populated
by `input.requested`) is still warm, and fall back to the synthetic
[EVE\_APPROVAL\_TOOL\_NAME](#eve-approval-tool-name) otherwise — see the module doc for why that
fallback exists and is not itself a bug.

These hooks are TELEMETRY, not enforcement: eve runs hook handlers after
events are durably recorded, and they cannot veto a tool call (eve's own
"observe-only" hook contract; `ctx.cancel()` only cancels the whole turn,
and these handlers never call it). The enforcement surface is
[intuticApproval](#intuticapproval). Handlers never throw — a telemetry failure must
not break the run (`GateClient.emit`'s own never-throws contract).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticAuditHooksOptions`](#intuticaudithooksoptions) |

#### Returns

[`EveAuditHookDefinition`](#eveaudithookdefinition)

***

### intuticConnectionApproval()

```ts
function intuticConnectionApproval(opts?): EveApprovalPolicy;
```

The same policy, shaped for a CONNECTION's `approval` field — eve's MCP and
OpenAPI connections accept one `approval` gating ALL of that connection's
tools (`defineMcpClientConnection`/`defineOpenAPIConnection`, confirmed at
`dist/src/public/definitions/connections/{mcp,openapi}.d.ts` — an omitted
`approval` means every connection tool executes without approval):

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

Implemented AS [intuticApproval](#intuticapproval) (one enforcement path, not two) —
the separate export exists because the surface differs in one way worth
knowing: `ctx.toolName` for a connection tool is the QUALIFIED name
(`support__add_internal_note`, connection slug + `__` + remote tool name —
eve's own convention, per `docs/patterns/multi-tenant-approvals.md`), and
that qualified name is what `Gate.guard()` evaluates and what SOP rules /
snapshot `tool:` subjects must match. This adapter deliberately does not
strip the prefix: the qualified name is the call's real identity inside
this eve app, and un-prefixing would let two connections' same-named remote
tools collapse into one rule target.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticApprovalOptions`](#intuticapprovaloptions) |

#### Returns

[`EveApprovalPolicy`](#eveapprovalpolicy)

## References

### intuticProxyBaseUrl

Re-exports [intuticProxyBaseUrl](../vercel/index.md#intuticproxybaseurl)

***

### intuticProxyUrl

Re-exports [intuticProxyUrl](../vercel/index.md#intuticproxyurl)

***

### withIntuticProxy

Re-exports [withIntuticProxy](../vercel/index.md#withintuticproxy)
