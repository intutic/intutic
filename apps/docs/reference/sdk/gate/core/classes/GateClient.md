[@intutic/gate](../../index.md) / [core](../index.md) / GateClient

# Class: GateClient

Control-plane client for the pre-execution gate.

`harness` defaults to `"generic"` and is sent as `harnessType` on every
gate call and event, so incidents attribute to the right adapter. Override
it when wrapping a specific framework (`mastra`, `vercel-ai`,
`langchainjs`, `dsh`, ...).

## Constructors

### Constructor

```ts
new GateClient(opts?): GateClient;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`GateClientOptions`](../index.md#gateclientoptions) |

#### Returns

`GateClient`

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-apikey"></a> `apiKey` | `readonly` | `string` |
| <a id="property-baseurl"></a> `baseUrl` | `readonly` | `string` |
| <a id="property-failclosed"></a> `failClosed` | `readonly` | `boolean` |
| <a id="property-harness"></a> `harness` | `readonly` | `string` |
| <a id="property-sessionid"></a> `sessionId` | `readonly` | `string` |
| <a id="property-timeoutms"></a> `timeoutMs` | `readonly` | `number` |
| <a id="property-workspaceid"></a> `workspaceId` | `readonly` | `string` |

## Accessors

### localOnly

#### Get Signature

```ts
get localOnly(): boolean;
```

True when there is no API key. Such a client cannot authenticate, so it
sends nothing: the control-plane tiers (SOP register, hook gate) are
skipped, events and holds are not reported, and the local tiers decide.

##### Returns

`boolean`

## Methods

### approvedBypasses()

```ts
approvedBypasses(): Promise<unknown[] | null>;
```

The workspace's approved bypasses (`GET /api/v1/decisions/approved-bypasses`),
or `null` when they cannot be read. Never throws: a hold that cannot be
checked for an approval stays held.

#### Returns

`Promise`\<`unknown`[] \| `null`\>

***

### emit()

```ts
emit(
   event, 
   toolName, 
   reason?, 
   toolInput?, 
   incidentId?, 
   filePath?, 
   gateDecisionId?
): Promise<boolean>;
```

Fire-and-forget telemetry. Never throws.

A `tool_blocked` event creates a `governance_incidents` row whose
description embeds the reason verbatim. `gateDecisionId` is the hook
gate's `decisionId` for the call this event reports: the control plane
then files the decision's incident once and does not export it to SIEM a
second time.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `event` | `string` | `undefined` |
| `toolName` | `string` | `undefined` |
| `reason` | `string` | `''` |
| `toolInput?` | `unknown` | `undefined` |
| `incidentId?` | `string` | `undefined` |
| `filePath?` | `string` | `undefined` |
| `gateDecisionId?` | `string` | `undefined` |

#### Returns

`Promise`\<`boolean`\>

***

### hookGate()

```ts
hookGate(toolName, toolInput): Promise<GateResponse>;
```

Synchronous allow/deny for one tool call.

The endpoint matches ~19 DLP regexes against the serialised toolInput,
plus SOP rules. It is defence in depth on top of the local tiers, not a
replacement for them.

When there is no verdict (the control plane cannot be reached, answers
non-2xx or without a boolean `allowed`, or answers
`GOVERNANCE_UNAVAILABLE` because its own checks could not run), the
verdict is decided by `failClosed`: true (the default) reports BLOCK,
because a client with no verdict has nothing to defer to; false reports
allow. A 400 `INVALID_REQUEST`, and a 403 `INSUFFICIENT_SCOPE` (the key
lacks `gateway:use`), are a BLOCK whatever `failClosed` says. A
shadow-mode workspace's `{allowed: true, degraded: true}` is an allow.

A [localOnly](#localonly) client makes no call and answers allow with code
`LOCAL_ONLY`, whatever `failClosed` says: with no key there is no
control-plane tier to fail, only local ones, which have already run.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`Promise`\<[`GateResponse`](../index.md#gateresponse)\>

***

### recordHold()

```ts
recordHold(hold): Promise<boolean>;
```

Records one hold in the review queue (`POST /api/v1/decisions`), the way
the hook gates' records reach it. Never throws; `false` when the control
plane did not accept it, so the refusal can say there is nothing to
approve yet.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `hold` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`boolean`\>

***

### fromEnv()

```ts
static fromEnv(opts?): GateClient;
```

Build a client from the environment, falling back to CLI credentials.

Reading `~/.intutic/credentials.json` means the gate works with whatever
workspace `intutic login` already bound, instead of duplicating the key:
its key, workspace and the control plane it logged in to. With no key in
either place the client is [localOnly](#localonly).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | \{ `failClosed?`: `boolean`; `harness?`: `string`; `sessionId?`: `string`; \} |
| `opts.failClosed?` | `boolean` |
| `opts.harness?` | `string` |
| `opts.sessionId?` | `string` |

#### Returns

`GateClient`
