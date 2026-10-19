[@intutic/gate](../../index.md) / [core](../index.md) / Gate

# Class: Gate

The pre-execution gate. [Gate.guard](#guard) evaluates one tool call against
the local tiers (SSO group policy, policy snapshot, MCP servers, image
integrity) and, with a [GateClient](GateClient.md), the control-plane tiers (SOP
rules, hook gate), and throws [IntuticGateRefusal](IntuticGateRefusal.md) to refuse it.
Without a client only the local tiers run.

## Constructors

### Constructor

```ts
new Gate(cfg?, client?): Gate;
```

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `cfg` | [`GateConfig`](../index.md#gateconfig) | `{}` |
| `client` | [`GateClient`](GateClient.md) \| `null` | `null` |

#### Returns

`Gate`

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-cfg"></a> `cfg` | `readonly` | `ResolvedConfig` |
| <a id="property-client"></a> `client` | `readonly` | [`GateClient`](GateClient.md) \| `null` |

## Methods

### getPolicy()

```ts
getPolicy(): ImagePolicy;
```

Load the image allowlist.

A missing or malformed allowlist is NOT treated as "allow everything".
An empty policy with `require_digest` still refuses every unpinned
image, which is the safe direction; a policy we cannot read at all
throws, and the caller turns that into a block.

#### Returns

[`ImagePolicy`](../index.md#imagepolicy)

***

### getSnapshot()

```ts
getSnapshot(): Snapshot;
```

#### Returns

[`Snapshot`](Snapshot.md)

***

### getSopRules()

```ts
getSopRules(): Promise<SopRule[]>;
```

Active SOP rules, fetched once per process.

Deliberately not refreshed on a timer: a rule set that changes mid-run
makes a verdict depend on when the fetch landed. Construct a new `Gate`
(or clear the cache) to refresh.

#### Returns

`Promise`\<[`SopRule`](../index.md#soprule)[]\>

***

### guard()

```ts
guard(toolName, toolInput): Promise<void>;
```

Throws [IntuticGateRefusal](IntuticGateRefusal.md) if this call must not run. Resolves to allow.

Under a chaos run's plan, the call is reported to the run's events file
whatever the tiers decide, and a call they allowed can still be refused
by the fault that is due (`CHAOS_FAULT`, or [IntuticGateHold](IntuticGateHold.md) for
a held one). A plan that is set but unreadable refuses every call: an
experiment run without the faults it asked for reports a resilience it
never measured.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | [`ToolInput`](../index.md#toolinput) |

#### Returns

`Promise`\<`void`\>

***

### recordOutcome()

```ts
recordOutcome(
   toolName, 
   toolInput, 
   result?
): void;
```

Records how a call that ran went, for Tier R. A test run
(`action:run_tests`) records its outcome (testOutcome.ts: the exit code,
else one read from `output`, the error flag and the runner summaries);
any other call marks earlier outcomes as no longer adjacent, and a call
that changed files (`isFileWriteCall`, scopeMatch.ts) makes an earlier pass stale.
Kept in memory per [GateClient.sessionId](GateClient.md#property-sessionid); with no session id
nothing is kept, and a qualified rule stays unmet. [wrapTool](../index.md#wraptool) calls
this after every call it ran.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | [`ToolInput`](../index.md#toolinput) |
| `result` | [`ToolOutcome`](../index.md#tooloutcome) |

#### Returns

`void`
