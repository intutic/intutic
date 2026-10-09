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

`chat()` does not send this context. The proxy does not read it, and the sync daemon attaches branch and task context to the proxy's session in the control plane itself.

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

Everything above (`ClawdeClient`) is a **data-plane** client: it wraps the local proxy for chat calls. `ControlPlaneClient` is a separate, optional class for the **management** operations the [CLI](/reference/cli) already exposes interactively — org signup, team/workspace creation, gateway registration and assignment, and provider-credential provisioning — so the same actions can be driven programmatically (infra-as-code, a secrets-manager sync job, provisioning a workspace per tenant in your own SaaS built on Intutic).

It talks to the **control plane** — Intutic's hosted one by default, or your own self-hosted `CONTROL_PLANE_URL` — not the proxy: a different origin from `ClawdeClient`'s `baseUrl`, so it takes its own `baseUrl`. Every method is a direct HTTP call with no hosted-vs-self-hosted branching, so it works unmodified against either. It needs a control plane to talk to, same as `intutic whoami` does: an open-core deployment with no control plane configured simply won't have anything to call.

Auth: the same `apiKey` you already pass to `ClawdeClient` — a `vk_...` virtual key or a login JWT both work, as long as the underlying member has `OWNER`/`ADMIN` on the relevant workspace for admin-gated calls (gateway registration, team creation, etc.).

### TypeScript

```typescript
import { ControlPlaneClient } from '@intutic/clawde';

const cp = new ControlPlaneClient({
  apiKey: process.env.INTUTIC_API_KEY!,
  baseUrl: process.env.INTUTIC_CONTROL_PLANE_URL, // defaults to Intutic's hosted control plane
});

const gateways = await cp.listGateways();
const { gatewayId, token } = await cp.registerGateway({ name: 'prod-gw', deploymentTarget: 'kubernetes' });
await cp.setProviderCredential('anthropic', { apiKey: 'sk-ant-...' });
const resolution = await cp.resolveGateway(); // which gateway this workspace should point at, and why
```

### Python

```python
import os

from intutic_clawde import ControlPlaneClient

cp = ControlPlaneClient(api_key=os.environ["INTUTIC_API_KEY"])  # base_url defaults to Intutic's hosted control plane

gateways = cp.list_gateways()
gw = cp.register_gateway("prod-gw", "kubernetes")
cp.set_provider_credential("anthropic", {"apiKey": "sk-ant-..."})
resolution = cp.resolve_gateway()
```

### What's covered

| Area | Methods |
|---|---|
| Identity | `whoami()` |
| Org signup | `signupOrg()` / `signup_org()` — unauthenticated; a self-hosted control plane always refuses it, and the hosted one only accepts it with `INTUTIC_PUBLIC_ORG_SIGNUP=true`, so prefer org creation below |
| Org creation | `startDomainVerification`, `checkDomainVerification`, `createOrg` / `start_domain_verification`, `check_domain_verification`, `create_org` — publish the returned TXT record, poll until `status` is `verified`, then create the org with that `verificationId` |
| Teams & workspaces | `listTeams`, `createTeam`, `listTeamWorkspaces`, `createWorkspace` |
| Gateways | `registerGateway`, `listGateways`, `getGatewayStatus`, `rotateGatewayToken`, `revokeGateway`, `setGatewayConfig`, `assignWorkspaceGateway`, `assignOrgGateway`, `resolveGateway` |
| Provider credentials | `listProviderCredentials`, `setProviderCredential`, `unsetProviderCredential` |

Not covered, on purpose: session establishment (`intutic login`/`logout` — supply `apiKey` directly instead) and local-environment/terminal-only commands (`init`, `doctor`, `install-daemon`, `integrity`, `rollback`, `connect`, `exec`, `start`, `syncContext`, `skill`) that have no meaning for a library embedded in your own process.

---

## Events

Register callbacks for the refusal verdicts: `kill`, `reask` and `hold`. `chat()` calls them before it throws `ClawdeBlockedError`, with `{ verdict, code, status, message }`, plus `ruleId` when the proxy names the rule that decided.

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
