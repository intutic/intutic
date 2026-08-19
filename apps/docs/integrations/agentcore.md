---
title: AWS Bedrock AgentCore
description: What Intutic can and cannot govern across AgentCore Runtime, Gateway, Policy, and Harness — plus the interceptor Lambda deployment walkthrough.
---

# AWS Bedrock AgentCore

AWS Bedrock AgentCore (GA 2025-10) is a 13-module platform for hosting and running agents on AWS — Runtime, Gateway, Policy, Harness, Memory, Identity, Code Interpreter, Browser, Observability, Payments, Evaluations, Optimization, Registry. This page covers exactly the four modules that intersect with tool-call governance: **Runtime**, **Gateway**, **Policy**, and **Harness**. The other nine (Memory, Identity, Code Interpreter, Browser, Observability, Payments, Evaluations, Optimization, Registry) have no tool-call surface for Intutic to govern and are out of scope here.

::: warning This page covers two structurally different integrations
**AgentCore Runtime** hosts your own agent code — it is governed via whichever already-supported framework SDK gate your code uses (Strands, LangGraph, CrewAI, ...), the same way that framework is governed anywhere else. There is a `HarnessType` entry (`agentcore-runtime`) and `intutic init`/`intutic connect` detect it, but it writes no config of its own.

**AgentCore Gateway** is a deployed AWS resource, not something on a developer's laptop — like [QM](/integrations/qm), it has **no `HarnessType` entry** and `intutic init`/`intutic connect` never detect or configure it. Its coverage is the `tools/agentcore-interceptor` Lambda, deployed once by an operator, calling a dedicated Intutic control-plane endpoint for a verdict.
:::

## What IS governable

| Module | What's governed | Mechanism |
|---|---|---|
| **Runtime** | Tool calls made by your own agent code | Whichever framework SDK gate your code already uses (Strands, LangGraph, CrewAI, ...) — unchanged by running inside Runtime |
| **Gateway** | MCP `tools/call` requests the gateway forwards to a target | The `tools/agentcore-interceptor` Lambda, attached as a REQUEST interceptor, calling `POST /api/v1/integrations/agentcore/gateway-check` |

## What is NOT governable, and why

| Module | Why not | |
|---|---|---|
| **Bedrock's own model-invocation traffic** (`Converse`/`InvokeModel`) | SigV4-signed — the signature covers the full request including the destination host, so it cannot be transparently redirected through the Intutic proxy the way an `OPENAI_BASE_URL`-style override works elsewhere in this product. This is a hard limitation, not a gap to close later. | Same limitation Strands' default Bedrock provider already documents — see [Strands' per-provider table](/integrations/strands#route-llm-traffic-through-the-proxy-per-provider-honesty). |
| **AgentCore Policy** (built on Cedar, internally "Dogwood") | Confirmed against the real `GatewayPolicyEngineConfiguration` API: its `arn` field only ever names an AWS-native `policy-engine/...` resource — there is no field for a third-party HTTP policy backend at all. AWS's own policy engine is closed; Intutic cannot plug into it the way it plugs into the Gateway interceptor. | [`GatewayPolicyEngineConfiguration` API reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GatewayPolicyEngineConfiguration.html) |
| **AgentCore Harness** agents | A distinct module from Runtime: Harness agents run NO customer code, so there is nothing to attach an SDK gate to. If a Harness agent's tool calls are exposed through a Gateway, the Gateway interceptor path above still applies — but Harness itself has no independent surface. | |

You can run AgentCore Policy (`policyEngineConfiguration`) and the Gateway interceptor **on the same gateway** — they are independent `CreateGateway` fields — but Intutic only ever integrates with the interceptor half.

## AgentCore Runtime

### How it works

The `agentcore-runtime` adapter is detected via any of:
- `bedrock-agentcore` in a Python manifest (`pyproject.toml`, `requirements.txt`, `uv.lock`) or in `package.json` dependencies — the SDK itself (confirmed live: PyPI `bedrock-agentcore` at 1.22.0, npm `bedrock-agentcore` at 0.4.3)
- `bedrock-agentcore-starter-toolkit` in a Python manifest — the optional Python CLI/dev-loop toolkit (confirmed at 0.3.11)
- `@aws/agentcore` in `package.json` — the npm CLI (confirmed at 0.27.0)
- `.bedrock_agentcore.yaml`, `agentcore/agentcore.json`, or `aws-targets.json` at the workspace root — config files the CLIs above write during `agentcore configure`/`agentcore launch`/`agentcore deploy`

It writes **no config of its own**. Runtime hosts your agent code unchanged, so the actual tool-call gate is whichever already-supported framework adapter your code uses — if your project also matches `strands-agents`, `langgraph`, `crewai`, etc., THAT adapter writes the real `.env.intutic` proxy configuration and the gate stays SDK-side exactly as documented on that framework's own page. If your Runtime-hosted code uses no framework this product supports (raw `boto3`, a hand-rolled tool loop), coverage is genuinely zero — the same honest gap the [Agentic Orchestrator](/integrations/agentic-orchestrator) integration has for its OpenCode backend.

### Deployment-target constraints worth knowing

These are not gate concerns this adapter can fix — they're facts about the hosting environment that change what "governed" actually means once your code runs on Runtime instead of your laptop.

**Environment variables are capped.** `CreateAgentRuntime`'s `environmentVariables` accepts at most **50 entries**, each key up to **100 characters** and each value up to **5,000 characters** (confirmed against the current `CreateAgentRuntime` API reference). The proxy base-URL vars your framework's `.env.intutic` writes are small and comfortably fit; this matters if you're already close to the cap for other reasons.

**Egress is PUBLIC by default.** Runtime's `networkMode` is `PUBLIC` or `VPC` (confirmed via `NetworkConfiguration`'s API reference). Routing Runtime's outbound traffic through a local/on-prem Intutic proxy — the way a laptop's `ANTHROPIC_BASE_URL` env var does — requires the agent to actually be able to reach that proxy's network location. Under `PUBLIC` mode there is no private path to an on-prem proxy at all. Under `VPC` mode, reaching an on-prem/local proxy needs the customer's own explicit NAT/VPN/Direct Connect topology; this is network infrastructure work the adapter cannot do for you, only document. If your proxy is itself internet-reachable (e.g. a deployed Intutic control-plane/proxy endpoint, not a laptop-local one), `PUBLIC` mode reaches it directly and no extra topology work is needed.

