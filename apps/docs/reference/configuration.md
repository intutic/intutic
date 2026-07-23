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
| `CONTROL_PLANE_URL` | ❌ | `https://api.intutic.ai` | Control plane base URL for remote SOP and policy syncing |
| `CONFIG_CAPTURE_INTERVAL` | ❌ | `5` | Sync loop cycles between local configuration snapshots |
| `MCP_DAEMON_SOCKET` | ❌ | `~/.intutic/mcp-proxy.sock` | Daemon Unix IPC socket path |

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

## Workspace Roles (RBAC)

| Role | Access Level |
|------|-------------|
| `OWNER` | Full control — billing, settings, member management |
| `ADMIN` | Manage SOPs, members, budgets |
| `EM` | Engineering Manager — view reports, manage budgets |
| `DEVELOPER` | Use agents, view own traces |
| `VIEWER` | Read-only access to dashboard |

Hierarchy: `OWNER` > `ADMIN` > `EM` > `DEVELOPER` > `VIEWER`

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
