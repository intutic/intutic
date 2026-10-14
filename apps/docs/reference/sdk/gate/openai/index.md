[@intutic/gate](../index.md) / openai

# @intutic/gate/openai

OpenAI Agents SDK (TypeScript) adapter: `intuticToolGuardrail()`,
`wrapTools()`, `wrapAgent()`, `installOpenAiGate()`.

`@intutic/gate/openai` — a framework-specific specialization of the same
idea `wrapTools.ts` implements generically (see that file's module doc):
wrap the framework's own veto point around this package's `Gate.guard()`.
The TypeScript twin of the Python SDK's
`intutic_clawde.gate.adapters.openai_agents` (`intutic_tool_guardrail`).

## The veto mechanism — CONFIRMED against a real install

`@openai/agents@0.16.1` was installed as a devDependency of this package
and its shipped `.d.ts`/compiled source read directly (not inferred from
docs alone). `@openai/agents` is a meta-package (`export * from
'@openai/agents-core'` + `'@openai/agents-openai'` + `export * as
realtime`); the relevant surface lives in `@openai/agents-core`:

The SDK's documented per-tool veto point is a **tool input guardrail**
(`dist/toolGuardrail.d.ts`, present since `@openai/agents-core` 0.3.8,
2026-01-14):

```ts
interface ToolInputGuardrailDefinition<TContext> {
  type: 'tool_input'
  name: string
  run: (data: { context: RunContext; agent: Agent; toolCall: protocol.FunctionCallItem })
    => Promise<ToolGuardrailFunctionOutput>   // { behavior, outputInfo? }
}
// behavior: {type:'allow'} | {type:'rejectContent'; message} | {type:'throwException'}
```

The runner (`dist/runner/toolExecution.js`) runs every guardrail in
`FunctionTool.inputGuardrails` BEFORE `invoke` — on `rejectContent` the
tool body never runs and `message` becomes the model-visible tool output
(`resolveFunctionFailureOutput`). `protocol.FunctionCallItem.arguments` is
the RAW, unparsed JSON arguments string (`z.ZodString`), same as the Python
SDK's `ToolContext.tool_arguments` — hence [toolInputFromArguments](#toolinputfromarguments).

Guardrail attachment is PER-TOOL: there is no run-level tool guardrail.
That is what [wrapTools](#wraptools) and [wrapAgent](#wrapagent) are for.

Ordering caveat (documented, verified in `toolExecution.js`): for a tool
whose `needsApproval` resolves true, input guardrails run AFTER the
human-approval flow by default. Opt in to guardrails-before-approval with
the run config `toolExecution: { preApprovalInputGuardrails: true }`
(available since `@openai/agents-core` 0.11.8;
`dist/runner/runConfig.d.ts`).

## The MCP materialization gotcha — why `wrapAgent` patches `getAllTools`

Tools contributed by `agent.mcpServers` do NOT live in `agent.tools`: they
are materialized per run by `agent.getAllTools()` → `getMcpTools()` →
`mcpToFunctionTool()` (`dist/mcp.js`), which builds them with the same
`tool()` factory — same guardrail path — but attaches NO guardrails of its
own. Mapping over `agent.tools` alone therefore silently misses every
MCP-sourced tool. [wrapAgent](#wrapagent) closes that hole by patching the
agent INSTANCE's `getAllTools` to inject the Intutic guardrail into every
`FunctionTool` it returns, MCP-derived ones included (the runner resolves
tools exclusively through `executionAgent.getAllTools(...)` —
`dist/runner/modelPreparation.js`). Injection is idempotent (keyed on
[GUARDRAIL\_NAME](#guardrail-name)), so tools that are both in `agent.tools` and in the
`getAllTools` result are gated exactly once.

## Non-function tools — what is and is not gateable

  * **hostedMcpTool** entries execute at OpenAI's side, but expose a
    client-visible approval loop: `providerData.require_approval` /
    `providerData.on_approval` (snake_case POST-construction — the
    camelCase `requireApproval`/`onApproval` exist only as `hostedMcpTool()`
    factory options; the runner reads only the snake_case fields,
    `dist/runner/mcpApprovals.js`). `wrapTools` rewrites these entries to
    `require_approval: 'always'` plus an Intutic `on_approval` that guards
    each call and composes any pre-existing handler. NOTE
    `hostedMcpTool()`'s own default is `require_approval: 'never'` — an
    unwrapped hosted MCP tool is entirely ungated.
  * **shellTool / applyPatchTool** (local) carry `needsApproval` +
    `onApproval` auto-resolvers. `wrapTools` forces `needsApproval` to
    always-true and installs a composed Intutic `onApproval`: gate refusal
    → reject (with the BLOCKED message); gate allow → the tool's ORIGINAL
    approval policy is replayed (original `needsApproval` false → approve;
    original `onApproval` present → delegated to). When the original
    policy demanded a human and no original `onApproval` exists, the
    decision is deliberately left undecided so the interruption still
    surfaces — see [OpenAiApprovalDecision](#openaiapprovaldecision) for the verified
    mechanism this relies on.
  * **computerTool** has NO `onApproval` — only a per-action
    `needsApproval` predicate (plus `onSafetyCheck`). `wrapTools` (and
    [intuticComputerNeedsApproval](#intuticcomputerneedsapproval)) can therefore only turn a gate
    refusal into `needsApproval → true`, which surfaces as a pending
    interruption in `result.interruptions` that YOUR code must
    `state.reject(...)`. Stated honestly: a caller who `state.approve()`s
    that interruption overrides the gate — the SDK gives this adapter no
    reject-with-message hook for computer actions. (The refusal is still
    emitted to the control plane as `tool_blocked` telemetry either way.)
  * **Hosted tools** (`webSearchTool`, `fileSearchTool`,
    `codeInterpreterTool`, `imageGenerationTool`, ...) are bare
    `HostedTool` objects executed server-side at OpenAI: NO client-side
    guardrail, approval hook, or wrapper ever sees them. The
    hosted-environment variant of `shellTool` (`environment.type:
    'container_*'`) is in the same bucket — its factory options type
    `needsApproval`/`onApproval` as `never`. `wrapTools` passes all of
    these through UNCHANGED rather than pretending they are gated.

## Realtime

`@openai/agents-realtime` honours `FunctionTool.inputGuardrails` through
the same `runToolInputGuardrails` helper (`realtimeSession.js`), so a
guardrail injected by this module also gates voice-agent tool calls.
`__tests__/openai.test.ts` drives a real `RealtimeSession` (0.16.1) with a
stand-in transport emitting `function_call`: a refused call never executes
and the BLOCKED message goes back via `sendFunctionCallOutput`.

## LLM egress and the tracing DLP leak

Routing chat traffic through the Intutic proxy is env-only for this SDK:
the underlying `openai` client (7.5.0, `client.js`) reads
`OPENAI_BASE_URL` whenever no explicit `baseURL`/client is passed to
`OpenAIProvider` — so a sourced `.env.intutic` governs egress with zero
code, unlike the Vercel AI SDK (see vercel.ts's module doc). The default
transport is the HTTP Responses API, whose wire shape the Intutic proxy
already parses.

BUT: `@openai/agents-openai`'s tracing exporter POSTs trace spans —
including tool inputs/outputs — to a HARDCODED
`https://api.openai.com/v1/traces/ingest` (`openaiTracingExporter.js`),
bypassing `OPENAI_BASE_URL` entirely, and tracing is ON by default. That
is a real DLP exfiltration path around the proxy.
[suppressAgentsTracingExport](#suppressagentstracingexport) (called by [installOpenAiGate](#installopenaigate)
unless opted out) sets the SDK's own kill-switch env
`OPENAI_AGENTS_DISABLE_TRACING=1` (read lazily per run —
`@openai/agents-core`'s `config.js`). Callers who need traces should
instead re-point the exporter endpoint in code
(`new OpenAITracingExporter({ endpoint })` + `setTraceProcessors`) at an
approved collector and opt out with `{ tracingExport: 'keep' }`.

## What this module does NOT import

Deliberately no runtime dependency on `@openai/agents`/
`@openai/agents-core` — the `OpenAi*` types below are narrow structural
copies of only the shapes this adapter touches, same policy as mastra.ts /
vercel.ts / dsh.ts (see dsh.ts's module doc for the full rationale). The
real packages are devDependencies used by `__tests__/openai.test.ts` to
type-check these structural types against the real shipped ones and to
drive the real runner machinery end to end.

## Interfaces

### OpenAiAgentLike

Minimal structural slice of `Agent` needed by [wrapAgent](#wrapagent): the
 static tool list plus the per-run materializer the runner actually
 consumes (`dist/runner/modelPreparation.js`).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-tools"></a> `tools` | `object`[] |

#### Methods

##### getAllTools()

```ts
getAllTools(...args): Promise<object[]>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`args` | `never`[] |

###### Returns

`Promise`\<`object`[]\>

***

### OpenAiApprovalDecision

Structural copy of the `{ approve, reason? }` decision `onApproval` /
`on_approval` handlers resolve with — with one deliberate widening:
`approve` is optional here.

For SHELL and APPLY_PATCH tools the runner checks `decision.approve ===
true` and `=== false` explicitly and treats anything else as "no decision
made", leaving the approval pending so it surfaces as an interruption
(VERIFIED against `@openai/agents-core@0.16.1`'s
`dist/runner/toolExecution.js`, `resolveToolApproval()`). This adapter
returns `{}` exactly once — when the gate allows a call whose ORIGINAL
tool policy demanded a human and no original `onApproval` exists — so the
caller's own interruption flow survives wrapping. That fall-through is
real but UNDOCUMENTED SDK behaviour; see the TD entry this phase filed.

Hosted MCP `on_approval` results are consumed with a TRUTHY check instead
(`dist/runner/mcpApprovals.js`), so `{}` there would silently REJECT —
the hosted-MCP wrapper never uses the fall-through.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-approve"></a> `approve?` | `boolean` |
| <a id="property-reason"></a> `reason?` | `string` |

***

### OpenAiFunctionCallLike

Slice of `protocol.FunctionCallItem` read by the guardrail: `arguments`
 is the RAW, unparsed JSON string (the full item also carries `callId`,
 `type: 'function_call'`, ...).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-arguments"></a> `arguments` | `string` |
| <a id="property-name"></a> `name` | `string` |

***

### OpenAiGateConfig

Config for [installOpenAiGate](#installopenaigate). Extends the core [GateConfig](../core/index.md#gateconfig).

#### Extends

- [`GateConfig`](../core/index.md#gateconfig)

#### Properties

| Property | Type | Default value | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="property-allowlistpath"></a> `allowlistPath?` | `string` | `'.intutic/image-allowlist.json'` | The image allowlist, relative to `repoRoot` unless absolute. | [`GateConfig`](../core/index.md#gateconfig).[`allowlistPath`](../core/index.md#property-allowlistpath) |
| <a id="property-enforce"></a> `enforce?` | `boolean` | `true` | `false` turns [Gate.guard](../core/classes/Gate.md#guard) into a no-op. | [`GateConfig`](../core/index.md#gateconfig).[`enforce`](../core/index.md#property-enforce) |
| <a id="property-reporoot"></a> `repoRoot?` | `string` | `'.'` | Where relative manifest and allowlist paths resolve from. | [`GateConfig`](../core/index.md#gateconfig).[`repoRoot`](../core/index.md#property-reporoot) |
| <a id="property-sessionid"></a> `sessionId?` | `string` | `undefined` | Overrides the generated-per-process session id. Mirrors `INTUTIC_SESSION_ID` for callers that already have one to hand. | - |
| <a id="property-tracingexport"></a> `tracingExport?` | `"intutic"` \| `"disable"` \| `"keep"` | `undefined` | What to do about the tracing exporter's proxy bypass (see [suppressAgentsTracingExport](#suppressagentstracingexport)). `'disable'` (default) sets the SDK's kill-switch env; `'keep'` leaves tracing exactly as configured — choose it ONLY once the exporter endpoint is re-pointed somewhere approved, otherwise tool inputs/outputs leave via api.openai.com. | - |
| <a id="property-usehookgate"></a> `useHookGate?` | `boolean` | `true` | Call the control plane's hook gate (needs a client). | [`GateConfig`](../core/index.md#gateconfig).[`useHookGate`](../core/index.md#property-usehookgate) |
| <a id="property-usesoprules"></a> `useSopRules?` | `boolean` | `true` | Fetch and apply the workspace's SOP rules (needs a client). | [`GateConfig`](../core/index.md#gateconfig).[`useSopRules`](../core/index.md#property-usesoprules) |
| <a id="property-workspaceid"></a> `workspaceId?` | `string` | `''` | Compared with the workspace the policy snapshot was compiled for, and scopes the SOP-rule fetch. | [`GateConfig`](../core/index.md#gateconfig).[`workspaceId`](../core/index.md#property-workspaceid-1) |

***

### OpenAiToolApprovalItemLike

Slice of `RunToolApprovalItem` the approval handlers read.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-rawitem"></a> `rawItem?` | `unknown` |

***

### OpenAiToolGuardrailFunctionOutput

Structural copy of `ToolGuardrailFunctionOutput` — the subset of
 `behavior` values this adapter emits (`throwException` is never used:
 a refusal is a model-visible rejection, not a run-fatal tripwire).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-behavior"></a> `behavior` | \| \{ `type`: `"allow"`; \} \| \{ `message`: `string`; `type`: `"rejectContent"`; \} |
| <a id="property-outputinfo"></a> `outputInfo?` | `unknown` |

***

### OpenAiToolInputGuardrail

Structural copy of `ToolInputGuardrailDefinition` — directly assignable
 both to a built `FunctionTool.inputGuardrails` array and to the `tool()`
 factory's `inputGuardrails` option.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-name-1"></a> `name` | `string` |
| <a id="property-run"></a> `run` | (`data`) => `Promise`\<[`OpenAiToolGuardrailFunctionOutput`](#openaitoolguardrailfunctionoutput)\> |
| <a id="property-type"></a> `type` | `"tool_input"` |

***

### OpenAiToolInputGuardrailData

Slice of `ToolInputGuardrailData` the guardrail reads. The real data also
 carries `context: RunContext` and `agent: Agent`, which pass through this
 (wider-parameter) structural type untouched.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-toolcall"></a> `toolCall` | [`OpenAiFunctionCallLike`](#openaifunctioncalllike) |

***

### OpenAiWrapOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |

## Variables

### GUARDRAIL\_NAME

```ts
const GUARDRAIL_NAME: "intutic" = 'intutic';
```

The `name` every guardrail this module builds carries. Also the
 idempotency key: a `FunctionTool` whose `inputGuardrails` already contains
 a guardrail with this name is never double-wrapped.

## Functions

### installOpenAiGate()

```ts
function installOpenAiGate(config?): Gate;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`OpenAiGateConfig`](#openaigateconfig) |

#### Returns

[`Gate`](../core/classes/Gate.md)

***

### intuticComputerNeedsApproval()

```ts
function intuticComputerNeedsApproval(opts?): (runContext, action, callId?) => Promise<boolean>;
```

Gate-driven `needsApproval` predicate for `computerTool` — the ONLY
pre-execution hook that tool exposes (no guardrails, no `onApproval`):

```ts
computerTool({ computer, needsApproval: intuticComputerNeedsApproval() })
```

A gate-refused (or gate-crashed — fail closed) action resolves `true`,
which the runner turns into a pending interruption in
`result.interruptions`; your interruption handler must `state.reject(...)`
it. This is honestly weaker than the guardrail path: the SDK offers no way
for this adapter to auto-reject a computer action with a message, and a
handler that `state.approve()`s the interruption overrides the gate. An
allowed action defers to `fallback` (the predicate the tool would
otherwise have used; defaults to no approval).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`OpenAiWrapOptions`](#openaiwrapoptions) & `object` |

#### Returns

(`runContext`, `action`, `callId?`) => `Promise`\<`boolean`\>

***

### intuticToolGuardrail()

```ts
function intuticToolGuardrail(opts?): OpenAiToolInputGuardrail;
```

Builds the Intutic tool input guardrail — `{ type: 'tool_input', name:
'intutic', run }` — attachable to any `FunctionTool`, either at
construction:

```ts
import { tool } from '@openai/agents'
import { Gate, install } from '@intutic/gate'
import { intuticToolGuardrail } from '@intutic/gate/openai'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const shell = tool({
  name: 'shell',
  description: 'Run a shell command',
  parameters: z.object({ command: z.string() }),
  inputGuardrails: [intuticToolGuardrail()],
  execute: async ({ command }) => run(command),
})
```

or after the fact via [wrapTools](#wraptools)/[wrapAgent](#wrapagent). On refusal the
guardrail resolves `{ behavior: { type: 'rejectContent', message } }` —
the runner skips the tool body and hands `message` (the
`[Intutic Governance] BLOCKED: ...` text) back to the model in place of a
tool result. On an unexpected gate crash it rejects too (fail closed). On
allow it resolves `{ behavior: { type: 'allow' } }`.

Requires a `Gate` — either passed via `{ gate }`, or installed
process-wide with `install(new Gate(...))`. A call with neither throws
out of `run` (which the runner escalates into a run-fatal `ToolCallError`)
rather than running the tool unguarded — same posture as
`wrapTool`/`intuticHooks`/`intuticToolApproval`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`OpenAiWrapOptions`](#openaiwrapoptions) |

#### Returns

[`OpenAiToolInputGuardrail`](#openaitoolinputguardrail)

***

### intuticTracingExporterOptions()

```ts
function intuticTracingExporterOptions(env?): object;
```

Where to point `@openai/agents`' tracing exporter so traces stay governed
rather than lost: the control plane's ingest route, authenticated with the
same API key the gate uses. Pass the result to the SDK's own exporter —

```ts
import { setTraceProcessors, BatchTraceProcessor, OpenAITracingExporter } from '@openai/agents'
setTraceProcessors([new BatchTraceProcessor(new OpenAITracingExporter(intuticTracingExporterOptions()))])
```

— and pass `{ tracingExport: 'intutic' }` to [installOpenAiGate](#installopenaigate). No
`@openai/agents` import here, so this module stays loadable without the SDK.
Generation spans become traces in the ledger; tool spans are counted, not
stored (the route's own doc says why).

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `env` | `ProcessEnv` | `process.env` |

#### Returns

`object`

| Name | Type |
| ------ | ------ |
| `apiKey` | `string` |
| `endpoint` | `string` |

***

### suppressAgentsTracingExport()

```ts
function suppressAgentsTracingExport(): void;
```

Close the tracing DLP leak: set the SDK's own kill-switch env
(`OPENAI_AGENTS_DISABLE_TRACING=1`) so the default exporter never POSTs
trace spans — which carry tool inputs/outputs — to its HARDCODED
`https://api.openai.com/v1/traces/ingest` endpoint (which ignores
`OPENAI_BASE_URL`, i.e. bypasses the Intutic proxy). The SDK reads the env
lazily per run, so calling this any time before `run(...)` is effective.

To keep traces instead, re-point the exporter at an approved collector in
your own code — `setTraceProcessors([new BatchTraceProcessor(new
OpenAITracingExporter({ endpoint }))])` — and pass
`{ tracingExport: 'keep' }` to [installOpenAiGate](#installopenaigate).

#### Returns

`void`

***

### toolInputFromArguments()

```ts
function toolInputFromArguments(raw): ToolInput;
```

Parse the raw JSON `arguments` string into the object `Gate.guard()`
evaluates. Port of the Python adapter's `_tool_input_of` — same fallback
keys (`raw`, `value`): a call the gate cannot parse should still reach a
rule, not silently skip evaluation.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `raw` | `string` \| `null` \| `undefined` |

#### Returns

[`ToolInput`](../core/index.md#toolinput)

***

### wrapAgent()

```ts
function wrapAgent<T>(agent, opts?): T;
```

Gate every tool an agent can reach, MCP-sourced tools included.

```ts
import { Agent, run } from '@openai/agents'
import { installOpenAiGate, wrapAgent } from '@intutic/gate/openai'

installOpenAiGate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID })

const agent = wrapAgent(new Agent({
  name: 'ops',
  tools: [shell],
  mcpServers: [filesystemServer],
}))
const result = await run(agent, prompt)
```

Two things happen, both idempotent:

  1. `agent.tools` is replaced with [wrapTools](#wraptools)' wrapped copies.
  2. The agent INSTANCE's `getAllTools` — the materializer the runner
     actually consumes each turn, and the ONLY place `mcpServers`-derived
     tools ever appear (see module doc) — is patched to wrap everything it
     returns.

MUTATES (and returns) the agent passed in.

Scope, stated plainly: this wraps ONE agent. Agents reached via handoffs
are separate objects — wrap each of them too.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`OpenAiAgentLike`](#openaiagentlike) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `agent` | `T` |
| `opts` | [`OpenAiWrapOptions`](#openaiwrapoptions) |

#### Returns

`T`

***

### wrapTools()

```ts
function wrapTools<T>(tools, opts?): T[];
```

Wrap a list of OpenAI Agents SDK tools so `Gate.guard()` runs before each
one executes — see the module doc for exactly what each tool `type` gets
(and what hosted tools cannot get). Returns NEW tool objects (shallow
copies); the ones passed in are not mutated. Wrapping twice is a no-op.

NOTE: this covers only the tools you hand it. Tools materialized from
`agent.mcpServers` do not exist yet at wrapping time — use
[wrapAgent](#wrapagent) for an agent with MCP servers.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `object` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | readonly `T`[] |
| `opts` | [`OpenAiWrapOptions`](#openaiwrapoptions) |

#### Returns

`T`[]
