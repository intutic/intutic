# REST API Reference <Badge type="warning" text="Cloud / Team" />

::: warning Commercial / Team Tier Feature
The REST API endpoints documented below are exposed by the **Intutic Control Plane** (local dev stack on port 3001 or Cloud SaaS / Private VPC).
:::

The Intutic control plane exposes a RESTful API under `/api/v1/`. All endpoints use JSON request/response bodies.

## Base URL

```
https://your-control-plane.example/api/v1
```

For local development:
```
http://localhost:3001/api/v1
```

## Authentication

Most endpoints require a JWT access token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

Public endpoints (signup, login, refresh) do not require authentication.

---

## Auth Endpoints

### POST /api/v1/auth/signup

Self-serve signup with workspace auto-provisioning. Creates a user, provisions a `free_trial` workspace, and issues a virtual API key.

**Auth:** None (public)

**Request body:**

```json
{
  "email": "dev@example.com",
  "password": "securepassword",
  "name": "Jane Developer",
  "workspaceName": "My Team"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `email` | string | ✅ | Valid email |
| `password` | string | ✅ | 8–128 chars |
| `name` | string | ✅ | 1–128 chars |
| `workspaceName` | string | ❌ | 1–64 chars, optional |

**Response:** `201 Created`

**Error codes:** `409` EMAIL_ALREADY_EXISTS, `422` validation, `503` SIGNUP_DISABLED

---

### POST /api/v1/auth/login

Authenticate with email and password.

**Auth:** None (public)

**Request body:**

```json
{
  "email": "dev@example.com",
  "password": "securepassword"
}
```

**Response:** `200 OK` with access token and refresh token

**Error codes:** `400` validation, `401` invalid credentials

---

### POST /api/v1/auth/refresh

Refresh an access token using a refresh token.

**Auth:** None (public)

**Request body:**

```json
{
  "refreshToken": "rt_..."
}
```

**Response:** `200 OK` with new access token

**Error codes:** `400` validation, `401` expired or invalid token

---

### POST /api/v1/auth/verify-email

Verify email address with a token.

**Auth:** None (public)

**Request body:**

```json
{
  "token": "<64-char-verification-token>"
}
```

**Response:** `200 OK`

**Error codes:** `400` TOKEN_INVALID, `410` TOKEN_EXPIRED

---

### POST /api/v1/auth/resend-verification

Resend the email verification link. Rate limited to 2 req/min per email.

**Auth:** None (public)

**Request body:**

```json
{
  "email": "dev@example.com"
}
```

**Response:** `200 OK`

**Error codes:** `404` USER_NOT_FOUND, `409` ALREADY_VERIFIED, `429` RATE_LIMITED

---

### POST /api/v1/auth/logout

Invalidate the current session.

**Auth:** JWT required

**Response:** `200 OK`

```json
{ "loggedOut": true }
```

---

### POST /api/v1/auth/change-password

Change the authenticated user's password.

**Auth:** JWT required

**Request body:**

```json
{
  "currentPassword": "oldpassword",
  "newPassword": "newpassword"
}
```

**Response:** `200 OK`

```json
{ "changed": true }
```

**Error codes:** `400` validation, `401` current password incorrect

---

### GET /api/v1/auth/me

Get the current authenticated user's info.

**Auth:** JWT required

**Response:** `200 OK` with member object

**Error codes:** `404` member not found

---

## Trace Endpoints

### GET /api/v1/traces

List execution traces for the workspace.

**Auth:** JWT required

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | `20` | 1–100 |
| `offset` | number | `0` | Pagination offset |
| `since` | ISO 8601 | — | Only traces after this timestamp |
| `enforcement` | enum | — | `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` |
| `model` | string | — | Filter by model name |

**Response:** `200 OK`

```json
{
  "traces": [...],
  "total": 142,
  "limit": 20,
  "offset": 0
}
```

---

### GET /api/v1/traces/:id

Get a single execution trace by ID.

**Auth:** JWT required

**Response:** `200 OK` — full trace with token counts, costs, compliance scores, anomaly data

**Error codes:** `404` trace not found

---

## SOP Endpoints

### POST /api/v1/sops

Create a new SOP.

**Auth:** JWT required

**Request body:**

```json
{
  "title": "Code Review Requirements",
  "markdown_content": "## Rules\n\nAll code must have tests...",
  "risk_tier": "MEDIUM",
  "complexity_tier": "MEDIUM",
  "version": "1.0.0",
  "dependencies": ["sop_abc123"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✅ | 1–500 chars |
| `markdown_content` | string | ✅ | 1–100,000 chars |
| `risk_tier` | enum | ✅ | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `complexity_tier` | enum | ✅ | `LOW`, `MEDIUM`, `HIGH` |
| `version` | string | ❌ | 1–50 chars |
| `dependencies` | string[] | ❌ | SOP IDs this depends on |

**Response:** `201 Created`

---

### GET /api/v1/sops

List SOPs with pagination and filters.

**Auth:** JWT required

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (min 1) |
| `limit` | number | `50` | 1–100 |
| `lifecycle_state` | enum | — | Filter by state |
| `risk_tier` | enum | — | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `complexity_tier` | enum | — | `LOW`, `MEDIUM`, `HIGH` |

**Lifecycle states:** `DRAFT`, `PENDING_REVIEW`, `GENERATED`, `HYPOTHESIZED`, `REFINED`, `VALIDATED`, `INVALIDATED`

---

### GET /api/v1/sops/:sopId

Get SOP detail.

**Auth:** JWT required

**Response:** `200 OK` with full SOP object

**Error codes:** `404` SOP not found

---

### PUT /api/v1/sops/:sopId

Update SOP (with anti-gaming gate).

**Auth:** JWT required

**Request body:** Same fields as create, all optional.

**Response:** `200 OK`

**Error codes:** `404` SOP not found

---

### DELETE /api/v1/sops/:sopId

Soft-delete SOP.

**Auth:** JWT required

**Response:** `200 OK`

```json
{ "deleted": true }
```

**Error codes:** `404` SOP not found

---

### POST /api/v1/sops/:sopId/transition

Lifecycle state transition.

**Auth:** JWT required

**Request body:**

```json
{
  "target_state": "VALIDATED",
  "reason": "Passed team review"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `target_state` | enum | ✅ | Target lifecycle state |
| `reason` | string | ❌ | Max 1,000 chars |

**Response:** `200 OK` on success

**Error codes:** `409` transition not allowed

---

### POST /api/v1/sops/:sopId/invalidate

Cascade invalidation — invalidates this SOP and all dependents.

**Auth:** JWT required

**Response:** `200 OK`

---

### GET /api/v1/sops/:sopId/dependencies

Get SOP dependency graph.

**Auth:** JWT required

**Response:** `200 OK`

```json
{
  "sop_id": "sop_abc123",
  "dependencies": [...]
}
```

---

### GET /api/v1/sops/:sopId/health

Get SOP health metrics.

**Auth:** JWT required

**Response:** `200 OK` with health metrics

---

## Usage / FinOps Endpoints

### GET /api/v1/usage/summary

Aggregated usage summary by period.

**Auth:** JWT required

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `period` | enum | ✅ | `daily`, `weekly`, `monthly` |
| `start` | ISO 8601 | ✅ | Start date (with offset) |
| `end` | ISO 8601 | ✅ | End date (with offset) |

---

### GET /api/v1/usage/events

Paginated raw execution trace events.

**Auth:** JWT required

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number |
| `limit` | number | `50` | 1–100 |
| `session_id` | string | — | Filter by session |

**Response:** `200 OK`

```json
{
  "events": [
    {
      "trace_id": "tr_abc123",
      "timestamp": "2026-06-11T22:24:00.000Z",
      "model": "claude-4-sonnet",
      "input_tokens": 1234,
      "output_tokens": 567,
      "cost_usd": 0.0037,
      "enforcement_action": "BYPASS",
      "token_utility": "USEFUL"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 142,
    "has_more": true
  }
}
```

---

### GET /api/v1/usage/models

Per-model cost breakdown.

**Auth:** JWT required

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `period` | enum | ✅ | `daily` or `monthly` |

**Response:** `200 OK`

```json
{
  "models": [...]
}
```

---

### POST /api/v1/usage/classify

Classify tokens as USEFUL or WASTED.

**Auth:** JWT required

**Request body:**

```json
{
  "trace_ids": ["tr_abc123", "tr_def456"],
  "classification": "WASTED",
  "reason": "Agent was looping"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `trace_ids` | string[] | ✅ | 1–500 trace IDs |
| `classification` | enum | ✅ | `USEFUL` or `WASTED` |
| `reason` | string | ✅ | 1–1,000 chars |

**Response:** `200 OK`

```json
{ "classified": 2 }
```

---

<!-- GENERATED:ROUTE-CATALOG:START -->

## Route Catalog

_Generated from `services/control-plane/src/routes/*.ts` by `generate-api-catalog.mjs`. 334 routes across 69 route files. Do not hand-edit this section — re-run the generator instead._

### `agentcoreGateway.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/integrations/agentcore/gateway-check` | Authenticated |  |

### `agents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/agents` | Authenticated | list agents in the workspace |
| GET | `/api/v1/agents/:id` | Authenticated | one agent, its facets, posture, live sessions |
| POST | `/api/v1/agents/:id/judge-score` | Authenticated |  |
| GET | `/api/v1/agents/graph` | Authenticated | nodes + edges + posture for the viz |
| POST | `/api/v1/agents/report` | Authenticated | daemon upserts an agent + facets (rescored) |

### `anomaly.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/anomalies` | OWNER/ADMIN/EM | Paginated anomaly list |
| GET | `/api/v1/capability-misses` | OWNER/ADMIN/EM | Capability miss events |
| POST | `/api/v1/capability-misses` | Authenticated |  |
| POST | `/api/v1/capability-misses/:missId/review` | OWNER/ADMIN/EM |  |

### `attenuate.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/attenuate` | Authenticated | Attenuate parent key to child key (team+) |
| GET | `/api/v1/attenuate/chain/:chainId` | Authenticated | Resolve delegation lineage (ADMIN+) |
| POST | `/api/v1/auth/obo-token` | Authenticated | Issue OBO ephemeral session token (pro+) |

### `audit.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/audit/timeline` | OWNER/ADMIN | Joined login/enforcement/decision/incident/ settings-change report for a workspace over a date range. |

### `auth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/change-password` | Authenticated | Change password (requires JWT) |
| GET | `/api/v1/auth/key-context` | Authenticated |  |
| POST | `/api/v1/auth/login` | Public | Login with email/password |
| POST | `/api/v1/auth/logout` | Authenticated | Logout (requires JWT) |
| POST | `/api/v1/auth/magic-link/login` | Public |  |
| POST | `/api/v1/auth/magic-link/request` | Public |  |
| GET | `/api/v1/auth/me` | Authenticated | Get current user info (requires JWT) |
| POST | `/api/v1/auth/refresh` | Public | Refresh access token |
| POST | `/api/v1/auth/resend-verification` | Public |  |
| GET | `/api/v1/auth/session` | Authenticated |  |
| POST | `/api/v1/auth/signup` | Public | Self-serve signup with workspace auto-provisioning |
| POST | `/api/v1/auth/signup/org` | Public |  |
| POST | `/api/v1/auth/verify-email` | Public |  |

### `billing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/billing/checkout` | Authenticated | Create Stripe Checkout Session (ADMIN) |
| GET | `/api/v1/billing/invoices` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/aws/register` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/aws/webhook` | Public |  |
| POST | `/api/v1/billing/marketplace/gcp/register` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/gcp/webhook` | Public |  |
| POST | `/api/v1/billing/subscription` | Authenticated |  |
| GET | `/api/v1/billing/usage-rate` | Authenticated |  |
| GET | `/api/v1/billing/usage/current` | Authenticated | Current metered usage summary (team+) |
| POST | `/api/v1/billing/webhook` | Public | Handle Stripe webhook (public) |

### `breakGlass.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/break-glass/approve` | Authenticated |  |
| POST | `/api/v1/break-glass/request` | Authenticated |  |
| GET | `/api/v1/break-glass/requests` | Authenticated |  |

### `budget.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/budget` | Authenticated | Current budget status |
| PUT | `/api/v1/budget` | Authenticated | Update budget settings |
| GET | `/api/v1/budget/alerts` | Authenticated | Budget alert history |
| POST | `/api/v1/budget/alerts/:alertId/acknowledge` | Authenticated | Acknowledge an alert |

### `compliance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/compliance/probes/history` | Authenticated |  |
| GET | `/api/v1/compliance/probes/latest` | Authenticated |  |
| POST | `/api/v1/compliance/probes/run` | Authenticated |  |
| POST | `/api/v1/compliance/soc2-collect` | OWNER/ADMIN |  |
| GET | `/api/v1/compliance/soc2-export/:runId` | OWNER/ADMIN |  |
| GET | `/api/v1/compliance/soc2-status` | Authenticated |  |

### `connectors.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/connectors` | Authenticated | List connectors |
| POST | `/api/v1/connectors` | Authenticated | Create connector |
| DELETE | `/api/v1/connectors/:connectorId` | Authenticated |  |
| PATCH | `/api/v1/connectors/:connectorId` | Authenticated |  |
| POST | `/api/v1/connectors/:connectorId/sync` | Authenticated |  |
| POST | `/api/v1/connectors/:connectorId/test` | Authenticated |  |
| DELETE | `/api/v1/connectors/virustotal` | OWNER/ADMIN | Remove the stored VT API key (OWNER/ADMIN) |
| GET | `/api/v1/connectors/virustotal` | OWNER/ADMIN | Read masked VT credential status (OWNER/ADMIN) |
| POST | `/api/v1/connectors/virustotal` | OWNER/ADMIN | Upsert the workspace's VT API key (OWNER/ADMIN) |
| GET | `/api/v1/connectors/virustotal/budget` | OWNER/ADMIN | Today's lookup budget usage (OWNER/ADMIN) |
| POST | `/api/v1/connectors/virustotal/test` | OWNER/ADMIN | Validate the stored key against a benign hash (OWNER/ADMIN) |

### `decisions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/decisions` | Authenticated | List decisions (paginated) |
| POST | `/api/v1/decisions` | Authenticated | Ingest review holds from the daemon |
| GET | `/api/v1/decisions/:entryId` | Authenticated | Get decision detail |
| POST | `/api/v1/decisions/:entryId/review` | Authenticated |  |
| GET | `/api/v1/decisions/analysis` | Authenticated | Aggregated pattern analysis |
| GET | `/api/v1/decisions/approved-bypasses` | Authenticated |  |
| POST | `/api/v1/decisions/substitutions` | Authenticated | Ingest tool calls the proxy rewrote |
| POST | `/api/v1/rule-candidates/:candidateId/bundle` | Authenticated |  |
| POST | `/api/v1/rule-candidates/:candidateId/mocks` | Authenticated |  |
| POST | `/api/v1/rule-candidates/:candidateId/promote` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/hold-candidates` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/rule-candidates` | Authenticated |  |

### `devices.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/devices` | OWNER/ADMIN | list enrolled devices |
| DELETE | `/api/v1/devices/:id` | OWNER/ADMIN | soft-retire a device |
| GET | `/api/v1/devices/:id` | OWNER/ADMIN | get a single device |
| POST | `/api/v1/devices/report` | Authenticated | any authenticated member, upserts on (workspaceId, fingerprint) |

### `domainVerification.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/domain-verification/:id` | Authenticated |  |
| POST | `/api/v1/domain-verification/start` | Authenticated |  |

### `dreamCycle.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/dream-cycle/queue` | Authenticated |  |
| POST | `/api/v1/dream-cycle/queue/:id/approve` | Authenticated |  |
| POST | `/api/v1/dream-cycle/queue/:id/reject` | Authenticated |  |
| GET | `/api/v1/dream-cycle/settings` | Authenticated |  |
| PUT | `/api/v1/dream-cycle/settings` | Authenticated |  |
| POST | `/api/v1/dream-cycle/trigger` | Authenticated |  |

### `enterpriseTrial.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/enterprise/trial/:id/convert` | Authenticated | Sales conversion (internal) |
| POST | `/api/v1/enterprise/trial/start` | Authenticated | Start trial (canonical implemented path) |
| GET | `/api/v1/enterprise/trial/status` | Authenticated | Trial status for workspace |
| GET | `/api/v1/enterprise/usage` | Authenticated | Current period usage summary |
| GET | `/api/v1/enterprise/usage/history` | Authenticated | Historical daily meters |

### `evaluate.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/policy/check` | Public | Check if a model check is allowed |
| GET | `/api/v1/policy/resolve` | Authenticated | Resolve active rules for workspace |

### `evaluatorSandbox.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/evaluator/sandbox/:runId/deploy` | Authenticated |  |
| GET | `/api/v1/evaluator/sandbox/:runId/results` | Authenticated |  |
| GET | `/api/v1/evaluator/sandbox/datasets` | Authenticated |  |
| POST | `/api/v1/evaluator/sandbox/datasets` | Authenticated |  |
| POST | `/api/v1/evaluator/sandbox/run` | Authenticated |  |

### `findings.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/findings` | Authenticated |  |
| POST | `/api/v1/findings/:findingId/adjudicate` | Authenticated |  |
| GET | `/api/v1/findings/:findingId/snippet` | OWNER/ADMIN |  |
| GET | `/api/v1/findings/adjudicated` | Authenticated |  |
| GET | `/api/v1/findings/response-echo/report` | Authenticated |  |
| GET | `/api/v1/findings/stats` | Authenticated |  |

### `fixEnhance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/fix/enhance` | Authenticated |  |

### `gatewayHeartbeat.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/gateways/:id/config` | Authenticated |  |
| POST | `/api/v1/gateways/:id/config-ack` | Authenticated |  |
| POST | `/api/v1/gateways/:id/heartbeat` | Authenticated |  |

### `gateways.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/gateways` | Authenticated |  |
| POST | `/api/v1/gateways` | OWNER/ADMIN |  |
| DELETE | `/api/v1/gateways/:id` | OWNER/ADMIN |  |
| PATCH | `/api/v1/gateways/:id/config` | OWNER/ADMIN |  |
| POST | `/api/v1/gateways/:id/rotate` | OWNER/ADMIN |  |
| POST | `/api/v1/gateways/:id/self-rotate` | Authenticated |  |
| GET | `/api/v1/gateways/:id/status` | Authenticated |  |
| PATCH | `/api/v1/workspace/gateway` | OWNER/ADMIN |  |
| GET | `/api/v1/workspace/gateway-resolution` | Authenticated |  |

### `governanceCoverage.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/governance-coverage` | Authenticated |  |
| GET | `/api/v1/governance-coverage/:harnessType` | Authenticated |  |
| POST | `/api/v1/governance-coverage/snapshot` | Authenticated |  |

### `harnessConfig.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/config/capture` | Authenticated | Capture config snapshot |
| POST | `/api/v1/skillopt/:suggestionId/apply` | Authenticated |  |
| POST | `/api/v1/skillopt/:suggestionId/apply-result` | Authenticated | Sync daemon's ack of an apply attempt |
| POST | `/api/v1/skillopt/:suggestionId/dismiss` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/config-snapshots` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/config-snapshots/:snapshotId/diff` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/skillopt-suggestions` | Authenticated |  |
| POST | `/api/v1/workspaces/:workspaceId/skillopt/generate` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/skills/report` | Authenticated |  |
| POST | `/api/v1/workspaces/:workspaceId/skills/report` | Authenticated |  |

### `hookEvents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/hook-events` | Authenticated |  |
| POST | `/api/v1/hook-gate` | Authenticated |  |

### `incidents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/incidents` | OWNER/ADMIN/EM | Paginated incident list |
| GET | `/api/v1/incidents/:id` | OWNER/ADMIN/EM | Single incident detail |
| POST | `/api/v1/incidents/:id/resolve` | OWNER/ADMIN/EM | Resolve an incident |

### `integrity.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/integrity/chain` | Authenticated |  |
| GET | `/api/v1/integrity/config-chain` | Authenticated |  |
| GET | `/api/v1/integrity/roots` | Authenticated |  |
| GET | `/api/v1/integrity/roots/:rootId` | Authenticated |  |
| GET | `/api/v1/integrity/roots/:rootId/proof/:traceId` | Authenticated |  |
| POST | `/api/v1/integrity/roots/:rootId/recompute` | Authenticated |  |
| GET | `/api/v1/integrity/traces/:traceId/leaf` | Authenticated |  |

### `intelligence.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/predict-cost` | Authenticated | Cost prediction |
| POST | `/api/v1/recommendations/:recommendationId/apply` | Authenticated |  |
| POST | `/api/v1/recommendations/:recommendationId/dismiss` | Authenticated |  |
| GET | `/api/v1/traces/:traceId/token-breakdown` | Authenticated | Per-tool token breakdown |
| GET | `/api/v1/workspaces/:workspaceId/optimization-recommendations` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/waste-patterns` | Authenticated |  |

### `judge.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/judge/chunk` | Public |  |
| POST | `/api/v1/judge/finalize` | Public |  |

### `keys.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/keys` | Authenticated | List API keys for the workspace |
| POST | `/api/v1/keys` | Authenticated | Create a new API key |
| DELETE | `/api/v1/keys/:id` | Authenticated | Revoke an API key |

### `loops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/loops` | Authenticated |  |
| GET | `/api/v1/loops/:loopRunId` | Authenticated |  |
| POST | `/api/v1/loops/:loopRunId/complete` | Authenticated |  |
| GET | `/api/v1/loops/:loopRunId/duplicates` | Authenticated |  |
| POST | `/api/v1/loops/:loopRunId/kill` | Authenticated |  |
| POST | `/api/v1/loops/:loopRunId/review` | Authenticated |  |
| POST | `/api/v1/loops/:loopRunId/verify` | Authenticated |  |
| GET | `/api/v1/loops/reviews` | Authenticated |  |
| POST | `/api/v1/loops/start` | Authenticated |  |
| GET | `/api/v1/ontology/proposals` | Authenticated |  |
| POST | `/api/v1/ontology/proposals/:proposalId/resolve` | Authenticated |  |

### `mcpDaemon.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/mcp-daemon/policy-invalidate` | Authenticated | bumps the workspace config version, the same signal wasmRules/SOP writes use. Sync daemons poll that counter and re-pull policy, which flushes their local policy LRU. |
| POST | `/api/v1/mcp-daemon/report` | Authenticated | daemon-side upload of one status snapshot, authenticated with the workspace API key. A daemon that stops reporting reads as `running: false` after a few missed intervals rather than showing a stale snapshot forever. |
| GET | `/api/v1/mcp-daemon/status` | Authenticated | dashboard projection of the stored snapshot. Absence is a valid state, not an error: it renders as a not-running daemon with empty counters. |

### `members.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/members` | Authenticated | List workspace members |
| DELETE | `/api/v1/members/:id` | OWNER/ADMIN | Deactivate a member |
| POST | `/api/v1/members/:id/reactivate` | OWNER/ADMIN |  |
| PUT | `/api/v1/members/:id/role` | OWNER/ADMIN | Update a member's role |
| POST | `/api/v1/members/invite` | OWNER/ADMIN | Invite a new member to the workspace |

### `metaclaw.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/metaclaw/proposals` | Authenticated |  |
| GET | `/api/v1/metaclaw/runs` | Authenticated |  |
| GET | `/api/v1/metaclaw/runs/:id` | Authenticated |  |
| POST | `/api/v1/metaclaw/trigger` | Authenticated |  |

### `notifications.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/notifications/log` | Authenticated | Notification history |
| GET | `/api/v1/notifications/rules` | Authenticated | List rules |
| POST | `/api/v1/notifications/rules` | Authenticated | Create rule |
| DELETE | `/api/v1/notifications/rules/:ruleId` | Authenticated | Delete rule |
| PUT | `/api/v1/notifications/rules/:ruleId` | Authenticated | Update rule |

### `oauth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/auth/oauth/github` | Public | Redirect to GitHub authorize URL |
| GET | `/api/v1/auth/oauth/github/callback` | Public | Handle GitHub callback |
| GET | `/api/v1/auth/oauth/google` | Public | Redirect to Google authorize URL |
| GET | `/api/v1/auth/oauth/google/callback` | Public | Handle Google callback |

### `orgs.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/orgs` | Authenticated |  |
| POST | `/api/v1/orgs/:orgId/billing/checkout` | Authenticated |  |
| PATCH | `/api/v1/orgs/:orgId/gateway` | Authenticated |  |
| GET | `/api/v1/orgs/regions` | Authenticated |  |

### `orgSops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/org-sops` | Authenticated |  |
| POST | `/api/v1/workspace/org-sops` | Authenticated |  |
| DELETE | `/api/v1/workspace/org-sops/:orgSopId` | Authenticated |  |

### `plans.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/plans/:planId` | Authenticated | Get plan details |
| GET | `/api/v1/plans/:planId/adherence` | Authenticated | Get adherence score |
| POST | `/api/v1/plans/:planId/approve` | OWNER/ADMIN/EM | Approve plan (OWNER/ADMIN/EM) |
| POST | `/api/v1/plans/:planId/close` | OWNER/ADMIN/EM | Close plan with a final outcome (OWNER/ADMIN/EM) |
| GET | `/api/v1/plans/:planId/deviation` | Authenticated | Get deviation log |
| POST | `/api/v1/plans/:planId/reject` | OWNER/ADMIN/EM | Reject plan before it executes (OWNER/ADMIN/EM) |
| POST | `/api/v1/plans/capture` | Authenticated | Capture a plan artifact |
| GET | `/api/v1/plans/session/:sessionId` | Authenticated |  |
| GET | `/api/v1/sops/:sopId/proof-tree` | Authenticated | Get latest proof tree |
| POST | `/api/v1/sops/:sopId/proof-tree` | Authenticated | Create/update proof tree |
| GET | `/api/v1/sops/:sopId/proof-tree/diff` | Authenticated | Diff proof tree versions |

### `policies.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/policies` | Authenticated |  |
| POST | `/api/v1/policies/:policyId/disable` | Authenticated |  |
| POST | `/api/v1/policies/:policyId/enable` | Authenticated |  |
| POST | `/api/v1/policies/:policyId/rollback` | Authenticated |  |

### `providerCredentials.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/provider-credentials` | Authenticated | provisioning status, every registry provider |
| DELETE | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | de-provision (OWNER/ADMIN only) |
| PUT | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | provision/rotate (OWNER/ADMIN only) |
| POST | `/api/v1/workspace/provider-credentials/:provider/verify` | OWNER/ADMIN | test the stored credential against the provider's own API. |

### `providerIncidents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/provider-incidents` | Authenticated |  |
| POST | `/api/v1/provider-incidents/sla-evidence` | OWNER/ADMIN |  |
| GET | `/api/v1/provider-incidents/sla-evidence/:runId` | OWNER/ADMIN |  |

### `qmSecurityScreen.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/integrations/qm/security-screen` | Public |  |

### `routing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/routing/bandit/status` | Authenticated | arm table + convergence summary |
| GET | `/api/v1/routing/cache/stats` | Authenticated | cache counters |
| GET | `/api/v1/routing/mirror-adoption-report` | Authenticated | win/loss/ tie, fault-rate delta, cost delta, latency delta for one mirror candidate |

### `saml.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/saml/acs` | Public | Assertion Consumer Service |
| GET | `/api/v1/auth/saml/login/:providerId` | Public | redirect to the IdP |
| GET | `/api/v1/auth/saml/metadata/:providerId` | Public | SP metadata XML for the IdP admin |

### `scim.ts` <Badge type="danger" text="Enterprise" />

> "Public" in the Auth column means these routes bypass the global workspace
> JWT middleware — not that they're unauthenticated. Every SCIM request still
> authenticates via a bearer token the handler itself validates, per the SCIM
> 2.0 protocol's own auth model.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/admin/offboarding/retry` | Public |  |
| GET | `/scim/v2/Groups` | Public |  |
| POST | `/scim/v2/Groups` | Public |  |
| DELETE | `/scim/v2/Groups/:id` | Public |  |
| GET | `/scim/v2/Groups/:id` | Public |  |
| PATCH | `/scim/v2/Groups/:id` | Public |  |
| PUT | `/scim/v2/Groups/:id` | Public |  |
| GET | `/scim/v2/Users` | Public | List users with filter/pagination |
| POST | `/scim/v2/Users` | Public | Provision new user |
| DELETE | `/scim/v2/Users/:id` | Public | Deprovision (full offboarding cascade) |
| GET | `/scim/v2/Users/:id` | Public | Get single user |
| PATCH | `/scim/v2/Users/:id` | Public | Partial update (e.g., deactivate) |
| PUT | `/scim/v2/Users/:id` | Public |  |

### `scimTokens.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/scim/tokens` | OWNER/ADMIN |  |
| POST | `/api/v1/scim/tokens` | OWNER/ADMIN |  |
| DELETE | `/api/v1/scim/tokens/:id` | OWNER/ADMIN |  |

### `sessions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/sessions` | Authenticated |  |
| GET | `/api/v1/sessions/:sessionId` | Authenticated |  |
| PATCH | `/api/v1/sessions/:sessionId/attest-sandbox` | Authenticated |  |
| PATCH | `/api/v1/sessions/:sessionId/end` | Authenticated |  |

### `siem.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/siem/destinations` | Authenticated | List destinations (masks credentials) |
| POST | `/api/v1/siem/destinations` | OWNER/ADMIN | Create a destination (encrypts credentials) |
| DELETE | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | Deactivate a destination |
| GET | `/api/v1/siem/destinations/:id` | Authenticated | Get destination details (masks credentials) |
| PUT | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | Update destination details |
| POST | `/api/v1/siem/destinations/:id/test` | OWNER/ADMIN | Health-check a destination |
| GET | `/api/v1/siem/dlq` | Authenticated | List DLQ failed events |
| POST | `/api/v1/siem/dlq/retry` | OWNER/ADMIN | Trigger a manual DLQ retry pass |

### `slackCommands.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/commands` | Public |  |

### `slackEvents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/events` | Public |  |

### `slackInteractions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/interactions` | Public |  |

### `slackOAuth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| DELETE | `/api/v1/adapters/slack` | Authenticated | Remove installation |
| POST | `/api/v1/adapters/slack/link-code` | Authenticated | Issue an account-link code |
| GET | `/api/v1/adapters/slack/oauth/authorize` | Authenticated | Start OAuth (redirect) |
| GET | `/api/v1/adapters/slack/oauth/callback` | Public | OAuth callback |
| GET | `/api/v1/adapters/slack/oauth/url` | Authenticated |  |
| GET | `/api/v1/adapters/slack/status` | Authenticated | Installation status |

### `slashCommand.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/slash-command` | Public |  |

### `sops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/sop/dependency-graph` | Authenticated |  |
| GET | `/api/v1/sop/rules` | Authenticated |  |
| GET | `/api/v1/sops` | Authenticated | List SOPs (paginated) |
| POST | `/api/v1/sops` | Authenticated | Create SOP |
| DELETE | `/api/v1/sops/:sopId` | Authenticated | Soft-delete SOP |
| GET | `/api/v1/sops/:sopId` | Authenticated | Get SOP detail |
| PUT | `/api/v1/sops/:sopId` | Authenticated | Update SOP |
| GET | `/api/v1/sops/:sopId/dependencies` | Authenticated | Get dependency graph |
| GET | `/api/v1/sops/:sopId/duplicates` | Authenticated | TD-125: Similarity dedup scoring |
| POST | `/api/v1/sops/:sopId/godel-probe` | Authenticated |  |
| GET | `/api/v1/sops/:sopId/health` | Authenticated | Get health metrics |
| POST | `/api/v1/sops/:sopId/holds` | Authenticated |  |
| POST | `/api/v1/sops/:sopId/invalidate` | Authenticated | Cascade invalidation |
| POST | `/api/v1/sops/:sopId/transition` | Authenticated | Lifecycle transition |
| GET | `/api/v1/sops/:sopId/versions` | Authenticated |  |
| POST | `/api/v1/sops/git-drift-report` | Authenticated | Record sops status drift results |

### `sslCompliance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/sessions/:sessionId/ssl-audit` | Authenticated |  |
| GET | `/api/v1/sessions/:sessionId/ssl-state` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/ssl-compliance` | Authenticated |  |

### `sso.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/auth/sso/callback` | Public | Handle IdP callback (public) |
| GET | `/api/v1/auth/sso/login/:providerId` | Public | Redirect to IdP (public) |
| GET | `/api/v1/auth/sso/providers` | Authenticated | List SSO providers (ADMIN+) |
| POST | `/api/v1/auth/sso/providers` | Authenticated | Create provider (OWNER) |
| DELETE | `/api/v1/auth/sso/providers/:providerId` | Authenticated | Delete provider (OWNER) |

### `sync.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/sync/config` | Authenticated | Push workspace config to daemon |
| GET | `/api/v1/sync/report` | Authenticated |  |
| POST | `/api/v1/sync/sop-hash` | Authenticated | Receive SOP hash integrity report |
| POST | `/api/v1/sync/status` | Authenticated | Record daemon heartbeat |
| GET | `/api/v1/sync/ws` | Public |  |

### `taskManagement.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/task-management/connections` | Authenticated | List task connections |
| POST | `/api/v1/task-management/connections` | Authenticated | Create task connection |
| DELETE | `/api/v1/task-management/connections/:connectionId` | Authenticated |  |
| POST | `/api/v1/task-management/connections/:connectionId/test` | Authenticated |  |

### `teams.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/orgs/:orgId/teams` | Authenticated |  |
| POST | `/api/v1/orgs/:orgId/teams` | Authenticated |  |
| GET | `/api/v1/teams/:teamId/workspaces` | Authenticated |  |
| POST | `/api/v1/teams/:teamId/workspaces` | Authenticated |  |

### `telemetry.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/telemetry/event` | Public | Forward a telemetry event |

### `traces.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/traces` | Authenticated | List traces with filtering and pagination |
| GET | `/api/v1/traces/:id` | Authenticated | Get a single trace by ID |
| GET | `/api/v1/traces/:id/dag` | Authenticated |  |
| POST | `/api/v1/traces/sync-back` | Authenticated |  |

### `trajectory.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/trajectory/alerts` | OWNER/ADMIN/EM | List trajectory alerts for workspace |
| GET | `/api/v1/trajectory/alerts/:alertId` | OWNER/ADMIN/EM |  |
| POST | `/api/v1/trajectory/analyze` | Authenticated | Submit trajectory summary for analysis |
| GET | `/api/v1/trajectory/status/:sessionId` | OWNER/ADMIN/EM |  |

### `trial.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/trial/status` | Authenticated | Authenticated, returns trial/plan status for workspace |
| GET | `/api/v1/trial/tiers` | Public | Public, returns static pricing tier definitions |

### `trust.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/trust-scores` | Authenticated | All trust scores for a workspace |
| GET | `/api/v1/trust-scores/:userId` | Authenticated | Single user trust score |

### `usage.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/usage/classify` | Authenticated | Classify tokens as USEFUL or WASTED |
| GET | `/api/v1/usage/events` | Authenticated | Paginated raw execution trace events |
| GET | `/api/v1/usage/models` | Authenticated | Per-model cost breakdown |
| GET | `/api/v1/usage/summary` | Authenticated | Aggregated usage summary by period |

### `users.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/users/me` | Authenticated | Get current user profile + workspaces |
| PUT | `/api/v1/users/me` | Authenticated | Update display name / avatar |

### `wasmRules.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/wasm-rules` | Authenticated |  |
| POST | `/api/v1/wasm-rules` | Authenticated |  |
| DELETE | `/api/v1/wasm-rules/:ruleId` | Authenticated |  |
| GET | `/api/v1/wasm-rules/:ruleId` | Authenticated |  |
| PUT | `/api/v1/wasm-rules/:ruleId` | Authenticated |  |
| POST | `/api/v1/wasm-rules/:ruleId/replay` | Authenticated |  |

### `workspace.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/workspace/byoc/test` | Authenticated |  |
| GET | `/api/v1/workspace/dashboard` | Authenticated | Aggregated dashboard summary |
| GET | `/api/v1/workspace/decisions-digest` | Authenticated |  |
| GET | `/api/v1/workspace/egress-policy` | Authenticated |  |
| POST | `/api/v1/workspace/judge-model/test` | OWNER/ADMIN |  |
| GET | `/api/v1/workspace/leaderboard` | Authenticated |  |
| GET | `/api/v1/workspace/onboarding-status` | Authenticated |  |
| POST | `/api/v1/workspace/onboarding/complete` | Authenticated |  |
| GET | `/api/v1/workspace/posture` | Authenticated |  |
| POST | `/api/v1/workspace/posture` | Authenticated |  |
| GET | `/api/v1/workspace/region` | Authenticated |  |
| PATCH | `/api/v1/workspace/region` | Authenticated |  |
| GET | `/api/v1/workspace/settings` | Authenticated | Read workspace settings (resolved with defaults) |
| PUT | `/api/v1/workspace/settings` | OWNER/ADMIN | Update workspace settings (ADMIN+) |
| GET | `/api/v1/workspace/sops-policy` | Authenticated |  |

<!-- GENERATED:ROUTE-CATALOG:END -->

---

## Member Invite Endpoint

### POST /api/v1/members/invite

Provision a new workspace member with a temporary password. The admin must share the credentials out-of-band (Intutic does not send invitation emails).

**Auth:** JWT required (Owner or Admin role)

**Request body:**

```json
{
  "email": "newdev@example.com",
  "displayName": "Jane Developer",
  "role": "DEVELOPER",
  "tempPassword": "initial-secure-pw-123"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `email` | string | ✅ | Valid email, max 256 chars |
| `displayName` | string | ✅ | 1–128 chars |
| `role` | enum | ✅ | `ADMIN`, `EM`, `DEVELOPER`, `VIEWER` |
| `tempPassword` | string | ✅ | 8–128 chars |

::: info
The `OWNER` role cannot be assigned via invite. Only existing Owners can transfer ownership.
:::

**Response:** `201 Created`

```json
{
  "memberId": "mb_abc123",
  "userId": "usr_def456",
  "email": "newdev@example.com",
  "displayName": "Jane Developer",
  "role": "DEVELOPER",
  "workspaceId": "wk_ghi789"
}
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `400` | Validation failed (missing fields, invalid email, password too short) |
| `403` | Workspace seat limit reached (upgrade plan to add more members) |
| `409` | Member already exists or duplicate invitation (`DUPLICATE_MEMBER`) |
