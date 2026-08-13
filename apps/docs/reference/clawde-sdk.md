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

The `clawde` SDK acts as a client-side wrapper around Anthropic's Message API, OpenAI API, or arbitrary agent tasks. It communicates locally with the Intutic proxy to enforce rules in the developer's execution path.

```
[Agent Script] ──> [clawde SDK Wrapper] ──> [Local Proxy (Port 4000)] ──> [LLM API]
```

### 1. Context Resolution
The SDK automatically resolves git branch names, active pull requests, and CI variables. If the Intutic sync-daemon is running, the SDK reads local state at `~/.intutic/config.json` to resolve the current task, Jira ticket, or incident context.

### 2. Warm-Path Budget Gating
Before forwarding calls to the LLM, the SDK estimates request and output tokens. It checks local memory caches (30-second TTL) or queries the local proxy at `/v1/budget/check`. The SDK piggybacks on response headers (`X-Intutic-Budget-*`) from the proxy to continuously refresh remaining budget limits.

### 3. Circuit Breaker Wrapper
Wrap arbitrary tasks or API calls in a circuit breaker. If pre-flight budget checks fail, or if policy violations are detected, the circuit breaker triggers fallback behaviors (such as returning a default safe response instead of executing the action).

### 4. Schema Conversion (TypeScript only)
Transparently normalizes Anthropic's Message API structures (converting tool call layouts, system parameters, and response structures) to and from OpenAI-compatible formats.

---

## Code Examples

### TypeScript Example

```typescript
import { ClawdeClient, circuitBreaker } from '@intutic/clawde';

// Initialize the client (auto-resolves config.json context)
const client = new ClawdeClient({
  apiKey: process.env.INTUTIC_API_KEY,
  baseUrl: 'http://127.0.0.1:4000'
});

// Wrap an agent action with policy enforcement
const runAgentTool = circuitBreaker({
  client,
  taskType: 'coding',
  failOpen: false, // block if proxy is unreachable
  defaultAction: async () => ({ status: 'blocked', reason: 'Safety circuit tripped' })
}, async (args) => {
  const response = await client.messages.create({
    model: 'claude-3-5-sonnet',
    max_tokens: 1000,
    messages: [{ role: 'user', content: `Run tool call: ${args.tool}` }]
  });
  return response;
});
```

### Python Example

```python
from intutic_clawde import ClawdeClient, ClawdeVerdictError

# Initialize client (auto-resolves config.json context)
client = ClawdeClient(api_key=os.environ.get("INTUTIC_API_KEY"))

# Register listeners for policy outcomes
client.on("hijack", lambda payload: print(f"Hijacked: {payload}"))
client.on("kill", lambda payload: print("Task terminated due to budget exhaustion!"))

# Wrap a tool execution with a circuit breaker
@client.circuit_breaker("deploy_production_tool", max_cost_usd=5.0, fail_open=False)
def run_deploy():
    # executes target tool action
    return "successfully deployed"

try:
    res = client.chat(model="gpt-4o", messages=[{"role": "user", "content": "compile build"}])
except ClawdeVerdictError as e:
    print(f"Request blocked by policy: {e.verdict}")
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
| Org signup | `signupOrg()` / `signup_org()` |
| Teams & workspaces | `listTeams`, `createTeam`, `listTeamWorkspaces`, `createWorkspace` |
| Gateways | `registerGateway`, `listGateways`, `getGatewayStatus`, `rotateGatewayToken`, `revokeGateway`, `setGatewayConfig`, `assignWorkspaceGateway`, `assignOrgGateway`, `resolveGateway` |
| Provider credentials | `listProviderCredentials`, `setProviderCredential`, `unsetProviderCredential` |

Not covered, on purpose: session establishment (`intutic login`/`logout` — supply `apiKey` directly instead) and local-environment/terminal-only commands (`init`, `doctor`, `install-daemon`, `integrity`, `rollback`, `connect`, `exec`, `start`, `syncContext`, `skill`) that have no meaning for a library embedded in your own process.

---

## Events

Register callbacks to act upon policy decisions:

### TypeScript
```typescript
client.on('hijack', (event) => {
  console.warn(`Policy hijack triggered on trace: ${event.traceId}. Reason: ${event.reason}`);
});

client.on('kill', (event) => {
  console.error(`Task killed due to budget exhaustion!`);
});
```

### Python
```python
client.on("hijack", lambda event: print(f"Hijack triggered: {event['reason']}"))
client.on("kill", lambda event: print("Killed due to budget limits!"))
```
