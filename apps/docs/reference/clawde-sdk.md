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

The proxy address is `baseUrl` (`base_url` in Python), then `INTUTIC_BASE_URL`, then `http://localhost:4000`. Each attempt times out after 30 seconds and a failed attempt is retried twice; `timeout` and `retries` change both.

For pre-execution checks on the tools an agent runs, rather than on its model calls, use the [Tool Gate SDK](/reference/gate-sdk).

### 1. Context Resolution
`resolveContext()` (`resolve_context()`) reads `~/.intutic/config.json`, which the sync daemon keeps current: git branch, Jira ticket, PagerDuty incident, CI pipeline, working directory, workspace and session. Without that file it falls back to `INTUTIC_WORKSPACE_ID`, `INTUTIC_SESSION_ID`, `GIT_BRANCH`, `GITHUB_RUN_ID` / `BUILDKITE_BUILD_ID` / `CIRCLE_BUILD_NUM` and `PD_INCIDENT_ID`. `chat()` sends the result as an `X-Intutic-Context` header. Pass `autoContext: false` (`auto_context=False`) to skip it.

The TypeScript client also sends the agent-graph headers the proxy uses for [graph guardrails](/guide/graph-guardrails) (`X-Intutic-Graph-Id`, `X-Intutic-Node-Id`, `X-Intutic-Parent-Session`, `X-Intutic-Depth`). They are inherited from `INTUTIC_GRAPH_ID`, `INTUTIC_NODE_ID` and `INTUTIC_DEPTH`, so an agent started by another agent is recorded as its child; pass `graphIdentity` to set them yourself.

### 2. Budget Check
`checkBudget(model, estimatedTokens)` (`check_budget(model, estimated_tokens)`) calls the control plane's `GET /api/v1/budget` and returns `{ allowed, remaining_usd, reason? }`. `allowed` is `remaining_usd > 0` for the whole workspace: the control plane has no per-call estimate, so `model` and `estimatedTokens` only key a 30-second cache. The control-plane address is `controlPlaneUrl` (`control_plane_url`), then `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted control plane. With no control plane to reach, it throws `ClawdeConnectionError`.

### 3. Circuit Breaker
`circuitBreaker(toolName, options)` (`circuit_breaker(tool_name, ...)`) returns a runner: call it with a function and that function runs immediately, behind the breaker.

- `maxCostUsd` (`max_cost_usd`): when set, the breaker runs `checkBudget` first and throws `ClawdeVerdictError('kill', ...)` if the workspace has no budget left. The amount itself is not compared with anything.
- After the function returns, a result whose `verdict` is `kill` throws `ClawdeVerdictError`.
- `failOpen` (`fail_open`), default `false`: when `true`, a failed budget check is ignored, and an error from the function is swallowed and the runner returns `null` (`None`).

### 4. Schema Conversion (TypeScript only)
`provider: 'anthropic'` converts the OpenAI-style `chat()` parameters to an Anthropic Messages body and the reply back to the OpenAI shape. `normalizeRequest()` and `normalizeResponse()` are exported for direct use.

### 5. Verdicts and Errors
`chat()` reads `x-intutic-verdict`, `x-intutic-budget-remaining` and `x-intutic-budget-pct` from the response, copies them onto the result as `verdict`, `budgetRemainingUsd` and `budgetPctUsed` (`verdict`, `budget_remaining_usd`, `budget_pct_used` in Python), fires the matching [event](#events) for any verdict other than `allow`, and throws `ClawdeVerdictError` on `kill`.

The Intutic proxy does not send those headers today, so `verdict` reads `allow` and no event fires from a proxy response. A request the proxy refuses comes back as an HTTP error — 403 for a block, 409 for a reask, with the reason in the JSON body. `chat()` retries it like any failed attempt, then throws `ClawdeConnectionError` whose message carries the status and the proxy's reason. Catch `ClawdeConnectionError` to handle a refusal.

---

## Code Examples

### TypeScript Example

```typescript
import { ClawdeClient, ClawdeConnectionError, ClawdeVerdictError } from '@intutic/clawde'
import type { ChatResponse } from '@intutic/clawde'

const client = new ClawdeClient({
  apiKey: process.env.INTUTIC_API_KEY!,
  baseUrl: 'http://127.0.0.1:4000',
})

// Workspace-level headroom check (needs a control plane)
const budget = await client.checkBudget('claude-sonnet-4-5', 1000)
if (!budget.allowed) throw new Error(`No budget left: $${budget.remaining_usd}`)

// A runner that wraps one action; calling it runs the action now
const runDeployCheck = client.circuitBreaker<ChatResponse>('deploy_check', {
  maxCostUsd: 5,
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
  if (err instanceof ClawdeVerdictError) console.error(`Circuit breaker tripped: ${err.message}`)
  else if (err instanceof ClawdeConnectionError) console.error(`Request failed or refused: ${err.message}`)
  else throw err
}
```

### Python Example

```python
import os

from intutic_clawde import ClawdeClient, ClawdeConnectionError, ClawdeVerdictError

client = ClawdeClient(api_key=os.environ["INTUTIC_API_KEY"])

def run_deploy():
    return client.chat(
        model="gpt-4o",
        messages=[{"role": "user", "content": "compile build"}],
    )

try:
    # Calling the runner runs run_deploy now, behind the breaker
    res = client.circuit_breaker("deploy_production_tool", max_cost_usd=5.0, fail_open=False)(run_deploy)
    print(res["choices"][0]["message"]["content"])
except ClawdeVerdictError as e:
    print(f"Circuit breaker tripped: {e}")
except ClawdeConnectionError as e:
    print(f"Request failed or refused: {e}")
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

Register callbacks for the verdicts `chat()` reads from the response headers: `hijack`, `enhance`, `kill` and `bypass`. Each callback receives the chat result, carrying `verdict` and the budget fields. As [Verdicts and Errors](#_5-verdicts-and-errors) explains, the proxy does not send these headers today, so these callbacks do not fire on proxy responses.

### TypeScript
```typescript
client.on('hijack', (event) => {
  console.warn(`Verdict ${event.verdict}; $${event.budgetRemainingUsd ?? '?'} budget left`)
})

client.on('kill', () => {
  console.error('Request killed by policy')
})
```

### Python
```python
client.on("hijack", lambda event: print(f"Verdict {event['verdict']}; ${event.get('budget_remaining_usd', '?')} budget left"))
client.on("kill", lambda event: print("Request killed by policy"))
```
