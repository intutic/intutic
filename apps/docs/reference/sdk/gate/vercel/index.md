[@intutic/gate](../index.md) / vercel

# @intutic/gate/vercel

## Interfaces

### IntuticToolApprovalOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |

***

### VercelToolApprovalOptions

Structural copy of the options object `ai`'s `GenericToolApprovalFunction`
 receives — the whole-config form of `toolApproval` accepted by
 `generateText`/`streamText`/`ToolLoopAgent`. Only `toolCall` is read here;
 the rest pass through the structural type so this function is assignable
 to the real (wider) signature.

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-toolcall"></a> `toolCall` | [`VercelToolCall`](#verceltoolcall) |

***

### VercelToolCall

Structural copy of `ai`'s `TypedToolCall` — the fields this adapter
 actually reads (`toolName`, `input`); the real type carries more.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-input"></a> `input` | `unknown` |
| <a id="property-toolname"></a> `toolName` | `string` |

## Type Aliases

### VercelToolApproval

```ts
type VercelToolApproval = (options) => Promise<VercelToolApprovalStatus>;
```

Structural copy of `ai`'s `GenericToolApprovalFunction` — the exact shape
 `toolApproval` expects.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`VercelToolApprovalOptions`](#verceltoolapprovaloptions) |

#### Returns

`Promise`\<[`VercelToolApprovalStatus`](#verceltoolapprovalstatus)\>

***

### VercelToolApprovalStatus

```ts
type VercelToolApprovalStatus = 
  | undefined
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | {
  reason?: undefined;
  type: "not-applicable";
}
  | {
  reason?: string;
  type: "approved";
}
  | {
  reason?: string;
  type: "denied";
}
  | {
  reason?: undefined;
  type: "user-approval";
};
```

Structural copy of `ai`'s `ToolApprovalStatus` — this package does not
 depend on `ai` at runtime, so the shape is declared here rather than
 imported. Confirmed field-for-field against `ai@7.0.68`'s
 `dist/index.d.ts` (see module doc), unchanged in `ai@7.0.127`.

## Functions

### intuticProxyBaseUrl()

```ts
function intuticProxyBaseUrl(proxyUrl?): string;
```

The `baseURL` an `@ai-sdk/*` provider needs to reach the proxy.

`@ai-sdk/openai` and `@ai-sdk/anthropic` append the endpoint path
(`/chat/completions`, `/responses`, `/messages`) to `baseURL` — their own
defaults end in `/v1` — while the proxy serves those routes under `/v1/*`.
So the bare proxy URL gets `/v1` appended. A URL that already ends in a
version segment (`/v1` or `/v1beta`) is kept as given, so `/v1` is never
doubled.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `proxyUrl` | `string` |

#### Returns

`string`

***

### intuticProxyUrl()

```ts
function intuticProxyUrl(): string;
```

Resolves the Intutic proxy URL the same way the rest of this codebase does
— `INTUTIC_PROXY_URL`, falling back to the local default every CLI command
and env-writer here shares (`tools/cli/src/commands/exec.ts`,
`tools/cli/src/lib/onboarding.ts`, `services/sync-daemon/src/agentReporter.ts`).
Not re-hardcoded per call site — one resolution rule, reused.

#### Returns

`string`

***

### intuticToolApproval()

```ts
function intuticToolApproval(opts?): VercelToolApproval;
```

Builds a `toolApproval` callback matching `ai`'s `GenericToolApprovalFunction`
signature, for direct use on `generateText`/`streamText`/`ToolLoopAgent`:

```ts
import { generateText } from 'ai'
import { Gate, install } from '@intutic/gate'
import { intuticToolApproval } from '@intutic/gate/vercel'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

await generateText({
  model,
  tools,
  toolApproval: intuticToolApproval(),
})
```

Resolves to `'not-applicable'` on allow (this gate has no opinion; any
other approval mechanism the caller has configured still applies) and to
`{ type: 'denied', reason }` on refusal — `reason` is the
`[Intutic Governance] BLOCKED: ...` message, handed back to the model in
place of a tool result.

Requires a `Gate` — either passed via `{ gate }` here, or installed
process-wide with `install(new Gate(...))`. A call with neither throws,
refusing to run the tool unguarded rather than silently skipping
enforcement — same posture as `wrapTool`/`intuticHooks`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticToolApprovalOptions`](#intutictoolapprovaloptions) |

#### Returns

[`VercelToolApproval`](#verceltoolapproval)

***

### withIntuticProxy()

```ts
function withIntuticProxy<TOptions, TProvider>(providerFactory, baseUrl?): (options) => TProvider;
```

Wraps a provider-constructing function so it points at the Intutic proxy.

The Vercel AI SDK has no env-var base-URL override (see module doc), so
routing LLM traffic through the proxy is IN-CODE: pass the provider
factory you would otherwise call directly (`createOpenAI`,
`createAnthropic`, or a compatible factory that accepts a
`{ baseURL }`-shaped options object and appends the provider's endpoint
path to it) and get back one pre-configured to call the proxy instead of
the provider's real endpoint. The Vercel AI Gateway (`createGateway`)
speaks a protocol the proxy does not parse, so it is not a target:

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { withIntuticProxy } from '@intutic/gate/vercel'

const openai = withIntuticProxy(createOpenAI)({ apiKey: process.env.OPENAI_API_KEY })
const model = openai('gpt-5-mini')
```

`baseUrl` overrides the resolved proxy URL (see [intuticProxyUrl](#intuticproxyurl));
omit it to use `INTUTIC_PROXY_URL`/the local default, same as every other
harness in this codebase. Either way the provider receives
[intuticProxyBaseUrl](#intuticproxybaseurl) of it — the proxy URL plus `/v1`.

This does NOT make Vercel AI SDK integration "zero-code": every provider
construction call site in the caller's application must go through this
wrapper (or otherwise set `baseURL` itself) for LLM egress to be governed
— there is no ambient env var this package (or any other) can set to
achieve the same effect for this framework.

#### Type Parameters

| Type Parameter |
| ------ |
| `TOptions` *extends* \| \{ `baseURL?`: `string`; \} \| `undefined` |
| `TProvider` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `providerFactory` | (`options`) => `TProvider` |
| `baseUrl?` | `string` |

#### Returns

(`options`) => `TProvider`
