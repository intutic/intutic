# clawde SDKs (TypeScript & Python) <Badge type="tip" text="Open-Core" />

Programmatic TypeScript and Python client SDKs for intercepting, wrapping, and enforcing governance policies on AI coding scripts.

## Installation

### TypeScript SDK
Install the open-core client SDK directly into your agent scripts or tooling harnesses:

```bash
npm install @intutic/clawde
```

### Python SDK
Install the open-core Python SDK equivalent:

```bash
pip install intutic-clawde
```

**Requires Python 3.10 or newer.** The floor was 3.9 through 1.6.3. It moved
because the patched releases of `requests` and `urllib3` — which carry fixes for
CVE-2026-25645, CVE-2026-44431 and CVE-2026-44432 — themselves require 3.10, so
supporting 3.9 would have meant pinning known-vulnerable transports. Python 3.9
reached end of life in October 2025.

---

## Architecture & Primitives

`ClawdeClient` is a data-plane client for the local Intutic proxy. `chat()` sends an OpenAI-format request to the proxy's `/v1/chat/completions` route, which governs it and forwards it to the provider.

```
[Agent Script] ──> [ClawdeClient] ──> [Local Proxy (port 4000)] ──> [LLM API]
```

The proxy address is `baseUrl` (`base_url` in Python), then `INTUTIC_BASE_URL`, then `http://localhost:4000`. Each attempt times out after 30 seconds. A transport failure, a timeout or a 5xx answer is retried twice; `timeout` and `retries` change both. A governance refusal and any other 4xx answer are not retried, because the same request would get the same answer.

For pre-execution checks on the tools an agent runs, rather than on its model calls, use the [Tool Gate SDK](/reference/gate-sdk).

### 1. Context Resolution
`resolveContext()` (`resolve_context()`) reads `~/.intutic/config.json`, which the sync daemon keeps current: git branch, Jira ticket, PagerDuty incident, CI pipeline, working directory, workspace and session. Without that file it falls back to `INTUTIC_WORKSPACE_ID`, `INTUTIC_SESSION_ID`, `GIT_BRANCH`, `GITHUB_RUN_ID` / `BUILDKITE_BUILD_ID` / `CIRCLE_BUILD_NUM` and `PD_INCIDENT_ID`. Pass `autoContext: false` (`auto_context=False`) to make it return an empty object.

`chat()` sends no context headers: the proxy does not read them. What it sends is a session, and the control plane attaches git context to the session.

### 1a. Git context and cost attribution
Cost per branch, per commit and per pull request is attributed through the session a call is filed under: the control plane copies that session's repository, branch and HEAD commit onto each call it records. On the first `chat()`, the client picks the session it sends as `x-session-id` on every call:

- A session id `resolveContext()` returns (`INTUTIC_SESSION_ID`, as `intutic exec` sets it) is the session that started the process, so its calls go under it unchanged.
- Otherwise, when the working directory is a git repository and the key is an Intutic virtual key (`vk_…`), the client registers a session (`POST /api/v1/sessions`, harness `clawde_sdk`) carrying the `origin` remote as `host/path` (credentials, port and `.git` removed before it is sent), the branch and the HEAD commit. On a detached HEAD, as CI checks out a pull request, the branch comes from `GITHUB_HEAD_REF`, then from the branch `resolveContext()` returns. It always confirms the key with `GET /api/v1/auth/me` first, even when `INTUTIC_WORKSPACE_ID` or the sync daemon names a workspace, and registers the session in the workspace the key belongs to. The repository is sent only to a control plane that accepted the key, and a provider key is never sent there at all.

The control plane is `controlPlaneUrl` (`control_plane_url`), then `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted one; a self-hosted deployment sets one of the first two. Registration is best effort: if the control plane cannot be reached or refuses, the call goes ahead without a session and is filed under **No git context**, and the client does not try again. The session holds the repository, branch and commit as they were at the first call. Pass `autoContext: false` (`auto_context=False`) to register nothing and send no session. See [Cost per branch and commit](/guide/budgets#cost-per-branch-and-commit) for how the figures are built.

The TypeScript client sends the agent-graph headers the proxy uses for [graph guardrails](/guide/graph-guardrails) (`X-Intutic-Graph-Id`, `X-Intutic-Node-Id`, `X-Intutic-Parent-Session`, `X-Intutic-Depth`). They are inherited from `INTUTIC_GRAPH_ID`, `INTUTIC_NODE_ID` and `INTUTIC_DEPTH`, so an agent started by another agent is recorded as its child; pass `graphIdentity` to set them yourself.

### 2. Budget Check
`checkBudget(model, estimatedTokens)` (`check_budget(model, estimated_tokens)`) calls the control plane's `GET /api/v1/budget` and returns `{ allowed, remaining_usd, reason? }`. `allowed` is `remaining_usd > 0` for the whole workspace: the control plane has no per-call estimate, so `model` and `estimatedTokens` only key a 30-second cache. The control-plane address is `controlPlaneUrl` (`control_plane_url`), then `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted control plane. With no control plane to reach, it throws `ClawdeConnectionError`.

