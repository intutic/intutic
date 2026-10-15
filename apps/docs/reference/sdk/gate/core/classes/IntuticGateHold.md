[@intutic/gate](../../index.md) / [core](../index.md) / IntuticGateHold

# Class: IntuticGateHold

Raised when a hold rule stopped the call to ask a person first (`code`
`HELD`). A subclass, so a caller that stops on every refusal stops on this
too; one that tells the user about holds catches it first.

`holdId` names the hold in the review queue, and is `undefined` when the
hold could not be recorded (no control plane to record it in), in which
case there is nothing to approve yet. `.message` starts
`[Intutic Governance] HELD:`, as the hook gates print a hold, and says who
can approve it and when a retry passes. See hold.ts.

## Extends

- [`IntuticGateRefusal`](IntuticGateRefusal.md)

## Constructors

### Constructor

```ts
new IntuticGateHold(reason, holdId): IntuticGateHold;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `string` |
| `holdId` | `string` \| `undefined` |

#### Returns

`IntuticGateHold`

#### Overrides

[`IntuticGateRefusal`](IntuticGateRefusal.md).[`constructor`](IntuticGateRefusal.md#constructor)

## Properties

| Property | Modifier | Type | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | \| `"INSUFFICIENT_SCOPE"` \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`code`](IntuticGateRefusal.md#property-code) |
| <a id="property-holdid"></a> `holdId` | `readonly` | `string` \| `undefined` | - |
| <a id="property-incidentid"></a> `incidentId` | `readonly` | `string` \| `undefined` | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`incidentId`](IntuticGateRefusal.md#property-incidentid) |
| <a id="property-reason"></a> `reason` | `readonly` | `string` | [`IntuticGateRefusal`](IntuticGateRefusal.md).[`reason`](IntuticGateRefusal.md#property-reason) |
