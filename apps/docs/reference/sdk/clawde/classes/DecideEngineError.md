[@intutic/clawde](../index.md) / DecideEngineError

# Class: DecideEngineError

## Extends

- `Error`

## Constructors

### Constructor

```ts
new DecideEngineError(
   code, 
   message, 
   status?
): DecideEngineError;
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `code` | [`DecideEngineErrorCode`](../index.md#decideengineerrorcode) | - |
| `message` | `string` | - |
| `status?` | `number` | The upstream HTTP status, for an `upstream` error that got a response. |

#### Returns

`DecideEngineError`

#### Overrides

```ts
Error.constructor
```

## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | [`DecideEngineErrorCode`](../index.md#decideengineerrorcode) | - |
| <a id="property-status"></a> `status?` | `readonly` | `number` | The upstream HTTP status, for an `upstream` error that got a response. |
