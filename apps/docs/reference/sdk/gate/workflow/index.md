[@intutic/gate](../index.md) / workflow

# @intutic/gate/workflow

`@ai-sdk/workflow` adapter: `withIntuticApproval()`, `intuticNeedsApproval()`,
`intuticApprovalStep()`, `wrapWorkflowTools()`, and the FatalError-compatible
`IntuticWorkflowRefusal`.

`@intutic/gate/workflow` — the same idea `vercel.ts` implements for the base
`ai` package (wrap the framework's own veto point around this package's
`Gate.guard()`), reshaped for Vercel's DURABLE workflow-agent runtime, where
two facts change the adapter's whole design:

## 1. The veto surface is per-tool `needsApproval`, not an agent option

Confirmed against a real install (`@ai-sdk/workflow@1.0.69`, re-read on
2.0.58): `WorkflowAgent`/`WorkflowAgentOptions` carry NO approval-policy
field — 1.x's shipped `.d.ts` never mentions `toolApproval`, and 2.x adds
only `experimental_toolApprovalSecret`, an HMAC secret that signs approval
requests so a replayed approval can be verified, not a veto. The veto surface is `needsApproval` (boolean | function) on the
TOOL definition, exactly as the framework's own workflow-agent docs
describe under "Tool Approval". The compiled agent loop confirms the
semantics (dist/index.js): `needsApproval == null` → no approval; a
boolean is used directly; a function is awaited as
`needsApproval(input, { toolCallId, messages, context })`. A call needing
approval pauses DURABLY — the run suspends and a human can approve hours
later — so this framework, uniquely in this package, has a real
human-in-the-loop lane for the gate to route into.

(`ai@7` — still in 7.0.127 — marks tool-level `needsApproval` `@deprecated`
in favour of generateText-level `toolApproval` — but `@ai-sdk/workflow`'s
OWN agent loop (1.x and 2.0.58 alike) reads the tool-level field and exposes no other veto surface, so it is the
correct — indeed the only — integration point here. Noted in the TD entry
this phase filed, so a future @ai-sdk/workflow release moving to the
generateText-shaped surface gets caught rather than silently ungated.)

## 2. Denials must not be retried — refusals here are FatalError-compatible

