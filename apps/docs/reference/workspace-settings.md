# Workspace Settings <Badge type="tip" text="Cloud" />

Every key a workspace's settings accept, with the values each one takes and what it changes. The dashboard, the [CLI](/reference/cli#intutic-settings-get-key), [Terraform](/reference/terraform/resources/workspace_settings) and the [REST API](/reference/api) all write the same settings through one endpoint, so the same keys and bounds apply everywhere.

## Reading settings

```
GET /api/v1/workspace/settings
```

Any member of the workspace can read them. The response is `{ "workspaceId": ..., "settings": { ... } }`: the stored settings with a default filled in for each key that has one and is not set. A key with no default and no stored value is left out. Storage credentials in `byocStorage` come back as `__redacted__`.

The response can also carry keys that are not on this page and cannot be written with `PUT`:

- `ssoKeyGateEnabledAt`: when `ssoKeyMaxIdleDays` was switched on, stamped by the server so the SSO-recency window starts from that moment. It is set when `ssoKeyMaxIdleDays` goes from unset or `null` to a number, kept when the window is changed, and removed when it is set back to `null`.
- `appliedSecurityPosture` and `appliedCostPosture`: the [posture](/guide/settings#postures) last applied, written by `POST /api/v1/workspace/posture`. Changing one of a posture's settings by hand removes its label.

## Writing settings

```bash
curl -X PUT "$INTUTIC_CONTROL_PLANE_URL/api/v1/workspace/settings" \
  -H "Authorization: Bearer $INTUTIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mcpDefaultPolicy": "deny", "featureFlags": {"ff_shadow_enforcement": true}}'
```

- **Who:** the OWNER or ADMIN role. Any other role gets `403`.
- **Strict:** a top-level key not listed on this page is refused with `400` naming it, and nothing is stored. So is a value outside the bounds below. Inside every object (`featureFlags`, `imageProvenance`, `anomaly_enforcement`, `banditKeywords`, `byocStorage`, `loop_review`, `mcpBudgets`, `sso_group_policy`) an unknown field is refused the same way, named. `managedJudgeModel`, `typedJudgeBackend` and `typedJudgeBackendAck` are no longer settings; a body carrying one is refused with a `400` that says why.
- **At least one key.** An empty body is refused.
- **Only the keys you send change.** Each top-level key you send replaces its stored value whole: send all of an object's fields, or the ones you leave out are gone. The exceptions:
  - `featureFlags` merges flag by flag, so `{"featureFlags": {"ff_shadow_enforcement": true}}` leaves every other flag as it was.
  - `byocStorage` keeps the stored `secretAccessKey` and `credentials` when the update leaves them out or sends `__redacted__`, so a bucket or prefix change does not need the secrets again.
  - `sso_group_policy` and `piiDetectors` take `null`, which removes the stored value.
- **Plan:** a non-null `sso_group_policy` needs a plan with single sign-on, <Badge type="warning" text="Biz Org+" />; on other plans it is refused with `403`. Clearing it with `null` works on every plan.

The response is `{ "updated": true, "workspaceId": ..., "settings": { ... } }`, the full settings after the change, in the same form as `GET`. Every change is recorded in the settings history on the [Audit Timeline](/guide/audit-timeline).

### From the CLI

`intutic settings get [key]` reads the settings or one of them, and `intutic settings set <key> (<value> | --file <path>)` sends a `PUT` with that one key. See [`intutic settings get`](/reference/cli#intutic-settings-get-key) and [`intutic settings set`](/reference/cli#intutic-settings-set-value).

```bash
intutic settings get mcpBudgets --json
intutic settings set sandboxRequirement require
intutic settings set featureFlags '{"ff_bandit_routing": true}'
```

### From Terraform

[`intutic_workspace_settings`](/reference/terraform/resources/workspace_settings) manages the keys named in its `settings` and leaves the rest alone. It checks top-level keys and feature flags against the same list as this page, so a misspelt one fails the plan.

## Settings

Types are JSON types. "Absent" is what an unset key with no default means. Lengths are in characters.

### MCP proxy

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `mcpProxyFailBehavior` | `open` \| `closed` | `open` | What the MCP proxy does with a tool call when a governance check cannot complete because the control plane is unreachable: `open` lets it run and sends a warning event, `closed` refuses it. See [MCP Proxy Enforcement](/guide/settings#mcp-proxy-enforcement) |
| `mcpProxyMode` | `per-session` \| `daemon` | `per-session` | Written to each machine's runtime environment as `INTUTIC_MCP_PROXY_MODE`. With `daemon`, MCP proxies make their policy lookups through the long-lived MCP daemon's socket instead of each holding its own cache |
| `mcpDefaultPolicy` | `allow` \| `deny` | absent, read as `allow` | What MCP proxies do with a server the workspace's registry has not approved: `allow` lets it run unless it is blocked, `deny` refuses it until an owner or admin approves it. See [The registry](/guide/mcp-governance#the-registry) |
| `mcpAllowedServers` | array of strings, each 1–256, at most 500 | absent | Server names MCP proxies will proxy. Empty or absent means any server. See [The allowlist](/guide/mcp-governance#the-allowlist-mcpallowedservers) |
| `mcpAllowedTools` | array of strings, each at least 1, at most 500 | absent | Tool names MCP proxies let an agent call. Empty or absent means any tool. See [Decisions and directions](/integrations/mcp-proxy#decisions-and-directions) |
| `mcpToolDescriptionOverrides` | object of tool name → string of at most 4000 | absent | Replacement descriptions MCP proxies put in `tools/list` responses before the model sees them |
| `mcpHighRiskToolChange` | `notify` \| `hold` | absent, read as `notify` | What a high-risk change to a server's tool set does: `notify` records it and sends an event, `hold` also returns the server to the approval queue. See [Tool-change risk](/guide/mcp-governance#tool-change-risk) |
| `mcpBudgets` | object: `budgets` (array of at most 200 budgets, required) and `warnAtPct` (integer 1–99). A budget is `id` (letters, digits, `-` and `_`, at most 40, unique), `scope` (`server` \| `tool` \| `member` \| `member_server`), `server`, `tool` and `memberId` as the scope requires, `period` (`hour` \| `day`) and `limit` (integer 1–1,000,000) | absent (no limits) | Limits on MCP tool calls per hour or per day. MCP proxies count calls and refuse one that would go over a limit. See [Call budgets](/guide/mcp-governance#call-budgets) |
| `mcpInjectionAction` | `warn` \| `block` | absent | What MCP proxies do when a prompt-injection pattern matches: `warn` reports it, `block` refuses the call or withholds the result. Absent leaves each proxy's `INTUTIC_MCP_INJECTION_ACTION` (default `warn`). See [Prompt-injection scanning](/guide/mcp-governance#prompt-injection-scanning) |
| `mcpInjectionPatterns` | array of strings, each 1–512, at most 200 | absent | Extra prompt-injection regular expressions MCP proxies check on top of their built-in patterns. A pattern that does not compile is dropped |
| `mcpAnomalyMode` | `enforce` \| `warn` \| `off` | absent | The MCP proxy's anomaly detectors: `enforce` lets each act up to its own ceiling, `warn` reports without blocking, `off` skips them. Absent leaves each proxy's `INTUTIC_MCP_ANOMALY_MODE` (default `enforce`). See [Configuration reference](/guide/mcp-governance#configuration-reference) |
| `mcpAnomalyOverrides` | object of detector id (`consecutive_repeat`, `ping_pong_cycle`, `landmark_cycle`, `tool_diversity_collapse`, `code_as_action`, `tool_poisoning`, `dlp_escalation`) → `steer` \| `reask` \| `kill` \| `off` | absent | Per-detector actions. A value can lower a detector below its ceiling, never raise it. Wins over `INTUTIC_MCP_ANOMALY_OVERRIDES`, detector by detector |

### Models, egress and data

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `allowedModels` | array of strings, each 1–256, at most 512 | absent | Model ids the proxy accepts for the workspace's requests. Empty or absent means any model. See [Approved Models](/guide/settings#approved-models) |
| `egressMode` | `off` \| `monitor` \| `enforce` | absent | The egress posture every proxy in the workspace takes. Absent leaves each proxy on its local config; `off` turns central egress control off. See [Network Egress Control](/guide/policies#network-egress-control) |
| `egressAllow` | array of strings, each 1–256, at most 512 | absent | Hosts, `.suffix` domains or CIDRs the proxies allow under `monitor` and `enforce`, added to each proxy's local allow list |
| `piiDetectors` | object of detector id (`pii.card`, `pii.iban`, `pii.ssn`, `pii.email`, `pii.phone`) → `off` \| `redact` \| `block`, or `null` | absent | The baseline action of each PII detector for the workspace's traffic. A machine's own config may only tighten it; a detector left out keeps each machine's own setting. `null` removes it. See [Setting detector actions for a workspace](/guide/policies#setting-detector-actions-for-a-workspace) |
| `allowLocalMemoryVaults` | boolean | `true` | Whether the proxy's search of local notes vaults (Obsidian, Logseq, Foam) for `/fix` may run. `false` starts the proxy with `INTUTIC_LOCAL_VAULTS=off` from the next `intutic connect`. Vault content never leaves the machine either way |
| `configBodyUpload` | boolean | `false` | Whether `intutic connect` uploads the text of harness config files, with credentials redacted, and not only their hashes. See [Harness Config History](/guide/settings#harness-config-history) |
| `byocStorage` | object: `provider` (`gcs` \| `s3` \| `disabled`, required), `bucketName` (1–255), `prefix` (at most 255), `projectId` (at most 128), `region` (at most 64), `accessKeyId` (at most 256), `secretAccessKey` (at most 1024), `credentials` (at most 8192), `mode` (`mirror` \| `primary`) | absent | Trace storage in a bucket you own: traces are copied to it (`mirror`) or kept only there (`primary`). The secrets are encrypted at rest and never returned. See [General](/guide/settings#general) |

### Routing and cost

The workspace's spend caps are not settings on this page: set them on **Settings › Billing › Budget Limits** or with `PUT /api/v1/budget`, not with `intutic settings` or `intutic_workspace_settings`. A workspace that has not saved a daily cap is held to $100 a day. See [Budgets](/guide/budgets#workspace-caps).

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `featureFlags` | object of the flags below, each a boolean | every flag off | Switches for routing, caching and automatic changes. Merged flag by flag on write. See [Feature flags](#feature-flags) |
| `banditKeywords` | object of `testing`, `deployment`, `review`, `debugging`, each an array of keywords. A keyword is trimmed and lower-cased, then must be 2–19 letters and digits, or `ci/cd` | built-in lists | The trigger words the proxy uses to classify a prompt's task type for routing. See [Configure Custom Task Trigger Words](/guide/intelligent-routing#step-2-configure-custom-task-trigger-words) |
| `contractedRates` | object of model id (1–128) → `{ "inputCostPer1k": number, "outputCostPer1k": number }`, each 0–1000 | absent | Your negotiated prices in USD per 1,000 tokens. The routing shadow-savings report prices a listed model at these rates; other models stay at list price. See [Contracted Model Rates](/guide/settings#contracted-model-rates) |
| `enforcement_mode` | `soft` \| `hard` | absent (`soft`) | With `workspace_hard_cap_enabled: true`, `hard` turns the plan's daily spend cap into a block: once the day's spend is over it, the proxy refuses every request with `429 OVERAGE_HARD_CAP_EXCEEDED` until midnight UTC. The control plane checks every five minutes. See [Plan daily cap](/guide/budgets#plan-daily-cap) |
| `workspace_hard_cap_enabled` | boolean | absent (`false`) | The second half of the plan daily cap's block: it blocks only when this is `true` and `enforcement_mode` is `hard` |

### Identity and review

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `ssoKeyMaxIdleDays` | integer 1–365, or `null` | `30` | Days without an SSO sign-in after which a member's API keys stop authenticating. `null` turns it off. Applies only in a workspace with an SSO provider, and not to automation keys. See [Making IdP removal sufficient](/guide/security#making-idp-removal-sufficient) |
| `sso_group_policy` | object: `highRiskTools`, `requiredGroups`, `requireOboFor`, each an array of names (each 1–256, at most 500, default empty); or `null` | absent | Tools only members of the named identity-provider groups may run, and tools only an on-behalf-of token may call. `null` removes it. Needs <Badge type="warning" text="Biz Org+" />. See [SSO group clearance](/concepts/circuit-breaker#_3-sso-group-clearance) |
| `reviewHoldBypassEnabled` | boolean | `false` | Whether approving a held call lets the identical retry through for `reviewHoldBypassTtlMinutes`. Off, approval records the decision only. See [Approval holds](/guide/mcp-governance#approval-holds) |
| `reviewHoldBypassTtlMinutes` | integer 1–60 | `10` | How long an approved retry stays allowed, when `reviewHoldBypassEnabled` is on |
| `loop_review` | object: `requireDistinctApprover` (boolean) | `{ "requireDistinctApprover": false }` | With `requireDistinctApprover` on, the member who started a held loop run cannot approve or reject it. See [`intutic loop review`](/reference/cli#intutic-loop-review) |
| `sandboxRequirement` | `off` \| `warn` \| `require` | absent, read as `off` | Whether `intutic exec` must run sandboxed: `warn` prints a warning when it is not, `require` refuses to run without `--sandbox`. See [Enforcement levels](/guide/sandboxed-execution#enforcement-levels) |
| `imageProvenance` | object: `enabled` (boolean), `requireDigest` (boolean), `allowedRegistries` (array of strings, each 1–256, at most 64), `approvedDigests` (object of repository (1–512) → array of at most 256 `sha256:<64 hex>` digests), `unverifiableAction` (`allow` \| `warn` \| `block`) | `enabled: false`, `requireDigest: true`, `allowedRegistries: []`, `approvedDigests: {}`, `unverifiableAction: allow` | The container-image policy checked before a deploy tool call runs: whether images must be pinned to a digest, which registries they may come from, and which digests each repository may use. An empty list or map allows any. `unverifiableAction` decides a call whose images cannot be read from the call itself, such as `kubectl apply -f` on a file |

### Detection and enforcement

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `bypassEnforcementTier` | `rewrite` \| `immutable` \| `alert-only` | `rewrite` | What the sync daemon does when a harness config file it manages is edited by hand: puts the file back, write-protects it with the macOS immutable flag, or records an incident only. See [MCP Proxy Enforcement](/guide/settings#mcp-proxy-enforcement) |
| `anomaly_enforcement` | object: `enabled` (boolean), `minRepeats` (integer 2–1000), `minConfidence` (number 0–1), `action` (`HIJACK` \| `KILL`), `categories` (array of strings, each 1–128, at most 64) | `enabled: false`, `minRepeats: 3`, `minConfidence: 0.8`, `action: HIJACK`, `categories: []` | Turns an anomaly finding repeated within one session into enforcement: once a category has `minRepeats` findings at or above `minConfidence`, `HIJACK` steers the agent with a corrective card and `KILL` blocks. An empty `categories` covers every category. Detection runs whatever this says |
| `trajectory_monitor_mode` | `ACTIVE` \| `PASSIVE` \| `OFF` | `PASSIVE` | `PASSIVE` analyzes each session's trajectory and raises alerts; `ACTIVE` also lets a critical verdict escalate to enforcement in that session; `OFF` skips the analysis. See [Trajectory Monitor](/guide/trajectory-monitor#changing-the-mode) |
| `securityProbeSampleRate` | number 0–1 | `1` | The fraction of ingested traces that get the two heavier security probes, the baseline and history anomaly checks and the output probe. `0` turns those two off; the other ingest checks always run |
| `governanceCardLabelingEnabled` | boolean | `true` | Whether corrective governance cards collect adoption labels for the judge's training data. Off stops label collection only; cards are still created and delivered. See [General](/guide/settings#general) |
| `decisionsLogEnabled` | boolean | `false` | Whether the sync daemon writes recent governance decisions to `.intutic/DECISIONS.md` and the harnesses' instruction files. See [Governed Decisions Log](/guide/decisions-log#turning-it-on) |

### Skills

| Key | Type and bounds | Default | What it does |
|-----|-----------------|---------|--------------|
| `enableLocalSkillAuditDelete` | boolean | `false` | Whether `intutic skill audit` deletes each flagged line from the file it was found in. See [`intutic skill audit`](/reference/cli#intutic-skill-audit) |
| `ciscoSkillScannerEnabled` | boolean | `false` | Whether `intutic skill audit` also runs Cisco's `skill-scanner` when it is on `PATH`, without `--engine cisco`. When it is not, the audit continues with the built-in scanner. See [Cisco `skill-scanner` integration](/guide/skill-scanning#cisco-skill-scanner-integration-opt-in) |
| `semanticSkillAnalysisEnabled` | boolean | `false` | Whether `intutic skill audit` sends each `SKILL.md`'s content with its report for semantic analysis. Only the verdict is stored. See [Semantic analysis](/guide/skill-scanning#semantic-analysis-optional) |
| `virusTotalSkillLookupEnabled` | boolean | `false` | Whether the sha256 hashes of skill-bundled scripts are looked up in VirusTotal when a skill report arrives. Needs a stored VirusTotal key; files are never uploaded. See [Enabling it](/guide/virustotal-scanning#enabling-it) |

## Feature flags

The flags inside `featureFlags`. Each is a boolean, and an unset flag is off.

| Flag | Default | What it does |
|------|---------|--------------|
| `ff_bandit_routing` | `false` | Turns on intelligent model routing in the workspace's proxies. Where this flag is set, it decides instead of the proxy's `routing.enabled`. See [Intelligent Model Routing](/guide/intelligent-routing) |
| `ff_shadow_routing` | unset | Runs the router and records the model it would have picked, while serving the model the request asked for. A separate flag from `ff_bandit_routing`, so shadow routing can be turned off again on its own |
| `ff_response_cache_exact` | `false` | Serves a cached answer to a query identical to an earlier one. See [Smart Model Routing & Response Cache](/guide/settings#smart-model-routing-response-cache) |
| `ff_response_cache_semantic` | `false` | Serves a cached answer to a query equivalent in meaning to an earlier one |
| `ff_shadow_enforcement` | `false` | The proxy evaluates every detector and records what it would have done, then lets the request through |
| `ff_sql_drop_strict_block` | `false` | The hook gate's `destructive.sql_drop` rule blocks instead of warning. On in the strict security posture |
| `ff_metaclaw_evolution` | `false` | Lets the SOP Optimizer run evolution cycles for the workspace. Also needs a plan that includes the SOP Optimizer. See [SOP Optimizer](/guide/metaclaw) |
| `ff_metaclaw_auto_apply` | `false` | Lets a manually triggered SOP Optimizer cycle apply a proposal without review. The scheduled cycle only ever proposes. See [How the SOP Optimizer Works](/guide/metaclaw#how-the-sop-optimizer-works) |
| `ff_skillopt_auto_apply` | `false` | Queues a SkillOpt config-edit suggestion with confidence of at least 0.85 for the sync daemon to apply, without review. See [Configuration Recommendations](/guide/intelligence#configuration-recommendations-skillopt) |
