[@intutic/gate](../index.md) / harness

# @intutic/gate/harness

`@ai-sdk/harness` adapter: `intuticApprovalResponder()`, `intuticSubmitApprovals()`,
`intuticStaticApprovals()`, `recommendedHarnessSettings()`, and
`intuticSandboxBootstrap()`.

`@intutic/gate/harness` — the same idea `vercel.ts` implements for the base
`ai` package (wrap the framework's own veto point around this package's
`Gate.guard()`), reshaped for Vercel's sandboxed coding-agent runtime,
whose veto surface is materially different from `generateText`'s.

## Confirmed against a real install

`@ai-sdk/harness@1.0.75` (plus `@ai-sdk/harness-claude-code@1.0.78` and
`@ai-sdk/harness-grok-build@1.0.12`) were installed and their shipped
`.d.ts`/compiled source read directly (not inferred from docs alone);
points 1-3 re-read on `@ai-sdk/harness@1.0.138` (the current devDependency,
on `ai@7.0.127`) — only the continuation element type changed (point 2):

1. **The `toolApproval` setting is STATIC.** `HarnessAgentSettings.toolApproval`
   is `HarnessAgentToolApprovalConfiguration = Readonly<Record<string,
   ToolApprovalStatus>>` (`dist/agent/index.d.ts`), whose own doc comment says
   it mirrors "AI SDK `toolApproval` object configuration for host-executed
   tools, **without callback support**". `vercel.ts`'s callback-shaped
   `intuticToolApproval()` therefore does NOT apply here — there is no place
   to hang a function. Per-call gating instead goes through the approval
   FLOW: mark tools `'user-approval'` (see [intuticStaticApprovals](#intuticstaticapprovals)),
   let the turn pause, and answer each pending approval with the gate
   (see [intuticApprovalResponder](#intuticapprovalresponder)).
2. **The portable answer path is continuation-based.**
   `continueTurn`/`continueGenerate`/`continueStream` accept
   `toolApprovalContinuations` (dist/agent/index.d.ts) — in 1.0.75 an array
   of `HarnessAgentToolApprovalContinuation` (`{ approvalResponse, toolCall
   }`), since 1.0.101 an array of bare `ToolApprovalResponse` parts (the
   old type is no longer exported in 1.0.138); see
   [HarnessToolApprovalContinuation](#harnesstoolapprovalcontinuation) for how one value serves both. The adapter-session
   method `session.submitToolApproval?({approvalId, approved, reason})` is
   OPTIONAL (`dist/index.d.ts` — `HarnessV1PromptControl`), and support
   genuinely varies per adapter: `@ai-sdk/harness-claude-code@1.0.78`
   implements it; `@ai-sdk/harness-grok-build@1.0.12` does not (zero
   occurrences in its shipped dist). This module therefore builds the
   responder on the continuation path and treats `submitToolApproval` as an
   optimization when present ([intuticSubmitApprovals](#intuticsubmitapprovals)).
3. **Built-in sandbox tools are NOT governed by `toolApproval` at all.**
   They are governed by `permissionMode: 'allow-reads' | 'allow-edits'
   | 'allow-all'`, which **defaults to `'allow-all'`** — the shipped doc
   comment says so verbatim: "Defaults to `'allow-all'`, preserving the
   existing bypass-permissions behavior unless users opt in." Under
   `'allow-all'` nothing pauses. Under the stricter modes the mode decides
   WHICH built-ins pause, and each paused call is then a genuine per-call
   approval this gate answers: the
   `@ai-sdk/harness-claude-code` bridge (`dist/bridge/index.mjs`,
   `createPermissionSettings`/`nativeToolRequiresApproval`) adds `ask` rules
   for bash-kind tools (`Bash`, `Monitor`) under `'allow-edits'`, and for
   edit- and bash-kind tools under `'allow-reads'`, emitting a
   `tool-approval-request` and blocking on the host's answer;
   `@ai-sdk/harness/agent` records it as a pending approval with
   `kind: 'builtin'`, pauses the turn, and delivers the continuation's
   decision through the adapter's `submitToolApproval`. What never pauses:
   read-kind built-ins (Read/Glob/Grep/WebFetch/...) in ANY mode, and
   write/edit under `'allow-edits'`. [recommendedHarnessSettings](#recommendedharnesssettings-1)
   exists to steer callers off the `'allow-all'` default.
4. **Execution is server-side, in a sandbox.** The agent's tools run inside
   a microVM (`@ai-sdk/sandbox-vercel` and friends), NOT on the machine
   where the Intutic proxy runs — the laptop proxy cannot see sandbox
   egress. The only egress control available at this layer is the sandbox's
   own `HarnessV1NetworkPolicy` (`{mode:'allow-all'|'deny-all'} | {mode:
   'custom', allowedHosts/allowedCIDRs/deniedCIDRs}`), applied via the
   sandbox session's optional `setNetworkPolicy?.()`. That is coarse
   host-level filtering, not Intutic DLP — stated plainly in
   `apps/docs/integrations/ai-sdk-harness.md` rather than oversold.

## What this module does NOT import

Deliberately no runtime dependency on `@ai-sdk/harness` — the structural
types below capture only the shapes this adapter touches, matching the
convention `vercel.ts`/`mastra.ts`/`dsh.ts` established. The real package
is a devDependency used by `__tests__/harness.test.ts` to (a) structurally
check these types against the shipped ones and (b) run this responder's
output through the REAL `collectHarnessAgentToolApprovalContinuations`
machinery.

## Interfaces

### HarnessApprovalRequest

One pending tool-approval request, in the shape this responder consumes.

Covers BOTH places a HarnessAgent surfaces one:

  - the `tool-approval-request` stream/message parts of a running turn
    (paired with their `tool-call` parts — `input` is the parsed value), and
  - `HarnessAgentPendingToolApproval` rows from a suspended session, where
    `input` is a JSON **string** (confirmed: `HarnessV1PendingToolApproval.
    input: string` in `@ai-sdk/harness@1.0.75`'s dist/index.d.ts). String
    inputs are JSON-parsed before the gate evaluates them — see
    [renderHarnessToolInput](#renderharnesstoolinput).

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-approvalid"></a> `approvalId` | `readonly` | `string` | - |
| <a id="property-input"></a> `input` | `readonly` | `unknown` | Parsed input object, or the JSON string a pending-approval row carries. |
| <a id="property-providerexecuted"></a> `providerExecuted?` | `readonly` | `boolean` | - |
| <a id="property-toolcallid"></a> `toolCallId` | `readonly` | `string` | - |
| <a id="property-toolname"></a> `toolName` | `readonly` | `string` | - |

***

### HarnessSessionLike

The slice of `@ai-sdk/harness`'s adapter-session control surface this
 module touches — `submitToolApproval` is OPTIONAL in the real
 `HarnessV1PromptControl` too, and per-adapter support varies (see module
 doc point 2).

#### Methods

##### submitToolApproval()?

```ts
optional submitToolApproval(input): PromiseLike<void>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | \{ `approvalId`: `string`; `approved`: `boolean`; `reason?`: `string`; \} |
| `input.approvalId` | `string` |
| `input.approved` | `boolean` |
| `input.reason?` | `string` |

###### Returns

`PromiseLike`\<`void`\>

***

### HarnessToolApprovalContinuation

One element of the `toolApprovalContinuations` array
`continueGenerate`/`continueStream` accept — shaped to satisfy BOTH
upstream contracts, because the shape changed in a patch release:

  - `@ai-sdk/harness` \<= 1.0.100 reads `HarnessAgentToolApprovalContinuation`
    = `{ approvalResponse, toolCall }`.
  - `@ai-sdk/harness` \>= 1.0.101 (2026-09-03) reads a bare
    `ToolApprovalResponse` and keys it by its top-level `approvalId`; an
    element without one is silently ignored and the paused turn never
    resumes (observed live, `uat/evidence/live-verify/harness-docker/`).
    Still the contract in 1.0.138, whose `collectHarnessAgentToolApproval
    Continuations` also returns bare `ToolApprovalResponse` parts.

So each continuation IS the `tool-approval-response` part (top-level
fields) and also carries `approvalResponse`/`toolCall` for older runtimes.

#### Extends

- [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse)

#### Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-approvalid-1"></a> `approvalId` | `public` | `string` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse).[`approvalId`](#property-approvalid-2) |
| <a id="property-approvalresponse"></a> `approvalResponse` | `readonly` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse) | - |
| <a id="property-approved"></a> `approved` | `public` | `boolean` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse).[`approved`](#property-approved-1) |
| <a id="property-providerexecuted-1"></a> `providerExecuted?` | `public` | `boolean` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse).[`providerExecuted`](#property-providerexecuted-2) |
| <a id="property-reason"></a> `reason?` | `public` | `string` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse).[`reason`](#property-reason-1) |
| <a id="property-toolcall"></a> `toolCall` | `readonly` | [`HarnessToolCallPart`](#harnesstoolcallpart) | - |
| <a id="property-type"></a> `type` | `public` | `"tool-approval-response"` | [`HarnessToolApprovalResponse`](#harnesstoolapprovalresponse).[`type`](#property-type-1) |

***

### HarnessToolApprovalResponse

Structural copy of `ai`'s `ToolApprovalResponse` prompt part (re-exported
 from `@ai-sdk/provider-utils` — confirmed field-for-field on 5.0.27 and
 5.0.53). This is
 the part a `role: 'tool'` message carries to answer an approval request.

#### Extended by

- [`HarnessToolApprovalContinuation`](#harnesstoolapprovalcontinuation)

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-approvalid-2"></a> `approvalId` | `string` |
| <a id="property-approved-1"></a> `approved` | `boolean` |
| <a id="property-providerexecuted-2"></a> `providerExecuted?` | `boolean` |
| <a id="property-reason-1"></a> `reason?` | `string` |
| <a id="property-type-1"></a> `type` | `"tool-approval-response"` |

***

### HarnessToolCallPart

Structural copy of the `toolCall` member of `@ai-sdk/harness` \<= 1.0.100's
 `HarnessAgentToolApprovalContinuation` (dist/agent/index.d.ts).

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-input-1"></a> `input` | `readonly` | `unknown` |
| <a id="property-providerexecuted-3"></a> `providerExecuted?` | `readonly` | `boolean` |
| <a id="property-toolcallid-1"></a> `toolCallId` | `readonly` | `string` |
| <a id="property-toolname-1"></a> `toolName` | `readonly` | `string` |
| <a id="property-type-2"></a> `type` | `readonly` | `"tool-call"` |

***

### IntuticApprovalResponderOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |

***

### IntuticSandboxBootstrap

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-bootstraphash"></a> `bootstrapHash` | `readonly` | `string` | Pass through unchanged to `HarnessAgentSettings.sandboxConfig.bootstrapHash` — required alongside `onBootstrap` by the real type. Deterministic: the same options always produce the same hash, and a snapshot-capable sandbox provider uses it to decide whether `onBootstrap` needs to run again. Computed the same way `snapshot.ts` computes the policy-snapshot digest — `createHash('sha256')` over the recipe content, this module's own existing hashing convention, not a new one. |
| <a id="property-onbootstrap"></a> `onBootstrap` | `readonly` | (`opts`) => `Promise`\<`void`\> | Pass through unchanged to `HarnessAgentSettings.sandboxConfig.onBootstrap`. |

***

### IntuticSandboxBootstrapOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-bootstrapdir"></a> `bootstrapDir?` | `string` | Directory inside the sandbox (relative to `workDir`) the hook script and its rules file are written under. Defaults to `.intutic/hooks`, the same relative location the laptop writer uses. |
| <a id="property-policysnapshotrules"></a> `policySnapshotRules?` | `string` | Compiled `.rules` text — the SAME artifact format `snapshot.ts` reads (`~/.intutic/hooks/policy-snapshot.rules` on a laptop). Copy the file content in, e.g. by reading it from the host running the orchestrator code before constructing this bootstrap. Omit to ship a hook script that loads zero rules (still present as a channel, evaluating nothing) — never silently skipped, so a missing snapshot shows up as an empty file inside the sandbox rather than a missing one. |
| <a id="property-workspaceid"></a> `workspaceId?` | `string` | Embedded in the recipe hash (so a workspace switch invalidates a cached snapshot) and in the hook script, which treats rules issued to another workspace as unverified — an integrity check, as `snapshot.ts`'s reader makes it, not a lookup key. |

***

### IntuticStaticApprovalsOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-deny"></a> `deny?` | readonly `string`[] | Tool names to mark `'denied'` unconditionally instead of `'user-approval'` — for tools that should never run under this agent regardless of what the gate would say about a specific call. |

***

### IntuticSubmitApprovalsResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-continuations"></a> `continuations` | [`HarnessToolApprovalContinuation`](#harnesstoolapprovalcontinuation)[] | The evaluated decisions, always produced — pass these to `continueGenerate`/`continueStream` when `submitted` is false. |
| <a id="property-submitted"></a> `submitted` | `boolean` | True when the session supported `submitToolApproval` and every decision was delivered through it; false when the caller must use the continuation path instead. |

***

### RecommendedHarnessSettings

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-inactivetools"></a> `inactiveTools?` | readonly \[`"bash"`\] | Spread into `HarnessAgentSettings.inactiveTools` — `undefined` when `filterBash: false` was passed. `HarnessV1BuiltinToolFiltering` (the same package's own type, `dist/index.d.ts`/`dist/agent/index.d.ts`) genuinely CAN drop `bash` at config time, confirmed against real shipped `dist/index.js` for both wrapped harnesses, Claude Code and Grok Build (not just their `.d.ts` — the behaviour lives in compiled logic no type file states): - `@ai-sdk/harness-claude-code@1.0.78` sets BOTH `supportsBuiltinToolApprovals: true` AND `supportsBuiltinToolFiltering: true` on its adapter object, and its `doStart`/`doContinueTurn` forward `builtinToolFiltering` verbatim onto the bridge `start`/`continue` message — true native exclusion, enforced by the wrapped Claude Agent SDK inside the sandbox itself, not merely a framework-side veto. `bash` never becomes callable. - `@ai-sdk/harness-grok-build@1.0.12` sets neither flag directly, but is built on `@ai-sdk/harness-acp@1.0.13` (its exact pinned dependency, confirmed via `npm pack`), which sets `supportsBuiltinToolApprovals: true` (and `supportsBuiltinToolFiltering: false`) — so Grok Build gets the FRAMEWORK's own fallback instead: `@ai-sdk/harness/agent`'s compiled `resolveHarnessAgentToolFiltering` (`dist/agent/index.js`) routes every inactive-builtin call through the approval path and auto-denies it before execution. Different mechanism, same practical outcome — `bash` is still never executed. - Confirmed further: if an adapter supported NEITHER flag, the framework does not silently ignore `inactiveTools` for a builtin — `HarnessAgent`'s constructor throws `HarnessCapabilityUnsupportedError` (`dist/agent/index.js`) rather than accepting a setting it cannot honour. So this recommendation is never a silent no-op for any adapter that accepts it at all. This is a coarse, all-or-nothing exclusion decided once at session-construction time — never a `Gate.guard()`-evaluated verdict per call. A workspace that genuinely needs `bash` passes `filterBash: false` and keeps `permissionMode: 'allow-edits'` (or `'allow-reads'`): every bash call then pauses as a builtin approval request and [intuticApprovalResponder](#intuticapprovalresponder) gives it a per-call verdict (see the `permissionMode` bullet on [recommendedHarnessSettings](#recommendedharnesssettings-1)). |
| <a id="property-networkpolicy"></a> `networkPolicy` | [`RecommendedNetworkPolicy`](#recommendednetworkpolicy) | NOT a `HarnessAgentSettings` field — apply it to the sandbox session via its optional `setNetworkPolicy?.()` (e.g. from `sandboxConfig.onSession`), or configure the equivalent on the sandbox provider. Optional-call it: providers without a local enforcement primitive omit the method, and a missing implementation means NO egress policy is applied at all — check for `undefined` and treat that as an uncovered surface, not a silent ok. |
| <a id="property-permissionmode"></a> `permissionMode` | `"allow-reads"` \| `"allow-edits"` | Spread into `HarnessAgentSettings`. |

***

### RecommendedHarnessSettingsOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-allowedhosts"></a> `allowedHosts?` | readonly `string`[] | Hosts sandbox egress should be limited to. When omitted, the recommended policy is `{ mode: 'deny-all' }` — deny-by-default until the caller decides what the sandbox legitimately needs to reach. |
| <a id="property-filterbash"></a> `filterBash?` | `boolean` | Whether to also recommend excluding the sandbox's native `bash` builtin from the tool set entirely, via `HarnessAgentSettings.inactiveTools`. Defaults to `true` — see [RecommendedHarnessSettings.inactiveTools](#property-inactivetools) for what this does and does not guarantee. |
| <a id="property-permissionmode-1"></a> `permissionMode?` | `"allow-reads"` \| `"allow-edits"` | `'allow-reads'` is stricter (built-ins can read but not write); the default recommendation is `'allow-edits'` (read + write inside the sandbox, but not the unrestricted `'allow-all'` the framework itself defaults to). `'allow-all'` is deliberately not accepted here — asking this function for the framework's own bypass default would make the helper's name a lie. |

***

### SandboxBootstrapCallbackOptions

Structural copy of `@ai-sdk/harness/agent`'s
 `HarnessAgentSandboxConfig['onBootstrap']` parameter shape
 (`dist/agent/index.d.ts`), narrowed to the fields this module reads.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-abortsignal"></a> `abortSignal?` | `readonly` | `AbortSignal` |
| <a id="property-session"></a> `session` | `readonly` | [`SandboxWriteSession`](#sandboxwritesession) |
| <a id="property-workdir"></a> `workDir` | `readonly` | `string` |

***

### SandboxWriteSession

Structural copy of `@ai-sdk/provider-utils`'s `SandboxSession`, narrowed
 to the methods [intuticSandboxBootstrap](#intuticsandboxbootstrap-1)'s `onBootstrap` calls.
 Confirmed field-for-field against `@ai-sdk/provider-utils@5.0.27`'s
 shipped `dist/index.d.ts` (`WriteFileOptions<string>` plus its own
 `encoding` addition on `writeTextFile`; `readTextFile` resolves `null`
 for a missing file).

#### Methods

##### readTextFile()

```ts
readTextFile(options): PromiseLike<string | null>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `abortSignal?`: `AbortSignal`; `path`: `string`; \} |
| `options.abortSignal?` | `AbortSignal` |
| `options.path` | `string` |

###### Returns

`PromiseLike`\<`string` \| `null`\>

##### run()

```ts
run(options): PromiseLike<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `abortSignal?`: `AbortSignal`; `command`: `string`; \} |
| `options.abortSignal?` | `AbortSignal` |
| `options.command` | `string` |

###### Returns

`PromiseLike`\<\{
  `exitCode`: `number`;
  `stderr`: `string`;
  `stdout`: `string`;
\}\>

##### writeTextFile()

```ts
writeTextFile(options): PromiseLike<void>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `content`: `string`; `encoding?`: `string`; `path`: `string`; \} |
| `options.content` | `string` |
| `options.encoding?` | `string` |
| `options.path` | `string` |

###### Returns

`PromiseLike`\<`void`\>

## Type Aliases

### HarnessNetworkPolicy

```ts
type HarnessNetworkPolicy = 
  | {
  mode: "allow-all";
}
  | {
  mode: "deny-all";
}
  | {
  allowedCIDRs?: readonly string[];
  allowedHosts?: readonly string[];
  deniedCIDRs?: readonly string[];
  mode: "custom";
};
```

Structural copy of `@ai-sdk/harness`'s `HarnessV1NetworkPolicy`. The two
 `custom` branches of the real union each require at least one allow field;
 this single structural branch keeps both optional and relies on the test
 suite's assignability check against the real (stricter) type for the
 values this module itself constructs.

***

### HarnessPermissionMode

```ts
type HarnessPermissionMode = "allow-reads" | "allow-edits" | "allow-all";
```

Structural copy of `@ai-sdk/harness`'s `HarnessV1PermissionMode`.

***

### RecommendedNetworkPolicy

```ts
type RecommendedNetworkPolicy = 
  | {
  mode: "deny-all";
}
  | {
  allowedHosts: readonly string[];
  deniedCIDRs: readonly string[];
  mode: "custom";
};
```

The exact policy shapes [recommendedHarnessSettings](#recommendedharnesssettings-1) constructs —
 narrower than [HarnessNetworkPolicy](#harnessnetworkpolicy) so the value is assignable to
 the REAL `HarnessV1NetworkPolicy` union (whose `custom` branches each
 require an allow field) without a cast; the test suite pins that
 assignability against the shipped type.

## Functions

### intuticApprovalResponder()

```ts
function intuticApprovalResponder(opts?): (requests) => Promise<HarnessToolApprovalContinuation[]>;
```

Build an approval responder: a function that evaluates each pending
tool-approval request via `Gate.guard()` and produces the
`toolApprovalContinuations` array for the continue-turn call —
`agent.continueGenerate({ session, toolApprovalContinuations })` /
`continueStream(...)`:

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { Gate, install } from '@intutic/gate'
import {
  intuticApprovalResponder,
  intuticStaticApprovals,
  recommendedHarnessSettings,
} from '@intutic/gate/harness'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const agent = new HarnessAgent({
  harness,
  sandbox,
  tools,
  ...recommendedHarnessSettings(),           // permissionMode: 'allow-edits'
  toolApproval: intuticStaticApprovals(tools), // every custom tool -> 'user-approval'
})

const respond = intuticApprovalResponder()
// ...run a turn; when it pauses awaiting approval, collect the pending
// tool-approval requests (stream parts or suspended-session rows), then:
const toolApprovalContinuations = await respond(pendingApprovals)
await agent.continueGenerate({ session, toolApprovalContinuations })
```

Decision mapping, per request:

  - gate allows              -\> `approved: true`
  - `IntuticGateRefusal`     -\> `approved: false`, `reason` = the
    `[Intutic Governance] BLOCKED: ...` message (the runtime submits an
    `execution-denied` result to the model in place of a tool result)
  - any OTHER throw          -\> `approved: false` with a "gate crashed"
    reason — **fail closed**, same posture as `dsh.ts`'s listener: this
    responder's output is a decision list consumed by a paused turn, and a
    deny is deliverable and auditable where an escaped throw could leave
    the turn suspended with no answer at all.

Requires a `Gate` — either passed via `{ gate }`, or installed process-wide
with `install(new Gate(...))`. A call with neither rejects before
evaluating anything, refusing to answer approvals unguarded.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticApprovalResponderOptions`](#intuticapprovalresponderoptions) |

#### Returns

(`requests`) => `Promise`\<[`HarnessToolApprovalContinuation`](#harnesstoolapprovalcontinuation)[]\>

***

### intuticSandboxBootstrap()

```ts
function intuticSandboxBootstrap(opts?): IntuticSandboxBootstrap;
```

Builds `{ bootstrapHash, onBootstrap }` for
`HarnessAgentSettings.sandboxConfig` — a channel the framework provides
but nothing used:

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { intuticSandboxBootstrap, recommendedHarnessSettings } from '@intutic/gate/harness'

const agent = new HarnessAgent({
  harness,
  sandbox,
  ...recommendedHarnessSettings(),
  sandboxConfig: intuticSandboxBootstrap({
    policySnapshotRules: fs.readFileSync(snapshotPath(), 'utf-8'),
    workspaceId: process.env.INTUTIC_WORKSPACE_ID,
  }),
})
```

Writes two files under `<workDir>/<bootstrapDir>` (default
`.intutic/hooks`) — the rules text verbatim, and a self-contained hook
script implementing Tier A1 against it (see
renderSandboxGateScript) — plus `.claude/settings.json` at
`<workDir>/.claude/settings.json` registering that script as a
`PreToolUse` hook, and the same registration merged into the sandbox user's
`$HOME/.claude/settings.json` (see writeSandboxUserSettings — the
project-level file alone does not reach per-session work directories). See
the module-level comment above this section for what this does and does
not cover, and why.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticSandboxBootstrapOptions`](#intuticsandboxbootstrapoptions) |

#### Returns

[`IntuticSandboxBootstrap`](#intuticsandboxbootstrap)

***

### intuticStaticApprovals()

```ts
function intuticStaticApprovals(tools, opts?): Readonly<Record<string, "user-approval" | "denied">>;
```

Build the static `toolApproval` record for `HarnessAgentSettings`.

The record shape is `Readonly<Record<string, ToolApprovalStatus>>` — STATIC
per-tool statuses "without callback support" (the shipped doc comment's own
words), so a per-call gate function cannot be expressed here at all. What a
static record CAN express is deny-by-default **routing**: every listed tool
is marked `'user-approval'`, which pauses the turn on every call to it, and
[intuticApprovalResponder](#intuticapprovalresponder) then answers each pause with a real
per-call `Gate.guard()` verdict. `'denied'` is deliberately NOT the default
here — it would refuse every call to the tool unconditionally, without the
gate ever seeing the arguments; use `{ deny: [...] }` for tools where that
is actually what you want.

Two scope limits, stated plainly:

  - This covers CUSTOM host-executed tools only. Built-in sandbox tools
    (read/write/edit/bash/...) never consult `toolApproval` — which of them
    pause is decided by `permissionMode` (default `'allow-all'`: none), and
    a paused built-in reaches [intuticApprovalResponder](#intuticapprovalresponder) the same way
    a custom tool's approval does. See [recommendedHarnessSettings](#recommendedharnesssettings-1).
  - A tool absent from this record has status `undefined` =
    "not-applicable" and runs WITHOUT any approval pause. Pass the same
    `tools` record you give the agent (or every tool name), not a subset.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | readonly `string`[] \| `Record`\<`string`, `unknown`\> |
| `opts` | [`IntuticStaticApprovalsOptions`](#intuticstaticapprovalsoptions) |

#### Returns

`Readonly`\<`Record`\<`string`, `"user-approval"` \| `"denied"`\>\>

***

### intuticSubmitApprovals()

```ts
function intuticSubmitApprovals(
   session, 
   requests, 
   opts?
): Promise<IntuticSubmitApprovalsResult>;
```

Evaluate pending approvals and deliver the decisions through
`session.submitToolApproval` when the adapter supports it.

`submitToolApproval` is an OPTIONAL adapter-session method and per-adapter
support varies (`harness-claude-code` implements it, `harness-grok-build`
does not — see module doc point 2). This helper treats it as an
optimization: when present, every decision is submitted directly (the turn
resumes in place); when absent, nothing is submitted and the caller passes
the returned `continuations` to `continueGenerate`/`continueStream` — the
portable path — instead. Either way the SAME evaluated decisions are
returned, so the caller never re-runs the gate for one delivery mechanism
vs. the other.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `session` | [`HarnessSessionLike`](#harnesssessionlike) |
| `requests` | readonly [`HarnessApprovalRequest`](#harnessapprovalrequest)[] |
| `opts` | [`IntuticApprovalResponderOptions`](#intuticapprovalresponderoptions) |

#### Returns

`Promise`\<[`IntuticSubmitApprovalsResult`](#intuticsubmitapprovalsresult)\>

***

### recommendedHarnessSettings()

```ts
function recommendedHarnessSettings(opts?): RecommendedHarnessSettings;
```

The settings posture this integration recommends, as a value callers can
spread/apply rather than prose they have to transcribe:

  - `permissionMode: 'allow-edits'` (or `'allow-reads'`) — because the
    framework's own default is `'allow-all'`, under which built-in sandbox
    tools (including `bash`) run with no approval surface this gate can
    reach. Under `'allow-edits'` every bash-kind built-in call pauses as a
    `kind: 'builtin'` approval request that [intuticApprovalResponder](#intuticapprovalresponder)
    answers per call; `'allow-reads'` adds write/edit to that. Read-kind
    built-ins never pause in any mode — the mode is the only control for
    them.
  - `inactiveTools: ['bash']` (default) — removes bash outright. With the
    default, bash calls never reach the gate because bash is never
    callable; `filterBash: false` is the per-call alternative (bash stays
    available and every call is gated as above).
  - a `networkPolicy` for the sandbox — `{ mode: 'deny-all' }` by default,
    or a `custom` allow-list (with the cloud-metadata CIDR denied) when
    `allowedHosts` is given. This is the honest egress-governance story for
    server-side sandbox execution: the Intutic proxy on the developer's
    machine never sees sandbox traffic, and host-level filtering is what
    the sandbox layer actually offers. It is coarse — no DLP, no
    per-request policy — and the integration docs say so.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`RecommendedHarnessSettingsOptions`](#recommendedharnesssettingsoptions) |

#### Returns

[`RecommendedHarnessSettings`](#recommendedharnesssettings)

***

### renderHarnessToolInput()

```ts
function renderHarnessToolInput(input): ToolInput;
```

Render a pending approval's `input` as the `tool_input` object
[Gate.guard](../core/classes/Gate.md#guard) evaluates.

Mirrors `dsh.ts`'s `renderDshToolInput`, plus one harness-specific case: a
`HarnessAgentPendingToolApproval` carries its input as a JSON **string**,
so strings are parsed first. A string that does not parse (or parses to a
non-object) falls back to `{ args: [...] }` so the gate still has
something to evaluate rather than throwing on a shape it does not
recognise.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `unknown` |

#### Returns

[`ToolInput`](../core/index.md#toolinput)
