[@intutic/gate](../../index.md) / [managed-agents](../index.md) / IntuticSessionConfirmer

# Class: IntuticSessionConfirmer

## Constructors

### Constructor

```ts
new IntuticSessionConfirmer(
   client, 
   sessionId, 
   opts?
): IntuticSessionConfirmer;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `client` | [`ManagedAgentsClientLike`](../index.md#managedagentsclientlike) |
| `sessionId` | `string` |
| `opts` | [`ManagedAgentsWrapOptions`](../index.md#managedagentswrapoptions) |

#### Returns

`IntuticSessionConfirmer`

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-sessionid"></a> `sessionId` | `readonly` | `string` |

## Methods

### handleEvent()

```ts
handleEvent(event): Promise<
  | UserToolConfirmationParams
| null>;
```

Answer one event if it needs an answer; returns the sent params, or
 `null` if nothing was sent (already answered, or
 [confirmationForEvent](../index.md#confirmationforevent) returned `null` — see its doc).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | [`ManagedAgentsSessionEventLike`](../index.md#managedagentssessioneventlike) |

#### Returns

`Promise`\<
  \| [`UserToolConfirmationParams`](../index.md#usertoolconfirmationparams)
  \| `null`\>

***

### handleWebhook()

```ts
handleWebhook(unwrapped): Promise<UserToolConfirmationParams[]>;
```

Answer the pause a `session.requires_action` webhook signalled.

`unwrapped` is what `client.beta.webhooks.unwrap(rawBody, { headers })`
returns (or its `.data`, or a plain object of the same shape). Anything
other than a `session.requires_action` payload is a no-op (`[]`): this
module only ever answers tool-confirmation pauses, so every other
webhook event type is intentionally ignored here.

The webhook payload carries only the session id — it does NOT carry the
tool call itself — so this always falls through to a [poll](#poll).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `unwrapped` | \{ `data?`: \{ `id?`: `string`; `type?`: `string`; \}; `id?`: `string`; `type?`: `string`; \} |
| `unwrapped.data?` | \{ `id?`: `string`; `type?`: `string`; \} |
| `unwrapped.data.id?` | `string` |
| `unwrapped.data.type?` | `string` |
| `unwrapped.id?` | `string` |
| `unwrapped.type?` | `string` |

#### Returns

`Promise`\<[`UserToolConfirmationParams`](../index.md#usertoolconfirmationparams)[]\>

***

### poll()

```ts
poll(opts?): Promise<UserToolConfirmationParams[]>;
```

List recent events and answer every unanswered
`agent.tool_use`/`agent.mcp_tool_use` pause found. Returns the sent
confirmations, in event order.

Two passes: `list()` returns events oldest first, so a pause precedes its
own `user.tool_confirmation`. Every confirmation is noted before any
pause is answered, or a fresh confirmer (one per webhook delivery)
re-answers every pause the session ever had — the live API accepts the
duplicate and it wakes an idle session.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | \{ `limit?`: `number`; \} |
| `opts.limit?` | `number` |

#### Returns

`Promise`\<[`UserToolConfirmationParams`](../index.md#usertoolconfirmationparams)[]\>

***

### watch()

```ts
watch(opts?): AsyncGenerator<UserToolConfirmationParams>;
```

Catch up on anything already pending, then follow the live event
stream, yielding each confirmation as it is sent, reconnecting when the
stream drops.

Modelled on the SDK's own `SessionToolRunner#streamLoop`: open the
stream FIRST, then reconcile with `poll()` — an event emitted in the gap
is buffered on the stream rather than lost, and `answered` dedups
anything that shows up on both. On end or error the loop sleeps
(backoff doubling from `backoffStartMs` to `backoffCapMs`, reset on any
received event) and reopens. A fatal 4xx (anything 400–499 other than
408 and 429) rethrows: the session is gone or the key is wrong, and
retrying would loop forever. `idleTimeoutMs` drops a stream that has
gone silent and reopens it, which re-polls. Ends only on a terminal
event, `signal` abort, or `maxReconnects` exhausted (unbounded by
default, the SDK's own choice).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`WatchOptions`](../index.md#watchoptions) |

#### Returns

`AsyncGenerator`\<[`UserToolConfirmationParams`](../index.md#usertoolconfirmationparams)\>
