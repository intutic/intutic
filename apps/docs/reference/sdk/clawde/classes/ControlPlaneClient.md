[@intutic/clawde](../index.md) / ControlPlaneClient

# Class: ControlPlaneClient

Control-plane management client — org/team/gateway/credentials
administration, as distinct from `ClawdeClient`'s data-plane chat calls.

Deliberately a separate class, not new methods on `ClawdeClient`:
`ClawdeClient.baseUrl` targets the *proxy* (default `http://localhost:4000`);
the control plane is a different origin entirely (`baseUrl` or
`INTUTIC_CONTROL_PLANE_URL`; see release.ts for the default). Bolting
management calls onto `ClawdeClient` would silently need a second base URL
on a class whose whole contract today is "one client, one proxy."

Every endpoint here comes from the control-plane calls in
`tools/cli/src/commands/*` — the CLI's own already-tested contracts, not
re-derived — and the Python SDK's `control_plane.py` has the same methods
in snake_case. `packages/shared-types/fixtures/control-plane-operations.json`
lists every method with the request it makes and the answer it returns, and
both SDKs' tests run against it, so neither can grow a method the other
lacks. Method names follow one pattern for whatever is added next: a verb
(`list`, `get`, `create`, `update`, `delete`, `rotate…Secret`, `download`,
or the CLI subcommand's own verb, such as `approve` or `promote`), then the
resource.

Not included: session establishment (`login`/`logout`; an SDK caller
supplies `apiKey` directly, and `ClawdeClient` registers its own session),
the CLI's workspace budget (`ClawdeClient.checkBudget()`), and commands
that act on the machine they run on: `init`, `setup`, `doctor`,
`install-daemon`, `connect`, `disconnect`, `exec`, `start`, `syncContext`,
`rollback`, `enforce`, `rules`, `judge`, `skill` (its loop commands are
here), `sops status`, `guardrails pull`, and `policy
compile|install|snapshot|list-local`.

Works unmodified against any control plane it is pointed at. An open-core
user who runs the proxy standalone with no control plane configured simply
never constructs this class: with no address (no `baseUrl`, no
`INTUTIC_CONTROL_PLANE_URL`, and no default before the hosted control plane
is released) the constructor throws — the same framing `whoami.ts` already
uses: "This command needs an Intutic control plane, which open core does
not include."

Auth: the same `apiKey` type `ClawdeClient` accepts — a `vk_` token or a
JWT both satisfy `services/control-plane/src/middleware/auth.ts`, which
resolves either to an `AuthContext` with a role. A call the role may not
make throws `ClawdeConnectionError` with the control plane's answer; for a
403 that names the roles allowed (`detail`), the message is that sentence,
as the CLI prints it.

## Constructors

### Constructor

```ts
new ControlPlaneClient(options): ControlPlaneClient;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`ControlPlaneClientOptions`](../index.md#controlplaneclientoptions) |

#### Returns

`ControlPlaneClient`

## Methods

### addPolicySource()

```ts
addPolicySource(source): Promise<PolicySource>;
```

POST /api/v1/connectors

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | [`PolicySourceInput`](../index.md#policysourceinput) |

#### Returns

`Promise`\<[`PolicySource`](../index.md#policysource)\>

***

### adjudicateFinding()

```ts
adjudicateFinding(
   findingId, 
   outcome, 
   options?
): Promise<FindingAdjudication>;
```

POST /api/v1/findings/:findingId/adjudicate — the ruling is recorded under the key's member.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `findingId` | `string` |
| `outcome` | [`FindingOutcome`](../index.md#findingoutcome) |
| `options` | [`AdjudicateOptions`](../index.md#adjudicateoptions) |

#### Returns

`Promise`\<[`FindingAdjudication`](../index.md#findingadjudication)\>

***

### approveDecision()

```ts
approveDecision(holdId, options?): Promise<DecisionReviewResult>;
```

POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) — approve a held call.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `holdId` | `string` |
| `options` | [`ReviewOptions`](../index.md#reviewoptions) |

#### Returns

`Promise`\<[`DecisionReviewResult`](../index.md#decisionreviewresult)\>

***

### approveGuardrailShadow()

```ts
approveGuardrailShadow(guardrailId): Promise<GuardrailTransitionResult>;
```

POST …/guardrails/:guardrailId/approve-shadow — into SHADOW: distributed as warn, measuring, enforcing nothing.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailTransitionResult`](../index.md#guardrailtransitionresult)\>

***

### approveLoopRun()

```ts
approveLoopRun(loopRunId, options?): Promise<LoopRunActionResult>;
```

POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) — approve a run held for review; it is ACTIVE again.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `loopRunId` | `string` |
| `options` | [`LoopRunReviewOptions`](../index.md#looprunreviewoptions) |

#### Returns

`Promise`\<[`LoopRunActionResult`](../index.md#looprunactionresult)\>

***

### approveMcpServer()

```ts
approveMcpServer(serverId): Promise<McpServerDecision>;
```

POST /api/v1/mcp/servers/:serverId/status — approve a server (OWNER, ADMIN).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverId` | `string` |

#### Returns

`Promise`\<[`McpServerDecision`](../index.md#mcpserverdecision)\>

***

### assignOrgGateway()

```ts
assignOrgGateway(orgId, gatewayId): Promise<{
  gatewayId: string | null;
}>;
```

PATCH /api/v1/orgs/:orgId/gateway — pass null to clear the org default.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `orgId` | `string` |
| `gatewayId` | `string` \| `null` |

#### Returns

`Promise`\<\{
  `gatewayId`: `string` \| `null`;
\}\>

***

### assignWorkspaceGateway()

```ts
assignWorkspaceGateway(gatewayId): Promise<{
  gatewayId: string | null;
}>;
```

PATCH /api/v1/workspace/gateway — pass null to clear the override.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` \| `null` |

#### Returns

`Promise`\<\{
  `gatewayId`: `string` \| `null`;
\}\>

***

### attenuateKey()

```ts
attenuateKey(
   parentKeyId, 
   requestedCaps, 
   options?
): Promise<AttenuationResult>;
```

POST /api/v1/attenuate — a child of one of your keys with narrower
scopes: each of `requestedCaps` is an API key scope (`gateway:use`,
`traces:read`, …) the parent grants. The child key is in the response
once and never stored.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `parentKeyId` | `string` |
| `requestedCaps` | `string`[] |
| `options` | [`AttenuateOptions`](../index.md#attenuateoptions) |

#### Returns

`Promise`\<[`AttenuationResult`](../index.md#attenuationresult)\>

***

### blockMcpServer()

```ts
blockMcpServer(serverId): Promise<McpServerDecision>;
```

POST /api/v1/mcp/servers/:serverId/status — block a server (OWNER, ADMIN).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverId` | `string` |

#### Returns

`Promise`\<[`McpServerDecision`](../index.md#mcpserverdecision)\>

***

### checkDomainVerification()

```ts
checkDomainVerification(verificationId): Promise<CheckDomainVerificationResult>;
```

GET /api/v1/domain-verification/:id — re-checks DNS for the TXT record.
Safe to call repeatedly; performs a fresh lookup every call.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `verificationId` | `string` |

#### Returns

`Promise`\<[`CheckDomainVerificationResult`](../index.md#checkdomainverificationresult)\>

***

### collectEvidence()

```ts
collectEvidence(options?): Promise<EvidenceCollectResult>;
```

POST /api/v1/compliance/soc2-collect (OWNER, ADMIN) — run a fresh evidence collection and seal it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`EvidenceCollectOptions`](../index.md#evidencecollectoptions) |

#### Returns

`Promise`\<[`EvidenceCollectResult`](../index.md#evidencecollectresult)\>

***

### completeLoopRun()

```ts
completeLoopRun(loopRunId, options?): Promise<LoopRunActionResult>;
```

POST /api/v1/loops/:loopRunId/complete — `outcome` records how the run ended.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `loopRunId` | `string` |
| `options` | [`CompleteLoopRunOptions`](../index.md#completelooprunoptions) |

#### Returns

`Promise`\<[`LoopRunActionResult`](../index.md#looprunactionresult)\>

***

### createApiKey()

```ts
createApiKey(label, options?): Promise<ApiKeyCreateResult>;
```

POST /api/v1/keys — a key for you, with `scopes` (`['*']` when omitted).
The plaintext `key` is in the response once and never stored. Called with
a key, each scope must be granted by that key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `label` | `string` |
| `options` | [`CreateApiKeyOptions`](../index.md#createapikeyoptions) |

#### Returns

`Promise`\<[`ApiKeyCreateResult`](../index.md#apikeycreateresult)\>

***

### createGuardrail()

```ts
createGuardrail(guardrail): Promise<AuthoredGuardrailWriteResult>;
```

POST /api/v1/policy-guardrails/guardrails (OWNER, ADMIN) — an authored
guardrail, created PROPOSED. An IR a check refuses is a 400 naming the
check.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrail` | [`AuthoredGuardrailInput`](../index.md#authoredguardrailinput) |

#### Returns

`Promise`\<[`AuthoredGuardrailWriteResult`](../index.md#authoredguardrailwriteresult)\>

***

### createNotificationRule()

```ts
createNotificationRule(rule): Promise<NotificationRule>;
```

POST /api/v1/notifications/rules. A webhook rule comes back with its
`signingSecret`, which is not shown again.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rule` | [`NotificationRuleInput`](../index.md#notificationruleinput) |

#### Returns

`Promise`\<[`NotificationRule`](../index.md#notificationrule)\>

***

### createOrg()

```ts
createOrg(params): Promise<CreateOrgResult>;
```

POST /api/v1/orgs — creates a real org from an already-authenticated
caller. Requires a `verified`, unconsumed domain verification (see
`startDomainVerification`); the verification is consumed atomically
inside the org-insert transaction, so it backs exactly this one org.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`CreateOrgParams`](../index.md#createorgparams) |

#### Returns

`Promise`\<[`CreateOrgResult`](../index.md#createorgresult)\>

***

### createOrgSop()

```ts
createOrgSop(sop): Promise<OrgSop>;
```

POST /api/v1/workspace/org-sops — a mandatory org-wide floor (OWNER, ADMIN of a workspace in the org).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `sop` | [`OrgSopInput`](../index.md#orgsopinput) |

#### Returns

`Promise`\<[`OrgSop`](../index.md#orgsop)\>

***

### createSiemDestination()

```ts
createSiemDestination(destination): Promise<SiemDestination>;
```

POST /api/v1/siem/destinations (OWNER, ADMIN). The control plane refuses
a destination that points at an internal address. A webhook destination
comes back with its `signingSecret`, which is not shown again.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `destination` | [`SiemDestinationInput`](../index.md#siemdestinationinput) |

#### Returns

`Promise`\<[`SiemDestination`](../index.md#siemdestination)\>

***

### createSop()

```ts
createSop(sop): Promise<SopCreateResult>;
```

POST /api/v1/sops — one workspace SOP; `markdown_content` without front matter.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `sop` | [`SopInput`](../index.md#sopinput) |

#### Returns

`Promise`\<[`SopCreateResult`](../index.md#sopcreateresult)\>

***

### createTaskConnection()

```ts
createTaskConnection(connection): Promise<TaskConnection>;
```

POST /api/v1/task-management/connections (OWNER, ADMIN). The control
plane tests the credentials with the provider and saves the connection
only if they are accepted (a 400 "Connection test failed" otherwise). A
Jira connection needs `metadata.accountEmail`. There is no update: to
change a connection, delete it and create it again.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `connection` | [`TaskConnectionInput`](../index.md#taskconnectioninput) |

#### Returns

`Promise`\<[`TaskConnection`](../index.md#taskconnection)\>

***

### createTeam()

```ts
createTeam(orgId, name): Promise<Pick<Team, "name" | "orgId" | "teamId">>;
```

POST /api/v1/orgs/:orgId/teams

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `orgId` | `string` |
| `name` | `string` |

#### Returns

`Promise`\<`Pick`\<[`Team`](../index.md#team), `"name"` \| `"orgId"` \| `"teamId"`\>\>

***

### createWorkspace()

```ts
createWorkspace(teamId, name): Promise<Pick<Workspace, "name" | "workspaceId"> & object>;
```

POST /api/v1/teams/:teamId/workspaces

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `teamId` | `string` |
| `name` | `string` |

#### Returns

`Promise`\<`Pick`\<[`Workspace`](../index.md#workspace), `"name"` \| `"workspaceId"`\> & `object`\>

***

### deleteGuardrail()

```ts
deleteGuardrail(guardrailId): Promise<GuardrailDeleteResult>;
```

DELETE /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER, ADMIN) — retires it; its history is kept.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailDeleteResult`](../index.md#guardraildeleteresult)\>

***

### deleteNotificationRule()

```ts
deleteNotificationRule(ruleId): Promise<void>;
```

DELETE /api/v1/notifications/rules/:ruleId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ruleId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### deleteOrgSop()

```ts
deleteOrgSop(orgSopId): Promise<void>;
```

DELETE /api/v1/workspace/org-sops/:orgSopId — answers 404 both for no such SOP and for a member without admin access.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `orgSopId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### deleteSiemDestination()

```ts
deleteSiemDestination(destinationId): Promise<void>;
```

DELETE /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) — deactivates it; `updateSiemDestination(id, { isActive: true })` turns it back on.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `destinationId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### deleteTaskConnection()

```ts
deleteTaskConnection(connectionId): Promise<TaskConnectionDeleteResult>;
```

DELETE /api/v1/task-management/connections/:connectionId (OWNER, ADMIN) — `deleted: false` when it was already gone.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `connectionId` | `string` |

#### Returns

`Promise`\<[`TaskConnectionDeleteResult`](../index.md#taskconnectiondeleteresult)\>

***

### disableMcpTool()

```ts
disableMcpTool(serverId, tool): Promise<McpServerDecision>;
```

POST /api/v1/mcp/servers/:serverId/tools — switch one tool off (OWNER, ADMIN).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverId` | `string` |
| `tool` | `string` |

#### Returns

`Promise`\<[`McpServerDecision`](../index.md#mcpserverdecision)\>

***

### downloadEvidence()

```ts
downloadEvidence(runId): Promise<Uint8Array<ArrayBufferLike>>;
```

GET /api/v1/compliance/soc2-export/:runId (OWNER, ADMIN) — a stored archive, as the file. Check it with `verifyEvidenceArchive`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `runId` | `string` |

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### downloadFrameworkCoverage()

```ts
downloadFrameworkCoverage(frameworkId, format): Promise<Uint8Array<ArrayBufferLike>>;
```

GET /api/v1/compliance/frameworks/:frameworkId/coverage?format= — the
report as a file. Unsigned: the signed copies are the ones sealed in the
evidence archive.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `frameworkId` | `string` |
| `format` | [`CoverageFormat`](../index.md#coverageformat) |

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### downloadInventoryHarnessesCsv()

```ts
downloadInventoryHarnessesCsv(filters?): Promise<Uint8Array<ArrayBufferLike>>;
```

GET /api/v1/inventory/harnesses?format=csv — the CSV the dashboard downloads.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`InventoryFilters`](../index.md#inventoryfilters) |

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### downloadInventoryMcpServersCsv()

```ts
downloadInventoryMcpServersCsv(filters?): Promise<Uint8Array<ArrayBufferLike>>;
```

GET /api/v1/inventory/mcp-servers?format=csv

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`InventoryFilters`](../index.md#inventoryfilters) |

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### enableMcpTool()

```ts
enableMcpTool(serverId, tool): Promise<McpServerDecision>;
```

POST /api/v1/mcp/servers/:serverId/tools — switch one tool on (OWNER, ADMIN).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverId` | `string` |
| `tool` | `string` |

#### Returns

`Promise`\<[`McpServerDecision`](../index.md#mcpserverdecision)\>

***

### extractPolicyDocument()

```ts
extractPolicyDocument(docId, options?): Promise<ExtractDocumentResult>;
```

POST /api/v1/policy-guardrails/documents/:docId/extract — propose guardrails from the document's clauses.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `docId` | `string` |
| `options` | [`ExtractOptions`](../index.md#extractoptions) |

#### Returns

`Promise`\<[`ExtractDocumentResult`](../index.md#extractdocumentresult)\>

***

### getAttenuationChain()

```ts
getAttenuationChain(chainId): Promise<AttenuationChainLink[]>;
```

GET /api/v1/attenuate/chain/:chainId (OWNER, ADMIN) — the delegation lineage.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `chainId` | `string` |

#### Returns

`Promise`\<[`AttenuationChainLink`](../index.md#attenuationchainlink)[]\>

***

### getBranchUsage()

```ts
getBranchUsage(options?): Promise<BranchUsageResponse>;
```

GET /api/v1/usage/branches

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UsageOptions`](../index.md#usageoptions) |

#### Returns

`Promise`\<[`BranchUsageResponse`](../index.md#branchusageresponse)\>

***

### getCommitUsage()

```ts
getCommitUsage(options?): Promise<CommitUsageResponse>;
```

GET /api/v1/usage/commits

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UsageOptions`](../index.md#usageoptions) |

#### Returns

`Promise`\<[`CommitUsageResponse`](../index.md#commitusageresponse)\>

***

### getFindingStats()

```ts
getFindingStats(): Promise<FindingStats>;
```

GET /api/v1/findings/stats — false-positive rate per detector, over adjudicated findings.

#### Returns

`Promise`\<[`FindingStats`](../index.md#findingstats)\>

***

### getFrameworkCoverage()

```ts
getFrameworkCoverage(frameworkId): Promise<FrameworkCoverage>;
```

GET /api/v1/compliance/frameworks/:frameworkId/coverage — `eu_ai_act`, `iso_42001`, `nist_ai_rmf` or `mitre_atlas`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `frameworkId` | `string` |

#### Returns

`Promise`\<[`FrameworkCoverage`](../index.md#frameworkcoverage)\>

***

### getGateLiveness()

```ts
getGateLiveness(): Promise<GateLiveness>;
```

GET /api/v1/governance/gate-liveness (OWNER, ADMIN, EM) — whether each installed harness's gate is reporting.

#### Returns

`Promise`\<[`GateLiveness`](../index.md#gateliveness)\>

***

### getGatewayConfig()

```ts
getGatewayConfig(gatewayId): Promise<GatewayConfigResult>;
```

GET /api/v1/gateways/:id/config — the flags set on the gateway and their version, as the gateway pulls them.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` |

#### Returns

`Promise`\<[`GatewayConfigResult`](../index.md#gatewayconfigresult)\>

***

### getGatewayStatus()

```ts
getGatewayStatus(gatewayId): Promise<GatewayStatus>;
```

GET /api/v1/gateways/:id/status

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` |

#### Returns

`Promise`\<[`GatewayStatus`](../index.md#gatewaystatus)\>

***

### getGithubWebhook()

```ts
getGithubWebhook(): Promise<GitHubWebhookInfo>;
```

GET /api/v1/integrations/github/webhook (OWNER, ADMIN) — the payload URL; never the secret.

#### Returns

`Promise`\<[`GitHubWebhookInfo`](../index.md#githubwebhookinfo)\>

***

### getGuardrail()

```ts
getGuardrail(guardrailId): Promise<GuardrailDetail>;
```

GET /api/v1/policy-guardrails/guardrails/:guardrailId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailDetail`](../index.md#guardraildetail)\>

***

### getGuardrailCoverage()

```ts
getGuardrailCoverage(token): Promise<TokenCoverage>;
```

GET /api/v1/policy-guardrails/coverage?token= — the passages that mention a tool or action, and the guardrails on them.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `token` | `string` |

#### Returns

`Promise`\<[`TokenCoverage`](../index.md#tokencoverage)\>

***

### getGuardrailImpact()

```ts
getGuardrailImpact(seed): Promise<LedgerImpact>;
```

GET /api/v1/policy-guardrails/impact — what a change to a document or a passage reaches. Name one of them.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `seed` | [`GuardrailImpactSeed`](../index.md#guardrailimpactseed) |

#### Returns

`Promise`\<[`LedgerImpact`](../index.md#ledgerimpact)\>

***

### getGuardrailReadiness()

```ts
getGuardrailReadiness(guardrailId): Promise<GuardrailReadiness>;
```

GET /api/v1/policy-guardrails/guardrails/:guardrailId/readiness — whether a SHADOW guardrail's evidence clears promotion.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailReadiness`](../index.md#guardrailreadiness)\>

***

### getIncident()

```ts
getIncident(incidentId): Promise<Incident>;
```

GET /api/v1/incidents/:incidentId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `incidentId` | `string` |

#### Returns

`Promise`\<[`Incident`](../index.md#incident)\>

***

### getIntegrityChain()

```ts
getIntegrityChain(): Promise<IntegrityChain>;
```

GET /api/v1/integrity/chain — the root chain walk; `intact: false` lists the breaks.

#### Returns

`Promise`\<[`IntegrityChain`](../index.md#integritychain)\>

***

### getIntegrityConfigChain()

```ts
getIntegrityConfigChain(): Promise<ConfigChain>;
```

GET /api/v1/integrity/config-chain — the harness config snapshot chain walk.

#### Returns

`Promise`\<[`ConfigChain`](../index.md#configchain)\>

***

### getIntegrityRoot()

```ts
getIntegrityRoot(rootId): Promise<IntegrityRootDetail>;
```

GET /api/v1/integrity/roots/:rootId — the root, its signature and its leaves.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rootId` | `string` |

#### Returns

`Promise`\<[`IntegrityRootDetail`](../index.md#integrityrootdetail)\>

***

### getInventorySummary()

```ts
getInventorySummary(): Promise<InventorySummary>;
```

GET /api/v1/inventory/summary

#### Returns

`Promise`\<[`InventorySummary`](../index.md#inventorysummary)\>

***

### getLoopRun()

```ts
getLoopRun(loopRunId): Promise<LoopRun>;
```

GET /api/v1/loops/:loopRunId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `loopRunId` | `string` |

#### Returns

`Promise`\<[`LoopRun`](../index.md#looprun)\>

***

### getMemberUsage()

```ts
getMemberUsage(options?): Promise<MemberUsageResponse>;
```

GET /api/v1/usage/members

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UsageOptions`](../index.md#usageoptions) |

#### Returns

`Promise`\<[`MemberUsageResponse`](../index.md#memberusageresponse)\>

***

### getMirrorAdoptionReport()

```ts
getMirrorAdoptionReport(candidateModel): Promise<MirrorAdoptionReport>;
```

GET /api/v1/routing/mirror-adoption-report — how a mirror-tested candidate model compared. Reported only; changes nothing.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidateModel` | `string` |

#### Returns

`Promise`\<[`MirrorAdoptionReport`](../index.md#mirroradoptionreport)\>

***

### getOptimizerSettings()

```ts
getOptimizerSettings(): Promise<OptimizerSettings>;
```

GET /api/v1/dream-cycle/settings — the SOP Optimizer's approval mode and auto-apply threshold.

#### Returns

`Promise`\<[`OptimizerSettings`](../index.md#optimizersettings)\>

***

### getPolicyDocument()

```ts
getPolicyDocument(docId): Promise<PolicyDocumentDetail>;
```

GET /api/v1/policy-guardrails/documents/:docId — passages, clauses and extraction runs.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `docId` | `string` |

#### Returns

`Promise`\<[`PolicyDocumentDetail`](../index.md#policydocumentdetail)\>

***

### getPullRequestUsage()

```ts
getPullRequestUsage(options?): Promise<PullRequestUsageResponse>;
```

GET /api/v1/usage/pull-requests

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UsageOptions`](../index.md#usageoptions) |

#### Returns

`Promise`\<[`PullRequestUsageResponse`](../index.md#pullrequestusageresponse)\>

***

### getResponseEchoReport()

```ts
getResponseEchoReport(options?): Promise<ResponseEchoReport>;
```

GET /api/v1/findings/response-echo/report

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`ResponseEchoReportOptions`](../index.md#responseechoreportoptions) |

#### Returns

`Promise`\<[`ResponseEchoReport`](../index.md#responseechoreport)\>

***

### getRuleCandidateSource()

```ts
getRuleCandidateSource(candidateId): Promise<RuleCandidateSource>;
```

GET /api/v1/rule-candidates/:candidateId/source — the source of record a
candidate's bundle must be compiled from. A source that does not hash to
the `sourceSha256` served with it is refused (`ClawdeConnectionError`):
something between the control plane and this process changed it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidateId` | `string` |

#### Returns

`Promise`\<[`RuleCandidateSource`](../index.md#rulecandidatesource)\>

***

### getSiemDestination()

```ts
getSiemDestination(destinationId): Promise<SiemDestination>;
```

GET /api/v1/siem/destinations/:destinationId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `destinationId` | `string` |

#### Returns

`Promise`\<[`SiemDestination`](../index.md#siemdestination)\>

***

### getSigningKeys()

```ts
getSigningKeys(): Promise<SigningJwks>;
```

GET /.well-known/intutic-trace-signing.json — the published signing keys,
fetched without credentials. `verifyEvidenceArchive` takes them.

#### Returns

`Promise`\<[`SigningJwks`](../index.md#signingjwks)\>

***

### getSop()

```ts
getSop(sopId): Promise<SopDetail>;
```

GET /api/v1/sops/:sopId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `sopId` | `string` |

#### Returns

`Promise`\<[`SopDetail`](../index.md#sopdetail)\>

***

### getTeamUsage()

```ts
getTeamUsage(options?): Promise<TeamUsageResponse>;
```

GET /api/v1/usage/teams — per SCIM group.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`UsageOptions`](../index.md#usageoptions) |

#### Returns

`Promise`\<[`TeamUsageResponse`](../index.md#teamusageresponse)\>

***

### getTrace()

```ts
getTrace(traceId): Promise<TraceDetail>;
```

GET /api/v1/traces/:traceId

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `traceId` | `string` |

#### Returns

`Promise`\<[`TraceDetail`](../index.md#tracedetail)\>

***

### getWorkspaceSettings()

```ts
getWorkspaceSettings(): Promise<WorkspaceSettings>;
```

GET /api/v1/workspace/settings — every setting, resolved with its default.

#### Returns

`Promise`\<[`WorkspaceSettings`](../index.md#workspacesettings)\>

***

### killLoopRun()

```ts
killLoopRun(loopRunId): Promise<LoopRunActionResult>;
```

POST /api/v1/loops/:loopRunId/kill

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `loopRunId` | `string` |

#### Returns

`Promise`\<[`LoopRunActionResult`](../index.md#looprunactionresult)\>

***

### listApiKeys()

```ts
listApiKeys(): Promise<ApiKey[]>;
```

GET /api/v1/keys — your own keys in the workspace, revoked ones included.

#### Returns

`Promise`\<[`ApiKey`](../index.md#apikey)[]\>

***

### listFindings()

```ts
listFindings(filters?): Promise<Finding[]>;
```

GET /api/v1/findings — detector findings, newest first.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`FindingFilters`](../index.md#findingfilters) |

#### Returns

`Promise`\<[`Finding`](../index.md#finding)[]\>

***

### listGateways()

```ts
listGateways(): Promise<Gateway[]>;
```

GET /api/v1/gateways

#### Returns

`Promise`\<[`Gateway`](../index.md#gateway)[]\>

***

### listGuardrailConflicts()

```ts
listGuardrailConflicts(): Promise<GuardrailConflict[]>;
```

GET /api/v1/policy-guardrails/conflicts — live guardrails and front-matter rules that contradict each other.

#### Returns

`Promise`\<[`GuardrailConflict`](../index.md#guardrailconflict)[]\>

***

### listGuardrailDuplicates()

```ts
listGuardrailDuplicates(options?): Promise<LedgerDuplicates>;
```

GET /api/v1/policy-guardrails/duplicates — overlapping passages and rules cited more than once.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`DuplicatesOptions`](../index.md#duplicatesoptions) |

#### Returns

`Promise`\<[`LedgerDuplicates`](../index.md#ledgerduplicates)\>

***

### listGuardrails()

```ts
listGuardrails(filters?): Promise<GuardrailSummary[]>;
```

GET /api/v1/policy-guardrails/guardrails

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`GuardrailFilters`](../index.md#guardrailfilters) |

#### Returns

`Promise`\<[`GuardrailSummary`](../index.md#guardrailsummary)[]\>

***

### listIncidents()

```ts
listIncidents(filters?): Promise<IncidentList>;
```

GET /api/v1/incidents — ranked by review priority; filter by status, severity and type.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`IncidentFilters`](../index.md#incidentfilters) |

#### Returns

`Promise`\<[`IncidentList`](../index.md#incidentlist)\>

***

### listIntegrityRoots()

```ts
listIntegrityRoots(options?): Promise<IntegrityRootList>;
```

GET /api/v1/integrity/roots — the sealed trace roots.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `loopRunId?`: `string`; \} |
| `options.loopRunId?` | `string` |

#### Returns

`Promise`\<[`IntegrityRootList`](../index.md#integrityrootlist)\>

***

### listInventoryDevices()

```ts
listInventoryDevices(): Promise<InventoryDevice[]>;
```

GET /api/v1/inventory/devices — one row per machine.

#### Returns

`Promise`\<[`InventoryDevice`](../index.md#inventorydevice)[]\>

***

### listInventoryDisconnects()

```ts
listInventoryDisconnects(options?): Promise<DeviceDisconnect[]>;
```

GET /api/v1/inventory/disconnects — machines that ran `intutic disconnect`, newest first (default 100, at most 500).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `limit?`: `number`; \} |
| `options.limit?` | `number` |

#### Returns

`Promise`\<[`DeviceDisconnect`](../index.md#devicedisconnect)[]\>

***

### listInventoryHarnesses()

```ts
listInventoryHarnesses(filters?): Promise<InventoryHarness[]>;
```

GET /api/v1/inventory/harnesses

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`InventoryFilters`](../index.md#inventoryfilters) |

#### Returns

`Promise`\<[`InventoryHarness`](../index.md#inventoryharness)[]\>

***

### listInventoryMcpServers()

```ts
listInventoryMcpServers(filters?): Promise<InventoryMcpServer[]>;
```

GET /api/v1/inventory/mcp-servers

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`InventoryFilters`](../index.md#inventoryfilters) |

#### Returns

`Promise`\<[`InventoryMcpServer`](../index.md#inventorymcpserver)[]\>

***

### listInventorySkills()

```ts
listInventorySkills(filters?): Promise<InventorySkill[]>;
```

GET /api/v1/inventory/skills

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`InventorySkillFilters`](../index.md#inventoryskillfilters) |

#### Returns

`Promise`\<[`InventorySkill`](../index.md#inventoryskill)[]\>

***

### listLoopRuns()

```ts
listLoopRuns(): Promise<LoopRun[]>;
```

GET /api/v1/loops

#### Returns

`Promise`\<[`LoopRun`](../index.md#looprun)[]\>

***

### listMcpServers()

```ts
listMcpServers(): Promise<McpServerList>;
```

GET /api/v1/mcp/servers — every server the workspace's MCP proxies have reported, and the registry-wide policy.

#### Returns

`Promise`\<[`McpServerList`](../index.md#mcpserverlist)\>

***

### listNotificationRules()

```ts
listNotificationRules(): Promise<NotificationRule[]>;
```

GET /api/v1/notifications/rules

#### Returns

`Promise`\<[`NotificationRule`](../index.md#notificationrule)[]\>

***

### listOrgSops()

```ts
listOrgSops(): Promise<OrgSop[]>;
```

GET /api/v1/workspace/org-sops — the org-wide SOP floors of the key's org.

#### Returns

`Promise`\<[`OrgSop`](../index.md#orgsop)[]\>

***

### listPolicyDocuments()

```ts
listPolicyDocuments(): Promise<PolicyDocumentSummary[]>;
```

GET /api/v1/policy-guardrails/documents

#### Returns

`Promise`\<[`PolicyDocumentSummary`](../index.md#policydocumentsummary)[]\>

***

### listPolicySources()

```ts
listPolicySources(): Promise<PolicySource[]>;
```

GET /api/v1/connectors — the workspace's policy sources (Notion, Confluence, GitHub, Google Drive).

#### Returns

`Promise`\<[`PolicySource`](../index.md#policysource)[]\>

***

### listProviderCredentials()

```ts
listProviderCredentials(): Promise<ProviderCredentialStatus[]>;
```

GET /api/v1/workspace/provider-credentials

#### Returns

`Promise`\<[`ProviderCredentialStatus`](../index.md#providercredentialstatus)[]\>

***

### listProviderModels()

```ts
listProviderModels(provider): Promise<ProviderModelList>;
```

GET /api/v1/workspace/provider-credentials/:provider/models

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `provider` | `string` |

#### Returns

`Promise`\<[`ProviderModelList`](../index.md#providermodellist)\>

***

### listSiemDestinations()

```ts
listSiemDestinations(): Promise<SiemDestinationList>;
```

GET /api/v1/siem/destinations — the destinations and the event sources they can receive.

#### Returns

`Promise`\<[`SiemDestinationList`](../index.md#siemdestinationlist)\>

***

### listSiemSources()

```ts
listSiemSources(): Promise<SiemSources>;
```

The event sources a destination can receive; `defaults` are the ones an empty `sourceTables` means.

#### Returns

`Promise`\<[`SiemSources`](../index.md#siemsources)\>

***

### listSops()

```ts
listSops(options?): Promise<SopSummary[]>;
```

GET /api/v1/sops

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `limit?`: `number`; \} |
| `options.limit?` | `number` |

#### Returns

`Promise`\<[`SopSummary`](../index.md#sopsummary)[]\>

***

### listTaskConnections()

```ts
listTaskConnections(): Promise<TaskConnection[]>;
```

GET /api/v1/task-management/connections — the workspace's Jira, Linear and PagerDuty connections, unwrapped from `items`.

#### Returns

`Promise`\<[`TaskConnection`](../index.md#taskconnection)[]\>

***

### listTeams()

```ts
listTeams(orgId): Promise<Team[]>;
```

GET /api/v1/orgs/:orgId/teams

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `orgId` | `string` |

#### Returns

`Promise`\<[`Team`](../index.md#team)[]\>

***

### listTeamWorkspaces()

```ts
listTeamWorkspaces(teamId): Promise<Workspace[]>;
```

GET /api/v1/teams/:teamId/workspaces

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `teamId` | `string` |

#### Returns

`Promise`\<[`Workspace`](../index.md#workspace)[]\>

***

### listTraces()

```ts
listTraces(filters?): Promise<TraceList>;
```

GET /api/v1/traces — newest first.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `filters` | [`TraceFilters`](../index.md#tracefilters) |

#### Returns

`Promise`\<[`TraceList`](../index.md#tracelist)\>

***

### predictCost()

```ts
predictCost(params): Promise<CostPrediction>;
```

POST /api/v1/predict-cost — estimate a call's cost before it runs. Size the input with a token count or the text.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`PredictCostParams`](../index.md#predictcostparams) |

#### Returns

`Promise`\<[`CostPrediction`](../index.md#costprediction)\>

***

### promoteGuardrail()

```ts
promoteGuardrail(guardrailId, options?): Promise<GuardrailTransitionResult>;
```

POST …/guardrails/:guardrailId/promote — into ENFORCING. Refused with a
409 until the shadow evidence clears the thresholds; a guardrail that
never fired needs `acknowledgeNoTraffic`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |
| `options` | [`PromoteOptions`](../index.md#promoteoptions) |

#### Returns

`Promise`\<[`GuardrailTransitionResult`](../index.md#guardrailtransitionresult)\>

***

### recomputeIntegrityRoot()

```ts
recomputeIntegrityRoot(rootId): Promise<IntegrityRecompute>;
```

POST /api/v1/integrity/roots/:rootId/recompute — re-derive the root from the stored traces.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `rootId` | `string` |

#### Returns

`Promise`\<[`IntegrityRecompute`](../index.md#integrityrecompute)\>

***

### reconfirmGuardrail()

```ts
reconfirmGuardrail(guardrailId): Promise<GuardrailTransitionResult>;
```

POST …/guardrails/:guardrailId/reconfirm — re-confirm a stale citation against a live passage.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailTransitionResult`](../index.md#guardrailtransitionresult)\>

***

### refreshPullRequestUsage()

```ts
refreshPullRequestUsage(): Promise<PullRequestRefreshResult>;
```

POST /api/v1/usage/pull-requests/refresh — look the branches up on GitHub now (OWNER, ADMIN, EM).

#### Returns

`Promise`\<[`PullRequestRefreshResult`](../index.md#pullrequestrefreshresult)\>

***

### registerGateway()

```ts
registerGateway(params): Promise<GatewayRegisterResult>;
```

POST /api/v1/gateways

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`GatewayRegisterParams`](../index.md#gatewayregisterparams) |

#### Returns

`Promise`\<[`GatewayRegisterResult`](../index.md#gatewayregisterresult)\>

***

### rejectDecision()

```ts
rejectDecision(holdId, options?): Promise<DecisionReviewResult>;
```

POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) — reject a held call.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `holdId` | `string` |
| `options` | [`ReviewOptions`](../index.md#reviewoptions) |

#### Returns

`Promise`\<[`DecisionReviewResult`](../index.md#decisionreviewresult)\>

***

### rejectGuardrail()

```ts
rejectGuardrail(guardrailId, reason): Promise<GuardrailTransitionResult>;
```

POST …/guardrails/:guardrailId/reject — recorded with the reason.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |
| `reason` | `string` |

#### Returns

`Promise`\<[`GuardrailTransitionResult`](../index.md#guardrailtransitionresult)\>

***

### rejectLoopRun()

```ts
rejectLoopRun(loopRunId, options?): Promise<LoopRunActionResult>;
```

POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) — reject a run held for review; it is KILLED.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `loopRunId` | `string` |
| `options` | [`LoopRunReviewOptions`](../index.md#looprunreviewoptions) |

#### Returns

`Promise`\<[`LoopRunActionResult`](../index.md#looprunactionresult)\>

***

### replayGuardrail()

```ts
replayGuardrail(guardrailId): Promise<GuardrailReplay>;
```

POST …/guardrails/:guardrailId/replay — what the guardrail would have done on captured traffic.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailReplay`](../index.md#guardrailreplay)\>

***

### replayWasmRule()

```ts
replayWasmRule(ruleId, options?): Promise<WasmReplayResult>;
```

POST /api/v1/wasm-rules/:ruleId/replay — what a rule would have done on sampled traffic, without enforcing.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ruleId` | `string` |
| `options` | [`WasmReplayOptions`](../index.md#wasmreplayoptions) |

#### Returns

`Promise`\<[`WasmReplayResult`](../index.md#wasmreplayresult)\>

***

### resetMcpServer()

```ts
resetMcpServer(serverId): Promise<McpServerDecision>;
```

POST /api/v1/mcp/servers/:serverId/status — return a server to the approval queue (OWNER, ADMIN).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `serverId` | `string` |

#### Returns

`Promise`\<[`McpServerDecision`](../index.md#mcpserverdecision)\>

***

### resolveGateway()

```ts
resolveGateway(): Promise<GatewayResolution>;
```

GET /api/v1/workspace/gateway-resolution

#### Returns

`Promise`\<[`GatewayResolution`](../index.md#gatewayresolution)\>

***

### retireGuardrail()

```ts
retireGuardrail(guardrailId): Promise<GuardrailTransitionResult>;
```

POST …/guardrails/:guardrailId/retire — gone from every rule endpoint on the next poll.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |

#### Returns

`Promise`\<[`GuardrailTransitionResult`](../index.md#guardrailtransitionresult)\>

***

### revokeApiKey()

```ts
revokeApiKey(keyId): Promise<void>;
```

DELETE /api/v1/keys/:keyId — revoke one of your live keys, or as an OWNER or ADMIN any live key in the workspace; a key you may not revoke (none, already revoked, another member's below OWNER/ADMIN) throws `ClawdeConnectionError` with the 404.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `keyId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### revokeGateway()

```ts
revokeGateway(gatewayId, reason?): Promise<void>;
```

DELETE /api/v1/gateways/:id

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` |
| `reason?` | `string` |

#### Returns

`Promise`\<`void`\>

***

### rotateGatewayToken()

```ts
rotateGatewayToken(gatewayId): Promise<GatewayRotateResult>;
```

POST /api/v1/gateways/:id/rotate

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` |

#### Returns

`Promise`\<[`GatewayRotateResult`](../index.md#gatewayrotateresult)\>

***

### rotateGithubWebhookSecret()

```ts
rotateGithubWebhookSecret(): Promise<GitHubWebhookSecret>;
```

POST /api/v1/integrations/github/webhook/secret (OWNER, ADMIN) — make the
webhook, or replace its secret. Deliveries signed with an earlier secret
are refused from then on.

#### Returns

`Promise`\<[`GitHubWebhookSecret`](../index.md#githubwebhooksecret)\>

***

### rotateNotificationRuleSecret()

```ts
rotateNotificationRuleSecret(ruleId): Promise<NotificationSecretRotation>;
```

POST /api/v1/notifications/rules/:ruleId/signing-secret — deliveries are signed with the new secret from now on.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ruleId` | `string` |

#### Returns

`Promise`\<[`NotificationSecretRotation`](../index.md#notificationsecretrotation)\>

***

### rotateSiemDestinationSecret()

```ts
rotateSiemDestinationSecret(destinationId): Promise<SiemSecretRotation>;
```

POST /api/v1/siem/destinations/:destinationId/signing-secret (OWNER, ADMIN)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `destinationId` | `string` |

#### Returns

`Promise`\<[`SiemSecretRotation`](../index.md#siemsecretrotation)\>

***

### searchPolicyPassages()

```ts
searchPolicyPassages(text): Promise<PassageSearchResult>;
```

GET /api/v1/policy-guardrails/search?q= — full-text search over live passages, best match first.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |

#### Returns

`Promise`\<[`PassageSearchResult`](../index.md#passagesearchresult)\>

***

### setGatewayConfig()

```ts
setGatewayConfig(gatewayId, config): Promise<GatewayConfigResult>;
```

PATCH /api/v1/gateways/:id/config

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `gatewayId` | `string` |
| `config` | [`GatewayConfigUpdate`](../index.md#gatewayconfigupdate) |

#### Returns

`Promise`\<[`GatewayConfigResult`](../index.md#gatewayconfigresult)\>

***

### setProviderCredential()

```ts
setProviderCredential(provider, fields): Promise<ProviderCredentialStatus>;
```

PUT /api/v1/workspace/provider-credentials/:provider

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `provider` | `string` |
| `fields` | `Record`\<`string`, `string`\> |

#### Returns

`Promise`\<[`ProviderCredentialStatus`](../index.md#providercredentialstatus)\>

***

### signupOrg()

```ts
signupOrg(params): Promise<OrgSignupResult>;
```

POST /api/v1/auth/signup/org — unauthenticated, creates the calling user.
`acceptTerms: true` is required: the caller is 18 or older and agrees to
the Terms and the Privacy Policy; without it the call fails with 400
`TERMS_NOT_ACCEPTED`.

Closed by default in production (`INTUTIC_PUBLIC_ORG_SIGNUP`, off unless
a deployment has built its own anonymous domain-verification story):
creating a real org auto-provisions a real managed gateway cell (LLD
#71), so org creation now requires DNS domain-ownership proof, and an
anonymous caller has no session to own a verification attempt against.
Prefer `startDomainVerification` + `checkDomainVerification` +
`createOrg` with an already-authenticated `apiKey` — the same flow the
CLI's `intutic org create` and the dashboard's "Create Organization"
modal use.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`OrgSignupParams`](../index.md#orgsignupparams) |

#### Returns

`Promise`\<[`OrgSignupResult`](../index.md#orgsignupresult)\>

***

### startDomainVerification()

```ts
startDomainVerification(domain): Promise<StartDomainVerificationResult>;
```

POST /api/v1/domain-verification/start — mints a DNS TXT-record
verification token for `domain`. Publish a TXT record at
`txtRecordName` with value `txtRecordValue`, then poll
`checkDomainVerification` until `status` is `'verified'`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `domain` | `string` |

#### Returns

`Promise`\<[`StartDomainVerificationResult`](../index.md#startdomainverificationresult)\>

***

### startLoopRun()

```ts
startLoopRun(name, options?): Promise<LoopRun>;
```

POST /api/v1/loops/start — register a loop run. Send its id with the run's
requests (`INTUTIC_LOOP_RUN_ID`, as `intutic loop exec` sets it) so the
proxy files them under it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `options` | [`StartLoopRunOptions`](../index.md#startlooprunoptions) |

#### Returns

`Promise`\<[`LoopRun`](../index.md#looprun)\>

***

### syncPolicySource()

```ts
syncPolicySource(connectorId): Promise<PolicySourceSyncResult>;
```

POST /api/v1/connectors/:connectorId/sync

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `connectorId` | `string` |

#### Returns

`Promise`\<[`PolicySourceSyncResult`](../index.md#policysourcesyncresult)\>

***

### testTaskConnection()

```ts
testTaskConnection(connectionId): Promise<TaskConnectionTestResult>;
```

POST /api/v1/task-management/connections/:connectionId/test (OWNER, ADMIN) — whether the provider still accepts the stored credentials.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `connectionId` | `string` |

#### Returns

`Promise`\<[`TaskConnectionTestResult`](../index.md#taskconnectiontestresult)\>

***

### unsetProviderCredential()

```ts
unsetProviderCredential(provider): Promise<void>;
```

DELETE /api/v1/workspace/provider-credentials/:provider

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `provider` | `string` |

#### Returns

`Promise`\<`void`\>

***

### updateApiKey()

```ts
updateApiKey(keyId, changes): Promise<ApiKey>;
```

PATCH /api/v1/keys/:keyId (OWNER, ADMIN) — replace a key's scopes, spend
budgets and/or rate limit; a field left out is unchanged. New scopes apply
from the key's next request.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `keyId` | `string` |
| `changes` | [`ApiKeyUpdate`](../index.md#apikeyupdate) |

#### Returns

`Promise`\<[`ApiKey`](../index.md#apikey)\>

***

### updateGuardrail()

```ts
updateGuardrail(guardrailId, changes): Promise<AuthoredGuardrailWriteResult>;
```

PUT /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER, ADMIN). A
changed IR creates the next version (`forked`), PROPOSED with no
evidence; a name or description edit keeps the evidence.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `guardrailId` | `string` |
| `changes` | [`AuthoredGuardrailUpdate`](../index.md#authoredguardrailupdate) |

#### Returns

`Promise`\<[`AuthoredGuardrailWriteResult`](../index.md#authoredguardrailwriteresult)\>

***

### updateNotificationRule()

```ts
updateNotificationRule(ruleId, changes): Promise<NotificationRule>;
```

PUT /api/v1/notifications/rules/:ruleId — only the fields given change.
A switch to the webhook channel comes back with the new `signingSecret`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ruleId` | `string` |
| `changes` | [`NotificationRuleUpdate`](../index.md#notificationruleupdate) |

#### Returns

`Promise`\<[`NotificationRule`](../index.md#notificationrule)\>

***

### updateOptimizerSettings()

```ts
updateOptimizerSettings(settings): Promise<OptimizerSettings>;
```

PUT /api/v1/dream-cycle/settings (OWNER, ADMIN) — set the approval mode.
`auto` lets a manually triggered optimizer run apply a STRENGTHEN
proposal whose score reaches `autoThreshold` without review; `manual`
applies nothing. The route sets an omitted `autoThreshold` to 0.85, so
pass the current one (`getOptimizerSettings`) to keep it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `settings` | [`OptimizerSettingsUpdate`](../index.md#optimizersettingsupdate) |

#### Returns

`Promise`\<[`OptimizerSettings`](../index.md#optimizersettings)\>

***

### updateSiemDestination()

```ts
updateSiemDestination(destinationId, changes): Promise<SiemDestination>;
```

PUT /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) — only the fields given change.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `destinationId` | `string` |
| `changes` | [`SiemDestinationUpdate`](../index.md#siemdestinationupdate) |

#### Returns

`Promise`\<[`SiemDestination`](../index.md#siemdestination)\>

***

### updateWorkspaceSettings()

```ts
updateWorkspaceSettings(settings): Promise<WorkspaceSettingsUpdateResult>;
```

PUT /api/v1/workspace/settings — the route `intutic settings set` calls.

Only the keys given change; the rest are kept (`featureFlags` merges one
level deeper, so one flag does not switch the others off). The control
plane is the authority on which keys exist and what each accepts: an
unknown key or a bad value is refused with a 400 naming it, a setting the
workspace's plan does not include with a
403 "Upgrade required", and a member below OWNER or ADMIN with a 403. Each
refusal throws `ClawdeConnectionError` carrying the server's answer.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `settings` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<[`WorkspaceSettingsUpdateResult`](../index.md#workspacesettingsupdateresult)\>

***

### uploadRuleCandidateBundle()

```ts
uploadRuleCandidateBundle(
   candidateId, 
   wasm, 
   sourceSha256, 
   options?
): Promise<BundleUploadResult>;
```

POST /api/v1/rule-candidates/:candidateId/bundle (OWNER, ADMIN) — upload
a compiled rule with the hash of the source it was compiled from. The
control plane runs its gates; `accepted` says whether the rule went into
shadow, and `gates` why.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `candidateId` | `string` |
| `wasm` | `Uint8Array` |
| `sourceSha256` | `string` |
| `options` | [`BundleUploadOptions`](../index.md#bundleuploadoptions) |

#### Returns

`Promise`\<[`BundleUploadResult`](../index.md#bundleuploadresult)\>

***

### whoami()

```ts
whoami(): Promise<WhoamiResult>;
```

GET /api/v1/auth/me

#### Returns

`Promise`\<[`WhoamiResult`](../index.md#whoamiresult)\>
