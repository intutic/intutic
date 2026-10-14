# @intutic/clawde

## Classes

- [ClawdeBlockedError](classes/ClawdeBlockedError.md)
- [ClawdeClient](classes/ClawdeClient.md)
- [ClawdeConnectionError](classes/ClawdeConnectionError.md)
- [ClawdeError](classes/ClawdeError.md)
- [ClawdeVerdictError](classes/ClawdeVerdictError.md)
- [ControlPlaneClient](classes/ControlPlaneClient.md)

## Interfaces

### AdjudicateOptions

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-note"></a> `note?` | `string` |

***

### AttenuateOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-ttlseconds"></a> `ttlSeconds?` | `number` | 60 to 86400 seconds. |

***

### AttenuationChainLink

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-chainid"></a> `chainId` | `string` |
| <a id="property-childkeyid"></a> `childKeyId` | `string` |
| <a id="property-createdat"></a> `createdAt` | `string` |
| <a id="property-expiresat"></a> `expiresAt` | `string` |
| <a id="property-grantedcaps"></a> `grantedCaps` | `string`[] |
| <a id="property-parentkeyid"></a> `parentKeyId` | `string` |
| <a id="property-workspaceid"></a> `workspaceId` | `string` |

***

### AttenuationResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-attenuationchainid"></a> `attenuationChainId` | `string` | - |
| <a id="property-childkey"></a> `childKey` | `string` | The child `vk_` key: shown once, never stored. |
| <a id="property-childkeyid-1"></a> `childKeyId` | `string` | - |
| <a id="property-expiresat-1"></a> `expiresAt` | `string` | - |
| <a id="property-grantedcaps-1"></a> `grantedCaps` | `string`[] | - |

***

### AuthoredGuardrailInput

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-description"></a> `description?` | `string` \| `null` | - |
| <a id="property-ir"></a> `ir` | `Record`\<`string`, `unknown`\> | - |
| <a id="property-name"></a> `name` | `string` | One line. |

***

### AuthoredGuardrailUpdate

Any of the three. A changed IR creates the next version; `description: null` clears it.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-description-1"></a> `description?` | `string` \| `null` |
| <a id="property-ir-1"></a> `ir?` | `Record`\<`string`, `unknown`\> |
| <a id="property-name-1"></a> `name?` | `string` |

***

### AuthoredGuardrailWriteResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-forked"></a> `forked` | `boolean` | The IR changed: a new version, PROPOSED with no evidence, replaced the old one, which is now RETIRED. |
| <a id="property-guardrail"></a> `guardrail` | [`GuardrailDetail`](#guardraildetail) \| `null` | The guardrail read back after the write; null only if it is gone by then. |
| <a id="property-ok"></a> `ok` | `true` | - |
| <a id="property-supersedes"></a> `supersedes` | `string` \| `null` | - |

***

### BranchUsage

#### Extends

- [`UsageTotals`](#usagetotals)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-branch"></a> `branch` | `string` \| `null` | - | - |
| <a id="property-commitcount"></a> `commitCount` | `number` | - | - |
| <a id="property-lastcallat"></a> `lastCallAt` | `string` | - | - |
| <a id="property-repo"></a> `repo` | `string` \| `null` | Null on the row for calls made with no git context. | - |
| <a id="property-totalcostusd"></a> `totalCostUsd` | `number` | - | [`UsageTotals`](#usagetotals).[`totalCostUsd`](#property-totalcostusd-5) |
| <a id="property-totalinputtokens"></a> `totalInputTokens` | `number` | - | [`UsageTotals`](#usagetotals).[`totalInputTokens`](#property-totalinputtokens-5) |
| <a id="property-totaloutputtokens"></a> `totalOutputTokens` | `number` | - | [`UsageTotals`](#usagetotals).[`totalOutputTokens`](#property-totaloutputtokens-5) |
| <a id="property-totalrawcostusd"></a> `totalRawCostUsd` | `number` | - | [`UsageTotals`](#usagetotals).[`totalRawCostUsd`](#property-totalrawcostusd-5) |
| <a id="property-tracecount"></a> `traceCount` | `number` | - | [`UsageTotals`](#usagetotals).[`traceCount`](#property-tracecount-5) |

***

### BranchUsageResponse

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-branches"></a> `branches` | [`BranchUsage`](#branchusage)[] |
| <a id="property-scope"></a> `scope` | [`UsageScope`](#usagescope) |

***

### BudgetCheckResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-allowed"></a> `allowed` | `boolean` |
| <a id="property-reason"></a> `reason?` | `string` |
| <a id="property-remaining_usd"></a> `remaining_usd` | `number` |

***

### BundleUploadOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-filename"></a> `fileName?` | `string` | The upload's file name. Default `rule.wasm`. |

***

### BundleUploadResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-accepted"></a> `accepted?` | `boolean` |
| <a id="property-gates"></a> `gates?` | `object`[] |
| <a id="property-mode"></a> `mode?` | `string` |
| <a id="property-ruleid"></a> `ruleId?` | `string` |

***

### ChatMessage

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-content"></a> `content` | `string` \| `any`[] |
| <a id="property-name-2"></a> `name?` | `string` |
| <a id="property-role"></a> `role` | `"system"` \| `"user"` \| `"assistant"` \| `"tool"` |
| <a id="property-tool_call_id"></a> `tool_call_id?` | `string` |
| <a id="property-tool_calls"></a> `tool_calls?` | `any`[] |

***

### ChatParams

#### Indexable

```ts
[key: string]: any
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-max_tokens"></a> `max_tokens?` | `number` |
| <a id="property-messages"></a> `messages` | [`ChatMessage`](#chatmessage)[] |
| <a id="property-model"></a> `model` | `string` |
| <a id="property-response_format"></a> `response_format?` | `any` |
| <a id="property-stream"></a> `stream?` | `boolean` |
| <a id="property-temperature"></a> `temperature?` | `number` |
| <a id="property-tool_choice"></a> `tool_choice?` | `any` |
| <a id="property-tools"></a> `tools?` | `any`[] |

***

### ChatResponse

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-budgetpctused"></a> ~~`budgetPctUsed?`~~ | `number` | **Deprecated** Never set: the proxy does not report budget on responses. Use `checkBudget()`. |
| <a id="property-budgetremainingusd"></a> ~~`budgetRemainingUsd?`~~ | `number` | **Deprecated** Never set: the proxy does not report budget on responses. Use `checkBudget()`. |
| <a id="property-choices"></a> `choices` | `object`[] | - |
| <a id="property-created"></a> `created` | `number` | - |
| <a id="property-id"></a> `id` | `string` | - |
| <a id="property-model-1"></a> `model` | `string` | - |
| <a id="property-object"></a> `object` | `string` | - |
| <a id="property-upstream"></a> `upstream?` | [`UpstreamCalls`](#upstreamcalls) | What the proxy's retry layer did, when it did anything: how many upstream calls this answer took, and — when a fallback answered after the model's retries ran out — which model failed (`model` names the one that answered). Absent for the ordinary single-call request. |
| <a id="property-usage"></a> `usage?` | `object` | - |
| `usage.completion_tokens` | `number` | - |
| `usage.prompt_tokens` | `number` | - |
| `usage.total_tokens` | `number` | - |
| <a id="property-verdict"></a> `verdict?` | [`Verdict`](#verdict) \| [`LegacyVerdict`](#legacyverdict) | Always `allow`: a response only comes back when the proxy let the request through. |

***

### CheckDomainVerificationResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-domain"></a> `domain` | `string` |
| <a id="property-status"></a> `status` | `"pending"` \| `"verified"` \| `"consumed"` \| `"expired"` |
| <a id="property-txtrecordname"></a> `txtRecordName` | `string` |
| <a id="property-txtrecordvalue"></a> `txtRecordValue` | `string` |
| <a id="property-verificationid"></a> `verificationId` | `string` |
| <a id="property-verifiedat"></a> `verifiedAt` | `string` \| `null` |

***

### CircuitBreakerOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-failopen"></a> `failOpen?` | `boolean` | - |
| <a id="property-maxcostusd"></a> ~~`maxCostUsd?`~~ | `number` | **Deprecated** Use `requireBudget: true`. Any value turns the workspace budget check on; the amount is not compared with anything, because nothing reports a call's cost before it is made. |
| <a id="property-requirebudget"></a> `requireBudget?` | `boolean` | Run `checkBudget()` first and refuse to run the function when the workspace has no budget left. Default: false. |
| <a id="property-sensitivitytier"></a> ~~`sensitivityTier?`~~ | `"low"` \| `"medium"` \| `"high"` \| `"critical"` | **Deprecated** Ignored: neither the SDK nor the proxy reads a sensitivity tier. |

***

### ClawdeClientOptions

Options for a [ClawdeClient](classes/ClawdeClient.md).

#### Properties

| Property | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-apikey"></a> `apiKey` | `string` | `undefined` | The key the proxy authenticates: an Intutic virtual key (`vk_…`) or a provider key. |
| <a id="property-autocontext"></a> `autoContext?` | `boolean` | `true` | Resolve context (`resolveContext()`) and register a session carrying the repository, branch and commit on the first `chat()`. `false` does neither. |
| <a id="property-baseurl"></a> `baseUrl?` | `string` | `INTUTIC_BASE_URL`, then `http://localhost:4000` | The proxy's address. |
| <a id="property-controlplaneurl"></a> `controlPlaneUrl?` | `string` | `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted control plane | Control-plane base URL used by checkBudget() and session registration (a different origin from `baseUrl` — see [ControlPlaneClient](classes/ControlPlaneClient.md)). |
| <a id="property-graphidentity"></a> `graphIdentity?` | `Partial`\<`GraphIdentity`\> | `undefined` | This client's position in the agent graph. Omit and it is inherited from the environment, so a spawned agent is automatically a child of its spawner. Supply it when one process drives several logical agents and the environment cannot describe the shape. |
| <a id="property-provider"></a> `provider?` | `"openai"` \| `"anthropic"` \| `"google"` | `undefined` | `'anthropic'` sends `chat()` to the proxy's `/v1/messages` route, converting the request and the answer between the OpenAI and Anthropic shapes. Otherwise the request goes to `/v1/chat/completions` as it is. |
| <a id="property-retries"></a> `retries?` | `number` | `2` | How many times a transport failure, a timeout or a 5xx answer is retried. |
| <a id="property-timeout"></a> `timeout?` | `number` | `30000` | How long one attempt may take, in milliseconds. |

***

### CommitUsage

#### Extends

- [`UsageTotals`](#usagetotals)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-branch-1"></a> `branch` | `string` \| `null` | - |
| <a id="property-commit"></a> `commit` | `string` \| `null` | - |
| <a id="property-firstcallat"></a> `firstCallAt` | `string` | - |
| <a id="property-lastcallat-1"></a> `lastCallAt` | `string` | - |
| <a id="property-repo-1"></a> `repo` | `string` \| `null` | - |
| <a id="property-totalcostusd-1"></a> `totalCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalCostUsd`](#property-totalcostusd-5) |
| <a id="property-totalinputtokens-1"></a> `totalInputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalInputTokens`](#property-totalinputtokens-5) |
| <a id="property-totaloutputtokens-1"></a> `totalOutputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalOutputTokens`](#property-totaloutputtokens-5) |
| <a id="property-totalrawcostusd-1"></a> `totalRawCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalRawCostUsd`](#property-totalrawcostusd-5) |
| <a id="property-tracecount-1"></a> `traceCount` | `number` | [`UsageTotals`](#usagetotals).[`traceCount`](#property-tracecount-5) |

***

### CommitUsageResponse

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-commits"></a> `commits` | [`CommitUsage`](#commitusage)[] |
| <a id="property-scope-1"></a> `scope` | [`UsageScope`](#usagescope) |

***

### CompleteLoopRunOptions

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-outcome"></a> `outcome?` | `"FAILED"` \| `"SUCCEEDED"` |

***

### CompliancePolicy

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-conditions"></a> `conditions` | `unknown` |
| <a id="property-createdat-1"></a> `createdAt` | `string` |
| <a id="property-currentversion"></a> `currentVersion` | `number` |
| <a id="property-description-2"></a> `description` | `string` \| `null` |
| <a id="property-enforcementaction"></a> `enforcementAction` | `string` |
| <a id="property-interventionmode"></a> `interventionMode` | `string` \| `null` |
| <a id="property-isactive"></a> `isActive` | `boolean` \| `null` |
| <a id="property-name-3"></a> `name` | `string` |
| <a id="property-policyid"></a> `policyId` | `string` |
| <a id="property-priority"></a> `priority` | `number` \| `null` |
| <a id="property-riskcategory"></a> `riskCategory` | `string` \| `null` |
| <a id="property-targettoolpattern"></a> `targetToolPattern` | `string` |
| <a id="property-updatedat"></a> `updatedAt` | `string` |
| <a id="property-workspaceid-1"></a> `workspaceId` | `string` |

***

### ConfigChain

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-breaks"></a> `breaks` | `object`[] | - |
| <a id="property-contentmismatches"></a> `contentMismatches` | `object`[] | - |
| <a id="property-harnesstype"></a> `harnessType` | `string` \| `null` | - |
| <a id="property-intact"></a> `intact` | `boolean` | - |
| <a id="property-ok-1"></a> `ok` | `boolean` | - |
| <a id="property-snapshotsnotwalked"></a> `snapshotsNotWalked` | `number` | Saturates at 1: read it as "more snapshots than the walk covered". |
| <a id="property-snapshotswalked"></a> `snapshotsWalked` | `number` | - |
| <a id="property-snapshotswithoutcontent"></a> `snapshotsWithoutContent?` | `number` | - |
| <a id="property-unchainedsnapshotids"></a> `unchainedSnapshotIds` | `string`[] | - |
| <a id="property-workspaceid-2"></a> `workspaceId` | `string` | - |

***

### ControlPlaneClientOptions

Options for a [ControlPlaneClient](classes/ControlPlaneClient.md).

#### Properties

| Property | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| <a id="property-apikey-1"></a> `apiKey` | `string` | `undefined` | An Intutic virtual key (`vk_…`) or a login JWT. |
| <a id="property-baseurl-1"></a> `baseUrl?` | `string` | `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted control plane | The control plane's address. |

***

### CostPrediction

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-basedonsamples"></a> `basedOnSamples` | `number` |
| <a id="property-confidence"></a> `confidence` | `"low"` \| `"medium"` \| `"high"` |
| <a id="property-estimatedcostusd"></a> `estimatedCostUsd` | `number` |
| <a id="property-estimatedoutputtokens"></a> `estimatedOutputTokens` | `number` |
| <a id="property-estimatedreasoningtokens"></a> `estimatedReasoningTokens` | `number` \| `null` |
| <a id="property-inputtokens"></a> `inputTokens` | `number` |

***

### CreateOrgParams

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-domain-1"></a> `domain` | `string` | - |
| <a id="property-orgname"></a> `orgName` | `string` | - |
| <a id="property-region"></a> `region?` | `string` | Gateway cell region ('us' | 'eu' | ...). Omit for the deployment's home region; server-validated. |
| <a id="property-verificationid-1"></a> `verificationId` | `string` | - |

***

### CreateOrgResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-name-4"></a> `name` | `string` |
| <a id="property-orgid"></a> `orgId` | `string` |
| <a id="property-plantier"></a> `planTier` | `string` |
| <a id="property-region-1"></a> `region?` | `string` |
| <a id="property-teamid"></a> `teamId` | `string` |
| <a id="property-workspaceid-3"></a> `workspaceId` | `string` |

***

### DecisionReviewResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-bypasswritten"></a> `bypassWritten?` | `boolean` | A short-lived bypass was written for the exact retried call. |
| <a id="property-ok-2"></a> `ok` | `boolean` | - |
| <a id="property-status-1"></a> `status` | `string` | - |

***

### DeviceDisconnect

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-createdat-2"></a> `createdAt` | `string` |
| <a id="property-disconnectid"></a> `disconnectId` | `string` |
| <a id="property-fingerprint"></a> `fingerprint` | `string` |
| <a id="property-harnesses"></a> `harnesses` | `string`[] |
| <a id="property-hostname"></a> `hostname` | `string` |
| <a id="property-memberid"></a> `memberId` | `string` \| `null` |
| <a id="property-reportedby"></a> `reportedBy` | `string` \| `null` |
| <a id="property-scope-2"></a> `scope` | `"machine"` \| `"harness"` |

***

### DuplicatesOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-minjaccard"></a> `minJaccard?` | `number` | 0 to 1. |

***

### EvidenceArchive

An evidence archive: the parts verification reads. Everything else is covered by the archive hash.

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-categories"></a> `categories?` | `object`[] |
| <a id="property-collectedat"></a> `collectedAt?` | `string` |
| <a id="property-formatversion"></a> `formatVersion?` | `number` |
| <a id="property-frameworks"></a> `frameworks?` | `object`[] |
| <a id="property-manifest"></a> `manifest?` | `object` |
| `manifest.algorithm?` | `string` |
| `manifest.archiveSha256?` | `string` |
| `manifest.sections?` | `Record`\<`string`, `string`\> |
| `manifest.unsignedReason?` | `string` |
| <a id="property-overallscore"></a> `overallScore?` | `number` \| `null` |
| <a id="property-periodend"></a> `periodEnd?` | `string` |
| <a id="property-periodstart"></a> `periodStart?` | `string` |
| <a id="property-runid"></a> `runId?` | `string` |
| <a id="property-signature"></a> `signature?` | [`EvidenceDetachedSignature`](#evidencedetachedsignature) \| `null` |

***

### EvidenceCollectOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-periodend-1"></a> `periodEnd?` | `string` | - |
| <a id="property-periodstart-1"></a> `periodStart?` | `string` | ISO 8601. |

***

### EvidenceCollectResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-archive"></a> `archive` | [`EvidenceArchive`](#evidencearchive) |
| <a id="property-artifacturl"></a> `artifactUrl` | `string` \| `null` |
| <a id="property-runid-1"></a> `runId` | `string` |
| <a id="property-signed"></a> `signed` | `boolean` |
| <a id="property-signingkeyid"></a> `signingKeyId?` | `string` |
| <a id="property-unsignedreason"></a> `unsignedReason?` | `string` |

***

### EvidenceDetachedSignature

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-algorithm"></a> `algorithm` | `string` |
| <a id="property-keyid"></a> `keyId` | `string` |
| <a id="property-preimagedomain"></a> `preimageDomain` | `string` |
| <a id="property-value"></a> `value` | `string` |

***

### EvidenceVerification

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-archivehashmatches"></a> `archiveHashMatches` | `boolean` | - |
| <a id="property-archivesha256"></a> `archiveSha256` | `string` | The recomputed whole-archive hash, and whether it equals `manifest.archiveSha256`. |
| <a id="property-sectionmismatches"></a> `sectionMismatches` | `string`[] | Manifest entries whose content does not hash to the recorded value, or that name nothing in the archive. |
| <a id="property-sectionschecked"></a> `sectionsChecked` | `number` | - |
| <a id="property-signature-1"></a> `signature` | [`EvidenceSignatureState`](#evidencesignaturestate) | - |
| <a id="property-signingkeyid-1"></a> `signingKeyId` | `string` \| `null` | - |
| <a id="property-unsignedreason-1"></a> `unsignedReason` | `string` \| `null` | - |
| <a id="property-verified"></a> `verified` | `boolean` | True only when the hashes match and a published key accepts the signature. |

***

### ExtractDocumentResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-cap"></a> `cap` | \| \{ `cap`: `number`; `count`: `number`; \} \| `null` |
| <a id="property-chunks"></a> `chunks` | `number` |
| <a id="property-docid"></a> `docId` | `string` |
| <a id="property-error"></a> `error` | `string` \| `null` |
| <a id="property-extractor"></a> `extractor` | `string` |
| <a id="property-guardrails"></a> `guardrails` | `object` |
| `guardrails.existing` | `number` |
| `guardrails.proposed` | `number` |
| `guardrails.rejectedForInjection` | `number` |
| <a id="property-lifted"></a> `lifted` | `object` |
| `lifted.clauses` | `number` |
| `lifted.errors` | `string`[] |
| `lifted.valid` | `number` |
| <a id="property-llmunavailable"></a> `llmUnavailable` | `boolean` |
| <a id="property-malformed"></a> `malformed` | `number` |
| <a id="property-proposals"></a> `proposals` | `number` |
| <a id="property-rejected"></a> `rejected` | `number` |
| <a id="property-runid-2"></a> `runId` | `string` \| `null` |
| <a id="property-skipped"></a> `skipped` | `"no_passages"` \| `"daily_cap"` \| `"cap_unavailable"` \| `"llm_disabled"` \| `null` |
| <a id="property-valid"></a> `valid` | `number` |
| <a id="property-verbatimquotes"></a> `verbatimQuotes` | `number` |

***

### ExtractOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-llm"></a> `llm?` | `boolean` | Default true. False runs only the front-matter lift, with no model call. |

***

### Finding

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-anomaly_kind"></a> `anomaly_kind` | `string` \| `null` |
| <a id="property-confidence-1"></a> `confidence` | `number` |
| <a id="property-created_at"></a> `created_at` | `string` |
| <a id="property-detector_id"></a> `detector_id` | `string` |
| <a id="property-disposition"></a> `disposition` | `string` \| `null` |
| <a id="property-finding_id"></a> `finding_id` | `string` |
| <a id="property-harness"></a> `harness` | `string` \| `null` |
| <a id="property-loop_run_id"></a> `loop_run_id` | `string` \| `null` |
| <a id="property-outcome-1"></a> `outcome` | [`FindingOutcome`](#findingoutcome) \| `null` |
| <a id="property-outcome_at"></a> `outcome_at` | `string` \| `null` |
| <a id="property-outcome_by"></a> `outcome_by` | `string` \| `null` |
| <a id="property-outcome_note"></a> `outcome_note` | `string` \| `null` |
| <a id="property-reason-1"></a> `reason` | `string` \| `null` |
| <a id="property-session_id"></a> `session_id` | `string` \| `null` |
| <a id="property-severity"></a> `severity` | `string` \| `null` |
| <a id="property-shadowed"></a> `shadowed` | `boolean` |
| <a id="property-trace_id"></a> `trace_id` | `string` \| `null` |

***

### FindingAdjudication

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-finding_id-1"></a> `finding_id` | `string` |
| <a id="property-outcome-2"></a> `outcome` | [`FindingOutcome`](#findingoutcome) |

***

### FindingFilters

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-detectorid"></a> `detectorId?` | `string` | - |
| <a id="property-limit"></a> `limit?` | `number` | - |
| <a id="property-unadjudicated"></a> `unadjudicated?` | `boolean` | Only findings nobody has ruled on. |

***

### FindingStats

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-caveats"></a> `caveats` | `string`[] |
| <a id="property-detectors"></a> `detectors` | `object`[] |

***

### FrameworkCoverage

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-frameworkid"></a> `frameworkId` | `string` |
| <a id="property-generatedat"></a> `generatedAt` | `string` |
| <a id="property-mappingversion"></a> `mappingVersion` | `string` |
| <a id="property-name-5"></a> `name` | `string` |
| <a id="property-summary"></a> `summary` | `object` |
| `summary.controls` | `number` |
| `summary.full` | `number` |
| `summary.mapped` | `number` |
| `summary.partial` | `number` |
| `summary.states` | `Record`\<`string`, `number`\> |

***

### GateLiveness

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-gates-1"></a> `gates` | `object`[] |
| <a id="property-windowhours"></a> `windowHours` | `number` |

***

### Gateway

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-createdat-3"></a> `createdAt` | `string` |
| <a id="property-deploymenttarget"></a> `deploymentTarget` | `string` |
| <a id="property-gatewayid"></a> `gatewayId` | `string` |
| <a id="property-keyprefix"></a> `keyPrefix` | `string` |
| <a id="property-lastheartbeatat"></a> `lastHeartbeatAt` | `string` \| `null` |
| <a id="property-name-6"></a> `name` | `string` |
| <a id="property-proxyversion"></a> `proxyVersion` | `string` \| `null` |
| <a id="property-revokedat"></a> `revokedAt` | `string` \| `null` |
| <a id="property-status-2"></a> `status` | `string` |

***

### GatewayConfigResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-config"></a> `config` | `Record`\<`string`, `unknown`\> | The flags set on the gateway (`requireVk`, `requireProvisionedKey`). One never set is absent: the gateway runs its deployment's own value. |
| <a id="property-configversion"></a> `configVersion` | `number` | - |

***

### GatewayConfigUpdate

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-requireprovisionedkey"></a> `requireProvisionedKey?` | `boolean` |
| <a id="property-requirevk"></a> `requireVk?` | `boolean` |

***

### GatewayRegisterParams

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-deploymenttarget-1"></a> `deploymentTarget` | `"docker"` \| `"kubernetes"` \| `"bare_metal"` |
| <a id="property-name-7"></a> `name` | `string` |

***

### GatewayRegisterResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-deploymenttarget-2"></a> `deploymentTarget` | `string` | - |
| <a id="property-gatewayid-1"></a> `gatewayId` | `string` | - |
| <a id="property-instructions"></a> `instructions` | `string` | - |
| <a id="property-name-8"></a> `name` | `string` | - |
| <a id="property-status-3"></a> `status` | `string` | - |
| <a id="property-token"></a> `token` | `string` | Shown once — not retrievable again after this response. |

***

### GatewayResolution

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-gateway"></a> `gateway` | \| \{ `deploymentTarget`: `string`; `gatewayId`: `string`; `name`: `string`; `status`: `string`; \} \| `null` |
| <a id="property-source"></a> `source` | `"workspace"` \| `"org"` \| `"default"` |
| <a id="property-staleassignment"></a> `staleAssignment?` | `string` |

***

### GatewayRotateResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-gatewayid-2"></a> `gatewayId` | `string` | - |
| <a id="property-instructions-1"></a> `instructions` | `string` | - |
| <a id="property-previoustokenvaliduntil"></a> `previousTokenValidUntil` | `string` | - |
| <a id="property-token-1"></a> `token` | `string` | Shown once — not retrievable again after this response. |

***

### GatewayStatus

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-activeworkspaces"></a> `activeWorkspaces?` | `number` \| `null` | - |
| <a id="property-appliedconfigversion"></a> `appliedConfigVersion` | `number` \| `null` | The config version the gateway reported running in its last heartbeat; null when unreachable or not reported. |
| <a id="property-desiredconfigversion"></a> `desiredConfigVersion` | `number` | The version the latest config change produced; 0 before any. The gateway pulls it on its next heartbeat. |
| <a id="property-lasterror"></a> `lastError?` | `string` \| `null` | - |
| <a id="property-litellmreachable"></a> `litellmReachable?` | `boolean` \| `null` | - |
| <a id="property-proxyversion-1"></a> `proxyVersion?` | `string` \| `null` | The fields below are null when the gateway is unreachable, and absent when its last heartbeat did not report them. |
| <a id="property-reportedat"></a> `reportedAt` | `string` \| `null` | - |
| <a id="property-status-4"></a> `status` | `"pending"` \| `"online"` \| `"degraded"` \| `"unreachable"` | - |
| <a id="property-uptimeseconds"></a> `uptimeSeconds?` | `number` \| `null` | - |

***

### GitHubWebhookInfo

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-configured"></a> `configured` | `boolean` |
| <a id="property-createdat-4"></a> `createdAt` | `string` \| `null` |
| <a id="property-lastdeliveryat"></a> `lastDeliveryAt` | `string` \| `null` |
| <a id="property-secretrotatedat"></a> `secretRotatedAt` | `string` \| `null` |
| <a id="property-url"></a> `url` | `string` \| `null` |

***

### GitHubWebhookSecret

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-secret"></a> `secret` | `string` | Shown once: not retrievable again after this response. |
| <a id="property-url-1"></a> `url` | `string` | - |

***

### GuardrailConflict

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-a"></a> `a` | `object` |
| `a.id` | `string` |
| `a.quote` | `string` |
| <a id="property-b"></a> `b` | `object` |
| `b.id` | `string` |
| `b.quote` | `string` |
| <a id="property-detail"></a> `detail` | `string` |
| <a id="property-kind"></a> `kind` | `string` |
| <a id="property-token-2"></a> `token` | `string` \| `null` |

***

### GuardrailDeleteResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-guardrail-1"></a> `guardrail` | [`GuardrailDetail`](#guardraildetail) |
| <a id="property-ok-3"></a> `ok` | `boolean` |

***

### GuardrailDetail

#### Extends

- [`GuardrailSummary`](#guardrailsummary)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-clause"></a> `clause` | `Record`\<`string`, `unknown`\> \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`clause`](#property-clause-1) |
| <a id="property-description-3"></a> `description` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`description`](#property-description-4) |
| <a id="property-document"></a> `document` | \| \{ `docId`: `string`; `provider`: `string`; `sourceUrl`: `string` \| `null`; `title`: `string`; \} \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`document`](#property-document-1) |
| <a id="property-enforcingfires"></a> `enforcingFires` | `number` | - | [`GuardrailSummary`](#guardrailsummary).[`enforcingFires`](#property-enforcingfires-1) |
| <a id="property-events"></a> `events` | `object`[] | - | - |
| <a id="property-guardrailid"></a> `guardrailId` | `string` | - | [`GuardrailSummary`](#guardrailsummary).[`guardrailId`](#property-guardrailid-1) |
| <a id="property-ir-2"></a> `ir` | `Record`\<`string`, `unknown`\> | The guardrail IR: `kind` and the keys that kind takes. | [`GuardrailSummary`](#guardrailsummary).[`ir`](#property-ir-3) |
| <a id="property-name-9"></a> `name` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`name`](#property-name-10) |
| <a id="property-passage"></a> `passage` | `Record`\<`string`, `unknown`\> \| `null` | - | - |
| <a id="property-promotedat"></a> `promotedAt` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`promotedAt`](#property-promotedat-1) |
| <a id="property-proposedat"></a> `proposedAt` | `string` | - | [`GuardrailSummary`](#guardrailsummary).[`proposedAt`](#property-proposedat-1) |
| <a id="property-provenance"></a> `provenance` | [`GuardrailProvenance`](#guardrailprovenance) | - | [`GuardrailSummary`](#guardrailsummary).[`provenance`](#property-provenance-2) |
| <a id="property-rejectedreason"></a> `rejectedReason` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`rejectedReason`](#property-rejectedreason-1) |
| <a id="property-rendered"></a> `rendered` | `unknown` | - | [`GuardrailSummary`](#guardrailsummary).[`rendered`](#property-rendered-1) |
| <a id="property-roles"></a> `roles` | `string`[] | - | [`GuardrailSummary`](#guardrailsummary).[`roles`](#property-roles-1) |
| <a id="property-rulecandidateid"></a> `ruleCandidateId` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`ruleCandidateId`](#property-rulecandidateid-1) |
| <a id="property-scope-3"></a> `scope` | `string` | - | [`GuardrailSummary`](#guardrailsummary).[`scope`](#property-scope-4) |
| <a id="property-shadowat"></a> `shadowAt` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`shadowAt`](#property-shadowat-1) |
| <a id="property-shadowevaluations"></a> `shadowEvaluations` | `number` | - | [`GuardrailSummary`](#guardrailsummary).[`shadowEvaluations`](#property-shadowevaluations-1) |
| <a id="property-shadowwouldact"></a> `shadowWouldAct` | `number` | - | [`GuardrailSummary`](#guardrailsummary).[`shadowWouldAct`](#property-shadowwouldact-1) |
| <a id="property-sourcestale"></a> `sourceStale` | `boolean` | - | [`GuardrailSummary`](#guardrailsummary).[`sourceStale`](#property-sourcestale-1) |
| <a id="property-status-5"></a> `status` | [`GuardrailStatus`](#guardrailstatus) | - | [`GuardrailSummary`](#guardrailsummary).[`status`](#property-status-7) |
| <a id="property-supersededby"></a> `supersededBy` | `string` \| `null` | - | - |
| <a id="property-supersedes-1"></a> `supersedes` | `string` \| `null` | - | [`GuardrailSummary`](#guardrailsummary).[`supersedes`](#property-supersedes-2) |
| <a id="property-target"></a> `target` | [`GuardrailTarget`](#guardrailtarget) | - | [`GuardrailSummary`](#guardrailsummary).[`target`](#property-target-2) |
| <a id="property-validation"></a> `validation` | `unknown` | - | - |
| <a id="property-version"></a> `version` | `number` | - | [`GuardrailSummary`](#guardrailsummary).[`version`](#property-version-1) |

***

### GuardrailFilters

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-docid-1"></a> `docId?` | `string` |
| <a id="property-limit-1"></a> `limit?` | `number` |
| <a id="property-provenance-1"></a> `provenance?` | [`GuardrailProvenance`](#guardrailprovenance) |
| <a id="property-status-6"></a> `status?` | [`GuardrailStatus`](#guardrailstatus) |
| <a id="property-target-1"></a> `target?` | [`GuardrailTarget`](#guardrailtarget) |

***

### GuardrailImpactSeed

Name exactly one: the document or the passage whose change to follow.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-docid-2"></a> `docId?` | `string` |
| <a id="property-passageid"></a> `passageId?` | `string` |

***

### GuardrailReadiness

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-adjudicated"></a> `adjudicated` | `number` \| `null` | Null when the evidence counters could not be read. |
| <a id="property-adjudicatedrequired"></a> `adjudicatedRequired` | `number` | - |
| <a id="property-evaluations"></a> `evaluations` | `number` \| `null` | Null when the evidence counters could not be read (the guardrail is then not ready). |
| <a id="property-falsepositiverate"></a> `falsePositiveRate` | `number` \| `null` | - |
| <a id="property-falsepositives"></a> `falsePositives` | `number` \| `null` | Null when the evidence counters could not be read. |
| <a id="property-neverfired"></a> `neverFired` | `boolean` | - |
| <a id="property-ready"></a> `ready` | `boolean` | - |
| <a id="property-reasons"></a> `reasons` | `string`[] | - |
| <a id="property-thresholds"></a> `thresholds` | `object` | - |
| `thresholds.maxAdjudicatedFalsePositiveRate` | `number` | - |
| `thresholds.maxWouldActRate` | `number` | - |
| `thresholds.minAdjudicatedFires` | `number` | - |
| `thresholds.minShadowEvaluations` | `number` | - |
| <a id="property-wouldact"></a> `wouldAct` | `number` \| `null` | Null when the evidence counters could not be read. |
| <a id="property-wouldactrate"></a> `wouldActRate` | `number` \| `null` | - |

***

### GuardrailReplay

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-captured"></a> `captured` | `number` |
| <a id="property-fires"></a> `fires` | `number` |
| <a id="property-sample"></a> `sample` | `object`[] |
| <a id="property-source-1"></a> `source` | `"enforcement_log"` \| `"context_snapshots"` \| `"execution_traces"` \| `"none"` |
| <a id="property-truncated"></a> `truncated` | `boolean` |
| <a id="property-unsupported"></a> `unsupported` | `string`[] |
| <a id="property-windowdays"></a> `windowDays` | `number` |

***

### GuardrailSummary

#### Extended by

- [`GuardrailDetail`](#guardraildetail)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-clause-1"></a> `clause` | `Record`\<`string`, `unknown`\> \| `null` | - |
| <a id="property-description-4"></a> `description` | `string` \| `null` | - |
| <a id="property-document-1"></a> `document` | \| \{ `docId`: `string`; `provider`: `string`; `sourceUrl`: `string` \| `null`; `title`: `string`; \} \| `null` | - |
| <a id="property-enforcingfires-1"></a> `enforcingFires` | `number` | - |
| <a id="property-guardrailid-1"></a> `guardrailId` | `string` | - |
| <a id="property-ir-3"></a> `ir` | `Record`\<`string`, `unknown`\> | The guardrail IR: `kind` and the keys that kind takes. |
| <a id="property-name-10"></a> `name` | `string` \| `null` | - |
| <a id="property-promotedat-1"></a> `promotedAt` | `string` \| `null` | - |
| <a id="property-proposedat-1"></a> `proposedAt` | `string` | - |
| <a id="property-provenance-2"></a> `provenance` | [`GuardrailProvenance`](#guardrailprovenance) | - |
| <a id="property-rejectedreason-1"></a> `rejectedReason` | `string` \| `null` | - |
| <a id="property-rendered-1"></a> `rendered` | `unknown` | - |
| <a id="property-roles-1"></a> `roles` | `string`[] | - |
| <a id="property-rulecandidateid-1"></a> `ruleCandidateId` | `string` \| `null` | - |
| <a id="property-scope-4"></a> `scope` | `string` | - |
| <a id="property-shadowat-1"></a> `shadowAt` | `string` \| `null` | - |
| <a id="property-shadowevaluations-1"></a> `shadowEvaluations` | `number` | - |
| <a id="property-shadowwouldact-1"></a> `shadowWouldAct` | `number` | - |
| <a id="property-sourcestale-1"></a> `sourceStale` | `boolean` | - |
| <a id="property-status-7"></a> `status` | [`GuardrailStatus`](#guardrailstatus) | - |
| <a id="property-supersedes-2"></a> `supersedes` | `string` \| `null` | - |
| <a id="property-target-2"></a> `target` | [`GuardrailTarget`](#guardrailtarget) | - |
| <a id="property-version-1"></a> `version` | `number` | - |

***

### GuardrailTransitionResult

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-guardrail-2"></a> `guardrail` | [`GuardrailDetail`](#guardraildetail) \| `null` | The guardrail as the transition left it. A promotion reads it back after the write: null only if it is gone by then. |
| <a id="property-ok-4"></a> `ok` | `boolean` | - |
| <a id="property-readiness"></a> `readiness?` | [`GuardrailReadiness`](#guardrailreadiness) | - |

***

### Incident

One governance incident, with the route's snake_case keys.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-anomaly_type"></a> `anomaly_type` | `string` | The incident type: an anomaly category or a system incident type. |
| <a id="property-created_at-1"></a> `created_at` | `string` \| `null` | - |
| <a id="property-description-5"></a> `description` | `string` | - |
| <a id="property-escalation_chain"></a> `escalation_chain` | `Record`\<`string`, `unknown`\> \| `null` | - |
| <a id="property-incident_id"></a> `incident_id` | `string` | - |
| <a id="property-resolution_status"></a> `resolution_status` | `string` \| `null` | - |
| <a id="property-resolved_at"></a> `resolved_at` | `string` \| `null` | - |
| <a id="property-resolved_by"></a> `resolved_by` | `string` \| `null` | - |
| <a id="property-review_priority"></a> `review_priority?` | `number` | In a list only: how far up the review queue the incident ranks. |
| <a id="property-session_id-1"></a> `session_id` | `string` \| `null` | - |
| <a id="property-severity-1"></a> `severity` | `"CRITICAL"` \| `"HIGH"` \| `"MEDIUM"` \| `"LOW"` | - |
| <a id="property-trace_id-1"></a> `trace_id` | `string` \| `null` | - |
| <a id="property-workspace_id"></a> `workspace_id` | `string` | - |

***

### IncidentFilters

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-limit-2"></a> `limit?` | `number` | 1 to 100; default 20. |
| <a id="property-page"></a> `page?` | `number` | From 1; default 1. |
| <a id="property-severity-2"></a> `severity?` | `string` | `CRITICAL`, `HIGH`, `MEDIUM` or `LOW`. |
| <a id="property-status-8"></a> `status?` | `string` | `OPEN`, `RESOLVED` or `AUTO_RESOLVED`. |
| <a id="property-type"></a> `type?` | `string` | An anomaly category such as `SCOPE_VIOLATION`, or a system incident type: `WASM_RULE_REFUSED` or `SYSTEM_ANOMALY`. The control plane refuses one it does not know with a 400. |

***

### IncidentList

`listProperty` and `rowCase`, which every control-plane list response carries beside its rows.

#### Extends

- [`ListEnvelope`](#listenvelope)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-data"></a> `data` | [`Incident`](#incident)[] | Ranked by review priority, not time. A list of 20 or more arrives TOON-encoded and is decoded here, with each cell cut at 120 characters: `getIncident` has the whole description. | - |
| <a id="property-listproperty"></a> `listProperty?` | `string` | - | [`ListEnvelope`](#listenvelope).[`listProperty`](#property-listproperty-2) |
| <a id="property-meta"></a> `meta` | `object` | - | - |
| `meta.audit` | `object` | The review budget: how many of the matching incidents the ranked queue covers. | - |
| `meta.audit.budget` | `number` | - | - |
| `meta.audit.matched` | `number` | - | - |
| `meta.audit.overBudget` | `boolean` | - | - |
| `meta.audit.withheld` | `number` | - | - |
| `meta.limit` | `number` | - | - |
| `meta.page` | `number` | - | - |
| `meta.total` | `number` | - | - |
| <a id="property-rowcase"></a> `rowCase?` | `"snake"` \| `"camel"` \| `"mixed"` | - | [`ListEnvelope`](#listenvelope).[`rowCase`](#property-rowcase-2) |

***

### IntegrityChain

The walk is the answer whether or not it found a break (the control plane answers a break with a 409).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-breaks-1"></a> `breaks` | `object`[] |
| <a id="property-intact-1"></a> `intact` | `boolean` |
| <a id="property-ok-5"></a> `ok` | `boolean` |
| <a id="property-rootsnotwalked"></a> `rootsNotWalked` | `number` |
| <a id="property-rootswalked"></a> `rootsWalked` | `number` |
| <a id="property-unchainedrootids"></a> `unchainedRootIds` | `string`[] |
| <a id="property-workspaceid-4"></a> `workspaceId` | `string` |

***

### IntegrityRecompute

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-changedtraceids"></a> `changedTraceIds` | `string`[] |
| <a id="property-missingtraceids"></a> `missingTraceIds` | `string`[] |
| <a id="property-ok-6"></a> `ok` | `boolean` |
| <a id="property-recomputedroot"></a> `recomputedRoot` | `string` \| `null` |
| <a id="property-retentionexpired"></a> `retentionExpired?` | `boolean` |
| <a id="property-storedroot"></a> `storedRoot` | `string` |
| <a id="property-verdict-1"></a> `verdict` | `"match"` \| `"mismatch"` \| `"missing_traces"` |

***

### IntegrityRootDetail

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-leaves"></a> `leaves` | `object`[] |
| <a id="property-ok-7"></a> `ok` | `boolean` |
| <a id="property-root"></a> `root` | [`SealedRoot`](#sealedroot) & [`SignedIntegrityRoot`](#signedintegrityroot) & `object` |

***

### IntegrityRootList

`listProperty` and `rowCase`, which every control-plane list response carries beside its rows.

#### Extends

- [`ListEnvelope`](#listenvelope)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-data-1"></a> `data` | [`SealedRoot`](#sealedroot)[] | - |
| <a id="property-leafschemaversion"></a> `leafSchemaVersion` | `number` | - |
| <a id="property-listproperty-1"></a> `listProperty?` | `string` | [`ListEnvelope`](#listenvelope).[`listProperty`](#property-listproperty-2) |
| <a id="property-ok-8"></a> `ok` | `boolean` | - |
| <a id="property-rowcase-1"></a> `rowCase?` | `"snake"` \| `"camel"` \| `"mixed"` | [`ListEnvelope`](#listenvelope).[`rowCase`](#property-rowcase-2) |

***

### InventoryDevice

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-cliversion"></a> `cliVersion` | `string` \| `null` |
| <a id="property-deviceid"></a> `deviceId` | `string` |
| <a id="property-disconnectedat"></a> `disconnectedAt` | `string` \| `null` |
| <a id="property-firstseenat"></a> `firstSeenAt` | `string` |
| <a id="property-guardprobes"></a> `guardProbes` | \| \{ `failed`: `number`; `ranAt`: `number`; `total`: `number`; \} \| `null` |
| <a id="property-harnesses-1"></a> `harnesses` | `number` |
| <a id="property-hostname-1"></a> `hostname` | `string` |
| <a id="property-lastseenat"></a> `lastSeenAt` | `string` |
| <a id="property-mcpservers"></a> `mcpServers` | `number` |
| <a id="property-platform"></a> `platform` | `string` |
| <a id="property-reportedby-1"></a> `reportedBy` | `string` \| `null` |
| <a id="property-skills"></a> `skills` | `number` |
| <a id="property-stale"></a> `stale` | `boolean` |
| <a id="property-stalegates"></a> `staleGates` | `number` |
| <a id="property-ungovernedharnesses"></a> `ungovernedHarnesses` | `number` |
| <a id="property-ungovernedmcpservers"></a> `ungovernedMcpServers` | `number` |
| <a id="property-workspace"></a> `workspace` | `string` \| `null` |

***

### InventoryFilters

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-device"></a> `device?` | `string` | A device id. |
| <a id="property-harness-1"></a> `harness?` | `string` | - |
| <a id="property-search"></a> `search?` | `string` | Text matched against the item's name and the machine's hostname. |
| <a id="property-status-9"></a> `status?` | `string` | - |

***

### InventoryHarness

#### Extends

- `InventoryItem`

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-configured-1"></a> `configured` | `boolean` | - |
| <a id="property-deviceid-1"></a> `deviceId` | `string` | `InventoryItem.deviceId` |
| <a id="property-devicestale"></a> `deviceStale` | `boolean` | `InventoryItem.deviceStale` |
| <a id="property-firstseenat-1"></a> `firstSeenAt` | `string` | `InventoryItem.firstSeenAt` |
| <a id="property-gatefile"></a> `gateFile` | `string` \| `null` | - |
| <a id="property-gateinstalled"></a> `gateInstalled` | `boolean` \| `null` | - |
| <a id="property-gatekind"></a> `gateKind` | `string` | - |
| <a id="property-harness-2"></a> `harness` | `string` | - |
| <a id="property-hostname-2"></a> `hostname` | `string` | `InventoryItem.hostname` |
| <a id="property-itemid"></a> `itemId` | `string` | `InventoryItem.itemId` |
| <a id="property-lasthookeventat"></a> `lastHookEventAt` | `string` \| `null` | - |
| <a id="property-lastseenat-1"></a> `lastSeenAt` | `string` | `InventoryItem.lastSeenAt` |
| <a id="property-reason-2"></a> `reason` | `string` \| `null` | - |
| <a id="property-reasontext"></a> `reasonText` | `string` \| `null` | - |
| <a id="property-status-10"></a> `status` | `string` | - |
| <a id="property-version-2"></a> `version` | `string` \| `null` | - |

***

### InventoryMcpServer

#### Extends

- `InventoryItem`

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-deviceid-2"></a> `deviceId` | `string` | `InventoryItem.deviceId` |
| <a id="property-devicestale-1"></a> `deviceStale` | `boolean` | `InventoryItem.deviceStale` |
| <a id="property-endpoint"></a> `endpoint` | `string` \| `null` | - |
| <a id="property-firstseenat-2"></a> `firstSeenAt` | `string` | `InventoryItem.firstSeenAt` |
| <a id="property-harness-3"></a> `harness` | `string` | - |
| <a id="property-hostname-3"></a> `hostname` | `string` | `InventoryItem.hostname` |
| <a id="property-itemid-1"></a> `itemId` | `string` | `InventoryItem.itemId` |
| <a id="property-lastseenat-2"></a> `lastSeenAt` | `string` | `InventoryItem.lastSeenAt` |
| <a id="property-reason-3"></a> `reason` | `string` \| `null` | - |
| <a id="property-server"></a> `server` | `string` | - |
| <a id="property-status-11"></a> `status` | `string` | - |
| <a id="property-transport"></a> `transport` | `string` | - |

***

### InventorySkill

#### Extends

- `InventoryItem`

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-clean"></a> `clean` | `boolean` | - |
| <a id="property-deviceid-3"></a> `deviceId` | `string` | `InventoryItem.deviceId` |
| <a id="property-devicestale-2"></a> `deviceStale` | `boolean` | `InventoryItem.deviceStale` |
| <a id="property-findingscount"></a> `findingsCount` | `number` | - |
| <a id="property-firstseenat-3"></a> `firstSeenAt` | `string` | `InventoryItem.firstSeenAt` |
| <a id="property-hostname-4"></a> `hostname` | `string` | `InventoryItem.hostname` |
| <a id="property-itemid-2"></a> `itemId` | `string` | `InventoryItem.itemId` |
| <a id="property-lastseenat-3"></a> `lastSeenAt` | `string` | `InventoryItem.lastSeenAt` |
| <a id="property-name-11"></a> `name` | `string` | - |
| <a id="property-scanned"></a> `scanned` | `boolean` | - |
| <a id="property-scriptcount"></a> `scriptCount` | `number` | - |
| <a id="property-sha256"></a> `sha256` | `string` \| `null` | - |
| <a id="property-source-2"></a> `source` | `string` | - |

***

### InventorySkillFilters

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-device-1"></a> `device?` | `string` |
| <a id="property-search-1"></a> `search?` | `string` |

***

### InventorySummary

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-devices"></a> `devices` | `number` |
| <a id="property-governedharnesses"></a> `governedHarnesses` | `number` |
| <a id="property-governedpercent"></a> `governedPercent` | `number` \| `null` |
| <a id="property-harnesses-2"></a> `harnesses` | `number` |
| <a id="property-mcpservers-1"></a> `mcpServers` | `number` |
| <a id="property-skills-1"></a> `skills` | `number` |
| <a id="property-staledevices"></a> `staleDevices` | `number` |
| <a id="property-stalegates-1"></a> `staleGates` | `number` |
| <a id="property-ungovernedharnesses-1"></a> `ungovernedHarnesses` | `number` |
| <a id="property-ungovernedmcpservers-1"></a> `ungovernedMcpServers` | `number` |
| <a id="property-unverifiedharnesses"></a> `unverifiedHarnesses` | `number` |

***

### LedgerDuplicates

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-minjaccard-1"></a> `minJaccard` | `number` |
| <a id="property-passagepairs"></a> `passagePairs` | `Record`\<`string`, `unknown`\>[] |
| <a id="property-samerule"></a> `sameRule` | `Record`\<`string`, `unknown`\>[] |

***

### LedgerImpact

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-clauses"></a> `clauses` | `Record`\<`string`, `unknown`\>[] |
| <a id="property-guardrails-1"></a> `guardrails` | `object`[] |
| <a id="property-maxdepth"></a> `maxDepth` | `number` |
| <a id="property-passages"></a> `passages` | `Record`\<`string`, `unknown`\>[] |
| <a id="property-seed"></a> `seed` | `object` |
| `seed.docId` | `string` \| `null` |
| `seed.passageId` | `string` \| `null` |
| <a id="property-truncated-1"></a> `truncated` | `boolean` |

***

### ListEnvelope

`listProperty` and `rowCase`, which every control-plane list response carries beside its rows.

#### Extended by

- [`McpServerList`](#mcpserverlist)
- [`IncidentList`](#incidentlist)
- [`TraceList`](#tracelist)
- [`IntegrityRootList`](#integrityrootlist)

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-listproperty-2"></a> `listProperty?` | `string` |
| <a id="property-rowcase-2"></a> `rowCase?` | `"snake"` \| `"camel"` \| `"mixed"` |

***

### LoopRun

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-budgetlimitusd"></a> `budgetLimitUsd` | `string` |
| <a id="property-looprunid"></a> `loopRunId` | `string` |
| <a id="property-name-12"></a> `name` | `string` |
| <a id="property-status-12"></a> `status` | [`LoopRunStatus`](#looprunstatus) |
| <a id="property-totaltokencostusd"></a> `totalTokenCostUsd` | `string` |

***

### LoopRunActionResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-ok-9"></a> `ok` | `boolean` |
| <a id="property-outcome-3"></a> `outcome?` | `string` |
| <a id="property-status-13"></a> `status?` | `string` |

***

### LoopRunReviewOptions

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-note-1"></a> `note?` | `string` |

***

### McpServer

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-disabledtools"></a> `disabledTools` | `string`[] | - |
| <a id="property-heldforreview"></a> `heldForReview` | `boolean` | A high-risk tool change is waiting for a decision. |
| <a id="property-lastseenat-4"></a> `lastSeenAt` | `string` | - |
| <a id="property-serverid"></a> `serverId` | `string` | - |
| <a id="property-servername"></a> `serverName` | `string` | - |
| <a id="property-status-14"></a> `status` | `"candidate"` \| `"approved"` \| `"blocked"` | - |
| <a id="property-tools-1"></a> `tools` | `string`[] | - |

***

### McpServerDecision

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-ok-10"></a> `ok` | `boolean` |
| <a id="property-server-1"></a> `server` | [`McpServer`](#mcpserver) |

***

### McpServerList

`listProperty` and `rowCase`, which every control-plane list response carries beside its rows.

#### Extends

- [`ListEnvelope`](#listenvelope)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-defaultpolicy"></a> `defaultPolicy` | `"allow"` \| `"deny"` | - |
| <a id="property-highrisktoolchange"></a> `highRiskToolChange` | `"hold"` \| `"notify"` | - |
| <a id="property-listproperty-3"></a> `listProperty?` | `string` | [`ListEnvelope`](#listenvelope).[`listProperty`](#property-listproperty-2) |
| <a id="property-pendingcount"></a> `pendingCount` | `number` | - |
| <a id="property-rowcase-3"></a> `rowCase?` | `"snake"` \| `"camel"` \| `"mixed"` | [`ListEnvelope`](#listenvelope).[`rowCase`](#property-rowcase-2) |
| <a id="property-servers"></a> `servers` | [`McpServer`](#mcpserver)[] | - |

***

### MemberUsage

#### Extends

- [`UsageTotals`](#usagetotals)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-activedays"></a> `activeDays` | `number` | - | - |
| <a id="property-displayname"></a> `displayName` | `string` \| `null` | - | - |
| <a id="property-email"></a> `email` | `string` \| `null` | - | - |
| <a id="property-memberid-1"></a> `memberId` | `string` \| `null` | Null for calls no single member owns. | - |
| <a id="property-models"></a> `models` | `string`[] | - | - |
| <a id="property-totalcostusd-2"></a> `totalCostUsd` | `number` | - | [`UsageTotals`](#usagetotals).[`totalCostUsd`](#property-totalcostusd-5) |
| <a id="property-totalinputtokens-2"></a> `totalInputTokens` | `number` | - | [`UsageTotals`](#usagetotals).[`totalInputTokens`](#property-totalinputtokens-5) |
| <a id="property-totaloutputtokens-2"></a> `totalOutputTokens` | `number` | - | [`UsageTotals`](#usagetotals).[`totalOutputTokens`](#property-totaloutputtokens-5) |
| <a id="property-totalrawcostusd-2"></a> `totalRawCostUsd` | `number` | - | [`UsageTotals`](#usagetotals).[`totalRawCostUsd`](#property-totalrawcostusd-5) |
| <a id="property-tracecount-2"></a> `traceCount` | `number` | - | [`UsageTotals`](#usagetotals).[`traceCount`](#property-tracecount-5) |

***

### MemberUsageResponse

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-members"></a> `members` | [`MemberUsage`](#memberusage)[] |
| <a id="property-scope-5"></a> `scope` | [`UsageScope`](#usagescope) |

***

### NotificationChannelConfig

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-emailrecipients"></a> `emailRecipients?` | `string`[] |
| <a id="property-pagerdutyroutingkey"></a> `pagerdutyRoutingKey?` | `string` |
| <a id="property-slackchannelid"></a> `slackChannelId?` | `string` |
| <a id="property-slackchannelname"></a> `slackChannelName?` | `string` |
| <a id="property-webhookurl"></a> `webhookUrl?` | `string` |

***

### NotificationFilters

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-harnesstype-1"></a> `harnessType?` | `string`[] |
| <a id="property-severity-3"></a> `severity?` | `string`[] |
| <a id="property-userid"></a> `userId?` | `string`[] |

***

### NotificationRule

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-channel"></a> `channel` | [`NotificationChannel`](#notificationchannel) | - |
| <a id="property-channelconfig"></a> `channelConfig` | [`NotificationChannelConfig`](#notificationchannelconfig) | - |
| <a id="property-cooldownminutes"></a> `cooldownMinutes` | `number` | - |
| <a id="property-enabled"></a> `enabled` | `boolean` | - |
| <a id="property-eventtype"></a> `eventType` | `string` | - |
| <a id="property-filters"></a> `filters` | [`NotificationFilters`](#notificationfilters) | - |
| <a id="property-ruleid-1"></a> `ruleId` | `string` | - |
| <a id="property-signingsecret"></a> `signingSecret?` | `string` | A webhook rule's signing secret, only in the response that made it. Not retrievable again. |

***

### NotificationRuleInput

The body of a create. Channel config and filters are each stored whole.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-channel-1"></a> `channel` | [`NotificationChannel`](#notificationchannel) |
| <a id="property-channelconfig-1"></a> `channelConfig` | [`NotificationChannelConfig`](#notificationchannelconfig) |
| <a id="property-cooldownminutes-1"></a> `cooldownMinutes?` | `number` |
| <a id="property-enabled-1"></a> `enabled?` | `boolean` |
| <a id="property-eventtype-1"></a> `eventType` | `string` |
| <a id="property-filters-1"></a> `filters?` | [`NotificationFilters`](#notificationfilters) |

***

### NotificationSecretRotation

#### Extends

- [`SigningSecretRotation`](#signingsecretrotation)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-ruleid-2"></a> `ruleId` | `string` | - | - |
| <a id="property-signingsecret-1"></a> `signingSecret` | `string` | Shown once: not retrievable again after this response. | [`SigningSecretRotation`](#signingsecretrotation).[`signingSecret`](#property-signingsecret-4) |

***

### OrgSignupParams

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-email-1"></a> `email` | `string` |
| <a id="property-name-13"></a> `name` | `string` |
| <a id="property-orgname-1"></a> `orgName` | `string` |
| <a id="property-password"></a> `password` | `string` |

***

### OrgSignupResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-accesstoken"></a> `accessToken` | `string` |
| <a id="property-cliinstall"></a> `cliInstall` | `string` |
| <a id="property-isnewuser"></a> `isNewUser` | `boolean` |
| <a id="property-org"></a> `org` | `object` |
| `org.id` | `string` |
| `org.name` | `string` |
| `org.planTier` | `string` |
| `org.trialExpiresAt` | `string` |
| <a id="property-refreshtoken"></a> `refreshToken` | `string` |
| <a id="property-user"></a> `user` | `object` |
| `user.email` | `string` |
| `user.emailVerified` | `boolean` |
| `user.id` | `string` |
| `user.name` | `string` |
| <a id="property-workspace-1"></a> `workspace` | `object` |
| `workspace.id` | `string` |
| `workspace.name` | `string` |
| `workspace.planTier` | `string` |
| `workspace.trialExpiresAt` | `string` |

***

### OrgSop

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-createdat-5"></a> `createdAt` | `string` |
| <a id="property-orgid-1"></a> `orgId?` | `string` |
| <a id="property-orgsopid"></a> `orgSopId` | `string` |
| <a id="property-risktier"></a> `riskTier` | `string` |
| <a id="property-title"></a> `title` | `string` |

***

### OrgSopInput

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-markdown_content"></a> `markdown_content` | `string` |
| <a id="property-risk_tier"></a> `risk_tier?` | `string` |
| <a id="property-title-1"></a> `title` | `string` |

***

### PassageSearchResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-passages-1"></a> `passages` | `object`[] |
| <a id="property-query"></a> `query` | `string` |

***

### PolicyChangeResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-currentversion-1"></a> `currentVersion?` | `number` |
| <a id="property-ok-11"></a> `ok` | `boolean` |

***

### PolicyDocumentDetail

#### Extends

- [`PolicyDocumentSummary`](#policydocumentsummary)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-clausecount"></a> `clauseCount` | `number` | [`PolicyDocumentSummary`](#policydocumentsummary).[`clauseCount`](#property-clausecount-1) |
| <a id="property-clauses-1"></a> `clauses` | `Record`\<`string`, `unknown`\>[] | - |
| <a id="property-contenthash"></a> `contentHash` | `string` | - |
| <a id="property-docid-3"></a> `docId` | `string` | [`PolicyDocumentSummary`](#policydocumentsummary).[`docId`](#property-docid-4) |
| <a id="property-fetchedat"></a> `fetchedAt` | `string` | [`PolicyDocumentSummary`](#policydocumentsummary).[`fetchedAt`](#property-fetchedat-1) |
| <a id="property-guardrailcount"></a> `guardrailCount` | `number` | [`PolicyDocumentSummary`](#policydocumentsummary).[`guardrailCount`](#property-guardrailcount-1) |
| <a id="property-injectionflagged"></a> `injectionFlagged` | `boolean` | [`PolicyDocumentSummary`](#policydocumentsummary).[`injectionFlagged`](#property-injectionflagged-1) |
| <a id="property-lastrun"></a> `lastRun` | \| \{ `error`: `string` \| `null`; `extractor`: `string`; `finishedAt`: `string` \| `null`; `runId`: `string`; `startedAt`: `string`; \} \| `null` | [`PolicyDocumentSummary`](#policydocumentsummary).[`lastRun`](#property-lastrun-1) |
| <a id="property-passagecount"></a> `passageCount` | `number` | [`PolicyDocumentSummary`](#policydocumentsummary).[`passageCount`](#property-passagecount-1) |
| <a id="property-passages-2"></a> `passages` | `Record`\<`string`, `unknown`\>[] | - |
| <a id="property-provider-1"></a> `provider` | `string` | [`PolicyDocumentSummary`](#policydocumentsummary).[`provider`](#property-provider-2) |
| <a id="property-runs"></a> `runs` | `Record`\<`string`, `unknown`\>[] | - |
| <a id="property-sopid"></a> `sopId` | `string` \| `null` | [`PolicyDocumentSummary`](#policydocumentsummary).[`sopId`](#property-sopid-1) |
| <a id="property-sourceurl"></a> `sourceUrl` | `string` \| `null` | [`PolicyDocumentSummary`](#policydocumentsummary).[`sourceUrl`](#property-sourceurl-1) |
| <a id="property-status-15"></a> `status` | `string` | [`PolicyDocumentSummary`](#policydocumentsummary).[`status`](#property-status-16) |
| <a id="property-title-2"></a> `title` | `string` | [`PolicyDocumentSummary`](#policydocumentsummary).[`title`](#property-title-3) |
| <a id="property-upstreamversion"></a> `upstreamVersion` | `string` \| `null` | - |

***

### PolicyDocumentSummary

#### Extended by

- [`PolicyDocumentDetail`](#policydocumentdetail)

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-clausecount-1"></a> `clauseCount` | `number` |
| <a id="property-docid-4"></a> `docId` | `string` |
| <a id="property-fetchedat-1"></a> `fetchedAt` | `string` |
| <a id="property-guardrailcount-1"></a> `guardrailCount` | `number` |
| <a id="property-injectionflagged-1"></a> `injectionFlagged` | `boolean` |
| <a id="property-lastrun-1"></a> `lastRun` | \| \{ `error`: `string` \| `null`; `extractor`: `string`; `finishedAt`: `string` \| `null`; `runId`: `string`; `startedAt`: `string`; \} \| `null` |
| <a id="property-passagecount-1"></a> `passageCount` | `number` |
| <a id="property-provider-2"></a> `provider` | `string` |
| <a id="property-sopid-1"></a> `sopId` | `string` \| `null` |
| <a id="property-sourceurl-1"></a> `sourceUrl` | `string` \| `null` |
| <a id="property-status-16"></a> `status` | `string` |
| <a id="property-title-3"></a> `title` | `string` |

***

### PolicySource

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-config-1"></a> `config` | `Record`\<`string`, `unknown`\> \| `null` |
| <a id="property-connector_id"></a> `connector_id` | `string` |
| <a id="property-created_at-2"></a> `created_at?` | `string` |
| <a id="property-last_attempt_at"></a> `last_attempt_at?` | `string` \| `null` |
| <a id="property-last_sync_error"></a> `last_sync_error?` | `string` \| `null` |
| <a id="property-last_synced_at"></a> `last_synced_at` | `string` \| `null` |
| <a id="property-name-14"></a> `name` | `string` |
| <a id="property-provider-3"></a> `provider` | [`PolicySourceProvider`](#policysourceprovider) |

***

### PolicySourceInput

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-config-2"></a> `config?` | `Record`\<`string`, `unknown`\> | - |
| <a id="property-name-15"></a> `name` | `string` | - |
| <a id="property-provider-4"></a> `provider` | [`PolicySourceProvider`](#policysourceprovider) | - |
| <a id="property-token-3"></a> `token` | `string` | The provider credential (a Google service-account key is the key file's JSON). |

***

### PolicySourceSyncResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-processed_docs"></a> `processed_docs` | `number` |
| <a id="property-success"></a> `success` | `boolean` |
| <a id="property-successor_sops"></a> `successor_sops` | `string`[] |
| <a id="property-updated_sops"></a> `updated_sops` | `string`[] |

***

### PredictCostParams

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-inputtext"></a> `inputText?` | `string` | - |
| <a id="property-inputtokencount"></a> `inputTokenCount?` | `number` | - |
| <a id="property-model-2"></a> `model` | `string` | - |
| <a id="property-workspaceid-5"></a> `workspaceId` | `string` | Must be the key's own workspace. |

***

### PromoteOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-acknowledgenotraffic"></a> `acknowledgeNoTraffic?` | `boolean` | Promote a guardrail that never fired in shadow. Default false. |

***

### ProviderCredentialStatus

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-lastfour"></a> `lastFour` | `string` \| `null` |
| <a id="property-provider-5"></a> `provider` | `string` |
| <a id="property-provisioned"></a> `provisioned` | `boolean` |
| <a id="property-routinglive"></a> `routingLive` | `boolean` |
| <a id="property-updatedat-1"></a> `updatedAt` | `string` \| `null` |

***

### ProviderModelList

The models a provider credential can reach, as the provider listed them
when the stored key was last checked. `models` and `checkedAt` are `null`
until a check has recorded a list (and stay so for providers that have no
list, such as Azure OpenAI, whose list names base models, not deployments).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-checkedat"></a> `checkedAt` | `string` \| `null` |
| <a id="property-models-1"></a> `models` | `string`[] \| `null` |
| <a id="property-provider-6"></a> `provider` | `string` |

***

### ProxyRefusal

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-code"></a> `code` | `string` | - |
| <a id="property-message"></a> `message` | `string` | - |
| <a id="property-ruleid-3"></a> `ruleId?` | `string` | The rule that decided, for a refusal the proxy answered in band. |
| <a id="property-verdict-2"></a> `verdict` | [`RefusalVerdict`](#refusalverdict) | - |

***

### PullRequestRefreshResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-checked"></a> `checked` | `number` |
| <a id="property-noaccess"></a> `noAccess` | `number` |
| <a id="property-notmodified"></a> `notModified` | `number` |
| <a id="property-pullrequests"></a> `pullRequests` | `number` |
| <a id="property-ratelimited"></a> `rateLimited` | `boolean` |

***

### PullRequestSources

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-apihost"></a> `apiHost` | `string` |
| <a id="property-connector"></a> `connector` | `boolean` |
| <a id="property-lastcheckedat"></a> `lastCheckedAt` | `string` \| `null` |
| <a id="property-mappedpullrequests"></a> `mappedPullRequests` | `number` |
| <a id="property-noaccessrepos"></a> `noAccessRepos` | `string`[] |
| <a id="property-webhook"></a> `webhook` | `boolean` |

***

### PullRequestUsage

#### Extends

- [`UsageTotals`](#usagetotals)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-author"></a> `author` | `string` \| `null` | - |
| <a id="property-basebranch"></a> `baseBranch` | `string` \| `null` | - |
| <a id="property-closedat"></a> `closedAt` | `string` \| `null` | - |
| <a id="property-firstcallat-1"></a> `firstCallAt` | `string` | - |
| <a id="property-headbranch"></a> `headBranch` | `string` | - |
| <a id="property-lastcallat-2"></a> `lastCallAt` | `string` | - |
| <a id="property-membercount"></a> `memberCount` | `number` | - |
| <a id="property-mergedat"></a> `mergedAt` | `string` \| `null` | - |
| <a id="property-number"></a> `number` | `number` | - |
| <a id="property-openedat"></a> `openedAt` | `string` | - |
| <a id="property-repo-2"></a> `repo` | `string` | - |
| <a id="property-state"></a> `state` | `"open"` \| `"closed"` \| `"merged"` | - |
| <a id="property-title-4"></a> `title` | `string` | - |
| <a id="property-totalcostusd-3"></a> `totalCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalCostUsd`](#property-totalcostusd-5) |
| <a id="property-totalinputtokens-3"></a> `totalInputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalInputTokens`](#property-totalinputtokens-5) |
| <a id="property-totaloutputtokens-3"></a> `totalOutputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalOutputTokens`](#property-totaloutputtokens-5) |
| <a id="property-totalrawcostusd-3"></a> `totalRawCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalRawCostUsd`](#property-totalrawcostusd-5) |
| <a id="property-tracecount-3"></a> `traceCount` | `number` | [`UsageTotals`](#usagetotals).[`traceCount`](#property-tracecount-5) |
| <a id="property-url-2"></a> `url` | `string` | - |

***

### PullRequestUsageResponse

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-github"></a> `github` | [`PullRequestSources`](#pullrequestsources) |
| <a id="property-pullrequests-1"></a> `pullRequests` | [`PullRequestUsage`](#pullrequestusage)[] |
| <a id="property-scope-6"></a> `scope` | [`UsageScope`](#usagescope) |

***

### ResolvedContext

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-cipipeline"></a> `ciPipeline?` | `string` |
| <a id="property-gitbranch"></a> `gitBranch?` | `string` |
| <a id="property-jiraticket"></a> `jiraTicket?` | `string` |
| <a id="property-pagerdutyincident"></a> `pagerdutyIncident?` | `string` |
| <a id="property-sessionid"></a> `sessionId?` | `string` |
| <a id="property-workingdirectory"></a> `workingDirectory?` | `string` |
| <a id="property-workspaceid-6"></a> `workspaceId?` | `string` |

***

### ResponseEchoReport

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-patterns"></a> `patterns` | `object`[] |
| <a id="property-refusal"></a> `refusal` | `string` \| `null` |
| <a id="property-tracesingested"></a> `tracesIngested` | `number` |
| <a id="property-window"></a> `window` | `object` |
| `window.since` | `string` |
| `window.until` | `string` |

***

### ResponseEchoReportOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-since"></a> `since?` | `string` | ISO 8601. |
| <a id="property-until"></a> `until?` | `string` | - |

***

### ReviewOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-reason-4"></a> `reason?` | `string` | Recorded with the decision. |

***

### RuleCandidateSource

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-candidateid"></a> `candidateId` | `string` | - |
| <a id="property-guardrailid-2"></a> `guardrailId` | `string` \| `null` | - |
| <a id="property-source-3"></a> `source` | `string` | - |
| <a id="property-sourcesha256"></a> `sourceSha256` | `string` | Lower-case hex; checked against `source` before it is returned. |
| <a id="property-status-17"></a> `status` | `string` | - |

***

### SealedRoot

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-first_trace_at"></a> `first_trace_at` | `string` |
| <a id="property-last_trace_at"></a> `last_trace_at` | `string` |
| <a id="property-leaf_count"></a> `leaf_count` | `number` |
| <a id="property-leaf_schema_version"></a> `leaf_schema_version` | `number` |
| <a id="property-loop_run_id-1"></a> `loop_run_id` | `string` \| `null` |
| <a id="property-merkle_root"></a> `merkle_root` | `string` |
| <a id="property-root_id"></a> `root_id` | `string` |
| <a id="property-sealed_at"></a> `sealed_at` | `string` |
| <a id="property-signature_alg"></a> `signature_alg` | `string` \| `null` |
| <a id="property-signing_key_id"></a> `signing_key_id` | `string` \| `null` |

***

### SiemDestination

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-adaptertype"></a> `adapterType` | [`SiemAdapterType`](#siemadaptertype) | - |
| <a id="property-batchsize"></a> `batchSize` | `number` | - |
| <a id="property-config-3"></a> `config?` | `Record`\<`string`, `unknown`\> | The adapter settings, with credentials masked. |
| <a id="property-destinationid"></a> `destinationId` | `string` | - |
| <a id="property-flushintervalms"></a> `flushIntervalMs` | `number` | - |
| <a id="property-isactive-1"></a> `isActive` | `boolean` | - |
| <a id="property-lasterror-1"></a> `lastError?` | `string` \| `null` | Absent on the create response, which reports no health yet. |
| <a id="property-lastheartbeatat-1"></a> `lastHeartbeatAt?` | `string` \| `null` | Absent on the create response, which reports no health yet. |
| <a id="property-name-16"></a> `name` | `string` | - |
| <a id="property-signingsecret-2"></a> `signingSecret?` | `string` | A webhook destination's signing secret, only in the response that made it. |
| <a id="property-sourcetables"></a> `sourceTables` | `string`[] | Empty means the default set: every source except the opt-in ones. |

***

### SiemDestinationInput

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-adaptertype-1"></a> `adapterType` | [`SiemAdapterType`](#siemadaptertype) | - |
| <a id="property-batchsize-1"></a> `batchSize?` | `number` | - |
| <a id="property-config-4"></a> `config` | `Record`\<`string`, `unknown`\> | Adapter settings, credentials included; the control plane encrypts them and masks them on every read. |
| <a id="property-flushintervalms-1"></a> `flushIntervalMs?` | `number` | - |
| <a id="property-name-17"></a> `name` | `string` | - |
| <a id="property-sourcetables-1"></a> `sourceTables?` | `string`[] | - |

***

### SiemDestinationList

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-items"></a> `items` | [`SiemDestinationSummary`](#siemdestinationsummary)[] |
| <a id="property-sources"></a> `sources` | [`SiemSources`](#siemsources) |

***

### SiemDestinationUpdate

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-batchsize-2"></a> `batchSize?` | `number` | - |
| <a id="property-config-5"></a> `config?` | `Record`\<`string`, `unknown`\> | - |
| <a id="property-flushintervalms-2"></a> `flushIntervalMs?` | `number` | - |
| <a id="property-isactive-2"></a> `isActive?` | `boolean` | `true` turns a deleted (deactivated) destination back on. |
| <a id="property-name-18"></a> `name?` | `string` | - |
| <a id="property-sourcetables-2"></a> `sourceTables?` | `string`[] | - |

***

### SiemSecretRotation

#### Extends

- [`SigningSecretRotation`](#signingsecretrotation)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-destinationid-1"></a> `destinationId` | `string` | - | - |
| <a id="property-signingsecret-3"></a> `signingSecret` | `string` | Shown once: not retrievable again after this response. | [`SigningSecretRotation`](#signingsecretrotation).[`signingSecret`](#property-signingsecret-4) |

***

### SiemSources

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-all"></a> `all` | `string`[] |
| <a id="property-defaults"></a> `defaults` | `string`[] |

***

### SignedIntegrityRoot

The fields of a sealed root its signature covers, as
`GET /api/v1/integrity/roots/:rootId` serves them: what
`verifyIntegrityRoot` reads.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-leaf_schema_version-1"></a> `leaf_schema_version` | `number` | - |
| <a id="property-loop_run_id-2"></a> `loop_run_id` | `string` \| `null` | - |
| <a id="property-merkle_root-1"></a> `merkle_root` | `string` | - |
| <a id="property-previous_root"></a> `previous_root?` | `string` \| `null` | The chain link; in the signed bytes from preimage version 2 on. |
| <a id="property-signature-2"></a> `signature` | `string` \| `null` | - |
| <a id="property-signature_alg-1"></a> `signature_alg` | `string` \| `null` | - |
| <a id="property-signing_key_id-1"></a> `signing_key_id` | `string` \| `null` | - |
| <a id="property-signing_preimage_version"></a> `signing_preimage_version?` | `number` | The preimage the signature covers; absent from a control plane older than the column, which means 1. |
| <a id="property-workspace_id-1"></a> `workspace_id` | `string` | - |

***

### SigningJwks

The control plane's published signing keys, one per `kid`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-keys"></a> `keys` | `Record`\<`string`, `unknown`\>[] |

***

### SigningSecretRotation

#### Extended by

- [`NotificationSecretRotation`](#notificationsecretrotation)
- [`SiemSecretRotation`](#siemsecretrotation)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-signingsecret-4"></a> `signingSecret` | `string` | Shown once: not retrievable again after this response. |

***

### SopCreateResult

The created SOP: `POST /api/v1/sops` answers with the SOP itself (it sends no `ok`).

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-complexitytier"></a> `complexityTier` | `string` |
| <a id="property-isactive-3"></a> `isActive` | `boolean` |
| <a id="property-lifecyclestate"></a> `lifecycleState` | `string` |
| <a id="property-markdowncontent"></a> `markdownContent` | `string` |
| <a id="property-risktier-1"></a> `riskTier` | `string` |
| <a id="property-sopid-2"></a> `sopId` | `string` |
| <a id="property-title-5"></a> `title` | `string` |
| <a id="property-version-3"></a> `version` | `string` |
| <a id="property-workspaceid-7"></a> `workspaceId` | `string` |

***

### SopDetail

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-markdowncontent-1"></a> `markdownContent` | `string` | - |
| <a id="property-risktier-2"></a> `riskTier` | `string` \| `null` | Null for a SOP stored without one. |
| <a id="property-sopid-3"></a> `sopId` | `string` | - |
| <a id="property-title-6"></a> `title` | `string` | - |
| <a id="property-version-4"></a> `version` | `string` | - |

***

### SopInput

The body `intutic sops push` sends, in the route's snake_case.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-complexity_tier"></a> `complexity_tier?` | `string` |
| <a id="property-markdown_content-1"></a> `markdown_content` | `string` |
| <a id="property-risk_tier-1"></a> `risk_tier?` | `string` |
| <a id="property-title-7"></a> `title` | `string` |
| <a id="property-version-5"></a> `version?` | `string` |

***

### SopSummary

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-contenthash-1"></a> `contentHash?` | `string` |
| <a id="property-sopid-4"></a> `sopId` | `string` |
| <a id="property-title-8"></a> `title` | `string` |

***

### StartDomainVerificationResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-domain-2"></a> `domain` | `string` |
| <a id="property-expiresat-2"></a> `expiresAt` | `string` |
| <a id="property-txtrecordname-1"></a> `txtRecordName` | `string` |
| <a id="property-txtrecordvalue-1"></a> `txtRecordValue` | `string` |
| <a id="property-verificationid-2"></a> `verificationId` | `string` |

***

### StartLoopRunOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-autojudge"></a> `autoJudge?` | `boolean` | - |
| <a id="property-budgetlimitusd-1"></a> `budgetLimitUsd?` | `string` \| `number` | - |
| <a id="property-sops"></a> `sops?` | `string`[] | SOP names active for the run. |

***

### Team

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-createdat-6"></a> `createdAt` | `string` |
| <a id="property-name-19"></a> `name` | `string` |
| <a id="property-orgid-2"></a> `orgId` | `string` |
| <a id="property-slug"></a> `slug` | `string` |
| <a id="property-teamid-1"></a> `teamId` | `string` |

***

### TeamUsage

#### Extends

- [`UsageTotals`](#usagetotals)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-activemembers"></a> `activeMembers` | `number` | - |
| <a id="property-displayname-1"></a> `displayName` | `string` | - |
| <a id="property-groupid"></a> `groupId` | `string` | - |
| <a id="property-membercount-1"></a> `memberCount` | `number` | - |
| <a id="property-totalcostusd-4"></a> `totalCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalCostUsd`](#property-totalcostusd-5) |
| <a id="property-totalinputtokens-4"></a> `totalInputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalInputTokens`](#property-totalinputtokens-5) |
| <a id="property-totaloutputtokens-4"></a> `totalOutputTokens` | `number` | [`UsageTotals`](#usagetotals).[`totalOutputTokens`](#property-totaloutputtokens-5) |
| <a id="property-totalrawcostusd-4"></a> `totalRawCostUsd` | `number` | [`UsageTotals`](#usagetotals).[`totalRawCostUsd`](#property-totalrawcostusd-5) |
| <a id="property-tracecount-4"></a> `traceCount` | `number` | [`UsageTotals`](#usagetotals).[`traceCount`](#property-tracecount-5) |

***

### TeamUsageResponse

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-scimgroups"></a> `scimGroups` | `boolean` | False when the workspace has no SCIM groups, so there are no teams. |
| <a id="property-teams"></a> `teams` | [`TeamUsage`](#teamusage)[] | - |

***

### TokenCoverage

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-guardrails-2"></a> `guardrails` | `object`[] |
| <a id="property-passages-3"></a> `passages` | `object`[] |
| <a id="property-token-4"></a> `token` | `string` |

***

### TraceDetail

#### Indexable

```ts
[key: string]: unknown
```

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-actualcostusd"></a> `actualCostUsd` | `number` |
| <a id="property-actualmodelrouted"></a> `actualModelRouted` | `string` |
| <a id="property-enforcementaction-1"></a> `enforcementAction` | `string` |
| <a id="property-requestedmodel"></a> `requestedModel` | `string` |
| <a id="property-requestid"></a> `requestId` | `string` |
| <a id="property-sessionid-1"></a> `sessionId` | `string` |
| <a id="property-timestamp"></a> `timestamp` | `string` |
| <a id="property-traceid"></a> `traceId` | `string` |

***

### TraceFilters

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-enforcement"></a> `enforcement?` | `"BYPASS"` \| `"ENHANCE"` \| `"HIJACK"` \| `"KILL"` | - |
| <a id="property-limit-3"></a> `limit?` | `number` | 1 to 100; default 20. |
| <a id="property-model-3"></a> `model?` | `string` | - |
| <a id="property-offset"></a> `offset?` | `number` | - |
| <a id="property-since-1"></a> `since?` | `string` | ISO 8601, or a relative duration such as `24h` or `7d`. |

***

### TraceList

`listProperty` and `rowCase`, which every control-plane list response carries beside its rows.

#### Extends

- [`ListEnvelope`](#listenvelope)

#### Properties

| Property | Type | Inherited from |
| ------ | ------ | ------ |
| <a id="property-limit-4"></a> `limit?` | `number` | - |
| <a id="property-listproperty-4"></a> `listProperty?` | `string` | [`ListEnvelope`](#listenvelope).[`listProperty`](#property-listproperty-2) |
| <a id="property-offset-1"></a> `offset?` | `number` | - |
| <a id="property-rowcase-4"></a> `rowCase?` | `"snake"` \| `"camel"` \| `"mixed"` | [`ListEnvelope`](#listenvelope).[`rowCase`](#property-rowcase-2) |
| <a id="property-total"></a> `total` | `number` | - |
| <a id="property-traces"></a> `traces` | [`TraceSummary`](#tracesummary)[] | - |

***

### TraceSummary

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-actualcostusd-1"></a> `actualCostUsd` | `number` |
| <a id="property-actualmodelrouted-1"></a> `actualModelRouted` | `string` |
| <a id="property-anomalydetected"></a> `anomalyDetected` | `string` \| `null` |
| <a id="property-breakglass"></a> `breakGlass?` | `boolean` |
| <a id="property-breakglassrequestid"></a> `breakGlassRequestId?` | `string` \| `null` |
| <a id="property-compliancescore"></a> `complianceScore` | `number` |
| <a id="property-enforcementaction-2"></a> `enforcementAction` | `string` |
| <a id="property-requestedmodel-1"></a> `requestedModel` | `string` |
| <a id="property-timestamp-1"></a> `timestamp` | `string` |
| <a id="property-traceid-1"></a> `traceId` | `string` |

***

### UpstreamCalls

The proxy's `x-intutic-upstream-attempts` / `x-intutic-upstream-fallback-from` headers, read.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-attempts"></a> `attempts` | `number` |
| <a id="property-fallbackfrom"></a> `fallbackFrom?` | `string` |

***

### UsageOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-period"></a> `period?` | [`UsagePeriod`](#usageperiod) | Default `monthly`. |

***

### UsageTotals

#### Extended by

- [`MemberUsage`](#memberusage)
- [`TeamUsage`](#teamusage)
- [`BranchUsage`](#branchusage)
- [`CommitUsage`](#commitusage)
- [`PullRequestUsage`](#pullrequestusage)

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-totalcostusd-5"></a> `totalCostUsd` | `number` |
| <a id="property-totalinputtokens-5"></a> `totalInputTokens` | `number` |
| <a id="property-totaloutputtokens-5"></a> `totalOutputTokens` | `number` |
| <a id="property-totalrawcostusd-5"></a> `totalRawCostUsd` | `number` |
| <a id="property-tracecount-5"></a> `traceCount` | `number` |

***

### WasmReplayOptions

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-limit-5"></a> `limit?` | `number` | - |
| <a id="property-since-2"></a> `since?` | `string` | ISO 8601. |

***

### WasmReplayResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-contextcount"></a> `contextCount` | `number` |
| <a id="property-ruleid-4"></a> `ruleId` | `string` |
| <a id="property-samplematches"></a> `sampleMatches` | `Record`\<`string`, `unknown`\>[] |
| <a id="property-since-3"></a> `since` | `string` \| `null` |
| <a id="property-verdictcounts"></a> `verdictCounts` | `Record`\<`string`, `number`\> |
| <a id="property-wouldactcount"></a> `wouldActCount` | `number` |
| <a id="property-wouldactrate-1"></a> `wouldActRate` | `number` |

***

### WhoamiResult

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-email-2"></a> `email` | `string` |
| <a id="property-memberid-2"></a> `memberId` | `string` |
| <a id="property-role-1"></a> `role` | `string` |
| <a id="property-workspaceid-8"></a> `workspaceId` | `string` |

***

### Workspace

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-createdat-7"></a> `createdAt` | `string` |
| <a id="property-name-20"></a> `name` | `string` |
| <a id="property-plantier-1"></a> `planTier` | `string` |
| <a id="property-slug-1"></a> `slug` | `string` |
| <a id="property-workspaceid-9"></a> `workspaceId` | `string` |

***

### WorkspaceSettings

#### Extended by

- [`WorkspaceSettingsUpdateResult`](#workspacesettingsupdateresult)

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-settings"></a> `settings` | `Record`\<`string`, `unknown`\> | Every setting, resolved with its default. |
| <a id="property-workspaceid-10"></a> `workspaceId` | `string` | - |

***

### WorkspaceSettingsUpdateResult

#### Extends

- [`WorkspaceSettings`](#workspacesettings)

#### Properties

| Property | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ |
| <a id="property-settings-1"></a> `settings` | `Record`\<`string`, `unknown`\> | Every setting, resolved with its default. | [`WorkspaceSettings`](#workspacesettings).[`settings`](#property-settings) |
| <a id="property-updated"></a> `updated` | `true` | - | - |
| <a id="property-workspaceid-11"></a> `workspaceId` | `string` | - | [`WorkspaceSettings`](#workspacesettings).[`workspaceId`](#property-workspaceid-10) |

## Type Aliases

### CoverageFormat

```ts
type CoverageFormat = "json" | "md" | "csv" | "pdf";
```

The coverage report formats: `md` is markdown.

***

### EventCallback

```ts
type EventCallback = (data) => void | Promise<void>;
```

Called with the refusal before `chat()` throws it as a `ClawdeBlockedError`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | \{ `budgetPctUsed?`: `number`; `budgetRemainingUsd?`: `number`; `code`: `string`; `message`: `string`; `ruleId?`: `string`; `status`: `number`; `verdict`: [`Verdict`](#verdict) \| [`LegacyVerdict`](#legacyverdict); \} | - |
| `data.budgetPctUsed?` | `number` | **Deprecated** Never set. |
| `data.budgetRemainingUsd?` | `number` | **Deprecated** Never set. |
| `data.code` | `string` | The proxy's refusal code, e.g. `policy_denied`, `OVERAGE_HARD_CAP_EXCEEDED` or `TOOL_DENIED`. |
| `data.message` | `string` | - |
| `data.ruleId?` | `string` | The rule that decided, when the proxy names one. |
| `data.status` | `number` | - |
| `data.verdict` | [`Verdict`](#verdict) \| [`LegacyVerdict`](#legacyverdict) | One of the `RefusalVerdict` values; typed wider so listeners written against 2.0 compile. |

#### Returns

`void` \| `Promise`\<`void`\>

***

### EvidenceSignatureState

```ts
type EvidenceSignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "keys_unavailable";
```

***

### FindingOutcome

```ts
type FindingOutcome = "TRUE_POSITIVE" | "FALSE_POSITIVE";
```

***

### GuardrailProvenance

```ts
type GuardrailProvenance = "extracted" | "authored";
```

***

### GuardrailStatus

```ts
type GuardrailStatus = "PROPOSED" | "SHADOW" | "ENFORCING" | "REJECTED" | "RETIRED";
```

***

### GuardrailTarget

```ts
type GuardrailTarget = "hook_rule" | "sop_front_matter" | "wasm_rule" | "workspace_setting";
```

***

### IntegrityRootSignatureState

```ts
type IntegrityRootSignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "keys_unavailable";
```

What `verifyIntegrityRoot` established: `valid` a published key accepted
the signature, `invalid` the key the root names rejected it, `unsigned` no
key was configured when it was sealed, `unverifiable` the key is not
published or the root names an algorithm or preimage version this build
cannot check, `keys_unavailable` no key set was given. Only `invalid` says
the root changed.

***

### ~~LegacyVerdict~~

```ts
type LegacyVerdict = "hijack" | "enhance" | "bypass";
```

#### Deprecated

Never reported. The proxy applies these inside the response and
does not tell the client, so no response carries them and no event fires for
them. Still accepted so code written against 2.0 compiles; they will be
removed in the next major version.

***

### LoopRunStatus

```ts
type LoopRunStatus = "ACTIVE" | "PENDING_REVIEW" | "COMPLETED" | "FAILED" | "KILLED";
```

***

### MirrorAdoptionReport

```ts
type MirrorAdoptionReport = 
  | {
  averageCostDeltaUsd: number | null;
  averageLatencyDeltaMs: number | null;
  candidateBetter: number;
  candidateModel: string;
  faultRateDelta: number | null;
  originalBetter: number;
  sampleCount: number;
  sufficientData: true;
  tie: number;
  unjudged: number;
}
  | {
  candidateModel: string;
  minimumRequired: number;
  reason: string;
  sampleCount: number;
  sufficientData: false;
};
```

***

### NotificationChannel

```ts
type NotificationChannel = "slack" | "email" | "webhook" | "pagerduty";
```

***

### NotificationRuleUpdate

```ts
type NotificationRuleUpdate = Partial<NotificationRuleInput>;
```

An update sends only the fields that change; `channelConfig` and `filters` replace the stored ones whole.

***

### PolicySourceProvider

```ts
type PolicySourceProvider = "notion" | "confluence" | "github" | "gdrive";
```

The connector providers that are policy sources.

***

### RefusalVerdict

```ts
type RefusalVerdict = "kill" | "reask" | "hold";
```

A governance refusal the proxy answered with: `kill` blocks the request, `reask`
refuses this attempt and tells the agent to revise it (it escalates to `kill`
after repeated attempts), and `hold` pauses a loop run until a human reviews it.

***

### SiemAdapterType

```ts
type SiemAdapterType = 
  | "syslog_cef"
  | "webhook_https"
  | "gcs"
  | "s3"
  | "splunk_hec"
  | "datadog_logs";
```

***

### SiemDestinationSummary

```ts
type SiemDestinationSummary = Omit<SiemDestination, "config" | "signingSecret">;
```

A destination as the list answers it: no adapter settings, and no signing secret.

***

### UsagePeriod

```ts
type UsagePeriod = "daily" | "monthly";
```

***

### UsageScope

```ts
type UsageScope = "workspace" | "self";
```

`self` when the caller may see only their own calls (below OWNER, ADMIN and EM).

***

### Verdict

```ts
type Verdict = "allow" | RefusalVerdict;
```

What `chat()` can know about a request: it was let through, or refused.

***

### VerdictEvent

```ts
type VerdictEvent = RefusalVerdict | LegacyVerdict;
```

Events `on()` accepts.

## Variables

### PROXY\_REFUSALS

```ts
const PROXY_REFUSALS: Readonly<Record<string, {
  status: number;
  verdict: RefusalVerdict;
}>>;
```

The proxy's governance refusals, by code, with the status the proxy sends
each with and the verdict it represents.

Most arrive as an error: the code is the `error.type` of the proxy's JSON
error body (`{"error": {"type", "message"}}`, `json_error` in
packages/proxy/src/proxy.rs). Matching on the status and the code together
matters because the same statuses also carry errors that are not decisions:
a provider's own 429 rate limit, a 403 for a key used against the wrong
workspace, a 400 for a malformed body. Those are not refusals and must not
be reported as one.

The rest (status 200, and `COST_GATE_EXCEEDED` on a non-streaming request)
arrive in band: an assistant turn explaining the refusal, named by
`REFUSAL_HEADER`, or on a stream by the `STREAM_REFUSAL_MARKER` comment line.

`__tests__/refusals.test.ts` holds this table to
packages/shared-types/fixtures/refusal-codes.json, the one list the proxy
and the Python SDK are held to as well, so a refusal the proxy adds or
renames fails the build instead of silently turning back into an `allow` or
a retried connection error.

***

### REFUSAL\_HEADER

```ts
const REFUSAL_HEADER: "x-intutic-refusal" = 'x-intutic-refusal';
```

The headers the proxy sets on a 200 that is a refusal in the shape of an
answer: the response gate withheld a tool call the model made, output DLP
withheld the body, or the cost-prediction gate answered instead of the
model. The first names the refusal's code, the second the rule that decided.

***

### REFUSAL\_RULE\_HEADER

```ts
const REFUSAL_RULE_HEADER: "x-intutic-refusal-rule" = 'x-intutic-refusal-rule';
```

***

### STREAM\_REFUSAL\_MARKER

```ts
const STREAM_REFUSAL_MARKER: ": intutic-refusal " = ': intutic-refusal ';
```

The prefix of the SSE comment line that names a refusal on a stream:
`: intutic-refusal {"code", "rule", "message"}`. The response headers went
out before the refusal happened, so a stream says it in band; every SSE
parser skips comment lines, so clients that do not look for it are
unaffected.

***

### UPSTREAM\_ATTEMPTS\_HEADER

```ts
const UPSTREAM_ATTEMPTS_HEADER: "x-intutic-upstream-attempts" = 'x-intutic-upstream-attempts';
```

Set by the proxy when its retry layer made more than one upstream call.

***

### UPSTREAM\_FALLBACK\_HEADER

```ts
const UPSTREAM_FALLBACK_HEADER: "x-intutic-upstream-fallback-from" = 'x-intutic-upstream-fallback-from';
```

Set by the proxy when a fallback answered: the model whose retries ran out.

## Functions

### normalizeRequest()

```ts
function normalizeRequest(params, provider?): any;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | [`ChatParams`](#chatparams) |
| `provider?` | `string` |

#### Returns

`any`

***

### normalizeResponse()

```ts
function normalizeResponse(response, provider?): ChatResponse;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `response` | `any` |
| `provider?` | `string` |

#### Returns

[`ChatResponse`](#chatresponse)

***

### resolveContext()

```ts
function resolveContext(): Promise<ResolvedContext>;
```

Each field comes from `~/.intutic/config.json` when that file carries it,
and from the environment otherwise. The file `intutic init` writes holds
none of these fields, so reading it must not hide the environment.

#### Returns

`Promise`\<[`ResolvedContext`](#resolvedcontext)\>

***

### streamRefusal()

```ts
function streamRefusal(text): ProxyRefusal | null;
```

The refusal named anywhere in a stream's text, or `null` when there is
none. Pass the whole body, or each line as it arrives.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |

#### Returns

[`ProxyRefusal`](#proxyrefusal) \| `null`

***

### verifyEvidenceArchive()

```ts
function verifyEvidenceArchive(archive, jwks): EvidenceVerification;
```

Checks an evidence archive the way it was sealed: the manifest's hashes,
then the signature over the archive hash against the published key its
`keyId` names (`jwks`, from `ControlPlaneClient.getSigningKeys()` or a saved
copy; null when it could not be had).

`verified` is true only for an archive whose hashes match and whose
signature a published key accepts. An unsigned archive, or one whose key is
not published, is not verified even when its hashes match: nothing then
shows who produced it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `archive` | [`EvidenceArchive`](#evidencearchive) |
| `jwks` | [`SigningJwks`](#signingjwks) \| `null` |

#### Returns

[`EvidenceVerification`](#evidenceverification)

***

### verifyIntegrityRoot()

```ts
function verifyIntegrityRoot(root, jwks): IntegrityRootSignatureState;
```

Checks a sealed root's signature against the published key the root itself
names (`jwks`, from `ControlPlaneClient.getSigningKeys()` or a saved copy;
null when it could not be had). Pass the `root` of
`ControlPlaneClient.getIntegrityRoot()`.

Only `invalid` says the root was changed: a published key rejected it.
`unverifiable` (the key is not published, or the root names an algorithm or
preimage version this build cannot check) and `keys_unavailable` are no
verdict, and `unsigned` is a deployment that had no signing key. The key is
chosen by `signing_key_id` and never by trying others: a root that verifies
under some other key is not the same claim.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `root` | [`SignedIntegrityRoot`](#signedintegrityroot) |
| `jwks` | [`SigningJwks`](#signingjwks) \| `null` |

#### Returns

[`IntegrityRootSignatureState`](#integrityrootsignaturestate)
