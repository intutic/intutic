[@intutic/clawde](../index.md) / ClawdeBlockedError

# Class: ClawdeBlockedError

The proxy refused the request: a policy block, a reask, a loop run held for
review, a spend cap, a DLP block, or a tool call the model made that the
proxy withheld. Never retried — the same request would be refused again.
`code` is the proxy's refusal code, `message` its reason, and `ruleId` the
rule that decided, when the proxy names one (every refusal it answers with
a 200 does).

## Extends

- [`ClawdeVerdictError`](ClawdeVerdictError.md)

## Constructors

### Constructor

```ts
new ClawdeBlockedError(
   verdict, 
   code, 
   status, 
   message, 
   ruleId?, 
   retryAfterSeconds?
): ClawdeBlockedError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `verdict` | [`RefusalVerdict`](../index.md#refusalverdict) |
| `code` | `string` |
| `status` | `number` |
| `message` | `string` |
| `ruleId?` | `string` |
| `retryAfterSeconds?` | `number` |

#### Returns

`ClawdeBlockedError`

#### Overrides

[`ClawdeVerdictError`](ClawdeVerdictError.md).[`constructor`](ClawdeVerdictError.md#constructor)

## Properties

| Property | Modifier | Type | Description | Overrides |
| ------ | ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | `string` | - | - |
| <a id="property-retryafterseconds"></a> `retryAfterSeconds` | `readonly` | `number` \| `undefined` | Seconds until the refusal stops applying, from the proxy's `Retry-After`: set on `RATE_LIMITED` (the next minute) and `BUDGET_EXCEEDED` (the budget's reset). Undefined for a refusal that retrying will not change. | - |
| <a id="property-ruleid"></a> `ruleId` | `readonly` | `string` \| `undefined` | - | - |
| <a id="property-status"></a> `status` | `readonly` | `number` | - | - |
| <a id="property-verdict"></a> `verdict` | `public` | [`RefusalVerdict`](../index.md#refusalverdict) | - | [`ClawdeVerdictError`](ClawdeVerdictError.md).[`verdict`](ClawdeVerdictError.md#property-verdict) |
