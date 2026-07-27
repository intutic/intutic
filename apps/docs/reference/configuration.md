# Configuration Reference <Badge type="tip" text="Open-Core" />

Environment variables, workspace settings, and proxy configurations for the Intutic platform.

---

## 1. Environment Variables

### Local Client & Proxy (Open Source)

These variables configure the local client utilities, sync daemon, and proxy gateway running on developer workstations.

| Variable | Required? | Default / Placeholder | Description |
| :--- | :---: | :---: | :--- |
| `VALKEY_URL` | ❌ | `redis://127.0.0.1:6379` | Local Valkey cache connection URL |
| `INTUTIC_API_KEY` | ❌ | — | Virtual API key (`vk_*`) used to authenticate and sync workspace rules |
| `CONTROL_PLANE_URL` | ❌ | `https://your-control-plane.example` | Control plane base URL for remote SOP and policy syncing |
| `CONFIG_CAPTURE_INTERVAL` | ❌ | `5` | Sync loop cycles between local configuration snapshots |
| `MCP_DAEMON_SOCKET` | ❌ | `~/.intutic/mcp-proxy.sock` | Daemon Unix IPC socket path |
| `INTUTIC_WASM_DIR` | ❌ | `~/.intutic/wasm` | Overrides the local WASM rule directory; takes precedence over the `intutic_settings.wasm_local_dir` config file value |

### Enterprise Control Plane (SaaS / Private VPC)

These variables are used exclusively in the backend control plane deployment to orchestrate registries, databases, and multi-channel notifications.

| Variable | Required? | Default / Placeholder | Description |
| :--- | :---: | :---: | :--- |
| `DATABASE_URL` | ✅ | `postgresql://...` | Postgres database connection string (Drizzle ledger) |
| `JWT_SECRET` | ✅ | `changeme` | Secret key for signing dashboard JWT tokens |
| `ENCRYPTION_KEY` | ✅ | `changeme` | 32-byte hex key for encrypting credentials and tokens |
| `PORT` | ❌ | `3001` | HTTP port for the control plane API service |
| `LITELLM_ADMIN_BASE_URL`| ❌ | `http://litellm:4000` | LiteLLM helper admin URL |
| `LITELLM_MASTER_KEY` | ❌ | — | LiteLLM helper API token |

---

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
| Workspace ID | `wk_*` | Auto-generated unique identifier |
| Name | string | Human-readable workspace name |
| Plan | enum | `free_trial`, `pro`, `team`, `enterprise` |
| Budget tiers | object | Per-role budget limits |

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

All IDs in Intutic use prefixed nanoid format:

| Prefix | Entity |
|--------|--------|
| `wk_` | Workspace |
| `mb_` | Member |
| `tr_` | Trace |
| `sp_` | SOP |
| `vk_` | Virtual API Key |
| `ev_` | Event |
| `tc_` | Tool Call |
| `in_` | Incident |
| `an_` | Anomaly |
| `se_` | Session |

Never use raw UUIDs or `Date.now()` directly. Use `newId(prefix)` and `newIso()` from `@intutic/id`.

---

## 4. Proxy `config.yaml` (`intutic_settings`)

The proxy reads a LiteLLM-compatible `config.yaml`. Intutic-specific options live under the top-level `intutic_settings` key, alongside `model_list` and `general_settings`.

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `wasm_local_dir` | string | `~/.intutic/wasm` | Directory scanned for locally installed WASM rules. The `INTUTIC_WASM_DIR` env var takes precedence over this value |

### Model Routing (`intutic_settings.routing`)

Contextual bandit routing picks a model per request via Thompson sampling over a candidate pool.

| Setting | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `enabled` | boolean | — | Enables bandit routing in standalone mode. Unset defers entirely to the control plane |
| `candidate_models` | string[] | `claude-3-5-sonnet`, `gpt-4o`, `gemini-2.0-flash` | Candidate model pool for Thompson sampling. Requests for models outside this pool bypass the bandit entirely. Names must match `model_list` entries so provider resolution and pricing stay accurate |
| `anthropic_model_override` | string | — | When set, any Anthropic-bound model is rewritten to this ID after routing. Unset leaves the routed model untouched |

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
