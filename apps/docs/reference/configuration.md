# Configuration Reference <Badge type="tip" text="Open-Core" />

Environment variables, workspace settings, and proxy configurations for the Intutic platform.

---

## 1. Environment Variables

### Proxy

The proxy (`intutic-proxy`) reads these at startup unless a row says otherwise.

#### Core

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CONFIG_PATH` | `config.yaml` in the working directory | The [`config.yaml`](#_4-proxy-config-yaml-intutic-settings) to load. The container image sets `/etc/intutic/proxy-config.yaml` |
| `PORT` | `4000` | The port the proxy listens on, on every interface |
| `RUST_LOG` | `intutic_proxy=info,tower_http=info` | Log filter, in `tracing` syntax (`intutic_proxy=debug`, `warn`, …) |
| `CONTROL_PLANE_URL` | unset | Unset, the proxy runs **standalone**: no control plane, and rules, budgets and allowlists come from local files. Set to a control plane's address, it runs **managed**: Valkey becomes required (startup fails if it cannot connect, rather than accepting requests unauthenticated), and every request is checked against the workspace's policy first, failing closed (`403 policy_denied`) when the check fails or times out unless `intutic_settings.policy.fail_closed` is `false` |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Valkey for the auth and budget cache, bandit state and the response cache. Standalone, the proxy tries it for 1.5 seconds and runs without it if it does not answer |
| `INTUTIC_STANDALONE` | unset | `1` or `true`: run standalone without probing for Valkey. Refused together with `CONTROL_PLANE_URL` |
| `INTUTIC_WORKSPACE_ID` | unset | The workspace for requests that do not name one (no `x-workspace-id` header and no workspace in the key). Also the workspace a centrally distributed egress policy file must name to be loaded |
| `INTUTIC_REGION` | unset | A region code (`eu`, …). Rewrites the hosted control plane's policy-check address to that region's control plane (`api.<region>.…`). Any other address is left alone |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Export traces and metrics over OTLP/gRPC to this collector. Unset, nothing is exported. See [OpenTelemetry](/guide/opentelemetry) |
| `OTEL_SERVICE_NAME` | `intutic-proxy` | The service name on exported traces and metrics |

#### Provider upstreams and keys

| Variable | Default | Description |
| :--- | :--- | :--- |
| `UPSTREAM_URL` | unset | One upstream for every provider, such as a LiteLLM gateway. A provider's own variable below takes precedence. See [Standalone](/integrations/standalone) |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Where requests for Anthropic models go |
| `OPENAI_UPSTREAM_URL` | `https://api.openai.com` | Where requests for OpenAI models go |
| `GEMINI_UPSTREAM_URL` | `https://generativelanguage.googleapis.com` | Where requests for Gemini models go |
| `MISTRAL_UPSTREAM_URL` | `https://api.mistral.ai` | Where requests for Mistral models go |
| `OPENROUTER_UPSTREAM_URL` | `https://openrouter.ai/api` | Where requests for OpenRouter models go |
| `DEEPSEEK_UPSTREAM_URL` | `https://api.deepseek.com` | Where requests for DeepSeek models go |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY` | unset | The provider key the proxy uses when a caller authenticates with an Intutic key (`vk_…`) and the workspace has not provisioned its own key for that provider. A caller that sends its own provider key uses that key. A gateway with `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY` set refuses instead of falling back |

The proxy picks the provider from the model name, so these are the only way to point a provider somewhere else; `model_list` in `config.yaml` does not route. For a single upstream used by every provider, see [Standalone](/integrations/standalone).

#### Rules, budgets and memory

| Variable | Default | Description |
| :--- | :--- | :--- |
| `INTUTIC_SOPS_DIR` | unset | Absolute path to a directory of `.md` SOP files. Overrides the default search, which walks up from the proxy's working directory looking for `.intutic/sops`. Set this when the proxy does not run beside a workspace — a container, or a shared gateway. A blank value counts as unset. A path that is set but is not a directory is **not** silently replaced by the walk: the proxy reports it and loads no SOPs, so a typo cannot be answered with policy from somewhere else. When the resolved SOP set is empty the proxy warns at startup, naming each control that is consequently inactive — including when the directory exists but is empty, which enforces exactly as much as no directory at all. The bundled Kubernetes manifests set this to `/etc/intutic-sops` and mount the `proxy-sops` ConfigMap there; see [SOPs → where the proxy looks](/guide/sops#where-the-proxy-looks-for-sops). |
| `INTUTIC_WASM_DIR` | `~/.intutic/wasm` | The local WASM rule directory; takes precedence over `intutic_settings.wasm_local_dir` |
| `INTUTIC_WASM_MANIFEST_ROOT` | unset (off) | The directory WASM rules may read files from: when a tool call names a manifest (`kubectl apply -f k8s/deploy.yaml`), the proxy reads that file under this root and hands its contents to the rule. Unset, rules see only the path. `~/` is expanded |
| `WASM_CONTEXT_SNAPSHOT_RATE` | `0.05` | The fraction of requests (0–1) whose rule-evaluation context is attached to the trace, so a new rule can be replayed against real traffic before it ships. The context holds the request's tool calls with their arguments, tool names and descriptions, DLP finding names and session counters, not the message text. Traces go to the control plane when one is connected, and to `~/.intutic/logs` otherwise. `0` turns it off |
| `INTUTIC_LOCAL_BUDGET_ENFORCE` | on | `0`, `false` or `no`: keep counting spend against the [local daily cap](/guide/budgets#local-daily-cap) but stop refusing requests over it |
| `INTUTIC_LOCAL_VAULTS` | unset | `off` turns off the local notes-vault search `/fix` uses. `intutic connect` sets it from the workspace's policy |
| `OFFLINE_PRICING_PATH` | the bundled price list | A JSON price list to use for cost estimates instead of the one built in. A file that does not parse is logged and ignored |
| `JUDGE_FINALIZE_DEADLINE_MS` | `5000` | How long the end of a judged streamed response may wait for the judge before the client gets its final event. `0` or a negative value waits as long as the judge takes |

#### Egress control

The proxy decides what to do with each `CONNECT` it receives when clients use it as their HTTPS proxy: AI provider hosts are decrypted and governed; other hosts follow the egress policy.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `INTUTIC_EGRESS_MODE` | `off` (or `intutic_settings.egress.mode`) | `off` tunnels every other host. `monitor` tunnels them but logs and counts the ones `enforce` would refuse. `enforce` refuses any host not on the allow list. Any other value means `off`; the mode in force is logged at startup and shown at `GET /intutic/egress` |
| `INTUTIC_EGRESS_ALLOW` | none | Comma-separated hosts (`example.com`), suffixes (`.example.com`) and IP ranges (`10.0.0.0/8`) to allow, added to `intutic_settings.egress.allow` |
| `INTUTIC_EGRESS_POLICY_FILE` | `~/.intutic/hooks/egress-policy.json` | The central egress policy the sync daemon writes for the workspace. Its mode overrides the local one and its allow list is added to the local list. A missing, corrupt or other-workspace file is ignored |
| `INTUTIC_EGRESS_RELOAD_SECS` | `30` | How often the central policy file is re-read |
| `INTUTIC_EXTRA_AI_HOSTS` | none | Comma-separated hosts to treat as AI providers (decrypted and governed), such as an internal model gateway |

#### Shared gateway

Settings for a proxy deployed as a shared or self-hosted gateway. See [Self-hosted gateway](/external/self-hosted-gateway) and [On-prem judge](/external/on-prem-judge).

| Variable | Default | Description |
| :--- | :--- | :--- |
| `INTUTIC_GATEWAY_REQUIRE_VK` | `false` | `true`: accept only Intutic keys (`vk_…`); any other bearer is refused with `401` |
| `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY` | `false` | `true`: refuse (`402`) a workspace that has not provisioned its own provider key instead of using the gateway's. `paid`: only for workspaces on a paid plan |
| `INTUTIC_GATEWAY_ID` | unset | The gateway's id (`gw_…`) from registration. With `INTUTIC_GATEWAY_TOKEN` and `CONTROL_PLANE_URL`, turns on heartbeats |
| `INTUTIC_GATEWAY_TOKEN` | unset | The gateway token (`gwk_…`) from registration |
| `INTUTIC_GATEWAY_ORG_ID` | unset | Set by Intutic on a managed gateway cell dedicated to one organization: the organization it serves |
| `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS` | `30` | Seconds between heartbeats |
| `INTUTIC_GATEWAY_ROTATION_INTERVAL_DAYS` | `30` | Days between automatic token rotations; `0` turns rotation off |
| `INTUTIC_GATEWAY_TOKEN_STATE_FILE` | unset | A file where a rotated token is kept, so a restart does not fall back to the original |
| `INTUTIC_GATEWAY_K8S_SECRET_NAME` | unset | In Kubernetes, the Secret a rotated token is written back to |
| `INTUTIC_GATEWAY_K8S_SECRET_KEY` | `INTUTIC_GATEWAY_TOKEN` | The key in that Secret |
| `INTUTIC_GATEWAY_LOCAL_JUDGE` | `false` | `true`: judge responses with your own model server instead of the control plane's, so content stays on your infrastructure |
| `LITELLM_LOCAL_URL` | `http://litellm:4000` | The local judge's LiteLLM address |
| `LITELLM_LOCAL_API_KEY` | unset | Bearer token for it, when it has one |
| `LITELLM_LOCAL_JUDGE_MODEL` | none (required) | The judge model's name on that server |
| `LITELLM_LOCAL_TYPED_JUDGE_MODEL` | `LITELLM_LOCAL_JUDGE_MODEL` | A separate model for the scored first stage |
| `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`, `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI` | unset | The first stage's review band, in log-odds: below `LO` is clean, above `HI` a violation. Set both to turn the first stage on |
| `INTUTIC_PROXY_PORT` | `8080` | The port in firewall rules generated to redirect AI traffic to the proxy |

