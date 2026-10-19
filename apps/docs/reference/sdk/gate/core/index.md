[@intutic/gate](../index.md) / core

# @intutic/gate

## Classes

- [DecideEngineError](classes/DecideEngineError.md)
- [Gate](classes/Gate.md)
- [GateClient](classes/GateClient.md)
- [GateConnectionError](classes/GateConnectionError.md)
- [GateError](classes/GateError.md)
- [IntuticGateEscalation](classes/IntuticGateEscalation.md)
- [IntuticGateHold](classes/IntuticGateHold.md)
- [IntuticGateRefusal](classes/IntuticGateRefusal.md)
- [Snapshot](classes/Snapshot.md)

## Interfaces

### DecideBand

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-no_below"></a> `no_below` | `number` |
| <a id="property-yes_at"></a> `yes_at` | `number` |

***

### DecideEngineConfig

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-adapter"></a> `adapter` | `DecideAdapter` | - |
| <a id="property-apikey"></a> `apiKey?` | `string` | From `INTUTIC_DECIDE_API_KEY` only; never written to engine.json or logged. |
| <a id="property-maxresponsestatebytes"></a> `maxResponseStateBytes?` | `number` | `INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES`: the limit for an `on: response` state; `DECIDE_MAX_RESPONSE_STATE_BYTES` (32,768) when unset. |
| <a id="property-model"></a> `model` | `string` | - |
| <a id="property-modeldigest"></a> `modelDigest?` | `string` | `INTUTIC_DECIDE_MODEL_DIGEST`: a weights digest for servers that cannot report one. |
| <a id="property-ollama"></a> `ollama` | `boolean` | An Ollama server: reasoning is switched off with `reasoning_effort`, and the digest comes from `/api/tags`. |
| <a id="property-parallel"></a> `parallel` | `number` | The most requests in flight at once. |
| <a id="property-selfhostedhosts"></a> `selfHostedHosts?` | `string` | `INTUTIC_SELF_HOSTED_DECISION_HOSTS`: names the host guard allows. |
| <a id="property-structured"></a> `structured` | `boolean` | Send `structured_outputs: {choice}` (logprobs only); some proxies refuse unknown fields. |
| <a id="property-timeoutms"></a> `timeoutMs` | `number` | - |
| <a id="property-url"></a> `url` | `string` | - |

***

### DecidePin

A calibration a rule may enforce under: the model digest it was evaluated on, and what the evaluation fitted.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-band"></a> `band?` | `object` |
| `band.no_below` | `number` |
| `band.yes_at` | `number` |
| <a id="property-combiner"></a> `combiner?` | `object` |
| `combiner.bias` | `number` |
| `combiner.weights` | `Record`\<`string`, `number`\> |
| <a id="property-evalrunid"></a> `evalRunId` | `string` |
| <a id="property-modeldigest-1"></a> `modelDigest` | `string` |
| <a id="property-source"></a> `source` | `"local"` \| `"server"` |
| <a id="property-temperature"></a> `temperature?` | `Record`\<`string`, `number`\> |

***

