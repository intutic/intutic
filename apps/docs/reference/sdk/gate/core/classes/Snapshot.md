[@intutic/gate](../../index.md) / [core](../index.md) / Snapshot

# Class: Snapshot

## Constructors

### Constructor

```ts
new Snapshot(): Snapshot;
```

#### Returns

`Snapshot`

## Properties

| Property | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-agedays"></a> `ageDays` | `number` | `0` | - |
| <a id="property-digest"></a> `digest` | `string` | `'none'` | - |
| <a id="property-droppedrules"></a> `droppedRules` | `number` | `0` | Regexes that would not compile. |
| <a id="property-generatedat"></a> `generatedAt` | `string` | `''` | - |
| <a id="property-mcpallowlist"></a> `mcpAllowlist` | [`McpAllowlistRecord`](../index.md#mcpallowlistrecord) \| `null` | `null` | The workspace's `mcpAllowedServers` list (the `@mcp_allowlist` record), or null when it set none. Null on a snapshot that fails its integrity check, as [mcpRegistry](#property-mcpregistry) is. |
| <a id="property-mcpregistry"></a> `mcpRegistry` | [`McpRegistryRecord`](../index.md#mcpregistryrecord) \| `null` | `null` | The workspace's MCP server registry decisions (the `@mcp_registry` record), or null when it made none. Null on a snapshot that fails its integrity check, on which the gate admits no MCP server at all (`mcpSnapshotUnverifiedRefusal`): a deleted record looks like one never set, so neither record can be vouched for. |
| <a id="property-opaque"></a> `opaque` | `boolean` | `false` | The workspace is OPAQUE (the `@intervention_mode` record): a refusal on workspace policy tells the agent `OPAQUE_REFUSAL_MESSAGE`, not the rule, and the event keeps the rule. Kept on a snapshot that fails its integrity check, since it only ever hides text and never allows a call. |
| <a id="property-rules"></a> `rules` | [`Rule`](../index.md#rule)[] | `[]` | - |
| <a id="property-ssogroups"></a> `ssoGroups` | [`SsoGroupRecord`](../index.md#ssogrouprecord) \| `null` | `null` | The workspace's SSO-group policy and the member this snapshot was issued to, or null when the workspace has no group policy. On a snapshot that fails its integrity check the member is null — groups unknown — so an edited group list in the file clears nothing. |
| <a id="property-state"></a> `state` | [`SnapshotState`](../index.md#snapshotstate) | `'absent'` | - |
| <a id="property-workspaceid"></a> `workspaceId` | `string` | `''` | - |

## Accessors

### healthMessage

#### Get Signature

```ts
get healthMessage(): string;
```

##### Returns

`string`
