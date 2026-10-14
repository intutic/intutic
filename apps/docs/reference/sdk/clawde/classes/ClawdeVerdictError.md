[@intutic/clawde](../index.md) / ClawdeVerdictError

# Class: ClawdeVerdictError

A governance verdict stopped the call: a proxy refusal (`ClawdeBlockedError`) or the circuit breaker's budget check.

## Extends

- [`ClawdeError`](ClawdeError.md)

## Extended by

- [`ClawdeBlockedError`](ClawdeBlockedError.md)

## Constructors

### Constructor

```ts
new ClawdeVerdictError(verdict, message): ClawdeVerdictError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `verdict` | `string` |
| `message` | `string` |

#### Returns

`ClawdeVerdictError`

#### Overrides

[`ClawdeError`](ClawdeError.md).[`constructor`](ClawdeError.md#constructor)

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-verdict"></a> `verdict` | `public` | `string` |
