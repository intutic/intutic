[@intutic/gate](../../index.md) / [workflow](../index.md) / IntuticWorkflowRefusal

# Class: IntuticWorkflowRefusal

A refused call inside a durable workflow.

`name` is `'FatalError'` — NOT `'IntuticGateRefusal'` — on purpose: the
workflow runtime's `FatalError.is()` duck-types on that exact string (see
module doc), and it is the only cross-VM-realm-safe way to tell the runtime
"abort, do not retry". Everything else about the refusal contract is
preserved: `instanceof IntuticGateRefusal` still holds (same realm),
`.message` still carries the `[Intutic Governance] BLOCKED:` prefix, and
`.reason`/`.code`/`.incidentId` carry the structured verdict. `fatal: true`
mirrors the property the real `FatalError` class sets, for code that
checks the flag rather than the name.

## Extends

- [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md)

## Constructors

### Constructor

```ts
new IntuticWorkflowRefusal(
   reason, 
   code, 
   incidentId?, 
   holdId?
): IntuticWorkflowRefusal;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `string` |
| `code` | \| `"GOVERNANCE_UNAVAILABLE"` \| `"INSUFFICIENT_SCOPE"` \| `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `"PREREQUISITE_UNMET"` \| `"OUT_OF_SCOPE"` \| `"OFF_PLAN"` \| `"PLAN_NOT_APPROVED"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` |
| `incidentId?` | `string` |
| `holdId?` | `string` |

#### Returns

`IntuticWorkflowRefusal`

#### Overrides

[`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`constructor`](../../core/classes/IntuticGateRefusal.md#constructor)

## Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | \| `"GOVERNANCE_UNAVAILABLE"` \| `"INSUFFICIENT_SCOPE"` \| `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `"PREREQUISITE_UNMET"` \| `"OUT_OF_SCOPE"` \| `"OFF_PLAN"` \| `"PLAN_NOT_APPROVED"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` | - | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`code`](../../core/classes/IntuticGateRefusal.md#property-code) |
| <a id="property-evidence"></a> `evidence` | `readonly` | [`RefusalEvidence`](../../core/index.md#refusalevidence)[] \| `undefined` | What the refuser saw, bounded; undefined when nothing, and in OPAQUE. | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`evidence`](../../core/classes/IntuticGateRefusal.md#property-evidence) |
| <a id="property-fatal"></a> `fatal` | `readonly` | `true` | - | - |
| <a id="property-holdid"></a> `holdId` | `readonly` | `string` \| `undefined` | The hold's id when the refusal was a hold (`code` `HELD`); see `IntuticGateHold`. | - |
| <a id="property-incidentid"></a> `incidentId` | `readonly` | `string` \| `undefined` | - | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`incidentId`](../../core/classes/IntuticGateRefusal.md#property-incidentid) |
| <a id="property-reason"></a> `reason` | `readonly` | `string` | - | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`reason`](../../core/classes/IntuticGateRefusal.md#property-reason) |
| <a id="property-scope"></a> `scope` | `readonly` | [`RefusalScope`](../../core/index.md#refusalscope) \| `undefined` | Where the refusal applies, so a retry can stay out of it (paths, tools, step, detector, rule), bounded as refusalDetail.ts says. Undefined when the refusal names none, and always in an OPAQUE workspace. | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md).[`scope`](../../core/classes/IntuticGateRefusal.md#property-scope) |

## Methods

### from()

```ts
static from(refusal): IntuticWorkflowRefusal;
```

Rewrap a core refusal so the durable runtime treats it as fatal.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `refusal` | [`IntuticGateRefusal`](../../core/classes/IntuticGateRefusal.md) |

#### Returns

`IntuticWorkflowRefusal`

***

### is()

```ts
static is(value): boolean;
```

Cross-realm-safe detection (the same trick `FatalError.is` itself uses):
`instanceof` fails across the workflow `vm` boundary, so this checks the
duck-typed name plus this package's own message prefix.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

#### Returns

`boolean`
