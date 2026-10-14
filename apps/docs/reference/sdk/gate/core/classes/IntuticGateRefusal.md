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
- [`IntuticGateHold`](IntuticGateHold.md)

## Constructors

### Constructor

```ts
new IntuticGateRefusal(
   reason, 
   code, 
   incidentId?
): IntuticGateRefusal;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reason` | `string` |
| `code` | \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` |
| `incidentId?` | `string` |

#### Returns

`IntuticGateRefusal`

#### Overrides

[`GateError`](GateError.md).[`constructor`](GateError.md#constructor)

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `readonly` | \| `"SSO_GROUP"` \| `"SNAPSHOT"` \| `"HELD"` \| `"SERVER_BLOCKED"` \| `"SERVER_HELD"` \| `"SERVER_NOT_APPROVED"` \| `"TOOL_DISABLED"` \| `"SERVER_NOT_ALLOWED"` \| `"POLICY_SNAPSHOT_UNVERIFIED"` \| `"SOP_RULE"` \| `"HOOK_GATE"` \| `"COMMAND_TOO_LARGE"` \| `"CHAOS_FAULT"` \| `"E_UNPINNED_LATEST"` \| `"E_UNPINNED_TAG"` \| `"E_UNKNOWN_REGISTRY"` \| `"E_UNKNOWN_IMAGE"` \| `"E_DIGEST_MISMATCH"` \| `"E_MANIFEST_UNPARSEABLE"` \| `"WORKFLOW_SANDBOX"` \| `"NO_GATE"` |
| <a id="property-incidentid"></a> `incidentId` | `readonly` | `string` \| `undefined` |
| <a id="property-reason"></a> `reason` | `readonly` | `string` |
