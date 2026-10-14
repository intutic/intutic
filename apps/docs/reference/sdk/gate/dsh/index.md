[@intutic/gate](../index.md) / dsh

# @intutic/gate/dsh

dsh.ts — Cordis plugin adapter for DeepSeek's "dsh" harness.

Published as the `@intutic/gate/dsh` subpath (see README.md's "Subpath
convention for later phases"). `services/sync-daemon/src/harness/dshHooks.ts`
merge-writes a row naming this module (`name: '@intutic/gate/dsh'`) into a
dsh profile's `cordis.patch.yml`; dsh's own Cordis loader resolves that name
with a plain dynamic `import()` and mounts the exported plugin
(`{ name, inject, apply }`) the same way it mounts every other bundle row.

## The veto mechanism — CONFIRMED against a real install, not assumed

dsh is a developer preview (`@deepseek-ai/dsh`, first published 2026-08-13)
built on DeepSeek's own "Cordis" plugin framework (`@deepseek-ai/cordis`,
`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-app-boot`, ...). Both are public
on the npm registry, and this module was authored against a real
`npm pack`/inspection of them (see the TD entry this phase filed for exactly
what was checked and what still had to be assumed) — NOT solely from the
phase brief's prior guess, which named a different event (`agent/pre-step`)
and a different decision shape (`{kind:'reject',...}`). Both turned out to
be close but not exact:

  - The real per-tool veto point is `tools/pre-execute` (declared by
    `@deepseek-ai/dsh-tools`), not `agent/pre-step` (`@deepseek-ai/dsh-agent`'s
    per-turn/step event — a coarser boundary that batches a driver step
    rather than one tool call, and the wrong extension point for a
    per-tool-call gate).
  - It is a genuine Cordis `waterfall`: `(exec: ToolExecution, next: () =>
    Promise<PreToolDecision>) => Promise<PreToolDecision>`. Cordis's own
    waterfall contract (confirmed by reading `@deepseek-ai/cordis`'s
    `events.d.ts`) composes listeners around a `next()` continuation —
    "a listener that does not call next() vetoes the rest of the chain,
    including the built-in behavior" — so this listener calls `next()` on
    ALLOW (to preserve whatever later listener or built-in behaviour — e.g.
    dsh's own `ask`/approval flow — would otherwise run) and returns its own
    `{kind:'deny',...}` WITHOUT calling `next()` to veto.
  - The decision shape is `PreToolDecision = {kind:'allow'} | {kind:'deny',
    reason} | {kind:'ask', reason?}` (confirmed from
    `@deepseek-ai/dsh-tools`'s shipped `.d.ts`) — `'deny'`, not the phase
    brief's guessed `'reject'`. dsh 0.2 widened it (`deny` gained an
    optional `info`, `ask` an optional `displayReason`, and a new
    `{kind:'cancel'}` exists); this listener never produces those, but a
    later listener's `next()` result may be one, so the type below says so.

## Re-verified against dsh 0.2.0-rc.2 (2026-10-03)

Read from `@deepseek-ai/dsh-tools@0.2.0-rc.2`'s shipped `lib/index.js`, not
only its types: the registry runs the `tools/pre-execute` waterfall with
`() => ({kind:'allow'})` as the terminal `next()`; a `deny` becomes the
tool result `Error: <reason>` with `isError: true` and the tool body never
runs; an `ask` goes to `ctx.approval` (`dsh-user-approval`, mounted by
`dsh-base` with policy `ask`) and, when no approval service is mounted, is
itself converted to a deny. Guards registered with `ctx.tools.guard()` run
after the waterfall and can only deny, so nothing downstream turns this
listener's deny back into an allow. Every other shipped listener
(`dsh-tool-jobs`, `dsh-workspace-changes`, `dsh-hooks-claude-code`, the
optional `dsh-experimental-auto-review`) calls `next()` before deciding,
so this listener is reached; auto-review returns the downstream result
whenever it is not `allow`. Observed end to end in a live headless
0.2.0-rc.2 session against a local mock model: the blocked `bash` call
never ran and the model's next request carried the deny reason as an
`is_error` tool_result (uat/evidence/live-verify/dsh-0.2.md).

`ctx.tools.guard()` (a separate, monotonic, explicitly SYNCHRONOUS
mechanism dsh also exposes) was considered and rejected: `@intutic/gate`'s
`Gate.guard()` is async (network-backed SOP-rule fetch and `/hook-gate`
POST — see gate.ts's module doc), and a synchronous `ToolGuard` cannot
`await` it. `tools/pre-execute` is the only one of dsh's two extension
points this package's async contract fits.

## What this module does NOT import

Deliberately no dependency on `@deepseek-ai/cordis` or `@deepseek-ai/dsh-tools`
at runtime — `CordisLikeContext`/`DshToolExecution`/`DshPreToolDecision`
below are narrow structural types capturing only the shape this plugin
actually touches, matching Cordis's own duck-typed plugin contract (a
plain `{ name?, inject?, apply(ctx, config) }` object — confirmed against
both `@deepseek-ai/cordis`'s README quick-start and dsh's own in-product
"cordis-plugin-development" skill doc, which returns `{ apply(ctx) {...} }`
with no import of anything). Adding a hard dependency on a fast-moving
preview product's framework package to `@intutic/gate`'s dsh subpath would
make every OTHER subpath's install pull it in too (or need a peerDependency
carve-out) for a shape simple enough to describe locally. The real
`@deepseek-ai/cordis` package is used only as a devDependency, in this
module's own test file, to exercise the real waterfall dispatch mechanics
against the genuine `Context` class rather than a hand-rolled stand-in.

