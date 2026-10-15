[@intutic/gate](../index.md) / managed-agents

# @intutic/gate/managed-agents

Anthropic Managed Agents (public beta since 2026-04-08) — a session
confirmation responder, plus guidance for the two execution surfaces this
adapter does NOT cover the same way.

`@intutic/gate/managed-agents` — the TypeScript twin of the Python SDK's
`intutic_clawde.gate.adapters.managed_agents`. See that module's doc for
the full research trail; this header covers only what differs for the
TypeScript SDK.

Managed Agents is architecturally different from every other adapter in
this package: the customer's process does not run the tool-call loop.
Anthropic hosts a "session" that emits an event stream, and the customer's
backend answers it. There is no local function call to wrap the way
`wrapTools()` wraps a Mastra tool.

## The veto mechanism — CONFIRMED against a real install

`@anthropic-ai/sdk@0.117.1` (the latest published release at the time this
adapter was built) was installed as a devDependency of this package and its
shipped `.d.ts` read directly (not inferred from docs alone; the Python
twin was checked the same way against `anthropic==0.122.0`, its own
latest). Re-read against `@anthropic-ai/sdk@0.131.0` — see
"0.131 additions" below:

  * `resources/beta/sessions/events.d.ts` — every request this module
    issues (`.list()`, `.send()`, `.stream()`) carries
    `anthropic-beta: managed-agents-2026-04-01` automatically (the real
    client sets it); [MANAGED\_AGENTS\_BETA](#managed-agents-beta) documents the value for a
    caller building a raw request.
  * `BetaManagedAgentsUserToolConfirmationEventParams` — the wire shape
    this module builds: `{ type: 'user.tool_confirmation', tool_use_id,
    result: 'allow' | 'deny', deny_message? }`. There is no
    `session_thread_id` param (0.117.1 and 0.131.0 alike); on the
    confirmation EVENT it is server-set, and 0.131's tool-use event doc says
    the server routes the confirmation by `tool_use_id`, "so clients do not
    send it back". Earlier versions of this module echoed it — removed.
  * `BetaManagedAgentsAgentToolUseEvent` and
    `BetaManagedAgentsAgentMCPToolUseEvent` both carry
    `evaluated_permission?: 'allow' | 'ask' | 'deny'`. A call the server
    evaluated to `'ask'` (e.g. because its `permission_policy` is
    `always_ask` — checked live 2026-10-14: an agent created with no
    `permission_policy` resolves to `always_ask` for an MCP toolset and to
    `always_allow` for the built-in agent toolset) PAUSES the session —
    Anthropic's own docs: "Denied tools do not run." A `'deny'` verdict
    means the SERVER already denied the call (no confirmation is expected
    or accepted); `'allow'` or unset means the call never paused at all.
    **This is the real, documented pre-execution veto this module answers
    — it is not observe-only.**
  * **0.131 additions.** A third `permission_policy`, `auto`
    (`BetaManagedAgentsAutoPolicy { type: 'auto' }`): the server judges each
    invocation itself. The tool-use events gain an `evaluation` field
    naming the policy that produced `evaluated_permission` (`always_allow`
    | `always_ask` | `auto`, the last carrying the per-invocation
    `BetaManagedAgentsAgentAutoEvaluatedPermission` — an OPEN union, with
    an open `reason_code` registry). Its type "always equals the event's
    top-level evaluated_permission", so this module keeps reading only the
    top-level value: an `auto` judgement of `ask` pauses and is answered
    exactly like an `always_ask` one, `auto` `allow`/`deny` need no answer,
    and unknown `evaluation` variants are never inspected, so they cannot
    change a verdict or crash. Subagent pauses are cross-posted to the
    primary thread's stream with `session_thread_id` set (informational);
    the per-instance `answered` set keeps a pause seen on both the list and
    the stream to one confirmation.
  * `lib/tools/SessionToolRunner.d.ts` is Anthropic's OWN reference
    dispatcher: it executes `agent.tool_use` / `agent.custom_tool_use`
    calls and posts results, but it does **not** decide `allow`/`deny` for
    an `ask`-gated call itself — it holds until *something* sends the
    matching `user.tool_confirmation` event. That "something" is what this
    module provides: [confirmationForEvent](#confirmationforevent) /
    [IntuticSessionConfirmer](classes/IntuticSessionConfirmer.md) turn a paused `agent.tool_use` /
    `agent.mcp_tool_use` event into a `Gate.guard()`-driven verdict.
  * `lib/environments/worker.d.ts`'s `EnvironmentWorker` (the self-hosted
    sandbox driver) is built on `SessionToolRunner` for built-in
    agent-toolset tools (bash, edit, read, write, glob, grep, web_fetch,
    web_search). **Self-hosted built-in tools therefore pause and resolve
    through the IDENTICAL `agent.tool_use` / `evaluated_permission` /
    `user.tool_confirmation` mechanism as hosted ones** — this adapter
    covers them the same way. What differs for self-hosted is only WHERE
    the tool body executes (the customer's own worker process), not how
    the pre-execution veto works.
  * `agent.mcp_tool_use` is explicitly excluded from `SessionToolRunner`'s
    own dispatch (its own doc comment: "Server-side `agent.mcp_tool_use`
    calls are intentionally excluded — the runner does not handle them" —
    MCP tools run server-side at Anthropic). But the confirmation gate is a
    SEPARATE mechanism from execution: `BetaManagedAgentsAgentMCPToolUseEvent`
    carries `evaluated_permission` exactly like the built-in event does, so
    this module answers MCP pauses too, even though nothing in the official
    SDK dispatches their execution locally.

## What this module does NOT cover the same way — custom tools

`BetaManagedAgentsAgentCustomToolUseEvent` has **no** `evaluated_permission`
field and no `permission_policy` concept at all: a custom tool always
executes wherever the client that owns its name is listening, with no
pause. It is answered with `user.custom_tool_result`
(`custom_tool_use_id` + `content` + `is_error`), not
`user.tool_confirmation`. This is the "customer's own process runs the
call" surface the phase brief anticipated — the natural integration point
IS this package's `wrapTools()`/`wrapTool()`, exactly as the brief
guessed. BUT verify the shape, because the generic helper does not apply
as-is: `BetaRunnableTool` (`lib/tools/BetaRunnableTool.d.ts`, what
`SessionToolRunner` dispatches against) exposes a `run(args, context)`
method, not the `execute(input)` method `wrapTools()`'s object branch looks
for (`wrapTools.ts` only recognises `.execute`) — handing it a
`BetaRunnableTool` throws a `TypeError` rather than silently skipping
governance, but it still means the generic helper needs a `.run`-aware
sibling rather than "just works". [wrapManagedAgentsCustomTool](#wrapmanagedagentscustomtool) /
[wrapManagedAgentsCustomTools](#wrapmanagedagentscustomtools) are that sibling — same throw-based
refusal contract, applied to `.run` instead of `.execute`.

## What this module does NOT cover at all — the sandbox tool BODY

The self-hosted `EnvironmentWorker` gates tool PAUSES exactly like the
hosted path (see above) — but the tool's actual execution runs inside the
customer's own worker process, outside this adapter's reach, same as every
other Intutic adapter's posture toward a framework's built-in tool bodies
(see openai.ts's module doc for the precedent). This module governs
WHETHER the call runs; it does not — and cannot — inspect or modify what
the tool body does once allowed.

## Webhook vs. streamed/polled delivery — both are real

`stream()` and `list()` were exercised against a live session on
2026-10-14; a signed webhook delivery has not been (it needs a public
endpoint).

`resources/beta/webhooks.d.ts`: `client.beta.webhooks.unwrap(body, {
headers, key })` verifies the HMAC signature and returns a typed event
(synchronously — no network call); for a pause it is
`session.requires_action`, which carries only `id` (the session id),
`organization_id`, `workspace_id` — NOT the tool call itself. A webhook is
therefore a NOTIFICATION to re-poll, not a self-contained payload —
[IntuticSessionConfirmer.handleWebhook](classes/IntuticSessionConfirmer.md#handlewebhook) does exactly that: re-lists
the session's unanswered events and answers them. `events.stream()` /
`events.list()` are the poll/stream alternative this module also supports
directly via [IntuticSessionConfirmer.poll](classes/IntuticSessionConfirmer.md#poll) /
[IntuticSessionConfirmer.watch](classes/IntuticSessionConfirmer.md#watch).

## Fail-closed posture

Matches every other adapter in this package: no gate configured, or an
unexpected exception out of `Gate.guard()`, both produce a `'deny'` verdict
— never a silently-allowed, unevaluated call. Only `IntuticGateRefusal` is
distinguished (its own message becomes `deny_message`); anything else is
wrapped in a generic "gate crashed" `deny_message`.

## What this module does NOT import

Deliberately no runtime dependency on `@anthropic-ai/sdk` — the types below
are narrow structural copies of only the shapes this adapter touches, same
policy as openai.ts / mastra.ts / vercel.ts (see openai.ts's module doc for
the full rationale). The real package is a devDependency used by
`__tests__/managedAgents.test.ts` to type-check these structural types
against the real shipped ones.

## Classes

- [IntuticSessionConfirmer](classes/IntuticSessionConfirmer.md)

## Interfaces

### AgentCustomToolUseEventLike

Slice of `BetaManagedAgentsAgentCustomToolUseEvent` — carries no
 `evaluated_permission`: custom tools never pause (see module doc).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-id"></a> `id` | `string` |
| <a id="property-input"></a> `input` | `Record`\<`string`, `unknown`\> |
| <a id="property-name"></a> `name` | `string` |
| <a id="property-session_thread_id"></a> `session_thread_id?` | `string` \| `null` |
| <a id="property-type"></a> `type` | `"agent.custom_tool_use"` |

***

### AgentMcpToolUseEventLike

Slice of `BetaManagedAgentsAgentMCPToolUseEvent` this module reads.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-evaluated_permission"></a> `evaluated_permission?` | `"deny"` \| `"allow"` \| `"ask"` \| `null` |
| <a id="property-evaluation"></a> `evaluation?` | `unknown` |
| <a id="property-id-1"></a> `id` | `string` |
| <a id="property-input-1"></a> `input` | `Record`\<`string`, `unknown`\> |
| <a id="property-mcp_server_name"></a> `mcp_server_name` | `string` |
| <a id="property-name-1"></a> `name` | `string` |
| <a id="property-session_thread_id-1"></a> `session_thread_id?` | `string` \| `null` |
| <a id="property-type-1"></a> `type` | `"agent.mcp_tool_use"` |

***

### AgentToolUseEventLike

Slice of `BetaManagedAgentsAgentToolUseEvent` this module reads.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-evaluated_permission-1"></a> `evaluated_permission?` | `"deny"` \| `"allow"` \| `"ask"` \| `null` | - |
| <a id="property-evaluation-1"></a> `evaluation?` | `unknown` | 0.131+: which policy produced `evaluated_permission`. Never read by this module (the top-level value is authoritative) — typed `unknown` so any current or future variant passes through. |
| <a id="property-id-2"></a> `id` | `string` | - |
| <a id="property-input-2"></a> `input` | `Record`\<`string`, `unknown`\> | - |
| <a id="property-name-2"></a> `name` | `string` | - |
| <a id="property-session_thread_id-2"></a> `session_thread_id?` | `string` \| `null` | Set when the pause was cross-posted from a subagent thread. Informational only — never echoed into the confirmation. |
| <a id="property-type-2"></a> `type` | `"agent.tool_use"` | - |

***

### ManagedAgentsClientLike

Structural slice of the Anthropic client this module needs:
 `client.beta.sessions.events`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-beta"></a> `beta` | `object` |
| `beta.sessions` | `object` |
| `beta.sessions.events` | [`ManagedAgentsSessionEventsClientLike`](#managedagentssessioneventsclientlike) |

***

### ManagedAgentsRunnableToolLike

Structural slice of `BetaRunnableTool` — the shape
 `SessionToolRunner`/`EnvironmentWorker` dispatch custom tools against
 (`lib/tools/BetaRunnableTool.d.ts`). Note the method is `run`, not
 `execute` — the reason `wrapTools()`'s generic object branch cannot be
 used as-is here (see module doc).

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-name-3"></a> `name` | `string` |
| <a id="property-run"></a> `run` | (`args`, `context?`) => `unknown` |

***

### ManagedAgentsSessionEventsClientLike

Structural slice of `client.beta.sessions.events` — only the three
 methods this module calls, positional-argument-compatible with the real
 SDK's `list(sessionID, params?, options?)` / `send(sessionID, params,
 options?)` / `stream(sessionID, params?, options?)`.

#### Methods

##### list()

```ts
list(sessionId, params?): AsyncIterable<ManagedAgentsSessionEventLike>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `sessionId` | `string` |
| `params?` | \{ `limit?`: `number`; `types?`: [`ManagedAgentsListedEventType`](#managedagentslistedeventtype)[]; \} |
| `params.limit?` | `number` |
| `params.types?` | [`ManagedAgentsListedEventType`](#managedagentslistedeventtype)[] |

###### Returns

`AsyncIterable`\<[`ManagedAgentsSessionEventLike`](#managedagentssessioneventlike)\>

##### send()

```ts
send(sessionId, params): Promise<unknown>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `sessionId` | `string` |
| `params` | \{ `events`: [`UserToolConfirmationParams`](#usertoolconfirmationparams)[]; \} |
| `params.events` | [`UserToolConfirmationParams`](#usertoolconfirmationparams)[] |

###### Returns

`Promise`\<`unknown`\>

##### stream()

```ts
stream(sessionId): Promise<AsyncIterable<ManagedAgentsSessionEventLike, any, any>>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `sessionId` | `string` |

###### Returns

`Promise`\<`AsyncIterable`\<[`ManagedAgentsSessionEventLike`](#managedagentssessioneventlike), `any`, `any`\>\>

***

### ManagedAgentsWrapOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |

***

### UserToolConfirmationParams

Structural copy of `BetaManagedAgentsUserToolConfirmationEventParams` —
 exactly what this module sends via `events.send()`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-deny_message"></a> `deny_message?` | `string` |
| <a id="property-result"></a> `result` | `"deny"` \| `"allow"` |
| <a id="property-tool_use_id"></a> `tool_use_id` | `string` |
| <a id="property-type-3"></a> `type` | `"user.tool_confirmation"` |

***

### WatchOptions

Options for [IntuticSessionConfirmer.watch](classes/IntuticSessionConfirmer.md#watch).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-backoffcapms"></a> `backoffCapMs?` | `number` | - |
| <a id="property-backoffstartms"></a> `backoffStartMs?` | `number` | - |
| <a id="property-idletimeoutms"></a> `idleTimeoutMs?` | `number` | Drop and reopen a stream that has been silent this long. |
| <a id="property-maxreconnects"></a> `maxReconnects?` | `number` | Reconnects allowed after the first connection; unbounded by default. |
| <a id="property-signal"></a> `signal?` | `AbortSignal` | Aborting ends `watch()` at the next opportunity. |

## Type Aliases

### ManagedAgentsListedEventType

```ts
type ManagedAgentsListedEventType = "agent.tool_use" | "agent.mcp_tool_use" | "user.tool_confirmation";
```

The event types [IntuticSessionConfirmer.poll](classes/IntuticSessionConfirmer.md#poll) filters `list()` to —
 a subset of the SDK's `BetaManagedAgentsSessionEventType`.

***

### ManagedAgentsSessionEventLike

```ts
type ManagedAgentsSessionEventLike = 
  | AgentToolUseEventLike
  | AgentMcpToolUseEventLike
  | AgentCustomToolUseEventLike
  | {
  id?: string;
  tool_use_id?: string;
  type: string;
};
```

Any session event — this module inspects only `.type` (and, for the
 confirmable two, the fields above) so a wider real event passes through
 this structural type untouched. No index signature: the SDK's events are
 interfaces, which TypeScript will not assign to an index-signature type.

## Variables

### MANAGED\_AGENTS\_BETA

```ts
const MANAGED_AGENTS_BETA: "managed-agents-2026-04-01" = 'managed-agents-2026-04-01';
```

The beta header every Sessions-API request needs. The real SDK sets this
 on every `.list()`/`.send()`/`.stream()` call automatically — this
 constant exists for callers building their own request against the
 endpoint directly.

## Functions

### confirmationForEvent()

```ts
function confirmationForEvent(event, opts?): Promise<UserToolConfirmationParams | null>;
```

Build the `user.tool_confirmation` params answering `event`, or `null` if
`event` needs no answer from this module.

`null` covers three cases, all correct to send nothing for: the event
isn't `agent.tool_use`/`agent.mcp_tool_use` (including
`agent.custom_tool_use` — see the module doc); its `evaluated_permission`
is `'allow'` or unset (the call never paused); or it is already `'deny'`
(the SERVER already resolved it — sending a confirmation for an id the
server considers closed would just error).

Anything else — `'ask'`, or a permission value this module doesn't
recognise — is treated as a pause needing a verdict, matching
`SessionToolRunner`'s own fail-closed handling of unrecognised wire values
(hold/deny rather than dispatch).

ASYNC: `Gate.guard()` is async in this package (unlike the Python SDK's
synchronous twin) — every caller must `await` this.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | [`ManagedAgentsSessionEventLike`](#managedagentssessioneventlike) |
| `opts` | [`ManagedAgentsWrapOptions`](#managedagentswrapoptions) |

#### Returns

`Promise`\<[`UserToolConfirmationParams`](#usertoolconfirmationparams) \| `null`\>

***

### isFatal4xx()

```ts
function isFatal4xx(err): boolean;
```

400–499 except 408 (timeout) and 429 (rate limit): a retry cannot help.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `err` | `unknown` |

#### Returns

`boolean`

***

### wrapManagedAgentsCustomTool()

```ts
function wrapManagedAgentsCustomTool<T>(tool, opts?): T;
```

Wrap one Managed Agents custom tool (`BetaRunnableTool` shape) so
`Gate.guard()` runs before `run()` executes.

Returns a NEW object (a shallow copy with `run` replaced); does not mutate
the one passed in. On refusal the wrapped `run()` THROWS
`IntuticGateRefusal` before the real implementation ever runs — the same
throw-based contract `wrapTool()` uses. Already-wrapped tools pass through
unchanged.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ManagedAgentsRunnableToolLike`](#managedagentsrunnabletoollike) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tool` | `T` |
| `opts` | [`ManagedAgentsWrapOptions`](#managedagentswrapoptions) |

#### Returns

`T`

***

### wrapManagedAgentsCustomTools()

```ts
function wrapManagedAgentsCustomTools<T>(tools, opts?): T[];
```

Wrap a collection of Managed Agents custom tools in one call — see
 [wrapManagedAgentsCustomTool](#wrapmanagedagentscustomtool).

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ManagedAgentsRunnableToolLike`](#managedagentsrunnabletoollike) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | readonly `T`[] |
| `opts` | [`ManagedAgentsWrapOptions`](#managedagentswrapoptions) |

#### Returns

`T`[]