#### Connected services

| Variable | Default | Description |
| :--- | :--- | :--- |
| `EMBEDDING_GENERATOR_URL` | `http://localhost:8085/v1/embeddings` | The OpenAI-compatible embeddings endpoint the semantic response cache uses |
| `TURBOVEC_URL` | `http://localhost:8083` | The base address of the vector index the semantic cache searches |

### CLI

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CONTROL_PLANE_URL` | unset | Set when `intutic start` runs, the proxy it starts is managed (see above) |
| `INTUTIC_DEV` | unset | `1`: talk to a local control plane at `http://localhost:3001` instead of the hosted control plane |
| `PORT` | `4000` | The port `intutic start` and `intutic connect` run the proxy on |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Passed to the proxy the CLI starts |
| `INTUTIC_PROXY_URL` | `http://localhost:4000` | The proxy `intutic exec` and `intutic enterprise` point agents at |
| `INTUTIC_PROXY_PORT` | `8877` | The HTTP proxy port `intutic connect` writes into Windsurf's settings |
| `INTUTIC_SNAPSHOT_RULES` | `~/.intutic/hooks/policy-snapshot.rules` | Where the CLI writes the policy snapshot the hook gate reads |
| `INTUTIC_WASM_DIR` | `~/.intutic/wasm` | Where `intutic policy install` puts WASM rules |
| `N8N_URL` | `http://localhost:5678` | The n8n instance `intutic connect` configures |
| `N8N_API_TOKEN` | unset | Its API key |
| `INTUTIC_FC_KERNEL` | none (required) | For `intutic exec --sandbox firecracker`: the guest kernel image |
| `INTUTIC_FC_ROOTFS` | none (required) | The guest root filesystem |
| `INTUTIC_FC_TAP` | `tap-intutic` | The TAP device |
| `INTUTIC_FC_HOST_IP` | `172.16.0.1` | The host's address on it |
| `INTUTIC_FC_GUEST_IP` | `172.16.0.2` | The guest's address |
| `INTUTIC_FC_PREFIX` | `30` | The network's prefix length |
| `INTUTIC_FC_VCPUS` | `1` | Guest vCPUs |
| `INTUTIC_FC_MEM` | `512` | Guest memory, in MiB |

