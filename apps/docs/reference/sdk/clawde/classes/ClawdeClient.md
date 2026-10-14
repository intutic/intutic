[@intutic/clawde](../index.md) / ClawdeClient

# Class: ClawdeClient

The data-plane client: `chat()` sends an OpenAI-format request through the
Intutic proxy, which governs it and forwards it to the provider, and throws
[ClawdeBlockedError](ClawdeBlockedError.md) when the proxy refuses it. `checkBudget()` and
`circuitBreaker()` add a workspace budget check, and `on()` registers
callbacks for refusal verdicts. For the operator APIs, use
[ControlPlaneClient](ControlPlaneClient.md).

## Constructors

### Constructor

```ts
new ClawdeClient(options): ClawdeClient;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`ClawdeClientOptions`](../index.md#clawdeclientoptions) |

#### Returns

`ClawdeClient`

## Methods

### chat()

```ts
chat(params): Promise<ChatResponse>;
```

Send a chat request through the proxy.

Resolves with `verdict: 'allow'` when the proxy let the request through. A
governance refusal, including one the proxy answers with a 200 and names in
`x-intutic-refusal` (or, on a stream, in its `: intutic-refusal` line),
fires the matching event and rejects with `ClawdeBlockedError`, unretried.
Transport failures, timeouts and 5xx answers are retried; anything else
rejects with `ClawdeConnectionError`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`ChatParams`](../index.md#chatparams) |

#### Returns

`Promise`\<[`ChatResponse`](../index.md#chatresponse)\>

***

### checkBudget()

```ts
checkBudget(model, estimatedTokens): Promise<BudgetCheckResult>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `model` | `string` |
| `estimatedTokens` | `number` |

#### Returns

`Promise`\<[`BudgetCheckResult`](../index.md#budgetcheckresult)\>

***

### circuitBreaker()

```ts
circuitBreaker<T>(toolName, options?): (fn) => Promise<T>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `options` | [`CircuitBreakerOptions`](../index.md#circuitbreakeroptions) |

#### Returns

(`fn`) => `Promise`\<`T`\>

***

### off()

```ts
off(event, callback): void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `string` |
| `callback` | [`EventCallback`](../index.md#eventcallback) |

#### Returns

`void`

***

### on()

```ts
on(event, callback): void;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | [`VerdictEvent`](../index.md#verdictevent) |
| `callback` | [`EventCallback`](../index.md#eventcallback) |

#### Returns

`void`

***

### resolveContext()

```ts
resolveContext(): Promise<ResolvedContext>;
```

#### Returns

`Promise`\<[`ResolvedContext`](../index.md#resolvedcontext)\>