### 3. Circuit Breaker
`circuitBreaker(toolName, options)` (`circuit_breaker(tool_name, ...)`) returns a runner: call it with a function and that function runs immediately, behind the breaker.

- `requireBudget` (`require_budget`), default `false`: the breaker runs `checkBudget` first and throws `ClawdeVerdictError('kill', ...)` if the workspace has no budget left. This is a workspace-level check, not a per-call cost ceiling: nothing reports what a call will cost before it is made.
- `failOpen` (`fail_open`), default `false`: when `true`, a budget check that cannot be made (the control plane is unreachable) is skipped, and an error from the function, a governance refusal included, is swallowed and the runner returns `null` (`None`). A budget check that answers with no budget left refuses the call either way. When `false`, a `ClawdeBlockedError` from `chat()` propagates unchanged.
- `maxCostUsd` (`max_cost_usd`) is deprecated: any value turns the budget check on, exactly like `requireBudget`, and the amount is ignored. Python emits a `DeprecationWarning`. `sensitivityTier` (TypeScript only) is deprecated and ignored. Both will be removed in the next major version.

### 4. Anthropic Requests (TypeScript only)
`provider: 'anthropic'` converts the OpenAI-style `chat()` parameters to an Anthropic Messages body, sends it to the proxy's `/v1/messages` route with the key in `x-api-key`, and converts the reply back to the OpenAI shape. `normalizeRequest()` and `normalizeResponse()` are exported for direct use.