**Bedrock's own model traffic still isn't proxyable** — see the table above. This holds inside Runtime exactly as it does anywhere else.

### Setup

```bash
intutic init
```

Then set up your chosen framework's own SDK gate exactly as documented on its page (e.g. [Strands](/integrations/strands), [LangGraph](/integrations/langgraph), [CrewAI](/integrations/crewai)) — nothing about running inside AgentCore Runtime changes that setup.

## AgentCore Gateway — interceptor Lambda

### How the interceptor works

AgentCore Gateway can front MCP tool calls. AWS lets an operator attach **at most one REQUEST interceptor and at most one RESPONSE interceptor per gateway** (confirmed: `CreateGateway`'s `interceptorConfigurations` accepts 1–2 items, and AWS's own devguide states plainly "you cannot have multiple interceptors of the same type") — **only Lambda functions can serve as interceptors**, no other runtime.

The REQUEST interceptor runs before the gateway calls the real tool target — this is the actual pre-execution veto point for `tools/call`. `tools/agentcore-interceptor` (`tools/agentcore-interceptor/src/handler.ts` in this repo) is that Lambda:

1. Extracts `params.name` / `params.arguments` from the incoming `tools/call` JSON-RPC request (every other MCP method — `tools/list`, `initialize`, ... — passes through unchanged; there's nothing to allow/deny about listing tools).
2. Calls `POST /api/v1/integrations/agentcore/gateway-check` on your Intutic control plane with `{ toolName, toolInput, sessionId?, gatewayId? }`, authenticated as `Authorization: Bearer vk_...` (a workspace virtual key — standard Bearer auth, not a special header scheme).
3. On `{ allowed: true }`, returns the original request unchanged (`transformedGatewayRequest`).
4. On `{ allowed: false, reason }`, short-circuits with a JSON-RPC error response (`transformedGatewayResponse`) — the gateway returns that immediately without ever calling the target.
5. On a control-plane failure (timeout, network error, non-2xx, unparseable body), **fails CLOSED by default** — deny, don't silently let a governed gateway call through ungoverned. Set `INTUTIC_FAIL_OPEN=true` to invert this if your own uptime requirements call for it.

::: tip Confirmed against AWS's real interceptor contract, not assumed
The exact event/response JSON shapes this Lambda implements (`interceptorInputVersion`/`interceptorOutputVersion: "1.0"`, `mcp.gatewayRequest`/`mcp.gatewayResponse`, `transformedGatewayRequest`/`transformedGatewayResponse`) were fetched live from AWS's current devguide (`docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html` and `.../gateway-interceptors-examples.html`, 2026-08-19) — see `tools/agentcore-interceptor/src/types.ts`'s module doc for exactly what was confirmed and where.
:::

### Composing with your own Lambda logic

Because a gateway can have only ONE REQUEST interceptor, if you need custom logic of your own (auth, header injection, model-routing rewrites, ...) on the same gateway, it must be composed into a single Lambda alongside Intutic's check — not two separate interceptors. The straightforward pattern: call your own logic first, and only invoke `checkToolCall` (exported from `tools/agentcore-interceptor/src/handler.ts`) for `tools/call` requests your logic didn't already reject.

### Short-circuit and streaming behavior

- **Short-circuit visibility depends on target type.** For MCP targets (what this Lambda is deployed against), a REQUEST interceptor's `transformedGatewayResponse` short-circuit STILL invokes a configured RESPONSE interceptor afterward — confirmed against AWS's devguide. (For HTTP targets, the opposite is true: the RESPONSE interceptor does NOT run after a short-circuit. Don't assume MCP behavior carries over if you also front an HTTP/Runtime target through the same gateway.)
- **Streaming applies to the RESPONSE side only.** When gateway response streaming is enabled, AWS invokes the RESPONSE interceptor multiple times per request (once per eligible JSON-RPC event). This Lambda is a REQUEST interceptor and is invoked once per `tools/call` regardless of whether the eventual response streams — streaming does not change its behavior. If you also attach this Lambda as a RESPONSE interceptor (its `handleResponseInterceptor` path passes every response through unchanged today), be aware of the streaming input shape differences documented in `types.ts`.

### Deployment walkthrough

**1. Build and package the Lambda**

```bash
cd tools/agentcore-interceptor
pnpm install
pnpm build   # emits dist/handler.js
```

Package `dist/` (plus `node_modules` if you add runtime dependencies beyond Node's built-in `fetch`) into a Lambda deployment artifact using your normal AWS deployment tooling (SAM, CDK, Terraform, or a plain zip upload).

**2. Configure the Lambda's environment**

| Variable | Required | Meaning |
|---|---|---|
| `INTUTIC_CONTROL_PLANE_URL` | Yes | Your Intutic control-plane base URL, e.g. `https://your-intutic-control-plane.example.com` |
| `INTUTIC_API_KEY` | Yes | A workspace virtual key (`vk_...`) minted via `POST /api/v1/keys` in your Intutic dashboard |
| `INTUTIC_FAIL_OPEN` | No (default `false`) | Set `"true"` to allow tool calls through when the control-plane check itself fails, instead of denying |
| `INTUTIC_TIMEOUT_MS` | No (default `3000`) | Control-plane call timeout |
| `AGENTCORE_GATEWAY_ID` | No | Attached to requests for control-plane log correlation only — never affects the verdict |

**3. Grant the gateway permission to invoke the Lambda**

Your gateway's service role needs `lambda:InvokeFunction` scoped to this specific function ARN (never a wildcard) — see [AWS's interceptor permissions guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-permissions.html) for the exact policy shape.

**4. Attach the Lambda as a REQUEST interceptor**

```bash
aws bedrock-agentcore-control update-gateway \
  --gateway-identifier <your-gateway-id> \
  --interceptor-configurations '[{
      "interceptor": {
          "lambda": { "arn": "arn:aws:lambda:<region>:<account-id>:function:<your-function-name>" }
      },
      "interceptionPoints": ["REQUEST"],
      "inputConfiguration": { "passRequestHeaders": true }
  }]'
```

`passRequestHeaders: true` is needed only if you want `Mcp-Session-Id` forwarded to the control plane for log correlation — the allow/deny decision itself never depends on headers.

**5. Verify**

Send a `tools/call` request through the gateway for a tool your workspace has a `BLOCK:` SOP rule against, and confirm you receive a JSON-RPC error whose message starts with `Blocked by Intutic governance:`. Check your control-plane logs for `agentcore_gateway_blocked` entries to confirm the verdict is being recorded.

## Config details

| Property | Value |
|---|---|
| Harness type (Runtime only) | `agentcore-runtime` — no entry for Gateway (server-side, like [QM](/integrations/qm)) |
| Config file (Runtime) | none — delegates entirely to whichever framework adapter your code uses |
| Detection (Runtime) | `bedrock-agentcore`/`bedrock-agentcore-starter-toolkit`/`@aws/agentcore` in a manifest, or `.bedrock_agentcore.yaml`/`agentcore/agentcore.json`/`aws-targets.json` at the workspace root |
| Gateway endpoint | `POST /api/v1/integrations/agentcore/gateway-check` |
| Gateway auth | `Authorization: Bearer vk_...` (standard workspace virtual key — no special header scheme) |
| Gateway request | `{ toolName: string, toolInput?: unknown, sessionId?: string, gatewayId?: string }` |
| Gateway response | `{ allowed: boolean, reason?: string }` |
| Interceptor Lambda source | `tools/agentcore-interceptor/src/handler.ts` |
