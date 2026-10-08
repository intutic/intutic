# Self-Hosted Gateway <Badge type="danger" text="Enterprise" />

This page documents deploying and managing your own Intutic gateway inside your organization's
own infrastructure — with Docker Compose or on Kubernetes — instead of routing every workspace
through Intutic's shared `gateway.intutic.ai`.

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
proxy process is run.

## 2. Deployment targets

### Docker

A purpose-built Compose file bundles the proxy, a local Valkey instance, and (optionally) a
LiteLLM container used by the opt-in [local judge](#4-what-does-not-run-locally-read-this-before-you-deploy)
— see §4 for exactly what that buys you and what it still doesn't. This is distinct from the full self-hosted
enterprise stack (`docker-compose.enterprise.yml`), which additionally runs its own
control-plane, Postgres, and dashboard — a self-hosted *gateway* keeps the control plane on
Intutic's Cloud and self-hosts only the data-plane proxy.

The Compose files are in the `gateway/` directory of each release bundle,
`intutic-selfhost-<version>-<arch>.tar.gz`; Intutic sends you the download links
([verifying a release](../guide/self-host#getting-a-release)).

```bash
cd intutic-selfhost-<version>/gateway
cp .env.gateway.example .env
# Set INTUTIC_GATEWAY_ID and INTUTIC_GATEWAY_TOKEN (from `intutic gateway register`),
# CONTROL_PLANE_URL, and INTUTIC_VERSION to the release (cat ../VERSION)
docker login ghcr.io --username <username>   # the pull token Intutic sent you
docker compose -f docker-compose.gateway.yml up -d
```

The images at `ghcr.io/intutic` are private, hence the login. A host that cannot reach
`ghcr.io` loads them from the bundle instead (`docker load -i ../images.tar`); one that also
cannot reach Docker Hub copies the `VALKEY_IMAGE` and `LITELLM_IMAGE` lines from
`../images.env` into `.env`.

Agents reach the gateway on the host's port `GATEWAY_PORT` (default `8080`), at `/v1`: for
example `http://gateway.example.internal:8080/v1`. Put your own TLS-terminating proxy or load
balancer in front of it for traffic that leaves the host.

### Kubernetes

The `intutic-gateway` chart runs the proxy, its own Valkey and, optionally, LiteLLM for the
local judge. It is separate from the `intutic` chart, which runs the whole product.

The chart is at `oci://ghcr.io/intutic/charts/intutic-gateway` and in each release bundle's
`helm/` directory. `<version>` is the release Intutic sent you; each release publishes the
chart and its images under that one version. `ghcr.io/intutic` is private: log Helm in, and
give the cluster a pull Secret, with the username and pull token Intutic sent you. The
gateway's token goes in a Secret, never in values:

```bash
kubectl create namespace intutic-gateway
kubectl -n intutic-gateway create secret generic intutic-gateway-token \
  --from-literal=INTUTIC_GATEWAY_ID=<gw_... from register> \
  --from-literal=INTUTIC_GATEWAY_TOKEN=<gwk_... from register>
kubectl -n intutic-gateway create secret docker-registry intutic-ghcr \
  --docker-server=ghcr.io --docker-username=<username> --docker-password=<pull token>
helm registry login ghcr.io --username <username>   # paste the pull token when asked

helm install my-gateway oci://ghcr.io/intutic/charts/intutic-gateway --version <version> \
  --namespace intutic-gateway \
  --set controlPlaneUrl=https://app.intutic.ai \
  --set 'imagePullSecrets[0].name=intutic-ghcr'
```

The proxy's Service is `ClusterIP` on port `8080`, so agents inside the cluster use
`http://my-gateway-intutic-gateway-proxy.intutic-gateway.svc.cluster.local:8080/v1`. For
agents outside it, set `proxy.service.type=LoadBalancer`, or route your own Ingress to that
Service. The install's notes print the address.

| Value | Default | |
|---|---|---|
| `controlPlaneUrl` | Intutic Cloud | The control plane the gateway reports to: Intutic Cloud, or your Self-host address |
| `gatewaySecretName` | `intutic-gateway-token` | The Secret with `INTUTIC_GATEWAY_ID` and `INTUTIC_GATEWAY_TOKEN` |
| `imagePullSecrets` | none | Pull Secrets for `ghcr.io/intutic` |
| `proxy.image.repository`, `proxy.image.tag` | `ghcr.io/intutic/proxy`, the chart's version | Your mirror of the proxy image |
| `proxy.service.type`, `proxy.service.port` | `ClusterIP`, `8080` | How agents reach the gateway |
| `proxy.replicaCount`, `proxy.resources` | 1, see `helm show values` | |
| `proxy.heartbeatIntervalSeconds` | 30 | How often the gateway reports in |
| `proxy.rotationIntervalDays` | 30 | How often the proxy rotates its token; `0` turns it off |
| `proxy.selfRotationPatchesOwnSecret` | `false` | Write each rotated token back to the Secret (below) |
| `proxy.requireVk` | `true` | Accept only Intutic virtual keys (`vk_`), never a raw provider key |
| `proxy.requireProvisionedKey` | `false` | Also refuse a virtual key with no provider key provisioned for it |
| `proxy.judgeFinalizeDeadlineMs` | 5000 | How long judging may hold up the end of a response, in milliseconds |
| `proxy.localJudge` | `false` | Judge with this chart's LiteLLM (§4) |
| `valkey.image.repository`, `valkey.image.tag` | `valkey/valkey`, `7-alpine` | |
| `valkey.persistence.enabled`, `valkey.persistence.size`, `valkey.persistence.storageClassName` | `false`, `1Gi`, the cluster default | Keep Valkey's data across restarts |
| `litellm.enabled` | `false` | Run LiteLLM for the local judge |
| `litellm.config` | none | LiteLLM's config: `--set-file litellm.config=./litellm_config.yaml` |
| `litellm.configMapName` | none | Or a ConfigMap of yours with the key `config.yaml` |
| `litellm.secretName` | none | A Secret passed to LiteLLM as environment: `LITELLM_MASTER_KEY` and the variables your config reads |
| `litellm.judgeModel` | none | The `model_name` the local judge calls |

`helm show values oci://ghcr.io/intutic/charts/intutic-gateway --version <version>` prints
them all with their comments.

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

The rotated value is kept in the proxy process's memory, and the proxy also persists it so a
restart doesn't revert to a stale token — the exact mechanism depends on your deployment target:

- **Docker** (`docker-compose.gateway.yml`): the proxy writes every self-rotated token to a
  state file (`INTUTIC_GATEWAY_TOKEN_STATE_FILE`) and reads it back at startup. The compose file
  mounts a named volume at that path, so it survives `docker compose up` recreating the
  container.
- **Kubernetes** (the `intutic-gateway` chart; the interval is `proxy.rotationIntervalDays`): a state file only survives an in-place container
  restart within the same pod, not a reschedule or rolling redeploy (a new pod is a fresh
  filesystem) — so the proxy additionally PATCHes its own gateway Secret via the in-cluster
  Kubernetes API on every successful rotation. Opt-in via the chart's
  `proxy.selfRotationPatchesOwnSecret` value (default `false` — it's a real RBAC grant, `get`+
  `patch` scoped to just this release's `gatewaySecretName`, beyond what the proxy needs to run).
  With it enabled, the next pod created from the Deployment — reschedule or redeploy — reads the
  current token fresh via its existing `secretKeyRef`.

None of this replaces `intutic gateway rotate` as your recovery path — if the persisted storage
itself is lost (the Docker volume deleted, or the Kubernetes flag left off), a restart still reverts to whatever `INTUTIC_GATEWAY_TOKEN` your deployment's
environment holds, and you're back to running that command and updating the stored token by hand.

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

## 4. What does NOT run locally (read this before you deploy) {#4-what-does-not-run-locally-read-this-before-you-deploy}

A self-hosted gateway routes your organization's LLM provider traffic through your own
infrastructure. It does **not**, today, keep every part of Intutic's evaluation pipeline local:

- **By default, LLM-as-judge evaluation stays on Intutic's Cloud control plane.** The proxy
  POSTs chunk/response content to `{CONTROL_PLANE_URL}/api/v1/judge/...` for evaluation
  (default `https://app.intutic.ai`) unless you opt into the local judge below. There it runs
  on Intutic's own self-hosted open-weight models, never a third-party hosted API.
- **Local judge (opt-in) keeps finalize-time judging entirely on your infrastructure.** Set
  `INTUTIC_GATEWAY_LOCAL_JUDGE=true` and `LITELLM_LOCAL_JUDGE_MODEL` (Docker), or
  `proxy.localJudge: true` and `litellm.judgeModel` (Helm), naming a model in the bundled
  LiteLLM's `model_list`, and finalize-time content is judged there instead — it never
  reaches `CONTROL_PLANE_URL`. That model must be self-hosted (Ollama, vLLM, or another server
  you run): judges never call a hosted API such as Anthropic, OpenAI, OpenRouter or Ollama Cloud,
  even with your own key. This is a **smaller capability than the SaaS judge**, not a
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
  - See [On-Prem Judge Setup](/external/on-prem-judge) for the `intutic judge configure` walkthrough
    that generates the `litellm_config.yaml`, env block, and Helm values a local judge needs —
    local files only, never a remote API call, matching this document's own point that
    local-judge config is not remotely settable.
  - An optional typed stage clears clean responses without a free-text call
    (`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`, `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI`,
    `LITELLM_LOCAL_TYPED_JUDGE_MODEL`). It needs a model that returns log-probabilities and a
    band you measured for that model — see
    [On-Prem Judge Setup](/external/on-prem-judge#typed-stage-optional).
- **If your judge LLM is unreachable** — local or SaaS — the proxy reports
  this honestly rather than silently passing every check: a response is annotated `Intutic
  LLM-as-a-Judge: verdict UNAVAILABLE — treat as unverified, not as clean`, instead of
  defaulting to a clean verdict. A local judge never falls back to calling the SaaS judge on
  its own failure.

## Related

- [CLI Reference — `intutic gateway`](/reference/cli#intutic-gateway-register)
- [Settings & Configuration — Provider Keys](/guide/settings#provider-keys)
- [LiteLLM & Proxy Routing Architecture](/external/litellm)
- [On-Prem Judge Setup](/external/on-prem-judge)