A durable workflow retries failed steps. Confirmed against real installs
(`workflow@4.8.3` re-exporting `@workflow/errors@4.2.1` via
`@workflow/core`; re-read on `workflow@5.0.1` / `@workflow/errors@5.0.1`):
the runtime's retry/abort decision consults `FatalError.is(err)`
(`@workflow/core`'s `runtime/step-handler.js` in 4.x,
`runtime/step-executor.js` in 5.x — a fatal error "bubbl[es] up to parent
workflow"; anything else is retried toward `maxAttempts`), and
`FatalError.is()` DUCK-TYPES: it checks `err.name === 'FatalError'` (5.x
also accepts `err.fatal === true`) on any Error-shaped object, precisely because
workflows execute in a separate `vm` realm where `instanceof` fails across
the boundary. A plain `IntuticGateRefusal` thrown from `needsApproval` or a
tool body would therefore be RETRIED — a governance denial replayed on a
timer until max attempts, burning the run to reach the same refusal. So
this adapter's refusals are [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md): still an
`IntuticGateRefusal` (`instanceof` works in-realm, `.reason`/`.code`/
`.incidentId` intact, message still `[Intutic Governance] BLOCKED: ...`)
but with `name = 'FatalError'` so the real runtime's duck-check aborts
instead of retry-looping. `__tests__/workflow.test.ts` pins this against
the REAL `FatalError.is` from the `workflow` package, not a re-derivation.

Deliberately asymmetric: a NON-refusal crash inside `Gate.guard()` (a
transient network failure in a remote tier, an unexpected bug) is re-thrown
UNTOUCHED — retryable, which is the durable runtime's correct response to a
transient failure. Only a real governance verdict (and the fail-closed
"no gate configured" case, which is deterministic and would fail every
retry identically) is made fatal.

## 3. `needsApproval` runs in the workflow VM — the gate must run in a step

Observed in a live run on the Workflow DevKit's local world:
`WorkflowAgent`'s loop runs inside the `"use workflow"` function, so it
calls `needsApproval` in the workflow VM, which has no Node.js modules.
`Gate` reads its policy snapshot with `node:fs`, so evaluating it there
fails with `require is not defined` — and when the workflow bundle pulls
`node:fs` in at module level, EVERY workflow sharing that bundle fails at
load (observed with `workflow/nitro`).

So the gate runs in a STEP, which has full Node.js and is durable. The
caller declares one `"use step"` function in their own module — the
directive must sit in a module the workflow bundler transforms, and the
step's body must build/receive the `Gate` itself, because step arguments
are serialized and a `Gate` instance is not serializable — whose body is
[intuticApprovalStep](#intuticapprovalstep), and passes it as `{ step }`:

```ts
export async function intuticGate(toolName: string, input: unknown) {
  'use step'
  return intuticApprovalStep(toolName, input, { gate: new Gate({ ... }) })
}
// in the workflow: tools: withIntuticApproval(tools, { step: intuticGate })
```

With `{ step }`, the `needsApproval` this module builds only calls the step
(a durable step invocation from the VM's point of view) and maps its
boolean; nothing Node-only runs in the VM. This module itself is safe to
import into workflow code: it imports nothing that touches Node.js
(`errors.ts`, `registry.ts`, `wrapTools.ts`; `Gate` is a type-only
import). Without `{ step }`, the gate is evaluated in-process, which still
works wherever Node.js is available (inside a step, or any plain `ai`
loop); called in the workflow VM it throws an [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md)
naming this fix instead of failing with `require is not defined`.

## Classes

- [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md)

## Interfaces

### WorkflowNeedsApprovalOptions

Structural copy of the options object `@ai-sdk/workflow`'s agent loop
 passes to a tool's `needsApproval` function (confirmed from the compiled
 loop: `needsApproval(tc.input, { toolCallId, messages, context })`). Only
 the fields this adapter could ever read are named; the index signature
 keeps the function assignable to the real (wider) option type.

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-toolcallid"></a> `toolCallId` | `string` |

***

### WorkflowToolLike

The slice of a workflow tool definition this adapter reads/replaces.
 Structurally compatible with `ai`'s `Tool` (whose `needsApproval` is
 `boolean | ToolNeedsApprovalFunction<...>`).

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-needsapproval"></a> `needsApproval?` | `boolean` \| ((`input`, `options`) => `unknown`) |

## Type Aliases

### IntuticApprovalStepOptions

```ts
type IntuticApprovalStepOptions = OnAllowOption & object;
```

Options for [intuticApprovalStep](#intuticapprovalstep) — the in-process evaluation, so no
 `step`.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `gate?` | [`Gate`](../core/classes/Gate.md) |

***

### IntuticGateStep

```ts
type IntuticGateStep = (toolName, input) => Promise<boolean>;
```

The `"use step"` function the caller declares to run the gate (see module
doc, section 3): called with the tool name and the call's input — both
serializable — it resolves `true` when a human should approve the call and
throws [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md) when the gate blocks it. Its body is
[intuticApprovalStep](#intuticapprovalstep).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `input` | `unknown` |

#### Returns

`Promise`\<`boolean`\>

***

### IntuticNeedsApprovalOptions

```ts
type IntuticNeedsApprovalOptions = OnAllowOption & object | OnAllowOption & object;
```

***

### WorkflowNeedsApproval

```ts
type WorkflowNeedsApproval = (input, options) => Promise<boolean>;
```

The `needsApproval` function shape this adapter produces — assignable to
 `ai`'s tool-level `needsApproval` (the surface `@ai-sdk/workflow`'s agent
 loop actually consults).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `unknown` |
| `options` | [`WorkflowNeedsApprovalOptions`](#workflowneedsapprovaloptions) |

#### Returns

`Promise`\<`boolean`\>

## Functions

### intuticApprovalStep()

```ts
function intuticApprovalStep(
   toolName, 
   input, 
   opts?
): Promise<boolean>;
```

The gate evaluation for ONE call, written to be the body of the caller's
`"use step"` function (see module doc, section 3):

```ts
// workflows/intutic-gate.ts
import { Gate } from '@intutic/gate'
import { intuticApprovalStep } from '@intutic/gate/workflow'

export async function intuticGate(toolName: string, input: unknown): Promise<boolean> {
  'use step'
  return intuticApprovalStep(toolName, input, {
    gate: new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }),
  })
}
```

Reference `@intutic/gate` only inside step bodies in that module: the
workflow bundler also bundles it into the VM with the step bodies
replaced, and a module-level use would keep the Node-only gate there.

Verdict mapping: BLOCK → throws [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md) (fatal — the
step runs once and the run fails instead of retry-looping; see module doc);
ALLOW → `false`, or `true` with `onAllow: 'human'`. A non-refusal crash in
the gate is re-thrown untouched (the step retries — correct for
transients). Requires a gate (`{ gate }` or `install()` in the process
that runs steps); called in the workflow VM itself, it throws naming the
fix.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `input` | `unknown` |
| `opts` | [`IntuticApprovalStepOptions`](#intuticapprovalstepoptions) |

#### Returns

`Promise`\<`boolean`\>

***

### intuticNeedsApproval()

```ts
function intuticNeedsApproval(toolName, opts?): WorkflowNeedsApproval;
```

Build an async `needsApproval` function for ONE workflow tool. On a
`WorkflowAgent`, pass the caller's gate step (see
[intuticApprovalStep](#intuticapprovalstep)):

```ts
deployService: {
  description: '...',
  inputSchema,
  execute: deployStep,
  needsApproval: intuticNeedsApproval('deployService', { step: intuticGate }),
},
```

The tool name is a parameter because the framework's `needsApproval`
signature does not carry it — `(input, { toolCallId, messages, context })`
has no `toolName` field (confirmed against the shipped types). Use
[withIntuticApproval](#withintuticapproval) to attach this to a whole tools record without
hand-repeating each name.

With `{ step }`, the returned function only calls the step and maps its
answer — safe in the workflow VM. Without it, the gate is evaluated
in-process (`{ gate }` or the installed gate), which needs Node.js: fine in
a plain `ai` loop or inside a step, and in the workflow VM it throws an
[IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md) naming the `{ step }` fix.

Verdict mapping: BLOCK → throws [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md) (fatal —
aborts instead of retry-looping; see module doc); ALLOW → `false` or `true`
per `onAllow`. A non-refusal crash in the gate is re-thrown untouched
(retryable — correct for transients).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `opts` | [`IntuticNeedsApprovalOptions`](#intuticneedsapprovaloptions) |

#### Returns

[`WorkflowNeedsApproval`](#workflowneedsapproval)

***

### withIntuticApproval()

```ts
function withIntuticApproval<T>(tools, opts?): T;
```

Attach the Intutic gate to every tool in a record, composing with any
`needsApproval` the tool already declares:

```ts
import { WorkflowAgent } from '@ai-sdk/workflow'
import { withIntuticApproval } from '@intutic/gate/workflow'
import { intuticGate } from './intutic-gate' // the "use step" function

export async function deployAgent(messages: ModelMessage[]) {
  'use workflow'
  const agent = new WorkflowAgent({
    model,
    tools: withIntuticApproval(tools, { step: intuticGate }),
  })
  // ...
}
```

(`{ step }` is what makes this work on a `WorkflowAgent`, whose
`needsApproval` runs in the workflow VM — see [intuticApprovalStep](#intuticapprovalstep)
and the module doc, section 3. Without it the gate is evaluated
in-process, which needs Node.js.)

For each tool (the record KEY is the tool name reported to the gate — the
same identity the framework itself dispatches on):

  1. The gate runs first. BLOCK throws [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md).
  2. On allow, the tool's OWN prior `needsApproval` still applies: a
     boolean is returned as-is; a function is awaited with the original
     arguments; a tool with none falls back to `onAllow` ('auto' → false).

So a tool that already said "always ask a human" (`needsApproval: true`)
keeps asking a human — this gate only ADDS the ability to refuse outright,
it never removes an approval pause the caller had configured.

Returns a NEW record of NEW tool objects (shallow copies); the input record
and its tools are not mutated.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `Record`\<`string`, [`WorkflowToolLike`](#workflowtoollike)\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | `T` |
| `opts` | [`IntuticNeedsApprovalOptions`](#intuticneedsapprovaloptions) |

#### Returns

`T`

***

### wrapWorkflowTools()

```ts
function wrapWorkflowTools<T>(tools, gate?): Record<string, T>;
```

`wrapTools` for durable workflow tool definitions — the same generic
execute-wrapping `wrapTools.ts` provides (gate first, then the real body),
with ONE workflow-specific change: a refusal thrown out of the wrapped
`execute` is rewrapped as [IntuticWorkflowRefusal](classes/IntuticWorkflowRefusal.md), because a
workflow tool's `execute` is a durable STEP and a step that throws a
non-fatal error is retried (see module doc). Everything else — including
"no gate configured" handling and the record-key-is-tool-name convention —
is `wrapTools`'s own behaviour, reused rather than reimplemented.

Call it inside the tool's `"use step"` body (it evaluates the gate
in-process, so it needs Node.js). Prefer [withIntuticApproval](#withintuticapproval) as the
primary integration: it uses the
framework's own pre-execution veto surface, refuses BEFORE the durable
step ever starts, and keeps the human-approval lane available. This
execute-level wrapper is defense in depth (or the option for callers whose
tools are shared with non-workflow code paths); running both double-guards
the call, which is harmless but emits duplicate gate telemetry.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* \| [`ExecutableTool`](../core/index.md#executabletool) \| [`AnyFn`](../core/index.md#anyfn) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | `Record`\<`string`, `T`\> |
| `gate?` | [`Gate`](../core/classes/Gate.md) |

#### Returns

`Record`\<`string`, `T`\>