### DecideQuestion

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-ask"></a> `ask` | `string` | - |
| <a id="property-band-1"></a> `band?` | [`DecideBand`](#decideband) | - |
| <a id="property-options"></a> `options?` | `string`[] | `choice` only, as written; decideOptions places `none_of_these`. |
| <a id="property-type"></a> `type` | `"yes_no"` \| `"choice"` | - |

***

### DecideRecord

One `@decide` record's payload.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-fallbackid"></a> `fallbackId` | `string` \| `null` | The paired fallback line's id; null when the rule is stamped shadow and has none. |
| <a id="property-ir"></a> `ir` | [`DecideRule`](#deciderule) | The rule as its `decide:` line carries it. |
| <a id="property-pins"></a> `pins` | [`DecidePin`](#decidepin)[] | - |
| <a id="property-ref"></a> `ref` | `string` | `<sopId>#<rule id>`. |
| <a id="property-rollout"></a> `rollout` | `"shadow"` \| `"enforce"` | - |
| <a id="property-rulehash"></a> `ruleHash` | `string` | - |
| <a id="property-ruletext"></a> `ruleText` | `string` | - |
| <a id="property-soptitle"></a> `sopTitle` | `string` | - |
| <a id="property-stampedby"></a> `stampedBy` | [`DecideStamp`](#decidestamp) | - |
| <a id="property-v"></a> `v` | `1` | - |

***

### DecideRule

A rule as its front-matter line carries it: the IR without `kind`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-band-2"></a> `band?` | [`DecideBand`](#decideband) |
| <a id="property-context"></a> `context?` | `"last_user_turn"`[] |
| <a id="property-escalate"></a> `escalate?` | `"ask"` \| `"review"` \| `"refuse"` |
| <a id="property-id"></a> `id` | `string` |
| <a id="property-on"></a> `on` | `"tool_call"` \| `"response"` |
| <a id="property-questions"></a> `questions` | `Record`\<`string`, [`DecideQuestion`](#decidequestion)\> |
| <a id="property-rollout-1"></a> `rollout?` | `"shadow"` \| `"enforce"` |
| <a id="property-title"></a> `title?` | `string` |
| <a id="property-tools"></a> `tools?` | `string`[] |
| <a id="property-when"></a> `when` | `string` |

***

### DecideSdkOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-band-3"></a> `band?` | [`DecideBand`](#decideband) | The band for every question without its own (default `{yes_at: 0.85, no_below: 0.15}`). |
| <a id="property-budgetms"></a> `budgetMs?` | `number` | Milliseconds for the whole call (default `INTUTIC_DECIDE_BUDGET_MS`, else 7,300). |
| <a id="property-engine"></a> `engine?` | [`DecideEngineConfig`](#decideengineconfig) | The engine's configuration. Without it, `engineFile` and `env` give it. |
| <a id="property-enginefile"></a> `engineFile?` | `unknown` | The parsed `engine.json`, or null when there is none. |
| <a id="property-env"></a> `env?` | `Record`\<`string`, `string` \| `undefined`\> | The environment, which overrides `engineFile`. |
| <a id="property-escalate-1"></a> `escalate?` | `"ask"` \| `"review"` \| `"refuse"` | What an unknown `when` does (default `ask`). |
| <a id="property-when-1"></a> `when?` | `string` | A `when` over the questions. With it, the result carries the rule's outcome. |

***

### DecideSdkResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-adapter-1"></a> `adapter` | `DecideAdapter` | - |
| <a id="property-answers"></a> `answers` | `Record`\<`string`, [`DecideSdkAnswer`](#decidesdkanswer)\> | - |
| <a id="property-code"></a> `code` | `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `null` | - |
| <a id="property-digeststrength"></a> `digestStrength` | `"strong"` \| `"weak"` \| `null` | - |
| <a id="property-error"></a> `error` | `"too_large"` \| `null` | `too_large` when the state was over 16,384 bytes, a tool call's limit, and nothing was asked. |
| <a id="property-latencyms"></a> `latencyMs` | `number` | - |
| <a id="property-model-1"></a> `model` | `string` \| `null` | - |
| <a id="property-modeldigest-2"></a> `modelDigest` | `string` \| `null` | - |
| <a id="property-outcome"></a> `outcome` | `"allow"` \| `"refuse"` \| `"escalate"` \| `null` | - |
| <a id="property-value"></a> `value` | `Tri` \| `null` | `when`'s value, or null without a `when`. |
| <a id="property-via"></a> `via` | `"ask"` \| `"review"` \| `null` | - |

***

### Decision

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-advisories"></a> `advisories?` | [`Decision`](#decision)[] | Every rule that matched without deciding the call (shadow, warn), in rule order, up to the deciding rule. The caller records each one, as the rendered gates do. When no rule decides, `severity` is the first of them. |
| <a id="property-next"></a> `next?` | `number` | Index of the rule after the deciding one: where to resume after an approved hold. |
| <a id="property-reason"></a> `reason` | `string` | The rule's reason and `[id]`; for a hold, the reason alone, which the gate words as a hold. |
| <a id="property-ruleid"></a> `ruleId` | `string` | - |
| <a id="property-severity"></a> `severity` | [`Severity`](#severity) \| `null` | `null` means allow. |

***

### ExecutableTool

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-execute"></a> `execute` | [`AnyFn`](#anyfn) |
| <a id="property-name"></a> `name?` | `string` |

***

### GateClientOptions

Options for a [GateClient](classes/GateClient.md). Every field is optional.

#### Properties

| Property | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-apikey-1"></a> `apiKey?` | `string` | `''` | The API key. Without one the client is [local-only](classes/GateClient.md#localonly). |
| <a id="property-baseurl"></a> `baseUrl?` | `string` | `INTUTIC_CONTROL_PLANE_URL`; this release has no default control plane | The control plane's address. A client with an `apiKey` needs one: with none the constructor throws rather than skip the hook gate unannounced. |
| <a id="property-failclosed"></a> `failClosed?` | `boolean` | `true` | Block a call when the hook gate gives no verdict: the control plane cannot be reached, answers without one, or answers `GOVERNANCE_UNAVAILABLE`. `false` lets such a call go ahead. |
| <a id="property-harness"></a> `harness?` | `string` | `'generic'` | Attributes incidents to the right adapter. Sent as `harnessType` on every gate call and event. |
| <a id="property-sessionid"></a> `sessionId?` | `string` | `''` | - |
| <a id="property-timeoutms-1"></a> `timeoutMs?` | `number` | `2000` | How long one control-plane request may take. |
| <a id="property-workspaceid"></a> `workspaceId?` | `string` | `''` | - |

***

### GateConfig

How a [Gate](classes/Gate.md) evaluates calls. Every field is optional.

#### Extended by

- [`DshGateConfig`](../dsh/index.md#dshgateconfig)
- [`OpenAiGateConfig`](../openai/index.md#openaigateconfig)

#### Properties

| Property | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-allowlistpath"></a> `allowlistPath?` | `string` | `'.intutic/image-allowlist.json'` | The image allowlist, relative to `repoRoot` unless absolute. |
| <a id="property-enforce"></a> `enforce?` | `boolean` | `true` | `false` turns [Gate.guard](classes/Gate.md#guard) into a no-op. |
| <a id="property-reporoot"></a> `repoRoot?` | `string` | `'.'` | Where relative manifest and allowlist paths resolve from. |
| <a id="property-usehookgate"></a> `useHookGate?` | `boolean` | `true` | Call the control plane's hook gate (needs a client). |
| <a id="property-usesoprules"></a> `useSopRules?` | `boolean` | `true` | Fetch and apply the workspace's SOP rules (needs a client). |
| <a id="property-workspaceid-1"></a> `workspaceId?` | `string` | `''` | Compared with the workspace the policy snapshot was compiled for, and scopes the SOP-rule fetch. |

***

### GateResponse

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-allowed"></a> `allowed` | `boolean` | - |
| <a id="property-code-1"></a> `code?` | `string` | The code the hook gate names, when it names one: the MCP registry's on its refusals, `GOVERNANCE_UNAVAILABLE` when its checks could not run, `INVALID_REQUEST` when it could not read the request, and `INSUFFICIENT_SCOPE` when the API key lacks the scope it needs. |
| <a id="property-decisionid"></a> `decisionId?` | `string` | The hook gate's id for this decision, when this answer is its own verdict: every verdict it gives names one, and a `GOVERNANCE_UNAVAILABLE` refusal keeps it only while `failClosed` refuses too. The gate reports the call with it (`gateDecisionId`), so the control plane exports the decision to SIEM once and files its incident once. |
| <a id="property-incidentid"></a> `incidentId?` | `string` | - |
| <a id="property-reached"></a> `reached` | `boolean` | False when the hook gate gave no verdict and `failClosed` decided it. |
| <a id="property-reason-1"></a> `reason` | `string` | - |

***

### ImagePolicy

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-images"></a> `images?` | `Record`\<`string`, \{ `approved_digests?`: `string`[]; \}\> |
| <a id="property-registries_allowed"></a> `registries_allowed?` | `string`[] |
| <a id="property-require_digest"></a> `require_digest?` | `boolean` |

***

### ImageRef

A parsed container image reference.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-digest"></a> `digest` | `string` \| `null` | `sha256:...` or null |
| <a id="property-raw"></a> `raw` | `string` | - |
| <a id="property-repository"></a> `repository` | `string` | registry/namespace/name, no tag, no digest |
| <a id="property-source-1"></a> `source` | `string` | which manifest file it came from |
| <a id="property-tag"></a> `tag` | `string` \| `null` | - |

***

### IntuticHeadersOptions

Port of `intutic_headers()` from
`packages/intutic-clawde/intutic_clawde/gate/framework.py`.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-harness-1"></a> `harness?` | `string` | Attributes traces to this adapter. Defaults to `"generic"`. |
| <a id="property-sessionid-1"></a> `sessionId?` | `string` | - |
| <a id="property-workspaceid-2"></a> `workspaceId?` | `string` | - |

***

### LoadSnapshotOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-evaluatesdecide"></a> `evaluatesDecide?` | `boolean` | The caller evaluates the decide rules the records carry. Only then is a decoded record's fallback line skipped; otherwise the fallback line refuses the rule's tools, exactly as in a gate that reads no records. |
| <a id="property-evaluatesrules"></a> `evaluatesRules?` | `boolean` | The caller evaluates the `@rule` records (Tier R). Only then is a decoded record's fallback line skipped; otherwise the fallback line refuses what the rule covers, exactly as in a gate that reads no records. |

***

### McpAllowlistRecord

The workspace's `mcpAllowedServers` list as the gates apply it: only the
listed servers may be called, and under `shadow` (an observe-only
workspace) a call to another is recorded instead of refused. A workspace
with no list has no record.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-servers"></a> `servers` | `string`[] |
| <a id="property-severity-1"></a> `severity` | `"shadow"` \| `"block"` |

***

### McpRegistryRecord

What the registry decides, per workspace. The MCP proxy's `McpRegistryPolicy` has the same shape.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-approvedservers"></a> `approvedServers` | `string`[] | - |
| <a id="property-blockedservers"></a> `blockedServers` | `string`[] | - |
| <a id="property-defaultpolicy"></a> `defaultPolicy` | `"deny"` \| `"allow"` | - |
| <a id="property-disabledtools"></a> `disabledTools` | `Record`\<`string`, `string`[]\> | Server name → tool names disabled within it. |
| <a id="property-heldservers"></a> `heldServers` | `string`[] | Servers a high-risk tool change returned to the approval queue; refused under either default. |

***

### RefusalEvidence

One thing the refuser saw.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-detail"></a> `detail` | `string` |
| <a id="property-kind"></a> `kind` | `string` |

***

### RefusalScope

Where a refusal applies, so a retry can stay out of it.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-detector"></a> `detector?` | `string` |
| <a id="property-paths"></a> `paths?` | `string`[] |
| <a id="property-rule"></a> `rule?` | `string` |
| <a id="property-step"></a> `step?` | `string` |
| <a id="property-tools-1"></a> `tools?` | `string`[] |

***

### Rule

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-id-1"></a> `id` | `string` | - |
| <a id="property-pattern"></a> `pattern` | `RegExp` | - |
| <a id="property-reason-2"></a> `reason` | `string` | - |
| <a id="property-severity-2"></a> `severity` | `string` | - |
| <a id="property-steps"></a> `steps?` | `RegExp`[][] \| `null` | A sequence rule's compiled steps (flags `s`, sequence.ts), or null. The rule is matched by searching for its steps in order, in linear time, rather than by [pattern](#property-pattern), which a backtracking engine runs in time growing with the square of the text. Absent on a rule built by hand, which is matched by [pattern](#property-pattern). |
| <a id="property-subject"></a> `subject` | [`RuleSubject`](#rulesubject) | - |

***

### SopRegister

The register as `GET /api/v1/sop/rules` answers it: the rules, and whether
the workspace's intervention mode is OPAQUE (`interventionMode`, absent from
a control plane that predates it, which reads as not OPAQUE). The gate uses
the mode when there is no policy snapshot to read it from.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-opaque"></a> `opaque` | `boolean` |
| <a id="property-rules"></a> `rules` | [`SopRule`](#soprule)[] |

***

### SopRule

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-action"></a> `action` | `string` |
| <a id="property-argpattern"></a> `argPattern` | `string` \| `null` |
| <a id="property-id-2"></a> `id` | `string` |
| <a id="property-reason-3"></a> `reason` | `string` |
| <a id="property-toolpattern"></a> `toolPattern` | `string` |

***

### SsoGroupPolicy

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-highrisktools"></a> `highRiskTools` | `string`[] |
| <a id="property-requiredgroups"></a> `requiredGroups` | `string`[] |
| <a id="property-requireobofor"></a> `requireOboFor` | `string`[] |

***

### SsoGroupRecord

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-issuedat"></a> `issuedAt` | `string` |
| <a id="property-member"></a> `member` | \| \{ `memberId`: `string`; `ssoGroups`: `string`[]; \} \| `null` |
| <a id="property-policy"></a> `policy` | [`SsoGroupPolicy`](#ssogrouppolicy) |

***

### ToolOutcome

What a tool call's result says about how it went, for [Gate.recordOutcome](classes/Gate.md#recordoutcome).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-exitcode"></a> `exitCode?` | `number` \| `null` |
| <a id="property-iserror"></a> `isError?` | `boolean` \| `null` |
| <a id="property-output"></a> `output?` | `string` \| `null` |

***

### WrapToolOptions

Options for [wrapTool](#wraptool).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gate"></a> `gate?` | [`Gate`](classes/Gate.md) | Overrides the process-wide installed gate for this tool only. |
| <a id="property-name-1"></a> `name?` | `string` | Tool name reported to the gate. Defaults to the function's own `.name` (or the tool object's `.name`), then falls back to `"tool"`. |

## Type Aliases

### AnyFn

```ts
type AnyFn = (...args) => any;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`args` | `any`[] |

#### Returns

`any`

***

### DecideEngineErrorCode

```ts
type DecideEngineErrorCode = 
  | "not_configured"
  | "host_refused"
  | "timeout"
  | "upstream"
  | "no_logprobs"
  | "bad_response"
  | "too_large"
  | "canary_failed";
```

***

### DecideSdkAnswer

```ts
type DecideSdkAnswer = 
  | {
  p: number | null;
  type: "yes_no";
  value: Tri;
}
  | {
  choice: string | null;
  options: Record<string, ChoiceAtom>;
  perOrder: Record<string, number>[] | null;
  type: "choice";
};
```

#### Union Members

##### Type Literal

```ts
{
  p: number | null;
  type: "yes_no";
  value: Tri;
}
```

***

##### Type Literal

```ts
{
  choice: string | null;
  options: Record<string, ChoiceAtom>;
  perOrder: Record<string, number>[] | null;
  type: "choice";
}
```

| Name | Type | Description |
| ------ | ------ | ------ |
| `choice` | `string` \| `null` | The option whose atom is T, or null. At most one can be, because `yes_at` is above 0.5. |
| `options` | `Record`\<`string`, `ChoiceAtom`\> | Each option's atom `q == o`: the mean over the orders, their spread, and its value. |
| `perOrder` | `Record`\<`string`, `number`\>[] \| `null` | - |
| `type` | `"choice"` | - |

***

### DecideStamp

```ts
type DecideStamp = "rule" | "local-disable" | "server-shadow" | "silent-log" | "no-pins";
```

Why a rule's stamped rollout is what it is. Only `rule` can stamp `enforce`.

***

### GateRefusalCode

```ts
type GateRefusalCode = typeof GATE_REFUSAL_CODES[number];
```

***

### GateRuleCode

```ts
type GateRuleCode = 
  | "PREREQUISITE_UNMET"
  | "OUT_OF_SCOPE"
  | "OFF_PLAN"
  | "PLAN_NOT_APPROVED";
```

The refusal codes Tier R gives.

***

### GateRuleKind

```ts
type GateRuleKind = "requires_outcome" | "scope_paths" | "plan_approval";
```

***

### GateRuleRecord

```ts
type GateRuleRecord = RequiresOutcomeRecord | ScopePathsRecord | PlanApprovalRecord;
```

***

### ImageRefusalCode

```ts
type ImageRefusalCode = 
  | typeof E_UNPINNED_LATEST
  | typeof E_UNPINNED_TAG
  | typeof E_UNKNOWN_REGISTRY
  | typeof E_UNKNOWN_IMAGE
  | typeof E_DIGEST_MISMATCH
  | typeof E_MANIFEST_UNPARSEABLE;
```

***

### ImageVerdict

```ts
type ImageVerdict = 
  | {
  code: "";
  detail: string;
  images: ImageRef[];
  ok: true;
}
  | {
  code: ImageRefusalCode;
  detail: string;
  images: ImageRef[];
  ok: false;
};
```

`code` is `''` on a pass and names the failure otherwise.

***

### LaneClass

```ts
type LaneClass = "irreversible" | "reversible_wide" | "reversible_contained";
```

A token's reversibility class.

***

### RuleSubject

```ts
type RuleSubject = "tool" | "command" | "target" | "phrase" | "action" | "any";
```

`phrase`: the source is `|`-separated phrases matched as words (phrases.ts),
not a regex. `action`: the source is matched against the action tokens the
command classifies to (`" action:deploy "`, actions.ts) — what a local
`review_before: action:<name>` compiles to.

***

### Severity

```ts
type Severity = 
  | typeof SEV_SHADOW
  | typeof SEV_WARN
  | typeof SEV_BLOCK
  | typeof SEV_HOLD;
```

***

### SnapshotState

```ts
type SnapshotState = "ok" | "absent" | "invalid" | "empty" | "stale";
```

***

### SsoGroupClearance

```ts
type SsoGroupClearance = "GRANTED" | "DENIED" | "REQUIRES_OBO";
```

SSO-group tool clearance, read from the policy snapshot.

Port of `evaluateSsoGroupClearance` and the `@sso_groups` record in
`packages/shared-types/src/ssoGroupClearance.ts` — the evaluator the control
plane's hook gate, the MCP proxy and the sync daemon's snapshot compiler
share. This package has no workspace dependencies, so it carries a copy, and
`src/__tests__/ssoGroups.test.ts` runs the shared vectors
(`packages/shared-types/fixtures/sso-group-clearance-vectors.json`) through
it so the copy cannot drift. `intutic_clawde/gate/sso_groups.py` is the
Python port of the same thing.

The snapshot's record carries the workspace's policy and the member the
snapshot was issued to, with their groups as the control plane resolved
them. It sits inside the snapshot's digest; when the digest fails, the gate
still applies the policy but treats the member's groups as unknown, so an
edited group list clears nothing.

***

### ToolInput

```ts
type ToolInput = Record<string, unknown>;
```

## Variables

### ACTION\_APPROVAL

```ts
const ACTION_APPROVAL: "require_approval" = 'require_approval';
```

***

### ACTION\_BLOCK

```ts
const ACTION_BLOCK: "block" = 'block';
```

***

### ACTION\_WARN

```ts
const ACTION_WARN: "warn" = 'warn';
```

***

### ARGUMENTS\_SIZE\_LIMIT

```ts
const ARGUMENTS_SIZE_LIMIT: number;
```

The largest tool arguments, in UTF-8 bytes of compact JSON, the gate evaluates.

***

### CAN\_EVALUATE\_RULE\_RECORDS

```ts
const CAN_EVALUATE_RULE_RECORDS: true = true;
```

Whether this gate evaluates the `@rule` records a snapshot carries (Tier
R). Only a gate that does skips a record's fallback line, and only when
the record decoded.

***

### COMMAND\_SIZE\_LIMIT

```ts
const COMMAND_SIZE_LIMIT: number;
```

The largest shell command, in UTF-8 bytes, the gate evaluates.

***

### GATE\_DEADLINE\_MS

```ts
const GATE_DEADLINE_MS: number;
```

How long the hook script the sandbox bootstrap writes may run, from process start, before it refuses.

***

### GATE\_REFUSAL\_CODES

```ts
const GATE_REFUSAL_CODES: readonly ["SSO_GROUP", "SNAPSHOT", "HELD", "PREREQUISITE_UNMET", "OUT_OF_SCOPE", "OFF_PLAN", "PLAN_NOT_APPROVED", "SERVER_BLOCKED", "SERVER_HELD", "SERVER_NOT_APPROVED", "TOOL_DISABLED", "SERVER_NOT_ALLOWED", "POLICY_SNAPSHOT_UNVERIFIED", "SOP_RULE", "HOOK_GATE", "INSUFFICIENT_SCOPE", "COMMAND_TOO_LARGE", "CHAOS_FAULT", "E_UNPINNED_LATEST", "E_UNPINNED_TAG", "E_UNKNOWN_REGISTRY", "E_UNKNOWN_IMAGE", "E_DIGEST_MISMATCH", "E_MANIFEST_UNPARSEABLE", "DECIDE_REFUSED", "DECIDE_ESCALATED", "GOVERNANCE_UNAVAILABLE", "WORKFLOW_SANDBOX", "NO_GATE"];
```

Every `code` an [IntuticGateRefusal](classes/IntuticGateRefusal.md) can carry: the tier that refused,
or for the image-integrity tier the specific failure. Held to
`packages/shared-types/fixtures/refusal-codes.json` (`gate`) by a test, as
the Python gate's list and the gate SDK reference are.

***

### PLAN\_CACHE\_MS

```ts
const PLAN_CACHE_MS: 30000 = 30_000;
```

How long Tier R keeps a session's plan before reading it again.

***

### READ\_ONLY\_TOOLS

```ts
const READ_ONLY_TOOLS: ReadonlySet<string>;
```

Tools that cannot change anything. They still get the local snapshot check
 (Tier A1), but skip the remote gate call (Tier B).

***

### SEV\_BLOCK

```ts
const SEV_BLOCK: "block";
```

***

### SEV\_HOLD

```ts
const SEV_HOLD: "hold";
```

A hold rule (a `REQUIRE_APPROVAL:` SOP, or a local `review_before:` token):
refuses like a block, but asks a person rather than denying — see hold.ts.

***

### SEV\_SHADOW

```ts
const SEV_SHADOW: "shadow";
```

Severity tiers, in the order the shipped gate handles them.

***

### SEV\_WARN

```ts
const SEV_WARN: "warn";
```

## Functions

### active()

```ts
function active(): Gate | null;
```

The process-wide gate [install](#install) set, or `null`.

#### Returns

[`Gate`](classes/Gate.md) \| `null`

***

### canonicalJson()

```ts
function canonicalJson(value): string;
```

JSON with object keys sorted at every level, so key order never changes a hash.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

#### Returns

`string`

***

### checkCommand()

```ts
function checkCommand(
   command, 
   repoRoot, 
   policy
): ImageVerdict;
```

Full check for a deploy command. The entry point the gate calls.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `command` | `string` |
| `repoRoot` | `string` |
| `policy` | [`ImagePolicy`](#imagepolicy) |

#### Returns

[`ImageVerdict`](#imageverdict)

***

### checkImages()

```ts
function checkImages(images, policy): ImageVerdict;
```

Evaluate parsed references against the allowlist. First failure wins.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `images` | readonly [`ImageRef`](#imageref)[] |
| `policy` | [`ImagePolicy`](#imagepolicy) |

#### Returns

[`ImageVerdict`](#imageverdict)

***

### checkWrittenManifest()

```ts
function checkWrittenManifest(
   path, 
   content, 
   policy
): ImageVerdict;
```

Check a manifest at authoring time, before it is ever applied.

Lets the dashboard show the bad image being *written* a full turn before it
is *applied* — the write is flagged, the apply is blocked.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `content` | `string` |
| `policy` | [`ImagePolicy`](#imagepolicy) |

#### Returns

[`ImageVerdict`](#imageverdict)

***

### classify()

```ts
function classify(toolName, toolInput): string[];
```

Classify one tool call into the abstract actions it performs.

Returns prefixed tokens (`action:deploy`, ...) in the order the Rust/Python
emit them. Order matters: the ordering detectors read position in the
sequence.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`string`[]

***

### decide()

```ts
function decide(
   state, 
   questions, 
   opts?
): Promise<DecideSdkResult>;
```

Asks `questions` (written as a decide rule's `questions`) about `state`.
With `opts.when` the result carries the outcome the rule would reach.
Throws a `TypeError` for questions a decide rule would refuse, and a
`DecideEngineError` when the engine is not configured, its host is
refused, or it cannot answer in time.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `state` | `string` |
| `questions` | `Record`\<`string`, [`DecideQuestion`](#decidequestion)\> |
| `opts` | [`DecideSdkOptions`](#decidesdkoptions) |

#### Returns

`Promise`\<[`DecideSdkResult`](#decidesdkresult)\>

***

### evaluate()

```ts
function evaluate(
   toolName, 
   target, 
   command, 
   snap, 
   guardDisabled?, 
   from?
): Decision;
```

Evaluate one tool call against the snapshot, as the rendered gates do: a
shadow or warn match is collected and evaluation continues, so a later block
or hold still decides the call. The first block or hold wins. With none, the
first advisory match is returned. `from` resumes after an approved hold.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `toolName` | `string` | `undefined` |
| `target` | `string` | `undefined` |
| `command` | `string` | `undefined` |
| `snap` | [`Snapshot`](classes/Snapshot.md) | `undefined` |
| `guardDisabled` | `boolean` | `false` |
| `from` | `number` | `0` |

#### Returns

[`Decision`](#decision)

***

### fetchRegister()

```ts
function fetchRegister(
   baseUrl, 
   apiKey, 
   workspaceId, 
   timeoutMs?
): Promise<SopRegister | null>;
```

[fetchRules](#fetchrules) with the workspace's mode: `null` if the register did not answer.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `baseUrl` | `string` | `undefined` |
| `apiKey` | `string` | `undefined` |
| `workspaceId` | `string` | `undefined` |
| `timeoutMs` | `number` | `FETCH_TIMEOUT_MS` |

#### Returns

`Promise`\<[`SopRegister`](#sopregister) \| `null`\>

***

### fetchRules()

```ts
function fetchRules(
   baseUrl, 
   apiKey, 
   workspaceId, 
   timeoutMs?
): Promise<SopRule[] | null>;
```

Fetch active VALIDATED rules, or `null` if they could not be fetched.

`null` and `[]` mean different things and the caller must not conflate
them: `null` is "the register did not answer", `[]` is "the register
answered and this workspace has no rules". Only the second is a statement
about policy.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `baseUrl` | `string` | `undefined` |
| `apiKey` | `string` | `undefined` |
| `workspaceId` | `string` | `undefined` |
| `timeoutMs` | `number` | `FETCH_TIMEOUT_MS` |

#### Returns

`Promise`\<[`SopRule`](#soprule)[] \| `null`\>

***

### firstMatch()

```ts
function firstMatch(
   rules, 
   toolName, 
   toolInput
): SopRule | null;
```

The rule that decides this call: the most severe one matching it (block,
then require_approval, then warn), the first of that severity in
control-plane order. `null` when none matches.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rules` | readonly [`SopRule`](#soprule)[] |
| `toolName` | `string` |
| `toolInput` | `Record`\<`string`, `unknown`\> \| `null` \| `undefined` |

#### Returns

[`SopRule`](#soprule) \| `null`

***

### guardDisabledFromEnv()

```ts
function guardDisabledFromEnv(): boolean;
```

#### Returns

`boolean`

***

### holdKey()

```ts
function holdKey(toolName, toolInput): object;
```

The bypass key's call half: the tool and a hash of its arguments.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`object`

| Name | Type |
| ------ | ------ |
| `targetHash` | `string` |
| `toolNameNormalized` | `string` |

***

### holdMessage()

```ts
function holdMessage(
   ruleReason, 
   ruleId, 
   outcome
): string;
```

What the agent is told, held or not recorded — the one place this package
words a hold. Says who can approve, and that a retry passes only with the
bypass setting on, because "retry after approval" alone is false under the
default settings.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ruleReason` | `string` |
| `ruleId` | `string` |
| `outcome` | \{ `holdId`: `string`; `recorded`: `boolean`; \} |
| `outcome.holdId` | `string` |
| `outcome.recorded` | `boolean` |

#### Returns

`string`

***

### install()

```ts
function install(gate): void;
```

Set the process-wide gate that wrapped tools use; `null` clears it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gate` | [`Gate`](classes/Gate.md) \| `null` |

#### Returns

`void`

***

### intuticHeaders()

```ts
function intuticHeaders(opts?): Record<string, string>;
```

Default headers for a client pointed at the Intutic proxy (an OpenAI-
compatible chat client, a raw `fetch` call, etc.).

`x-session-id` matters: the proxy defaults an unset one to the literal
`"unknown"`, which merges every run into a single dashboard session.
`x-intutic-harness` attributes traces to this adapter — the proxy honours
it for trace attribution (unknown headers are ignored by older proxies, so
it is always safe to send).

Usage:

    const client = new OpenAI(\{ baseURL: proxyUrl, defaultHeaders: intuticHeaders(\{ sessionId: runId \}) \})

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `opts` | [`IntuticHeadersOptions`](#intuticheadersoptions) |

#### Returns

`Record`\<`string`, `string`\>

***

### isDeploy()

```ts
function isDeploy(toolName, toolInput): boolean;
```

True when this call would deploy — the trigger for the image check.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`boolean`

***

### isDeployCommand()

```ts
function isDeployCommand(toolName, toolInput): boolean;
```

True when this call should be image-checked.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`boolean`

***

### isPinned()

```ts
function isPinned(img): boolean;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `img` | [`ImageRef`](#imageref) |

#### Returns

`boolean`

***

### isTest()

```ts
function isTest(toolName, toolInput): boolean;
```

True when this call runs a test suite.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolName` | `string` |
| `toolInput` | `unknown` |

#### Returns

`boolean`

***

### loadSnapshot()

```ts
function loadSnapshot(
   workspaceId?, 
   path?, 
   opts?
): Snapshot;
```

Read the policy snapshot the sync daemon compiled: from `path`, else
[snapshotPath](#snapshotpath). A missing file gives an empty snapshot whose `state`
is `'absent'`. A snapshot whose digest does not match its rules, or that
was compiled for a workspace other than a non-empty `workspaceId`, is
`'invalid'`: its rules and MCP records are dropped.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `workspaceId` | `string` | `''` |
| `path?` | `string` | `undefined` |
| `opts?` | [`LoadSnapshotOptions`](#loadsnapshotoptions) | `{}` |

#### Returns

[`Snapshot`](classes/Snapshot.md)

***

### manifestPathsFromCommand()

```ts
function manifestPathsFromCommand(command): object;
```

Extract the -f/-k targets from a kubectl/helm command.

Returns `{paths, readable}`. `readable` is false when the command applies
something we cannot inspect — stdin (`-f -`), a URL, or a command we could
not tokenise. That drives the fail-closed path.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `command` | `string` |

#### Returns

`object`

| Name | Type |
| ------ | ------ |
| `paths` | `string`[] |
| `readable` | `boolean` |

***

### parseImageRef()

```ts
function parseImageRef(raw, source?): ImageRef;
```

Parse `registry/repo:tag@sha256:...` into its parts.

Docker's own rule for splitting registry from repository: the first path
component is a registry host only if it contains a dot or a colon, or is
exactly `localhost`. This function does not need to make that
classification itself — it only needs to find the tag/digest boundary,
which is a colon (or `@`) in the LAST path component; a colon earlier
(a registry port, `localhost:5000/foo`) is left alone.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `raw` | `string` | `undefined` |
| `source` | `string` | `''` |

#### Returns

[`ImageRef`](#imageref)

***

### parseRegister()

```ts
function parseRegister(payload): SopRegister;
```

[parseRules](#parserules), and the `interventionMode` beside them.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `payload` | `unknown` |

#### Returns

[`SopRegister`](#sopregister)

***

### parseRules()

```ts
function parseRules(payload): SopRule[];
```

Accept the rule list in whichever envelope the control plane used.

`/api/v1/sop/rules` returns `{rules:[...]}`, while sibling list endpoints
variously return `{items:[...]}` and `{data:[...]}`. Reading the wrong key
yields zero rules and a tier that enforces nothing while looking healthy —
the worst failure a gate can have — so all three are accepted rather than
assumed.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `payload` | `unknown` |

#### Returns

[`SopRule`](#soprule)[]

***

### ruleMatches()

```ts
function ruleMatches(
   rule, 
   toolName, 
   toolInputJson
): boolean;
```

Mirror of `matchSopRule`, including its silent-skip on bad regex.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rule` | [`SopRule`](#soprule) |
| `toolName` | `string` |
| `toolInputJson` | `string` |

#### Returns

`boolean`

***

### serialiseToolInput()

```ts
function serialiseToolInput(toolInput): string;
```

The `JSON.stringify(tool_input ?? {})` shape every mirror matches against.

`JSON.stringify` already produces compact separators and preserves
insertion order and non-ASCII by default — this function exists mainly so
every call site names the contract explicitly rather than calling
`JSON.stringify` inline and drifting on a future edit.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `toolInput` | `Record`\<`string`, `unknown`\> \| `null` \| `undefined` |

#### Returns

`string`

***

### snapshotPath()

```ts
function snapshotPath(): string;
```

Where the policy snapshot is read from: `INTUTIC_SNAPSHOT_RULES`, else `~/.intutic/hooks/policy-snapshot.rules`.

#### Returns

`string`

***

### supportsArgPatterns()

```ts
function supportsArgPatterns(rules): boolean;
```

True when the control plane emitted at least one usable `argPattern`.

A control plane predating `intutic-enterprise#14` cannot produce one, so
this doubles as a deployment probe — surface it rather than letting the
tier be silently inert.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rules` | readonly [`SopRule`](#soprule)[] |

#### Returns

`boolean`

***

### toolOutcomeOf()

```ts
function toolOutcomeOf(result): ToolOutcome;
```

What a tool's return value says about how it went: a string is its
output; an object's numeric `exitCode`, `exit_code` or `returncode` is its
exit code, and its string `output`, `stdout` or `stderr` its output.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `result` | `unknown` |

#### Returns

[`ToolOutcome`](#tooloutcome)

***

### touchesInfra()

```ts
function touchesInfra(path): boolean;
```

True when a written path is infrastructure-as-code.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` \| `null` \| `undefined` |

#### Returns

`boolean`

***

### verdictReason()

```ts
function verdictReason(v): string;
```

The single line an operator sees on the dashboard.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `v` | [`ImageVerdict`](#imageverdict) |

#### Returns

`string`

***

### wrapTool()

#### Call Signature

```ts
function wrapTool<T>(fn, opts?): T;
```

Wrap a single tool — a plain async function, or a `{ execute, ... }`
object — so `Gate.guard()` runs before the real implementation.

The object form returns a NEW object (a shallow copy with `execute`
replaced); it does not mutate the one passed in, since the frameworks this
targets tend to hand out tool definitions that are re-used or frozen.
Already-wrapped functions/objects pass through unchanged, so wrapping the
same tool twice does not double-gate it.

##### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`AnyFn`](#anyfn) |

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | `T` |
| `opts?` | [`WrapToolOptions`](#wraptooloptions) |

##### Returns

`T`

#### Call Signature

```ts
function wrapTool<T>(tool, opts?): T;
```

Wrap a single tool — a plain async function, or a `{ execute, ... }`
object — so `Gate.guard()` runs before the real implementation.

The object form returns a NEW object (a shallow copy with `execute`
replaced); it does not mutate the one passed in, since the frameworks this
targets tend to hand out tool definitions that are re-used or frozen.
Already-wrapped functions/objects pass through unchanged, so wrapping the
same tool twice does not double-gate it.

##### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ExecutableTool`](#executabletool) |

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `tool` | `T` |
| `opts?` | [`WrapToolOptions`](#wraptooloptions) |

##### Returns

`T`

***

### wrapTools()

#### Call Signature

```ts
function wrapTools<T>(tools, gate?): T[];
```

Wrap a collection of tools in one call.

Accepts either an array (tool name comes from each tool's own `.name`/
function name) or a record keyed by tool name (the Vercel AI SDK / Mastra
`tools: { myTool: {...} }` shape) — in the record form the KEY is always
the name reported to the gate, since that is the identity the framework
itself uses to invoke the tool.

##### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ExecutableTool`](#executabletool) \| [`AnyFn`](#anyfn) |

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | readonly `T`[] |
| `gate?` | [`Gate`](classes/Gate.md) |

##### Returns

`T`[]

#### Call Signature

```ts
function wrapTools<T>(tools, gate?): Record<string, T>;
```

Wrap a collection of tools in one call.

Accepts either an array (tool name comes from each tool's own `.name`/
function name) or a record keyed by tool name (the Vercel AI SDK / Mastra
`tools: { myTool: {...} }` shape) — in the record form the KEY is always
the name reported to the gate, since that is the identity the framework
itself uses to invoke the tool.

##### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ExecutableTool`](#executabletool) \| [`AnyFn`](#anyfn) |

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `tools` | `Record`\<`string`, `T`\> |
| `gate?` | [`Gate`](classes/Gate.md) |

##### Returns

`Record`\<`string`, `T`\>