## Interfaces

### CordisLikeContext

Structural stand-in for the Cordis `Context` this plugin needs — see the
module doc for why the real `@deepseek-ai/cordis` package is not imported.

#### Methods

##### on()

```ts
on(event, listener): () => boolean;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"tools/pre-execute"` |
| `listener` | (`exec`, `next`) => `Promise`\<[`DshPreToolDecision`](#dshpretooldecision)\> |

###### Returns

() => `boolean`

***

### DshGateConfig

`cordis.patch.yml` row config for this plugin. Extends the core
 [GateConfig](../core/index.md#gateconfig) with the one dsh-specific knob: an explicit session id,
 since dsh has no single "the session" this plugin can read off `exec` (a
 `ToolExecution` carries an `agent?`, not a raw session/conversation id) —
 see resolveSessionId.

#### Extends

- [`GateConfig`](../core/index.md#gateconfig)

#### Properties

| Property | Type | Default value | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="property-allowlistpath"></a> `allowlistPath?` | `string` | `'.intutic/image-allowlist.json'` | The image allowlist, relative to `repoRoot` unless absolute. | [`GateConfig`](../core/index.md#gateconfig).[`allowlistPath`](../core/index.md#property-allowlistpath) |
| <a id="property-enforce"></a> `enforce?` | `boolean` | `true` | `false` turns [Gate.guard](../core/classes/Gate.md#guard) into a no-op. | [`GateConfig`](../core/index.md#gateconfig).[`enforce`](../core/index.md#property-enforce) |
| <a id="property-reporoot"></a> `repoRoot?` | `string` | `'.'` | Where relative manifest and allowlist paths resolve from. | [`GateConfig`](../core/index.md#gateconfig).[`repoRoot`](../core/index.md#property-reporoot) |
| <a id="property-sessionid"></a> `sessionId?` | `string` | `undefined` | Overrides the generated-per-process session id. Mirrors `INTUTIC_SESSION_ID` for callers that already have one to hand. | - |
| <a id="property-usehookgate"></a> `useHookGate?` | `boolean` | `true` | Call the control plane's hook gate (needs a client). | [`GateConfig`](../core/index.md#gateconfig).[`useHookGate`](../core/index.md#property-usehookgate) |
| <a id="property-usesoprules"></a> `useSopRules?` | `boolean` | `true` | Fetch and apply the workspace's SOP rules (needs a client). | [`GateConfig`](../core/index.md#gateconfig).[`useSopRules`](../core/index.md#property-usesoprules) |
| <a id="property-workspaceid"></a> `workspaceId?` | `string` | `''` | Compared with the workspace the policy snapshot was compiled for, and scopes the SOP-rule fetch. | [`GateConfig`](../core/index.md#gateconfig).[`workspaceId`](../core/index.md#property-workspaceid-1) |

***

### DshToolExecution

The slice of dsh's real `tools/pre-execute` payload (`ToolExecution`, from
`@deepseek-ai/dsh-tools`) this plugin reads. `arguments` is documented as
"losslessly JSON-serializable parsed arguments (tools validate their own
schema)" — an `unknown`, not necessarily an object, hence
renderDshToolInput below.

#### Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-arguments"></a> `arguments` | `readonly` | `unknown` |
| <a id="property-name"></a> `name` | `readonly` | `string` |

## Type Aliases

### DshPreToolDecision

```ts
type DshPreToolDecision = 
  | {
  kind: "allow";
}
  | {
  kind: "deny";
  reason: string;
}
  | {
  kind: "ask";
  reason?: string;
}
  | {
  kind: "cancel";
};
```

The slice of the real `PreToolDecision` union from `@deepseek-ai/dsh-tools`
 (0.2.0-rc.2) this plugin returns or passes through from `next()`.

## Variables

### default

```ts
default: object;
```

Default export — the whole Plugin object, for `name: '@intutic/gate/dsh'`
 cordis.patch.yml rows that resolve this module and pass it directly to
 `ctx.plugin()` (dsh's loader unwraps a default export the same way it
 unwraps a named one — see `dsh-app-boot`'s `unwrapExports`). Named exports
 (`apply`, `inject`, `PLUGIN_NAME`) are also available for a caller that
 imports this subpath directly rather than through the loader.

#### Type Declaration

| Name | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-apply"></a> `apply()` | (`ctx`, `config`) => `void` | - | Mount the Intutic governance gate on a dsh profile. Builds one [Gate](../core/classes/Gate.md) for the lifetime of this plugin instance (not per call — Tier A1/A2/A3 all cache within a `Gate`, see gate.ts) and installs it as the process-wide default too (`install()`), so a hand-authored `wrapTool`/`wrapTools` call elsewhere in the same dsh process picks up the identical instance rather than constructing a second one with independent caches. Never throws out of `apply()` itself: a `GateClient.fromEnv` failure (e.g. credentials genuinely unreadable) degrades to a client-less `Gate` — Tier B and Tier A3 inactive, Tier A1/A2 (local, load-bearing) unaffected — rather than taking down the whole dsh profile boot over a governance layer that is additive by design. |
| <a id="property-inject"></a> `inject` | `string`[] | - | Cordis Plugins declare their hard dependencies here; the loader defers activation until every named service exists and reactivates on restart. `tools` is `@deepseek-ai/dsh-tools`'s `ToolRegistry` service — the thing that actually dispatches `tools/pre-execute`. |
| <a id="property-name-1"></a> `name` | `string` | `PLUGIN_NAME` | - |

***

### inject

```ts
const inject: string[];
```

Cordis Plugins declare their hard dependencies here; the loader defers
 activation until every named service exists and reactivates on restart.
 `tools` is `@deepseek-ai/dsh-tools`'s `ToolRegistry` service — the thing
 that actually dispatches `tools/pre-execute`.

***

### PLUGIN\_NAME

```ts
const PLUGIN_NAME: "intutic-governance" = 'intutic-governance';
```

The Cordis Plugin id this module registers as. Shown in dsh's own plugin
 diagnostics/`--dump-config` output.

## Functions

### apply()

```ts
function apply(ctx, config?): void;
```

Mount the Intutic governance gate on a dsh profile.

Builds one [Gate](../core/classes/Gate.md) for the lifetime of this plugin instance (not per
call — Tier A1/A2/A3 all cache within a `Gate`, see gate.ts) and installs it
as the process-wide default too (`install()`), so a hand-authored
`wrapTool`/`wrapTools` call elsewhere in the same dsh process picks up the
identical instance rather than constructing a second one with independent
caches.

Never throws out of `apply()` itself: a `GateClient.fromEnv` failure (e.g.
credentials genuinely unreadable) degrades to a client-less `Gate` — Tier B
and Tier A3 inactive, Tier A1/A2 (local, load-bearing) unaffected — rather
than taking down the whole dsh profile boot over a governance layer that is
additive by design.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ctx` | [`CordisLikeContext`](#cordislikecontext) |
| `config` | [`DshGateConfig`](#dshgateconfig) |

#### Returns

`void`

***

### createPreExecuteListener()

```ts
function createPreExecuteListener(gate): (exec, next) => Promise<DshPreToolDecision>;
```

Build the `tools/pre-execute` listener for a given [Gate](../core/classes/Gate.md).

Factored out of [apply](#apply) so a test can exercise the exact listener
`apply()` registers — event extraction, the refusal-to-decision mapping,
the fail-closed default, and the waterfall `next()`-calling on allow —
against a controllable fake `Gate`, without needing a real dsh install or
network access to construct a `GateClient`.

Never throws: every path returns a [DshPreToolDecision](#dshpretooldecision). A crash
inside `gate.guard()` that is not an [IntuticGateRefusal](../core/classes/IntuticGateRefusal.md) — a bug in
this gate, or an unexpected throw from a tier it calls into — is treated
as "cannot evaluate" and denied rather than allowed to escape the
waterfall or fall through to an allow; see gate.ts's own module doc for why
every tier in this package takes that direction on failure.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gate` | [`Gate`](../core/classes/Gate.md) |

#### Returns

(`exec`, `next`) => `Promise`\<[`DshPreToolDecision`](#dshpretooldecision)\>
