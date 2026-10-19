[@intutic/gate](../../index.md) / [core](../index.md) / IntuticGateEscalation

# Class: IntuticGateEscalation

Raised when a decide rule could not decide the call and a person should
(`code` `DECIDE_ESCALATED`): the answers fell between its bands, or the
option orders disagreed. A subclass, so a caller that stops on every
refusal stops on this too; one that can ask its user (dsh's approval) asks
with `reason` and runs the call only on a yes. `ruleId` names the rule
(`decide.<ruleRef>`), and is `undefined` in an OPAQUE workspace.

## Extends

- [`IntuticGateRefusal`](IntuticGateRefusal.md)

## Constructors

### Constructor

```ts
new IntuticGateEscalation(reason, ruleId): IntuticGateEscalation;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `string` |
| `ruleId` | `string` \| `undefined` |

#### Returns

`IntuticGateEscalation`

#### Overrides

[`IntuticGateRefusal`](IntuticGateRefusal.md).[`constructor`](IntuticGateRefusal.md#constructor)

## Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | \| `"GOVERNANCE_UNAVAILABLE"` \| `"INSUFFICIENT_SCOPE"` \| `"DECIDE_REFUSED"` \| `"DECIDE_ESCALATED"` \| `"PREREQUISITE_UNMET"` \| `"OUT_OF_SCOPE"` \| `"OFF_PLAN"` \| `"PLAN_NOT_APPROVED"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` | - | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`code`](IntuticGateRefusal.md#property-code) |
| <a id="property-evidence"></a> `evidence` | `readonly` | [`RefusalEvidence`](../index.md#refusalevidence)[] \| `undefined` | What the refuser saw, bounded; undefined when nothing, and in OPAQUE. | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`evidence`](IntuticGateRefusal.md#property-evidence) |
| <a id="property-incidentid"></a> `incidentId` | `readonly` | `string` \| `undefined` | - | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`incidentId`](IntuticGateRefusal.md#property-incidentid) |
| <a id="property-reason"></a> `reason` | `readonly` | `string` | - | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`reason`](IntuticGateRefusal.md#property-reason) |
| <a id="property-ruleid"></a> `ruleId` | `readonly` | `string` \| `undefined` | - | - |
| <a id="property-scope"></a> `scope` | `readonly` | [`RefusalScope`](../index.md#refusalscope) \| `undefined` | Where the refusal applies, so a retry can stay out of it (paths, tools, step, detector, rule), bounded as refusalDetail.ts says. Undefined when the refusal names none, and always in an OPAQUE workspace. | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`scope`](IntuticGateRefusal.md#property-scope) |
