[@intutic/gate](../../index.md) / [core](../index.md) / IntuticGateRefusal

# Class: IntuticGateRefusal

Raised when a tool call must not run.

The structured fields (`reason`, `code`, `incidentId`) carry the
machine-readable version of the refusal; `.message` carries the
human-readable, prefix-recognisable one.

## Extends

- [`GateError`](GateError.md)

## Extended by

- [`IntuticWorkflowRefusal`](../../workflow/classes/IntuticWorkflowRefusal.md)
- [`IntuticGateEscalation`](IntuticGateEscalation.md)
- [`IntuticGateHold`](IntuticGateHold.md)

## Constructors

### Constructor

```ts
new IntuticGateRefusal(
   reason, 
   code, 
   incidentId?, 
   detail?
): IntuticGateRefusal;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `string` |
| `code` | \| `"GOVERNANCE_UNAVAILABLE"` \| `"INSUFFICIENT_SCOPE"` \| `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `"PREREQUISITE_UNMET"` \| `"OUT_OF_SCOPE"` \| `"OFF_PLAN"` \| `"PLAN_NOT_APPROVED"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` |
| `incidentId?` | `string` |
| `detail?` | \{ `evidence?`: [`RefusalEvidence`](../index.md#refusalevidence)[]; `scope?`: [`RefusalScope`](../index.md#refusalscope); \} |
| `detail.evidence?` | [`RefusalEvidence`](../index.md#refusalevidence)[] |
| `detail.scope?` | [`RefusalScope`](../index.md#refusalscope) |

#### Returns

`IntuticGateRefusal`

#### Overrides

[`GateError`](GateError.md).[`constructor`](GateError.md#constructor)

## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | \| `"GOVERNANCE_UNAVAILABLE"` \| `"INSUFFICIENT_SCOPE"` \| `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `"PREREQUISITE_UNMET"` \| `"OUT_OF_SCOPE"` \| `"OFF_PLAN"` \| `"PLAN_NOT_APPROVED"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` | - |
| <a id="property-evidence"></a> `evidence` | `readonly` | [`RefusalEvidence`](../index.md#refusalevidence)[] \| `undefined` | What the refuser saw, bounded; undefined when nothing, and in OPAQUE. |
| <a id="property-incidentid"></a> `incidentId` | `readonly` | `string` \| `undefined` | - |
| <a id="property-reason"></a> `reason` | `readonly` | `string` | - |
| <a id="property-scope"></a> `scope` | `readonly` | [`RefusalScope`](../index.md#refusalscope) \| `undefined` | Where the refusal applies, so a retry can stay out of it (paths, tools, step, detector, rule), bounded as refusalDetail.ts says. Undefined when the refusal names none, and always in an OPAQUE workspace. |