### 5. Verdicts and Errors
A response that comes back carries `verdict: 'allow'`: the proxy let the request through. Every governance refusal the proxy can give has a stable code. `chat()` recognises each one, fires the matching [event](#events), and throws `ClawdeBlockedError` without retrying:

| Status | Code | `verdict` | Meaning |
|---|---|---|---|
| 403 | `policy_denied` | `kill` | A policy, anomaly detector or custom WASM rule blocked the request |
| 403 | `model_not_allowed` | `kill` | The model is not on the approved-models list |
| 403 | `LOOP_RUN_TERMINATED` | `kill` | The loop run this request belongs to has stopped |
| 403 | `LOOP_RUN_PENDING_REVIEW` | `hold` | The loop run is paused until a reviewer approves or rejects it |
| 403 | `policy_held` | `hold` | A Rego or WASM rule held the request for approval; the error names the hold id |
| 409 | `policy_reask` | `reask` | Revise the approach and try again; repeated attempts escalate to `policy_denied` |
| 403 | `GOVERNANCE_UNAVAILABLE` | `kill` | A governance check could not complete. Either a custom WASM or Rego rule reached no verdict (its deadline, its instruction budget, an error, or a result that is not a verdict): refused whatever the proxy's fail setting, and refused again if the same request is retried, the message naming the rule. Or, with the proxy failing closed, the workspace's PII detector setting could not be read |
| 429 | `BUDGET_EXCEEDED` | `kill` | The key's remaining budget does not cover the request |
| 429 | `OVERAGE_HARD_CAP_EXCEEDED` | `kill` | The daily spend cap is reached |
| 402, or 200 | `COST_GATE_EXCEEDED` | `kill` | The request's estimated cost is over the workspace threshold: 402 on a stream, a 200 answer otherwise |
| 400 | `dlp_policy_violation` | `kill` | The request contains content the DLP policy blocks |
| 200 | `TOOL_DENIED` | `kill` | The model called a tool an SOP denies to this agent role; the call was withheld |
| 200 | `SSO_GROUP` | `kill` | The model called a tool the workspace's SSO group policy does not clear for this member; the call was withheld |
| 200 | `SQL_GUARD` | `kill` | The model called a shell tool to run destructive SQL against a database the SQL allowlist does not admit; the call was withheld |
| 200 | `RESPONSE_UNPARSEABLE` | `kill` | The model's response did not parse while a tool policy was in force, so it was withheld; retrying may succeed |
| 200 | `OUTPUT_DLP` | `kill` | The model's response held sensitive content that could not be redacted safely, so it was withheld |

`ClawdeBlockedError` extends `ClawdeVerdictError` and carries `verdict`, `code`, `status`, `ruleId` (`rule_id`) and the proxy's reason as its message. The circuit breaker's budget check throws a plain `ClawdeVerdictError`.

**Refusals sent as an error.** A status other than 200 comes with a JSON body, `{"error": {"type": "<code>", "message": "<reason>"}}`. `chat()` matches the status and the code together, so a provider's own 429 or a 403 for a key used against the wrong workspace is not mistaken for a refusal. These carry no `ruleId`.

**Refusals sent as an answer.** The rows with status 200 happen after the model ran: the proxy found something in its reply it will not deliver, such as a tool call an SOP denies, and replaces the reply with an assistant turn that says why. A chat client shows that turn, and an agent reads it as its own previous turn and does not retry the call. Each of these names itself so an SDK does not take it for the model's answer:

- Non-streaming, in two response headers: `x-intutic-refusal: <code>` and `x-intutic-refusal-rule: <rule id>`, for example `TOOL_DENIED` and `deny_tools.Bash`, or `SSO_GROUP` and `sso_group.high_risk.Bash`.
- Streaming, in an SSE comment line just before the refusal text, because the headers went out before the refusal happened: `: intutic-refusal {"code": "TOOL_DENIED", "rule": "deny_tools.Bash", "message": "…"}`. Every SSE parser skips comment lines, so clients that do not look for it are unaffected.

`chat()` reads both. It does not stream, so for a stream you read yourself, pass each line (or the whole body) to `streamRefusal()` (`stream_refusal()`), which returns the refusal or `null` (`None`). `PROXY_REFUSALS`, `REFUSAL_HEADER`, `REFUSAL_RULE_HEADER` and `STREAM_REFUSAL_MARKER` are exported alongside it.

Every other failure throws `ClawdeConnectionError` with the status and response body in its message: an unreachable proxy, a timeout, a 5xx after the retries run out, or a 4xx that is not a refusal, such as a key the proxy does not accept.

`budgetRemainingUsd` and `budgetPctUsed` are deprecated and never set; the proxy does not report budget on responses. Use `checkBudget()` instead.

---

## Code Examples

### TypeScript Example

```typescript
import { ClawdeBlockedError, ClawdeClient, ClawdeConnectionError, ClawdeVerdictError } from '@intutic/clawde'
import type { ChatResponse } from '@intutic/clawde'

const client = new ClawdeClient({
  apiKey: process.env.INTUTIC_API_KEY!,
  baseUrl: 'http://127.0.0.1:4000',
  provider: 'anthropic',
})

// A runner that wraps one action; calling it runs the action now
const runDeployCheck = client.circuitBreaker<ChatResponse>('deploy_check', {
  requireBudget: true, // needs a control plane
  failOpen: false,
})

try {
  const response = await runDeployCheck(() =>
    client.chat({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Run the deploy checklist' }],
    }),
  )
  console.log(response.choices[0]?.message.content)
} catch (err) {
  if (err instanceof ClawdeBlockedError) console.error(`Refused (${err.verdict}, ${err.code}): ${err.message}`)
  else if (err instanceof ClawdeVerdictError) console.error(`Circuit breaker tripped: ${err.message}`)
  else if (err instanceof ClawdeConnectionError) console.error(`Request failed: ${err.message}`)
  else throw err
}
```

### Python Example

```python
import os

from intutic_clawde import ClawdeBlockedError, ClawdeClient, ClawdeConnectionError, ClawdeVerdictError

client = ClawdeClient(api_key=os.environ["INTUTIC_API_KEY"])

def run_deploy():
    return client.chat(
        model="gpt-4o",
        messages=[{"role": "user", "content": "compile build"}],
    )

try:
    # Calling the runner runs run_deploy now, behind the breaker
    res = client.circuit_breaker("deploy_production_tool", require_budget=True)(run_deploy)
    print(res["choices"][0]["message"]["content"])
except ClawdeBlockedError as e:
    print(f"Refused ({e.verdict}, {e.code}): {e}")
except ClawdeVerdictError as e:
    print(f"Circuit breaker tripped: {e}")
except ClawdeConnectionError as e:
    print(f"Request failed: {e}")
```

---

## Control-Plane Management (`ControlPlaneClient`)

Everything above (`ClawdeClient`) is a **data-plane** client: it wraps the local proxy for chat calls. `ControlPlaneClient` is a separate, optional class for the **operator** APIs the [CLI](/reference/cli) exposes: org and workspace setup, gateways, settings and provider credentials, the MCP registry, notification rules, SIEM destinations, usage, the AI inventory, compliance evidence, policy guardrails, held decisions and loop runs, findings, traces, trace integrity, policies and SOPs. Both SDKs have the same methods, camelCase in TypeScript and snake_case in Python, so the same work can run from code (infra-as-code, a secrets-manager sync job, a nightly compliance export, provisioning a workspace per tenant in your own product built on Intutic).

It talks to the **control plane** — Intutic's hosted one by default, or your own self-hosted `CONTROL_PLANE_URL` — not the proxy: a different origin from `ClawdeClient`'s `baseUrl`, so it takes its own `baseUrl` (`base_url`). Every method is a direct HTTP call with no hosted-vs-self-hosted branching, so it works unmodified against either. It needs a control plane to talk to, same as `intutic whoami` does: an open-core deployment with no control plane configured simply won't have anything to call.

Auth: the same `apiKey` you already pass to `ClawdeClient` — a `vk_...` virtual key or a login JWT. Each call needs the role the CLI command needs: approving an MCP server, writing a SIEM destination or collecting evidence takes OWNER or ADMIN, workspace-wide usage and the whole machine inventory take OWNER, ADMIN or EM, and a DEVELOPER sees only their own usage and machines.

### TypeScript

```typescript
import { ControlPlaneClient, verifyEvidenceArchive } from '@intutic/clawde';

const cp = new ControlPlaneClient({
  apiKey: process.env.INTUTIC_API_KEY!,
  baseUrl: process.env.INTUTIC_CONTROL_PLANE_URL, // defaults to Intutic's hosted control plane
});

const { servers, pendingCount } = await cp.listMcpServers();
await cp.approveMcpServer(servers[0].serverId);
const usage = await cp.getMemberUsage({ period: 'daily' });

// Seal this month's evidence, then check the archive offline
const { runId } = await cp.collectEvidence({ periodStart: '2026-10-01' });
const archive = JSON.parse(new TextDecoder().decode(await cp.downloadEvidence(runId)));
const check = verifyEvidenceArchive(archive, await cp.getSigningKeys());
if (!check.verified) throw new Error(`evidence not verified: ${check.signature}`);
```

### Python

```python
import json
import os

from intutic_clawde import ControlPlaneClient, verify_evidence_archive

cp = ControlPlaneClient(api_key=os.environ["INTUTIC_API_KEY"])  # base_url defaults to Intutic's hosted control plane

registry = cp.list_mcp_servers()
cp.approve_mcp_server(registry["servers"][0]["serverId"])
usage = cp.get_member_usage(period="daily")

run = cp.collect_evidence(period_start="2026-10-01")
archive = json.loads(cp.download_evidence(run["runId"]))
check = verify_evidence_archive(archive, cp.get_signing_keys())
assert check["verified"], check["signature"]
```

### Arguments and answers

A method takes the ids it acts on as positional arguments, then its optional settings: one options object in TypeScript (`getMemberUsage({ period: 'daily' })`), the same names in snake_case as keyword arguments in Python (`get_member_usage(period="daily")`). A request body with several fields, such as a notification rule, a SIEM destination or an authored guardrail, is passed whole, with the keys the route takes (`createNotificationRule({ eventType, channel, channelConfig })`, `create_notification_rule({"eventType": ..., ...})`).

Answers are the route's JSON, typed: TypeScript interfaces, Python `TypedDict`s, both with the route's own key names. A list that is the whole answer comes back as the list (`listNotificationRules()` returns the rules); an answer with more than rows comes back whole (`listMcpServers()` also returns the default policy and the pending count). `download…` methods return the file's bytes (`Uint8Array`, `bytes`): a coverage report (`json`, `md`, `csv` or `pdf`), an inventory CSV, an evidence archive.

A call that fails throws (raises) `ClawdeConnectionError` with the method, path, status and the control plane's answer in its message. A 403 that names the roles allowed reads as that sentence, as the CLI prints it: `Control plane POST /api/v1/mcp/servers/mcp_1/status refused (403): Requires the OWNER or ADMIN role`. The integrity chain walks (`getIntegrityChain`, `getIntegrityConfigChain`) return the walk whether or not it found a break.

`verifyEvidenceArchive(archive, jwks)` (`verify_evidence_archive`) checks an evidence archive offline, as `intutic compliance verify` does: the manifest's section hashes, the whole-archive hash, then the Ed25519 signature against the published key its `keyId` names. `verified` is true only when the hashes match and a published key accepts the signature; an unsigned archive, or one whose key is not published, is reported but not verified. Pass `null` (`None`) for `jwks` when the keys cannot be had.

`verifyIntegrityRoot(root, jwks)` (`verify_integrity_root`) checks a sealed trace root's signature offline, as `intutic integrity verify` does: it rebuilds the bytes the control plane signed from the root's own fields, under the preimage version the root records, and checks the Ed25519 signature against the published key its `signing_key_id` names. Pass the `root` of `getIntegrityRoot()`. It answers `valid`, or `invalid` when that key rejects the signature, which is the only answer that says the root changed. `unsigned` means no signing key was configured when the root was sealed; `unverifiable` means the key is not published, or the root names an algorithm or preimage version this SDK cannot check; `keys_unavailable` means `jwks` was `null` (`None`). `recomputeIntegrityRoot()` checks the other half, whether the stored traces still hash to the root.

```typescript
import { verifyIntegrityRoot } from '@intutic/clawde';

const { root } = await cp.getIntegrityRoot(rootId);
const signature = verifyIntegrityRoot(root, await cp.getSigningKeys()); // 'valid' | 'invalid' | …
const { verdict } = await cp.recomputeIntegrityRoot(rootId);            // 'match' | 'mismatch' | 'missing_traces'
```

In Python both signature checks need the `cryptography` package: `pip install 'intutic-clawde[compliance]'`.

### What's covered

| Area | TypeScript | Python | Route | CLI |
|---|---|---|---|---|
| Identity and org setup | `whoami` | `whoami` | `GET /api/v1/auth/me` | `intutic whoami` |
|  | `signupOrg` | `signup_org` | `POST /api/v1/auth/signup/org` | — |
|  | `startDomainVerification` | `start_domain_verification` | `POST /api/v1/domain-verification/start` | `intutic org create` |
|  | `checkDomainVerification` | `check_domain_verification` | `GET /api/v1/domain-verification/:verificationId` | `intutic org create` |
|  | `createOrg` | `create_org` | `POST /api/v1/orgs` | `intutic org create` |
|  | `listTeams` | `list_teams` | `GET /api/v1/orgs/:orgId/teams` | `intutic team list` |
|  | `createTeam` | `create_team` | `POST /api/v1/orgs/:orgId/teams` | `intutic team create` |
|  | `listTeamWorkspaces` | `list_team_workspaces` | `GET /api/v1/teams/:teamId/workspaces` | `intutic team workspaces` |
|  | `createWorkspace` | `create_workspace` | `POST /api/v1/teams/:teamId/workspaces` | `intutic team create-workspace` |
| Gateways | `registerGateway` | `register_gateway` | `POST /api/v1/gateways` | `intutic gateway register` |
|  | `listGateways` | `list_gateways` | `GET /api/v1/gateways` | `intutic gateway list` |
|  | `getGatewayStatus` | `get_gateway_status` | `GET /api/v1/gateways/:gatewayId/status` | `intutic gateway status` |
|  | `rotateGatewayToken` | `rotate_gateway_token` | `POST /api/v1/gateways/:gatewayId/rotate` | `intutic gateway rotate` |
|  | `revokeGateway` | `revoke_gateway` | `DELETE /api/v1/gateways/:gatewayId` | `intutic gateway revoke` |
|  | `getGatewayConfig` | `get_gateway_config` | `GET /api/v1/gateways/:gatewayId/config` | `intutic gateway config get` |
|  | `setGatewayConfig` | `set_gateway_config` | `PATCH /api/v1/gateways/:gatewayId/config` | `intutic gateway config set` |
|  | `assignWorkspaceGateway` | `assign_workspace_gateway` | `PATCH /api/v1/workspace/gateway` | `intutic gateway assign` |
|  | `assignOrgGateway` | `assign_org_gateway` | `PATCH /api/v1/orgs/:orgId/gateway` | `intutic gateway assign` |
|  | `resolveGateway` | `resolve_gateway` | `GET /api/v1/workspace/gateway-resolution` | `intutic gateway resolve` |
| Settings and provider credentials | `getWorkspaceSettings` | `get_workspace_settings` | `GET /api/v1/workspace/settings` | `intutic settings get` |
|  | `updateWorkspaceSettings` | `update_workspace_settings` | `PUT /api/v1/workspace/settings` | `intutic settings set` |
|  | `listProviderCredentials` | `list_provider_credentials` | `GET /api/v1/workspace/provider-credentials` | `intutic credentials list` |
|  | `setProviderCredential` | `set_provider_credential` | `PUT /api/v1/workspace/provider-credentials/:provider` | `intutic credentials set` |
|  | `unsetProviderCredential` | `unset_provider_credential` | `DELETE /api/v1/workspace/provider-credentials/:provider` | `intutic credentials unset` |
| MCP server registry | `listMcpServers` | `list_mcp_servers` | `GET /api/v1/mcp/servers` | `intutic mcp list` |
|  | `approveMcpServer` | `approve_mcp_server` | `POST /api/v1/mcp/servers/:serverId/status` | `intutic mcp approve` |
|  | `blockMcpServer` | `block_mcp_server` | `POST /api/v1/mcp/servers/:serverId/status` | `intutic mcp block` |
|  | `resetMcpServer` | `reset_mcp_server` | `POST /api/v1/mcp/servers/:serverId/status` | `intutic mcp reset` |
|  | `enableMcpTool` | `enable_mcp_tool` | `POST /api/v1/mcp/servers/:serverId/tools` | `intutic mcp enable-tool` |
|  | `disableMcpTool` | `disable_mcp_tool` | `POST /api/v1/mcp/servers/:serverId/tools` | `intutic mcp disable-tool` |
| Notifications | `listNotificationRules` | `list_notification_rules` | `GET /api/v1/notifications/rules` | `intutic notifications list` |
|  | `createNotificationRule` | `create_notification_rule` | `POST /api/v1/notifications/rules` | `intutic notifications create` |
|  | `updateNotificationRule` | `update_notification_rule` | `PUT /api/v1/notifications/rules/:ruleId` | `intutic notifications update` |
|  | `deleteNotificationRule` | `delete_notification_rule` | `DELETE /api/v1/notifications/rules/:ruleId` | `intutic notifications delete` |
|  | `rotateNotificationRuleSecret` | `rotate_notification_rule_secret` | `POST /api/v1/notifications/rules/:ruleId/signing-secret` | `intutic notifications rotate-secret` |
| SIEM export | `listSiemDestinations` | `list_siem_destinations` | `GET /api/v1/siem/destinations` | `intutic siem list` |
|  | `getSiemDestination` | `get_siem_destination` | `GET /api/v1/siem/destinations/:destinationId` | `intutic siem show` |
|  | `listSiemSources` | `list_siem_sources` | `GET /api/v1/siem/destinations` | `intutic siem sources` |
|  | `createSiemDestination` | `create_siem_destination` | `POST /api/v1/siem/destinations` | `intutic siem create` |
|  | `updateSiemDestination` | `update_siem_destination` | `PUT /api/v1/siem/destinations/:destinationId` | `intutic siem update` |
|  | `deleteSiemDestination` | `delete_siem_destination` | `DELETE /api/v1/siem/destinations/:destinationId` | `intutic siem delete` |
|  | `rotateSiemDestinationSecret` | `rotate_siem_destination_secret` | `POST /api/v1/siem/destinations/:destinationId/signing-secret` | `intutic siem rotate-secret` |
| Usage | `getMemberUsage` | `get_member_usage` | `GET /api/v1/usage/members` | `intutic usage members` |
|  | `getTeamUsage` | `get_team_usage` | `GET /api/v1/usage/teams` | `intutic usage teams` |
|  | `getBranchUsage` | `get_branch_usage` | `GET /api/v1/usage/branches` | `intutic usage branches` |
|  | `getCommitUsage` | `get_commit_usage` | `GET /api/v1/usage/commits` | `intutic usage commits` |
|  | `getPullRequestUsage` | `get_pull_request_usage` | `GET /api/v1/usage/pull-requests` | `intutic usage pull-requests` |
|  | `refreshPullRequestUsage` | `refresh_pull_request_usage` | `POST /api/v1/usage/pull-requests/refresh` | `intutic usage pull-requests --refresh` |
| AI inventory | `getInventorySummary` | `get_inventory_summary` | `GET /api/v1/inventory/summary` | `intutic inventory summary` |
|  | `listInventoryDevices` | `list_inventory_devices` | `GET /api/v1/inventory/devices` | `intutic inventory devices` |
|  | `listInventoryHarnesses` | `list_inventory_harnesses` | `GET /api/v1/inventory/harnesses` | `intutic inventory harnesses` |
|  | `listInventoryMcpServers` | `list_inventory_mcp_servers` | `GET /api/v1/inventory/mcp-servers` | `intutic inventory mcp-servers` |
|  | `listInventorySkills` | `list_inventory_skills` | `GET /api/v1/inventory/skills` | `intutic inventory skills --device --search` |
|  | `listInventoryDisconnects` | `list_inventory_disconnects` | `GET /api/v1/inventory/disconnects` | `intutic inventory disconnects` |
|  | `downloadInventoryHarnessesCsv` | `download_inventory_harnesses_csv` | `GET /api/v1/inventory/harnesses` | `intutic inventory harnesses --csv` |
|  | `downloadInventoryMcpServersCsv` | `download_inventory_mcp_servers_csv` | `GET /api/v1/inventory/mcp-servers` | `intutic inventory mcp-servers --csv` |
| Compliance | `getFrameworkCoverage` | `get_framework_coverage` | `GET /api/v1/compliance/frameworks/:frameworkId/coverage` | `intutic compliance coverage` |
|  | `downloadFrameworkCoverage` | `download_framework_coverage` | `GET /api/v1/compliance/frameworks/:frameworkId/coverage` | `intutic compliance coverage --format` |
|  | `collectEvidence` | `collect_evidence` | `POST /api/v1/compliance/soc2-collect` | `intutic compliance collect --from --to` |
|  | `downloadEvidence` | `download_evidence` | `GET /api/v1/compliance/soc2-export/:runId` | `intutic compliance download` |
|  | `getSigningKeys` | `get_signing_keys` | `GET /.well-known/intutic-trace-signing.json` | `intutic compliance verify` |
|  | `verifyEvidenceArchive` | `verify_evidence_archive` | none, offline | `intutic compliance verify` |
| Gate liveness, GitHub webhook | `getGateLiveness` | `get_gate_liveness` | `GET /api/v1/governance/gate-liveness` | `intutic gate-liveness` |
|  | `getGithubWebhook` | `get_github_webhook` | `GET /api/v1/integrations/github/webhook` | `intutic github webhook show` |
|  | `rotateGithubWebhookSecret` | `rotate_github_webhook_secret` | `POST /api/v1/integrations/github/webhook/secret` | `intutic github webhook rotate-secret` |
| Policy guardrails | `listPolicySources` | `list_policy_sources` | `GET /api/v1/connectors` | `intutic guardrails sources list` |
|  | `addPolicySource` | `add_policy_source` | `POST /api/v1/connectors` | `intutic guardrails sources add` |
|  | `syncPolicySource` | `sync_policy_source` | `POST /api/v1/connectors/:connectorId/sync` | `intutic guardrails sources sync` |
|  | `listPolicyDocuments` | `list_policy_documents` | `GET /api/v1/policy-guardrails/documents` | `intutic guardrails docs list` |
|  | `getPolicyDocument` | `get_policy_document` | `GET /api/v1/policy-guardrails/documents/:docId` | `intutic guardrails docs show` |
|  | `extractPolicyDocument` | `extract_policy_document` | `POST /api/v1/policy-guardrails/documents/:docId/extract` | `intutic guardrails docs extract` |
|  | `getGuardrailCoverage` | `get_guardrail_coverage` | `GET /api/v1/policy-guardrails/coverage` | `intutic guardrails search` |
|  | `searchPolicyPassages` | `search_policy_passages` | `GET /api/v1/policy-guardrails/search` | `intutic guardrails search --text` |
|  | `getGuardrailImpact` | `get_guardrail_impact` | `GET /api/v1/policy-guardrails/impact` | `intutic guardrails impact` |
|  | `listGuardrailDuplicates` | `list_guardrail_duplicates` | `GET /api/v1/policy-guardrails/duplicates` | `intutic guardrails duplicates` |
|  | `listGuardrails` | `list_guardrails` | `GET /api/v1/policy-guardrails/guardrails` | `intutic guardrails list` |
|  | `getGuardrail` | `get_guardrail` | `GET /api/v1/policy-guardrails/guardrails/:guardrailId` | `intutic guardrails show` |
|  | `getGuardrailReadiness` | `get_guardrail_readiness` | `GET /api/v1/policy-guardrails/guardrails/:guardrailId/readiness` | `intutic guardrails show` |
|  | `approveGuardrailShadow` | `approve_guardrail_shadow` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/approve-shadow` | `intutic guardrails approve-shadow` |
|  | `promoteGuardrail` | `promote_guardrail` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/promote` | `intutic guardrails promote` |
|  | `rejectGuardrail` | `reject_guardrail` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/reject` | `intutic guardrails reject` |
|  | `retireGuardrail` | `retire_guardrail` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/retire` | `intutic guardrails retire` |
|  | `reconfirmGuardrail` | `reconfirm_guardrail` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/reconfirm` | `intutic guardrails reconfirm` |
|  | `createGuardrail` | `create_guardrail` | `POST /api/v1/policy-guardrails/guardrails` | `intutic guardrails create` |
|  | `updateGuardrail` | `update_guardrail` | `PUT /api/v1/policy-guardrails/guardrails/:guardrailId` | `intutic guardrails update` |
|  | `deleteGuardrail` | `delete_guardrail` | `DELETE /api/v1/policy-guardrails/guardrails/:guardrailId` | `intutic guardrails delete` |
|  | `replayGuardrail` | `replay_guardrail` | `POST /api/v1/policy-guardrails/guardrails/:guardrailId/replay` | `intutic guardrails replay` |
|  | `listGuardrailConflicts` | `list_guardrail_conflicts` | `GET /api/v1/policy-guardrails/conflicts` | `intutic guardrails conflicts` |
| Held decisions and loop runs | `approveDecision` | `approve_decision` | `POST /api/v1/decisions/:holdId/review` | `intutic decision approve --reason` |
|  | `rejectDecision` | `reject_decision` | `POST /api/v1/decisions/:holdId/review` | `intutic decision reject` |
|  | `startLoopRun` | `start_loop_run` | `POST /api/v1/loops/start` | `intutic loop start` |
|  | `getLoopRun` | `get_loop_run` | `GET /api/v1/loops/:loopRunId` | `intutic loop exec` |
|  | `listLoopRuns` | `list_loop_runs` | `GET /api/v1/loops` | `intutic loop list` |
|  | `completeLoopRun` | `complete_loop_run` | `POST /api/v1/loops/:loopRunId/complete` | `intutic loop complete` |
|  | `killLoopRun` | `kill_loop_run` | `POST /api/v1/loops/:loopRunId/kill` | `intutic loop kill` |
|  | `approveLoopRun` | `approve_loop_run` | `POST /api/v1/loops/:loopRunId/review` | `intutic loop review --approve` |
|  | `rejectLoopRun` | `reject_loop_run` | `POST /api/v1/loops/:loopRunId/review` | `intutic loop review --reject` |
| Findings and traces | `listFindings` | `list_findings` | `GET /api/v1/findings` | `intutic findings list` |
|  | `adjudicateFinding` | `adjudicate_finding` | `POST /api/v1/findings/:findingId/adjudicate` | `intutic findings adjudicate` |
|  | `getFindingStats` | `get_finding_stats` | `GET /api/v1/findings/stats` | `intutic findings stats` |
|  | `getResponseEchoReport` | `get_response_echo_report` | `GET /api/v1/findings/response-echo/report` | `intutic findings echo-report` |
|  | `listTraces` | `list_traces` | `GET /api/v1/traces` | `intutic traces list` |
|  | `getTrace` | `get_trace` | `GET /api/v1/traces/:traceId` | `intutic traces inspect` |
| Trace integrity | `listIntegrityRoots` | `list_integrity_roots` | `GET /api/v1/integrity/roots` | `intutic integrity roots` |
|  | `getIntegrityRoot` | `get_integrity_root` | `GET /api/v1/integrity/roots/:rootId` | `intutic integrity verify` |
|  | `recomputeIntegrityRoot` | `recompute_integrity_root` | `POST /api/v1/integrity/roots/:rootId/recompute` | `intutic integrity verify` |
|  | `getIntegrityChain` | `get_integrity_chain` | `GET /api/v1/integrity/chain` | `intutic integrity chain` |
|  | `getIntegrityConfigChain` | `get_integrity_config_chain` | `GET /api/v1/integrity/config-chain` | `intutic integrity config-chain` |
|  | `verifyIntegrityRoot` | `verify_integrity_root` | none, offline | `intutic integrity verify` |
| Compliance policies, WASM rules | `listPolicies` | `list_policies` | `GET /api/v1/policies` | `intutic policy export` |
|  | `enablePolicy` | `enable_policy` | `POST /api/v1/policies/:policyId/enable` | `intutic policy enable` |
|  | `disablePolicy` | `disable_policy` | `POST /api/v1/policies/:policyId/disable` | `intutic policy disable` |
|  | `rollbackPolicy` | `rollback_policy` | `POST /api/v1/policies/:policyId/rollback` | `intutic policy rollback` |
|  | `getRuleCandidateSource` | `get_rule_candidate_source` | `GET /api/v1/rule-candidates/:candidateId/source` | `intutic policy compile --candidate` |
|  | `uploadRuleCandidateBundle` | `upload_rule_candidate_bundle` | `POST /api/v1/rule-candidates/:candidateId/bundle` | `intutic policy compile --candidate --upload` |
|  | `replayWasmRule` | `replay_wasm_rule` | `POST /api/v1/wasm-rules/:ruleId/replay` | `intutic policy replay` |
| SOPs | `listSops` | `list_sops` | `GET /api/v1/sops` | `intutic sops pull` |
|  | `getSop` | `get_sop` | `GET /api/v1/sops/:sopId` | `intutic sops pull` |
|  | `createSop` | `create_sop` | `POST /api/v1/sops` | `intutic sops push` |
|  | `listOrgSops` | `list_org_sops` | `GET /api/v1/workspace/org-sops` | `intutic sops org-list` |
|  | `createOrgSop` | `create_org_sop` | `POST /api/v1/workspace/org-sops` | `intutic sops push --org` |
|  | `deleteOrgSop` | `delete_org_sop` | `DELETE /api/v1/workspace/org-sops/:orgSopId` | `intutic sops org-rm` |
| Keys, cost, routing | `attenuateKey` | `attenuate_key` | `POST /api/v1/attenuate` | `intutic attenuate` |
|  | `getAttenuationChain` | `get_attenuation_chain` | `GET /api/v1/attenuate/chain/:chainId` | `intutic attenuate chain` |
|  | `predictCost` | `predict_cost` | `POST /api/v1/predict-cost` | `intutic predict-cost` |
|  | `getMirrorAdoptionReport` | `get_mirror_adoption_report` | `GET /api/v1/routing/mirror-adoption-report` | `intutic routing adoption-report` |

`getGatewayStatus` (`get_gateway_status`) reports `appliedConfigVersion`, the config version the gateway said it runs in its last heartbeat (`null` when it is unreachable or has not reported one), beside `desiredConfigVersion`, the version the latest config change produced. `getGatewayConfig` (`get_gateway_config`) returns the flags set on the gateway and that version, readable by any member of the gateway's org.

`updateWorkspaceSettings({ key: value })` (`update_workspace_settings({...})`) is the route `intutic settings set` calls: only the keys given change, and the control plane applies the same checks. An unknown key or a bad value is refused with a 400 that names it, a setting the plan does not include (the group policy for high-risk tools below Biz Org) with a 403 `Upgrade required`, and a member below OWNER or ADMIN with a 403. Each refusal throws (raises) `ClawdeConnectionError` with the server's answer in its message. See [Workspace settings](/reference/workspace-settings) for every key, its type and what it does.


`signupOrg` is unauthenticated; a self-hosted control plane always refuses it, and the hosted one only accepts it with `INTUTIC_PUBLIC_ORG_SIGNUP=true`, so create orgs with `startDomainVerification`, `checkDomainVerification` and `createOrg`: publish the returned TXT record, poll until `status` is `verified`, then create the org with that `verificationId`.

`listTraces` takes `since` as an ISO 8601 time or a duration such as `24h`; a page of 20 traces or more arrives TOON-encoded and is decoded before it is returned, with any cell longer than 120 characters cut short as the control plane sent it. `getRuleCandidateSource` refuses a source that does not hash to the `sourceSha256` served with it.

Not covered, on purpose: session establishment (`intutic login`/`logout` — supply `apiKey` directly; `ClawdeClient` registers its own session), the workspace budget (`checkBudget()` above), and commands that act on the machine they run on: `init`, `setup`, `doctor`, `install-daemon`, `connect`, `disconnect`, `exec`, `start`, `sync-context`, `rollback`, `enforce`, `rules`, `judge`, `skill` (its loop commands are covered), `sops status`, `guardrails pull` and `policy compile`, `install`, `list-local` and `snapshot`.

---

## Events

Register callbacks for the refusal verdicts: `kill`, `reask` and `hold`. `chat()` calls them before it throws `ClawdeBlockedError`, with `{ verdict, code, status, message }`, plus `ruleId` (`rule_id` in Python) when the proxy names the rule that decided.

`hijack`, `enhance` and `bypass` are still accepted so existing code keeps working, but they never fire: the proxy applies those verdicts inside the response and does not report them to the client. They will be removed in the next major version.

### TypeScript
```typescript
client.on('reask', (event) => {
  console.warn(`Asked to revise (${event.code}): ${event.message}`)
})

client.on('kill', (event) => {
  console.error(`Blocked by policy (${event.code}): ${event.message}`)
})
```

### Python
```python
client.on("reask", lambda event: print(f"Asked to revise ({event['code']}): {event['message']}"))
client.on("kill", lambda event: print(f"Blocked by policy ({event['code']}): {event['message']}"))
```
