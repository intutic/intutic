[@intutic/gate](../index.md) / mastra

# @intutic/gate/mastra

## Interfaces

### IntuticHooksOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-denialoutput"></a> `denialOutput?` | (`ctx`) => `unknown` | Shapes the `output` handed back to the model on a refusal. The default produces `{ error: true, message, code, incidentId? }` — reasonable for an unstructured/text-ish tool output, but NOT guaranteed to satisfy an arbitrary tool's own Zod `outputSchema` (this hook is never told what that schema is — see the module doc's "Confirmed against a real install" section). Supply this when your tools declare strict output schemas the default shape would fail. |
| <a id="property-gate"></a> `gate?` | [`Gate`](../core/classes/Gate.md) | Overrides the process-wide installed gate (`install(new Gate(...))`). |

***

### MastraToolBeforeHookResult

Structural copy of `@mastra/core`'s `ToolBeforeHookResult`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-output"></a> `output` | `unknown` |
| <a id="property-proceed"></a> `proceed` | `false` |

***

### MastraToolHookContext

Structural copy of `@mastra/core`'s `ToolHookContext` — this package does
 not depend on `@mastra/core` at runtime, so the shape is declared here
 rather than imported. Confirmed field-for-field against
 `@mastra/core@1.59.0`'s `dist/tools/types.d.ts` (see module doc), and
 unchanged in 1.74.0.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-context"></a> `context?` | `unknown` | Execution context passed to the tool. Not read by this adapter. |
| <a id="property-input"></a> `input` | `unknown` | Input passed to the tool — this is what `Gate.guard()` evaluates. |
| <a id="property-metadata"></a> `metadata?` | `Record`\<`string`, `unknown`\> | Optional adapter-specific metadata (e.g. `agentId`/`agentName`). |
| <a id="property-toolname"></a> `toolName` | `string` | The name exposed to the model for this tool call. |

## Type Aliases

### MastraBeforeToolCall

```ts
type MastraBeforeToolCall = (context) => Promise<void | MastraToolBeforeHookResult>;
```

Structural copy of `@mastra/core`'s `ToolHooks['beforeToolCall']` — the
 slice of the real type this adapter implements. Assignable directly to
 `Agent`'s `hooks` constructor option.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`MastraToolHookContext`](#mastratoolhookcontext) |

#### Returns

`Promise`\<`void` \| [`MastraToolBeforeHookResult`](#mastratoolbeforehookresult)\>

## Functions

### intuticHooks()

```ts
function intuticHooks(opts?): object;
```

Builds a `{ beforeToolCall }` object shaped for direct use in `@mastra/core`'s
`Agent` constructor's `hooks` option:

```ts
import { Agent } from '@mastra/core/agent'
import { Gate, install } from '@intutic/gate'
import { intuticHooks } from '@intutic/gate/mastra'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const agent = new Agent({
  id: 'my-agent',
  name: 'My Agent',
  model: 'openai/gpt-5-mini',
  tools: { deleteTool },
  hooks: intuticHooks(),
})
```

On refusal, returns `{ proceed: false, output }` — the real tool body
never runs. On allow, returns `undefined`, Mastra's own "no opinion"
value, so the real `execute` runs untouched.

Requires a `Gate` — either passed via `{ gate }` here, or installed
process-wide with `install(new Gate(...))`. A call with neither throws
(via the underlying `beforeToolCall`), refusing to run tools unguarded
rather than silently skipping enforcement — same posture as `wrapTool`.

See the module doc's TAMPER NOTE: this only governs calls that do not
override `hooks` at the `.generate()`/`.stream()` call site.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticHooksOptions`](#intutichooksoptions) |

#### Returns

`object`

| Name | Type |
| ------ | ------ |
| `beforeToolCall` | [`MastraBeforeToolCall`](#mastrabeforetoolcall) |