`intutic connect` also passes `ANTHROPIC_API_KEY` from its own environment to the proxy it starts.

### Gate SDK

Read by `@intutic/gate`. The MCP daemon and the Python `intutic-clawde` gate read `INTUTIC_API_KEY` too.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `INTUTIC_API_KEY` | from `intutic login` | The workspace key (`vk_…`) |
| `INTUTIC_WORKSPACE_ID` | from `intutic login` | The workspace |
| `INTUTIC_CONTROL_PLANE_URL` | the hosted control plane | The control plane |
| `INTUTIC_PROXY_URL` | `http://localhost:4000` | The proxy the Vercel AI SDK helper points models at |
| `INTUTIC_SESSION_ID` | generated | The session id reported with each verdict |
| `INTUTIC_SNAPSHOT_RULES` | `~/.intutic/hooks/policy-snapshot.rules` | The local policy snapshot |
| `INTUTIC_GUARD_DISABLE` | unset | `1` turns the local snapshot guard off |

### MCP daemon

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MCP_DAEMON_SOCKET` | `~/.intutic/mcp-proxy.sock` | The MCP daemon's Unix socket |

The MCP proxy's other settings are on [MCP Proxy](/integrations/mcp-proxy).

<!-- ENTERPRISE_ONLY_START -->
### Control plane

These configure the control plane in hosted and Self-host deployments.

| Variable | Required? | Default | Description |
| :--- | :---: | :---: | :--- |
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `JWT_SECRET` | ✅ | — | Secret for signing session tokens |
| `ENCRYPTION_KEY` | ✅ | — | 32-byte key for encrypting stored credentials and tokens |
| `APP_URL` | Self-host | — | The dashboard's address; links in emails and invitations point here |
| `API_BASE_URL` | Self-host | `http://localhost:3001` | The API's public address. Identity providers send users back here, so it builds the OIDC redirect URI (`/api/v1/auth/sso/callback`), the SAML ACS URL (`/api/v1/auth/saml/acs`) and the SCIM base URL |
| `OIDC_CALLBACK_URL` | ❌ | built from `API_BASE_URL` | The full OIDC redirect URI, when users reach the API at a different address |
| `SAML_ACS_URL` | ❌ | built from `API_BASE_URL` | The full SAML ACS URL, likewise |
| `SAML_SP_ENTITY_ID` | ❌ | `<API_BASE_URL>/saml/metadata` | The service-provider entity id for SAML providers that do not set their own |
| `TRACE_SIGNING_PRIVATE_KEY` | ❌ | — | Ed25519 PKCS#8 PEM. Signs the Merkle root sealed over each loop run's execution traces; the public half is served at `/.well-known/intutic-trace-signing.json`. Unset means roots are still sealed and re-derivable, just unattributable to this deployment by a third party. |
| `TRACE_SIGNING_RETIRED_KEYS` | ❌ | — | Previously-active PEMs, any number of them, separated by newlines or commas or not at all (whole armoured blocks are matched). **Never used to sign** — they are published in the JWKS and used to verify roots sealed before a rotation, selected by the key id recorded on each root. Set this when you rotate `TRACE_SIGNING_PRIVATE_KEY`; without it, every root signed by the outgoing key becomes permanently unverifiable. A malformed entry here is logged and skipped rather than fatal, so one stale PEM cannot empty the JWKS. |
| `PORT` | ❌ | `3001` | HTTP port for the control plane API |
| `LITELLM_PROXY_URL` | ❌ | — | The LiteLLM endpoint for model calls (judges, probes, extraction). Takes precedence over `LITELLM_ADMIN_BASE_URL` |
| `LITELLM_ADMIN_BASE_URL` | ❌ | `http://localhost:4000` | The LiteLLM endpoint when `LITELLM_PROXY_URL` is unset |
| `LITELLM_PLATFORM_KEY` | ❌ | — | Scoped LiteLLM virtual key for judge/probe/generation calls — NOT LiteLLM's own admin secret, which this service never holds. See the key-rotation runbook for how it's minted. |

