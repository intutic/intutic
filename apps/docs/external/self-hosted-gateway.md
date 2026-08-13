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
LiteLLM container used by the opt-in [local judge](#4-what-does-not-run-locally-read-this-before-you-deploy)
— see §4 for exactly what that buys you and what it still doesn't. This is distinct from the full self-hosted
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
LiteLLM (if enabled) is only consumed when `proxy.localJudge=true` — see §4.

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

### Automatic token rotation

Independent of the manual `intutic gateway rotate` above, a running proxy rotates its own
token on a schedule (default every 30 days, `INTUTIC_GATEWAY_ROTATION_INTERVAL_DAYS`; `0`
disables it) by calling the same rotation mechanics the CLI uses, authenticated with the
token it already holds — not a new privilege, just automatic timing.

By default the rotated value lives only in the proxy process's memory, so a restart (crash,
redeploy) reverts to whatever token your deployment's environment was last set to — this is a
mitigation for a long-lived process holding one credential for too long, not a substitute for
updating your deployment's stored `INTUTIC_GATEWAY_TOKEN`. **The bare-metal target is the one
exception**: `@intutic/gateway-daemon` automatically persists each self-rotated token to a
local state file and re-reads it on every restart it performs (crash or config-reconciliation),
so rotation survives a restart there as long as the daemon's own working directory does. Docker
and Kubernetes deployments do not have this yet (TD-341). See the [gateway-daemon README](https://github.com/intutic/intutic-enterprise/blob/main/packages/gateway-daemon/README.md#automatic-token-rotation-and-how-it-survives-a-restart-here-td-341)
for the full picture, including when even the bare-metal case still needs a manual
`intutic gateway rotate`.

### Pointing a workspace at your gateway

Assign a gateway per-workspace (overriding the org default) or per-org (every workspace under
it that hasn't set its own override):

```bash
intutic gateway assign <gateway_id> --workspace <workspace_id>   # this workspace only
intutic gateway assign <gateway_id> --org <org_id>                # org-wide default
intutic gateway resolve --workspace <workspace_id>                 # which gateway actually applies, and why
```

`gateway resolve` reports `source: workspace | org | default` so you can tell whether a
workspace is riding its own override, its org's default, or the shared `gateway.intutic.ai`
(no assignment at any level). This is *routing resolution* — it tells a client which gateway to
point at — not traffic proxying: the client still connects directly to the resolved gateway's
own exposed address, there is no proxy-in-front-of-proxies routing requests between gateways.

## 4. What does NOT run locally (read this before you deploy)

A self-hosted gateway routes your organization's LLM provider traffic through your own
infrastructure. It does **not**, today, keep every part of Intutic's evaluation pipeline local:

- **By default, LLM-as-judge evaluation stays on Intutic's Cloud control plane.** The proxy
  POSTs chunk/response content to `{CONTROL_PLANE_URL}/api/v1/judge/...` for evaluation
  (default `https://app.intutic.ai`) unless you opt into the local judge below.
- **Local judge (opt-in) keeps finalize-time judging entirely on your infrastructure.** Set
  `INTUTIC_GATEWAY_LOCAL_JUDGE=true` (Docker/bare-metal) or `proxy.localJudge: true` (Helm),
  point `LITELLM_LOCAL_URL` / `proxy.localJudge` + `litellm.judgeModel` at a model in your own
  bundled LiteLLM's `model_list`, and finalize-time content is judged there instead — it never
  reaches `CONTROL_PLANE_URL`. This is a **smaller capability than the SaaS judge**, not a
  drop-in replacement, and the gap is deliberate, not an oversight:
  - Verdicts are `COMPLIANT | VIOLATION | AMBIGUOUS` only (no SaaS-judge chunk-log
    reconciliation vocabulary).
  - Judging happens once, at finalize time — **no mid-stream chunk grading** (the SaaS judge's
    `judge_chunk_scan!` path is skipped entirely when local judge is on).
  - **No personal-SOPs merge** — only the workspace's shared SOPs are graded against.
  - **No incident persistence** — a `VIOLATION` verdict is annotated in the response; it is not
    written to `governance_incidents`, since that table lives in the control plane's Postgres,
    which a self-hosted gateway deliberately doesn't have a connection to.
  - SOP *text* is still fetched from the control plane (`sops::all_sops_for_workspace`) — only
    the judged *content* stays local, a disclosed trade-off, not a silent one.
- **If your judge LLM is unreachable** — local or SaaS — the proxy reports this honestly rather
  than silently passing every check: a response is annotated `Intutic LLM-as-a-Judge: verdict
  UNAVAILABLE — treat as unverified, not as clean`, instead of defaulting to a clean verdict. A
  local judge never falls back to calling the SaaS judge on its own failure.

## Related

- [CLI Reference — `intutic gateway`](/reference/cli#intutic-gateway-register)
- [Settings & Configuration — Provider Keys](/guide/settings#provider-keys)
- [LiteLLM & Proxy Routing Architecture](/external/litellm)
