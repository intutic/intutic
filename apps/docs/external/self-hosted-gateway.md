# Self-Hosted Gateway <Badge type="danger" text="Enterprise" />

This page documents deploying and managing your own Intutic gateway inside your organization's
own infrastructure — Docker, Kubernetes, or a bare-metal Node.js supervisor daemon — instead of
routing every workspace through Intutic's shared `gateway.intutic.ai`.

---

## 1. What a self-hosted gateway is

A gateway is a running instance of the same Rust proxy (`packages/proxy`) that powers
`gateway.intutic.ai`, registered against your org and pointed at by one or more of your
workspaces. Ownership anchors on the **org**, not the workspace — a gateway is something an
org stands up once and points its workspaces at, the same way one shared `gateway.intutic.ai`
process already serves every Cloud workspace multi-tenant today.

Every deployment target shares one control-plane registration flow (`intutic gateway register`
— see the [CLI reference](/reference/cli#intutic-gateway-register)) and one heartbeat/config
protocol, built into the proxy binary itself. What differs between targets is only how the
proxy process is supervised.

## 2. Deployment targets

### Docker

A purpose-built Compose file bundles the proxy, a local Valkey instance, and (optionally) a
LiteLLM container — see [§4](#4-what-does-not-run-locally-read-this-before-you-deploy) for what
that LiteLLM container is and is not wired to. This is distinct from the full self-hosted
enterprise stack (`docker-compose.enterprise.yml`), which additionally runs its own
control-plane, Postgres, and dashboard — a self-hosted *gateway* keeps the control plane on
Intutic's Cloud and self-hosts only the data-plane proxy.

```bash
git clone https://github.com/intutic/intutic-enterprise
cd intutic-enterprise/infra/compose
cp .env.gateway.example .env.gateway
# Set INTUTIC_GATEWAY_TOKEN (from `intutic gateway register`) and CONTROL_PLANE_URL
docker compose -f docker-compose.gateway.yml up -d
```

### Kubernetes

A dedicated, distributable Helm chart — separate from the chart that deploys Intutic's own
full SaaS stack, since that one also ships the control plane and dashboard.

```bash
helm install my-gateway ./tools/helm/intutic-gateway \
  --set gateway.token=<gwk_... from register> \
  --set gateway.controlPlaneUrl=https://api.intutic.ai
```

`NOTES.txt` after install shows the proxy's in-cluster address and reminds you the bundled
LiteLLM (if enabled) is not wired to anything yet — see §4.

### Bare-metal (Node.js supervisor daemon)

`@intutic/gateway-daemon` is a thin supervisor, not a proxy reimplementation: it downloads and
verifies a pinned Rust proxy release, writes its config, restarts it on crash, and polls the
control plane for config changes. It deliberately does **not** self-update — a supervisor that
swaps its own binary is a materially bigger security-review surface than one running a pinned
version, so upgrades are a manual, deliberate step.

```bash
npm install -g @intutic/gateway-daemon
INTUTIC_GATEWAY_TOKEN=gwk_... intutic-gateway-daemon
```

## 3. Registering, monitoring, and rotating a gateway

All lifecycle operations go through the control plane, reachable from the CLI (see the
[CLI reference](/reference/cli#intutic-gateway-register) for full option tables):

```bash
intutic gateway register --name "prod-gateway" --target docker   # prints a one-time gwk_ token
intutic gateway list                                             # every registered gateway
intutic gateway status <gateway_id>                               # online / degraded / unreachable
intutic gateway rotate <gateway_id>                                # new token, old one valid for a grace period
intutic gateway revoke <gateway_id> --reason "decommissioned"      # immediate, no grace period
intutic gateway config set <gateway_id> --require-provisioned-key true
```

A gateway that stops heartbeating is reported `unreachable` once its heartbeat is older than
the TTL window (~90s) — a self-healing status, not an error state that needs to be cleared.

### Pointing a workspace at your gateway

Today this is a manual step, not a resolved platform feature: point the client's base URL
(`CONTROL_PLANE_URL` / proxy target) at your gateway's own exposed address instead of
`gateway.intutic.ai`. A `workspaces.gatewayId` assignment field exists in the schema for a
future "the platform resolves which gateway serves this workspace" capability, but nothing
reads or writes it yet — don't rely on assigning a gateway through the dashboard to actually
change where traffic goes.

## 4. What does NOT run locally (read this before you deploy)

A self-hosted gateway routes your organization's LLM provider traffic through your own
infrastructure. It does **not**, today, keep every part of Intutic's evaluation pipeline local:

- **The LLM-as-judge evaluation stays on Intutic's Cloud control plane.** Judge calls are made
  by the control plane, not the proxy — the proxy only POSTs chunk/response content to
  `{CONTROL_PLANE_URL}/api/v1/judge/...` for evaluation, and by default that URL is
  `https://app.intutic.ai`. If your organization needs judged content to never leave your
  infrastructure, this is not yet supported by a self-hosted gateway alone — deterministic
  enforcement (SOPs, WASM rules, egress policy) all run locally in the proxy regardless, but
  the LLM-judge layer specifically does not.
- **The bundled LiteLLM container is not wired to anything.** Both the Docker Compose file and
  the Helm chart can optionally start a LiteLLM instance at your gateway's site, provisioned
  ahead of a proxy-side feature that would consume it — but as of today nothing in the proxy
  calls out to it. Starting it gets you a reachable, otherwise-idle container.
- **If your judge LLM is unreachable**, the proxy reports this honestly rather than silently
  passing every check: a response is annotated `Intutic LLM-as-a-Judge: verdict UNAVAILABLE —
  treat as unverified, not as clean`, instead of defaulting to a clean verdict.

This page will be updated when local judge evaluation for self-hosted gateways ships.

## Related

- [CLI Reference — `intutic gateway`](/reference/cli#intutic-gateway-register)
- [Settings & Configuration — Provider Keys](/guide/settings#provider-keys)
- [LiteLLM & Proxy Routing Architecture](/external/litellm)
