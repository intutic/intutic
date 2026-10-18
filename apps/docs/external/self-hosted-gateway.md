# Self-Hosted Gateway <Badge type="danger" text="Enterprise" />

This page documents deploying and managing your own Intutic gateway inside your organization's
own infrastructure — with Docker Compose, on Kubernetes, or on bare metal under systemd — instead
of routing every workspace through Intutic's shared `gateway.intutic.ai`.

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
proxy process is run. A config change applies live on every target (see
[Changing a gateway's config](#changing-a-gateway-s-config)).

## 2. Deployment targets

### Docker

A purpose-built Compose file bundles the proxy, a local Valkey instance, and (optionally) a
LiteLLM container used by the opt-in [local judge](#4-what-does-not-run-locally-read-this-before-you-deploy)
— see §4 for exactly what that buys you and what it still doesn't — and a
[decide model](#decide-model) server. This is distinct from the full self-hosted
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
`ghcr.io` loads them from the bundle instead (`docker load -i ../images.tar`) and copies the
`LITELLM_IMAGE` and `DECIDE_MODEL_IMAGE` lines from `../images.env` into `.env` (both images are
on `ghcr.io` too); one that also cannot reach Docker Hub copies the `VALKEY_IMAGE` line as well.

Agents reach the gateway on the host's port `GATEWAY_PORT` (default `8080`), at `/v1`: for
example `http://gateway.example.internal:8080/v1`. Put your own TLS-terminating proxy or load
balancer in front of it for traffic that leaves the host.

#### Decide model {#decide-model}

[Decide rules](/guide/decide) ask a self-hosted model. The Compose file can run that model
server too, in one of two profiles: run one, never both. Either answers as `decide-model` on
port 8000 of the gateway's internal network, which has no route out, and the Compose file
points the proxy's decide engine at it: `INTUTIC_DECIDE_ENGINE_URL`, with the service name
listed in `INTUTIC_SELF_HOSTED_DECISION_HOSTS` so the engine's
[self-hosted guard](/guide/decide#self-hosted-only) allows it. These are the variables a gate
reads. No weights ship in the bundle: put them in `DECIDE_MODEL_DIR` (default `./models`, next
to the Compose file) first. With `INTUTIC_DECIDE_MODEL` empty the engine is not configured.

| Profile | Server | Model |
|---|---|---|
| `decide-model-gpu` | vLLM, on one NVIDIA GPU with 24 GB (an L4) | Qwen3.6-27B, AWQ 4-bit: the server model that passed Intutic's evaluation |
| `decide-model` | llama.cpp, on CPU | One GGUF file you choose. No CPU-sized model passed the evaluation |

On a GPU host, with the NVIDIA Container Toolkit installed, download the weights at the
revision Intutic tested:

```bash
hf download cyankiwi/Qwen3.6-27B-AWQ-INT4 --revision e5cc0400fb2403c437c2c40a7c52fb5ae93fda18 \
  --local-dir models/Qwen3.6-27B-AWQ-INT4
```

set these in `.env`, and start the profile with the rest of the gateway:

```bash
INTUTIC_DECIDE_MODEL=qwen3.6-27b-awq
INTUTIC_DECIDE_MODEL_DIGEST=hf:cyankiwi/Qwen3.6-27B-AWQ-INT4@e5cc0400fb2403c437c2c40a7c52fb5ae93fda18
```

```bash
docker compose -f docker-compose.gateway.yml --profile decide-model-gpu up -d
```

vLLM's image is about 10 GB and is not in the bundle. It is pinned by digest
(`DECIDE_MODEL_GPU_IMAGE`); a host without Docker Hub access needs a mirror of it.
`DECIDE_MODEL_GPU_WEIGHTS` names another weights directory, and
`DECIDE_MODEL_GPU_MEMORY_UTILIZATION` (default `0.94`) the share of GPU memory vLLM takes.

On CPU, copy your GGUF file into `models/`, then set:

```bash
DECIDE_MODEL_FILE=<file>.gguf
INTUTIC_DECIDE_MODEL=<a name for it>
INTUTIC_DECIDE_MODEL_DIGEST=sha256:<the file's SHA-256, from sha256sum models/<file>.gguf>
INTUTIC_DECIDE_TIMEOUT_MS=30000
```

```bash
docker compose -f docker-compose.gateway.yml --profile decide-model up -d
```

The server checks the file against `INTUTIC_DECIDE_MODEL_DIGEST` before it starts and refuses one
that does not match, so the digest decide pins are keyed by is the weights it serves. Its image,
llama.cpp, is in the bundle. A CPU answers far more slowly than a GPU, hence the longer
per-call timeout. The release's air-gap smoke test runs this profile with Qwen3.5-4B (Q4_K_M)
to prove the wiring: that model reads the engine canary's yes/no questions the right way round,
but its choice answer falls short of the canary's bar, so decide rules on it are unavailable,
and an enforcing one refuses its calls.

Whichever model you run, a rule enforces on it only once `intutic decide eval` passes for that
rule on your labels. Neither profile can be reached from outside the gateway host's internal
network. To run `intutic decide eval` or `intutic doctor` against it from the host, publish its
port in a `docker-compose.override.yml` beside the Compose file, which gives it a route out
while it is there:

```yaml
services:
  decide-model:            # or decide-model-gpu
    networks: [gateway-internal, egress]
    ports: ["127.0.0.1:8000:8000"]
```

and point the CLI at `http://127.0.0.1:8000` with the same model name and digest.

### Kubernetes

The `intutic-gateway` chart runs the proxy, its own Valkey and, optionally, LiteLLM for the
local judge and a [decide model](#decide-model) server. It is separate from the `intutic` chart, which runs the whole product.

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
| `nameOverride`, `fullnameOverride` | none | Resource names are `<release>-intutic-gateway`, or the release name alone when it contains `intutic-gateway`. `nameOverride` replaces the `intutic-gateway` part, `fullnameOverride` the whole name |
| `proxy.image.repository`, `proxy.image.tag`, `proxy.image.pullPolicy` | `ghcr.io/intutic/proxy`, the chart's version, `IfNotPresent` | Where the proxy image comes from |
| `proxy.service.type`, `proxy.service.port` | `ClusterIP`, `8080` | How agents reach the gateway |
| `proxy.replicaCount`, `proxy.resources` | 1, see `helm show values` | |
| `proxy.heartbeatIntervalSeconds` | 30 | How often the gateway reports in |
| `proxy.rotationIntervalDays` | 30 | How often the proxy rotates its token; `0` turns it off |
| `proxy.selfRotationPatchesOwnSecret` | `false` | Write each rotated token back to the Secret (below) |
| `proxy.requireVk` | `true` | Accept only Intutic virtual keys (`vk_`), never a raw provider key |
| `proxy.requireProvisionedKey` | `false` | Also refuse a virtual key with no provider key provisioned for it |
| `proxy.judgeFinalizeDeadlineMs` | 5000 | How long judging may hold up the end of a response, in milliseconds |
| `proxy.localJudge` | `false` | Judge with this chart's LiteLLM (§4) |
| `proxy.localJudgeTypedLo`, `proxy.localJudgeTypedHi` | none | The local judge's optional typed stage: log-odds bounds (`Lo` < `Hi`), on only when both are set. Quote them (`"-4"`). Measure your own model's band; the values validated for one model do not carry over |
| `proxy.podAnnotations` | none | Annotations on the proxy's pods |
| `proxy.podSecurityContext` | `runAsNonRoot: true`, `runAsUser: 1001` | The proxy pod's security context |
| `proxy.securityContext` | no privilege escalation, every capability dropped | The proxy container's security context |
| `proxy.nodeSelector`, `proxy.tolerations`, `proxy.affinity` | none | Where the proxy runs |
| `valkey.image.repository`, `valkey.image.tag`, `valkey.image.pullPolicy` | `valkey/valkey`, `7-alpine`, `IfNotPresent` | |
| `valkey.resources` | see `helm show values` | Valkey's requests and limits |
| `valkey.persistence.enabled`, `valkey.persistence.size`, `valkey.persistence.storageClassName` | `false`, `1Gi`, the cluster default | Keep Valkey's data across restarts |
| `litellm.enabled` | `false` | Run LiteLLM for the local judge |
| `litellm.config` | none | LiteLLM's config: `--set-file litellm.config=./litellm_config.yaml` |
| `litellm.configMapName` | none | Or a ConfigMap of yours with the key `config.yaml` |
| `litellm.secretName` | none | A Secret passed to LiteLLM as environment: `LITELLM_MASTER_KEY` and the variables your config reads |
| `litellm.judgeModel` | none | The `model_name` the local judge calls |
| `litellm.typedJudgeModel` | `litellm.judgeModel` | The `model_name` for the local judge's typed stage |
| `litellm.image.repository`, `litellm.image.digest`, `litellm.image.tag`, `litellm.image.pullPolicy` | `ghcr.io/berriai/litellm`, pinned by digest, `main-latest`, `IfNotPresent` | The digest wins over the tag; clear it only to track upstream on purpose |
| `litellm.resources` | see `helm show values` | LiteLLM's requests and limits; it is killed at start with under 512Mi of memory |
| `serviceAccount.create`, `serviceAccount.name`, `serviceAccount.annotations` | `true`, named after the release, none | The pods' ServiceAccount. With `create: false`, name one that exists |
| `decideModel.enabled` | `false` | Run a [decide model](#decide-model) server, `<release>-intutic-gateway-decide-model:8000`, and point the proxy's decide engine at it |
| `decideModel.variant` | `cpu` | `cpu` (llama.cpp, one GGUF file) or `gpu` (vLLM, one NVIDIA GPU) |
| `decideModel.model` | none, required | The name the proxy asks for (`INTUTIC_DECIDE_MODEL`), e.g. `qwen3.6-27b-awq` |
| `decideModel.digest` | none, required | `INTUTIC_DECIDE_MODEL_DIGEST`. `cpu`: `sha256:<the file's SHA-256>`, checked before the server starts. `gpu`: what pins your download, e.g. `hf:cyankiwi/Qwen3.6-27B-AWQ-INT4@<revision>` |
| `decideModel.weights.existingClaim`, `decideModel.weights.path` | none, required | A PersistentVolumeClaim holding the weights, mounted read-only, and the GGUF file (`cpu`) or weights directory (`gpu`) in it |
| `decideModel.timeoutMs` | the engine's 5000 | The proxy's per-call timeout in milliseconds; a CPU model needs more |
| `decideModel.cpu.image.repository`, `decideModel.cpu.image.digest`, `decideModel.cpu.image.tag`, `decideModel.cpu.image.pullPolicy`, `decideModel.gpu.image.repository`, `decideModel.gpu.image.digest`, `decideModel.gpu.image.tag`, `decideModel.gpu.image.pullPolicy` | llama.cpp `server-b11459`, vLLM `v0.27.1`, each pinned by digest; `IfNotPresent` | The digest wins over the tag |
| `decideModel.cpu.resources`, `decideModel.gpu.resources`, `decideModel.gpu.gpuMemoryUtilization` | see `helm show values`; `0.94` | The GPU variant asks for one `nvidia.com/gpu` |
| `decideModel.nodeSelector`, `decideModel.tolerations`, `decideModel.affinity` | none | Where the model server runs, e.g. a GPU node pool |

`helm show values oci://ghcr.io/intutic/charts/intutic-gateway --version <version>` prints
them all with their comments.

The decide model's Service is reachable inside the cluster. A gate or `intutic decide eval` run
in the cluster can use it as its engine: set `INTUTIC_DECIDE_ENGINE_URL` to
`http://<service>.<namespace>.svc.cluster.local:8000`, which the engine's guard allows as a
`.local` name. A short Service name must be listed in `INTUTIC_SELF_HOSTED_DECISION_HOSTS`, as the
chart does for the proxy.

### Bare metal

The proxy binary published with each release, run by systemd: no containers and no Node.js on
the host. The unit, `intutic-gateway.service`, and its env file template,
`intutic-gateway.env.example`, are in the same `gateway/` directory of the release bundle as
the Compose files. The host needs a Valkey (or Redis) the proxy can reach, such as the
`valkey-server` package on the same host.

Register the gateway with the deployment target **Bare metal** (`--target bare_metal`), then, as
root, from `intutic-selfhost-<version>/gateway`:

```bash
# The binary for this host from the same release, checked against the release's checksums.json.
VERSION=$(cat ../VERSION) ARCH=x64   # or arm64
URL=https://github.com/intutic/intutic/releases/download/v$VERSION
curl -fL -O "$URL/intutic-proxy-linux-$ARCH" -O "$URL/checksums.json"
grep -o "\"intutic-proxy-linux-$ARCH\": \"sha256:[0-9a-f]*\"" checksums.json |
  sed "s/.*sha256:\([0-9a-f]*\)\"/\1  intutic-proxy-linux-$ARCH/" | sha256sum -c -
install -m 0755 "intutic-proxy-linux-$ARCH" /usr/local/bin/intutic-proxy

# Settings: the gateway ID and token from register, CONTROL_PLANE_URL and VALKEY_URL.
install -d -m 0755 /etc/intutic
install -m 0600 intutic-gateway.env.example /etc/intutic/intutic-gateway.env
"${EDITOR:-vi}" /etc/intutic/intutic-gateway.env

install -m 0644 intutic-gateway.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now intutic-gateway
```

The dashboard's **Setup files** for a bare-metal gateway give the same commands with an env file
pre-filled for that gateway. A host without internet access gets the two files from the release
page on a machine that has it.

Agents reach the gateway on the host's `PORT` (default `8080`), at `/v1`. `journalctl -u
intutic-gateway` shows its log. The unit runs the proxy as a user that exists only while the
service runs, with no capabilities, no new privileges and a read-only view of the system: it can
write only its state directory, `/var/lib/intutic-gateway`, which holds the rotated token
(below). It restarts after a crash, waiting longer after each failure up to a minute (systemd
254 or later; older systemd restarts every 2 seconds). To upgrade, install the new release's
binary the same way and run `systemctl restart intutic-gateway`.

## 3. Registering, monitoring, and rotating a gateway

All lifecycle operations go through the control plane, reachable from the CLI (see the
[CLI reference](/reference/cli#intutic-gateway-register) for full option tables):

```bash
intutic gateway register --name "prod-gateway" --target docker   # prints a one-time gwk_ token
intutic gateway list                                             # every registered gateway
intutic gateway status <gateway_id>                               # online / degraded / unreachable
intutic gateway rotate <gateway_id>                                # new token, old one valid for a grace period
intutic gateway revoke <gateway_id> --reason "decommissioned"      # immediate, no grace period
intutic gateway config get <gateway_id>                           # the config values set here, and their version
intutic gateway config set <gateway_id> --require-provisioned-key true
```

A gateway that stops heartbeating is reported `unreachable` once its heartbeat is older than
the TTL window (~90s) — a self-healing status, not an error state that needs to be cleared.

Registering a gateway and changing its config need the Enterprise or Self-host plan. After a
move to another plan, a registered gateway keeps running with the config it has: `list`,
`status`, `config get`, `rotate` and `revoke` still work, so you can always see it and take it
down, and `config set` is refused until the plan includes self-hosted gateways again.

### Changing a gateway's config

`intutic gateway config set` changes two settings of a running gateway: `--require-vk` and
`--require-provisioned-key`, the same switches as `INTUTIC_GATEWAY_REQUIRE_VK` and
`INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY` (`proxy.requireVk` and `proxy.requireProvisionedKey` in
the chart). A value set this way overrides the deployment's own, and `true` for
`--require-provisioned-key` means every workspace, as the variable's `true` does.
`intutic gateway config get` prints the values set this way and the config version; a flag it
shows as not set runs the deployment's own value.

The change applies live on every target, Docker, Kubernetes and bare metal alike, within one
heartbeat interval: `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS` (`proxy.heartbeatIntervalSeconds` in
the chart), 30 seconds by default. Each heartbeat tells the proxy the latest config version; when
it differs from the one the proxy runs, the proxy fetches the config and applies it to the next
request, with no restart and no redeploy. That includes a version lower than the one it runs,
which means the control plane's version counter was reset: the proxy applies the config it is
served, adopts its version and logs a warning. A proxy that restarts fetches the config with its first
heartbeat, which it sends as it starts.

If that fetch fails, or returns a config the proxy cannot read whole, the proxy keeps the config
it has and tries again on the next heartbeat. The next heartbeat reports the version the proxy
runs: **Config** in the dashboard's gateway list, and `Config version` in `intutic gateway
status`, show it against the latest one set.

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
- **Bare metal** (`intutic-gateway.service`): the unit sets the state file to
  `/var/lib/intutic-gateway/gateway-token`, in the service's own state directory, which survives
  restarts and reboots.
- **Kubernetes** (the `intutic-gateway` chart; the interval is `proxy.rotationIntervalDays`): a state file only survives an in-place container
  restart within the same pod, not a reschedule or rolling redeploy (a new pod is a fresh
  filesystem) — so the proxy additionally PATCHes its own gateway Secret via the in-cluster
  Kubernetes API on every successful rotation. Opt-in via the chart's
  `proxy.selfRotationPatchesOwnSecret` value (default `false` — it's a real RBAC grant, `get`+
  `patch` scoped to just this release's `gatewaySecretName`, beyond what the proxy needs to run).
  With it enabled, the next pod created from the Deployment — reschedule or redeploy — reads the
  current token fresh via its existing `secretKeyRef`.

None of this replaces `intutic gateway rotate` as your recovery path — if the persisted storage
itself is lost (the Docker volume or the bare-metal state directory deleted, or the Kubernetes flag left off), a restart still reverts to whatever `INTUTIC_GATEWAY_TOKEN` your deployment's
environment holds, and you're back to running that command and updating the stored token by hand.

### Pointing a workspace at your gateway

Assign a gateway per-workspace (overriding the org default) or per-org (every workspace under
it that hasn't set its own override):

```bash
intutic gateway assign --gateway <gateway_id>                 # the workspace you're logged in to only
intutic gateway assign --gateway <gateway_id> --org <org_id>  # org-wide default
intutic gateway assign --clear [--org <org_id>]               # remove the override / org default
intutic gateway resolve                                       # which gateway actually applies, and why
```

`gateway resolve` (`--json` gives `source: workspace | org | default`) tells you whether a
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
  - **No incident persistence** — a `VIOLATION` or `AMBIGUOUS` verdict is annotated in the response; it is not
    written to `governance_incidents`, since that table lives in the control plane's Postgres,
    which a self-hosted gateway deliberately doesn't have a connection to.
  - SOP *text* is still fetched from the control plane (`sops::all_sops_for_workspace`) — only
    the judged *content* stays local, a disclosed trade-off, not a silent one.
  - See [On-Prem Judge Setup](/external/on-prem-judge) for the `intutic judge configure` walkthrough
    that generates the `litellm_config.yaml`, env block, and Helm values a local judge needs —
    local files only, never a remote API call, matching this document's own point that
    local-judge config is not remotely settable.
  - A typed band (`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`, `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI`,
    `LITELLM_LOCAL_TYPED_JUDGE_MODEL`) makes the judge the decide rule `local-judge`: two yes/no
    questions scored from log-probabilities, with the free-text judge writing only the note on a
    violation. It needs a model that returns log-probabilities and a band you measured for that
    model. These variables are deprecated since 3.0 and removed in 4.0 — see
    [On-Prem Judge Setup](/external/on-prem-judge#typed-stage-the-local-judge-decide-rule).
- **If your judge LLM is unreachable** — local or SaaS — the proxy reports
  this honestly rather than silently passing every check: a response is annotated `Intutic
  LLM-as-a-Judge: verdict UNAVAILABLE`, with the reason and "Treat it as unverified, not as
  clean.", instead of defaulting to a clean verdict. A local judge never falls back to calling the SaaS judge on
  its own failure.

## Related

- [CLI Reference — `intutic gateway`](/reference/cli#intutic-gateway-register)
- [Settings & Configuration — Provider Keys](/guide/settings#provider-keys)
- [LiteLLM & Proxy Routing Architecture](/external/litellm)
- [On-Prem Judge Setup](/external/on-prem-judge)