---
<!-- ENTERPRISE_ONLY_END -->

## 2. Local Sandbox Development Stack

The open-source workstation components run against a lightweight, local Valkey cache service.

```bash
# Start the local development Valkey service
docker compose up -d

# Valkey port mapping:
# Valkey: 6379
```

### Test stack

To execute the unit and integration tests under isolated conditions, spin up the test compose file:

```bash
# Start isolated test services
docker compose -f docker-compose.test.yml up -d

# Valkey test port mapping:
# Valkey-test: 6380
```

---

## 3. Workspace Settings

Workspaces are the top-level organizational unit. Each workspace has:

| Setting | Type | Description |
|---------|------|-------------|
| Workspace ID | `ws_*` | Auto-generated unique identifier |
| Name | string | Human-readable workspace name |
| Plan | enum | `free`, `free_trial`, `enterprise_trial`, `self_serve`, `biz_org`, `ent_adv` (Enterprise), `ent_lic` (Self-host) |
| Budget tiers | object | Per-role budget limits |
| `allowedModels` | string[] | Approved-models allowlist. Absent or empty means unrestricted. Enforced by the proxy at request time — a request naming a model outside this list is rejected before it reaches a provider. See [Settings → Security → Approved Models](/guide/settings#approved-models) |
| `allowedModels` (standalone) | string[] | The same allowlist for a proxy with no control plane, read from `~/.intutic/config.json` (`allowed_models` accepted as an alias) on a 60-second cache. Same absent-or-empty-means-unrestricted rule. See [Settings → Standalone allowlist](/guide/settings#standalone-allowedmodels-in-intutic-config-json) |
| `maxDailyBudgetUsd` (standalone) | number | The proxy's [local daily cap](/guide/budgets#local-daily-cap), read from the same file on the same cache. Defaults to `10` |


<!-- ENTERPRISE_ONLY_START -->
## Workspace Roles (RBAC)

| Role | Access Level |
|------|-------------|
| `OWNER` | Full control — billing, settings, member management |
| `ADMIN` | Manage SOPs, members, budgets |
| `EM` | Engineering Manager — view reports, manage budgets |
| `DEVELOPER` | Use agents, view own traces |
| `VIEWER` | Read-only access to dashboard |

Hierarchy: `OWNER` > `ADMIN` > `EM` > `DEVELOPER` > `VIEWER`
<!-- ENTERPRISE_ONLY_END -->

## Budget Tiers

| Tier | Intended for |
|------|-------------|
| `JUNIOR` | Junior developers — lowest budget ceiling |
| `SENIOR` | Senior developers |
| `STAFF` | Staff engineers |
| `PRINCIPAL` | Principal engineers — highest budget ceiling |

## Model Routing Tiers

| Tier | Usage |
|------|-------|
| `frontier` | Latest, most capable models (e.g., Claude 4, GPT-4.5) |
| `economy` | Cost-effective models for routine tasks |
| `local` | Locally-hosted models for maximum privacy |

## Execution Modes

| Mode | Description |
|------|-------------|
| `STANDARD` | Normal operation — enforcement actions applied |
| `PLAN_ONLY` | Generate execution plan without running |
| `SHADOW` | Run enforcement in shadow mode (log only, don't block) |
| `AUTONOMOUS` | Fully autonomous — minimal human oversight |

## ID Conventions

IDs are a short prefix, an underscore and 21 random characters (`ws_V1StGXR8_Z5jdHi6B-myT`). The common prefixes:

| Prefix | Entity |
|--------|--------|
| `ws_` | Workspace |
| `mbr_` | Member |
| `tr_` | Trace |
| `sp_` | SOP |
| `vk_` | Virtual API key |
| `ses_` | Session |

---

## 4. Proxy `config.yaml` (`intutic_settings`)

The proxy reads a LiteLLM-shaped `config.yaml` (path from `CONFIG_PATH`). Every key is optional, and keys the proxy does not know are ignored.

Of LiteLLM's own keys, only `model_list` does anything here, and only one thing: when it is non-empty, a `routing.candidate_models` entry it does not name (as `model_name` or `litellm_params.model`) is dropped at startup. The proxy does not route by it; upstreams and keys come from the [environment](#provider-upstreams-and-keys). `litellm_params.api_key`, `litellm_params.api_base` and `general_settings` (including `master_key` and `database_url`) are ignored: the proxy does not authenticate callers with a master key.

Intutic's options live under `intutic_settings`:

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `wasm_local_dir` | string | `~/.intutic/wasm` | Directory scanned for locally installed WASM rules. `INTUTIC_WASM_DIR` takes precedence |
| `workflow.default_budget_usd` | number | none | A spend ceiling applied to any loop run that arrives without one, so the workflow budget detector can fire without a control plane. Unset leaves runs uncapped |
| `commands.non_blocking` | boolean | `false` | `true`: `/fix` adds its synthesis to your prompt and forwards the turn to the model instead of answering locally |
| `memory.enabled` | boolean | `true` | Search local notes vaults (Obsidian, Logseq, Foam) for `/fix` |
| `memory.vaults` | string[] | none | Vault directories to search; a vault found above the working directory is searched as well |
| `response_gate.enabled` | boolean | `true` | Refuse a tool call in the model's response that the role's deny list forbids, before the client can run it |
| `response_gate.fail_closed` | boolean | `true` | When a deny list applies and the response will not parse, refuse it rather than forward it unchecked |
| `response_injection_snippet.enabled` | boolean | `true` | Keep a short, DLP-scrubbed excerpt around a prompt-injection pattern found in a response, so a finding can be reviewed |
| `response_injection_snippet.window_bytes` | number | `200` | The excerpt's width, capped by the proxy |

### Policy check (`intutic_settings.policy`)

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `control_plane_url` | string | `CONTROL_PLANE_URL` | Where the pre-request policy check goes. `CONTROL_PLANE_URL` takes precedence |
| `fail_closed` | boolean | `true` | Refuse the request (`403 policy_denied`) when the check fails or cannot be reached. `false` lets it through |
| `timeout_ms` | number | `3000` | How long the check may take |

### DLP (`intutic_settings.dlp`)

`enabled`, `scan_input`, `scan_output`, `stream_holdback_bytes` and custom `patterns`: see [Policies › Enforcement](/guide/policies#enforcement).

### Egress (`intutic_settings.egress`)

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `mode` | string | `off` | `off`, `monitor` or `enforce`; `INTUTIC_EGRESS_MODE` takes precedence. See [Egress control](#egress-control) |
| `allow` | string[] | none | Hosts, `.suffixes` and IP ranges to allow; `INTUTIC_EGRESS_ALLOW` adds to it |

### Gateway (`intutic_settings.gateway`)

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `require_vk` | boolean | `false` | As `INTUTIC_GATEWAY_REQUIRE_VK`, which takes precedence |
| `require_provisioned_key` | boolean | `false` | As `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=true` |
| `provisioned_key_paid_only` | boolean | `false` | With `require_provisioned_key`, apply it to paid workspaces only (`INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=paid`) |
| `local_judge` | boolean | `false` | As `INTUTIC_GATEWAY_LOCAL_JUDGE` |

### Tool-output compaction (`intutic_settings.snip_compactor`)

Shrinks long tool output in non-streamed JSON responses after the DLP scan, and records the bytes saved on the trace.

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `enabled` | boolean | `true` | Master switch |
| `max_tool_output_tokens` | number | `8192` | Truncate text longer than this (estimated at 4 characters a token) |
| `collapse_repetitions_above` | number | `3` | Collapse a line repeated more than this many times |
| `import_dedup` | boolean | `true` | Drop repeated import lines |
| `stack_trace_dedup` | boolean | `true` | Collapse repeated stack frames |
| `whitespace_normalize` | boolean | `true` | Collapse runs of blank space |
| `json_max_array_items` | number | `3` | Keep this many items of a JSON array and summarize the rest |
| `json_max_string_value_chars` | number | `20` | Cut longer JSON string values… |
| `json_entropy_threshold` | number | `0.85` | …unless they look like identifiers (entropy above this, 0–1), which are kept whole |
| `code_skeleton_enabled` | boolean | `true` | Reduce long code blocks to their signatures, types and imports |
| `code_skeleton_min_lines` | number | `10` | The shortest block that is reduced |
| `code_skeleton_incremental_cache` | boolean | `false` | Reuse the reduction of an identical block on the same thread |

### Model Routing (`intutic_settings.routing`)

Contextual bandit routing picks a model per request via Thompson sampling over a candidate pool.

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `enabled` | boolean | — | Enables bandit routing in standalone mode. Unset defers entirely to the control plane |
| `candidate_models` | string[] | `claude-3-5-sonnet`, `gpt-4o`, `gemini-2.0-flash` | Candidate model pool for Thompson sampling. Requests for models outside this pool bypass the bandit entirely. With a non-empty `model_list`, names it does not list are dropped at startup |
| `mode` | string | `enforce` | `enforce` serves the routed model; `shadow` records what it would have picked and serves the requested one; `off` does not route |
| `mirror_sample_rate` | number | `0` | Fraction of eligible non-streamed requests (at most `0.05`) also sent to the routed or mirror candidate, scored off the critical path. Each mirrored request is paid for twice |
| `mirror_candidate_model` | string | — | A model to mirror-test against live traffic, whether or not it is a candidate |
| `anthropic_model_override` | string | — | When set, any Anthropic-bound model is rewritten to this ID after routing. Unset leaves the routed model untouched |
| `sop_pin_max_age_secs` | number | `600` | How long a session's injected SOP text stays fixed, so the prompt prefix stays cacheable. `0` re-renders it on every request |
| `cache_guard_max_age_secs` | number | `300` | How recent a prompt-cache observation must be for routing to keep a warm session on its model. `0` turns the guard off |
| `cache_guard_min_read_bp` | number | `5000` | The cache-read share (basis points) that counts as warm |
| `cache_guard_cold_start_prompt_bytes` | number | `20000` | On a session's first turn, a prompt larger than this stays on the requested model. `0` turns this off |

**Precedence:** when a control plane manages the workspace, the Valkey `ff_bandit_routing` feature flag is authoritative. `routing.enabled` applies only to standalone deployments where no control plane manages the workspace.

### Reward Loop (`intutic_settings.routing.reward`)

Rewards are computed only from signals the proxy already observes — upstream success, latency versus SLO, token anomaly, and cost ratio. No LLM judge is involved.

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `enabled` | boolean | `true` | Enables the local deterministic reward loop |
| `latency_slo_ms` | number | `30000` | Latency SLO; responses slower than this are penalised proportionally. Includes full stream duration for streaming responses |
| `latency_penalty` | number | `0.3` | Maximum reward deduction for exceeding the latency SLO |
| `token_anomaly_penalty` | number | `0.2` | Reward deduction when the token-anomaly detector fires |
| `cost_penalty` | number | `0.2` | Maximum reward deduction when the routed model costs more than the requested model would have |

```yaml
intutic_settings:
  # Directory scanned for locally installed WASM rules
  # (INTUTIC_WASM_DIR takes precedence over this value).
  wasm_local_dir: "~/.intutic/wasm"

  routing:
    enabled: true
    candidate_models: ["claude-3-5-sonnet", "gpt-4o", "gemini-2.0-flash"]
    reward:
      enabled: true
      latency_slo_ms: 30000
      latency_penalty: 0.3
      token_anomaly_penalty: 0.2
      cost_penalty: 0.2
```
