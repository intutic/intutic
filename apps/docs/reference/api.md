# REST API Reference <Badge type="warning" text="Cloud / Team" />

::: warning Commercial / Team Tier Feature
The REST API endpoints documented below are exposed by the **Intutic Control Plane** (local dev stack on port 3001 or Cloud SaaS / Private VPC).
:::

The Intutic control plane exposes a RESTful API under `/api/v1/`. All endpoints use JSON request/response bodies.

## Base URL

```
https://api.intutic.ai/api/v1
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

Public endpoints (register, login, refresh, signup) do not require authentication.

---

## Auth Endpoints

### POST /api/v1/auth/register

Register a new user and workspace.

**Auth:** None (public)

**Request body:**

```json
{
  "email": "dev@example.com",
  "password": "securepassword",
  "name": "Jane Developer"
}
```

**Response:** `201 Created`

**Error codes:** `400` validation, `409` email already exists

---

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

## Other Route Files

The control plane includes additional routes not yet documented in detail:

| Route File | Prefix | Purpose |
|------------|--------|---------|
| `anomaly.ts` | `/api/v1/anomalies` | Anomaly detection and alerts |
| `budget.ts` | `/api/v1/budgets` | Budget tier management |
| `decisions.ts` | `/api/v1/decisions` | PCAS enforcement decision log |
| `evaluate.ts` | `/api/v1/evaluate` | Request evaluation pipeline |
| `incidents.ts` | `/api/v1/incidents` | Governance incident lifecycle |
| `keys.ts` | `/api/v1/keys` | Virtual API key management |
| `members.ts` | `/api/v1/members` | Workspace member management |
| `plans.ts` | `/api/v1/plans` | Execution plan management |
| `scim.ts` | `/scim/v2/Users`, `/scim/v2/Groups` | SCIM 2.0 user/group provisioning (RFC 7643/7644) |
| `sync.ts` | `/api/v1/sync` | Harness config sync |
| `trust.ts` | `/api/v1/trust` | Trust score management |
| `workspace.ts` | `/api/v1/workspace` | Workspace CRUD |

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
  "memberId": "mem_abc123",
  "userId": "usr_def456",
  "email": "newdev@example.com",
  "displayName": "Jane Developer",
  "role": "DEVELOPER",
  "workspaceId": "ws_ghi789"
}
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `400` | Validation failed (missing fields, invalid email, password too short) |
| `403` | Workspace seat limit reached (upgrade plan to add more members) |
| `409` | Member already exists or duplicate invitation (`DUPLICATE_MEMBER`) |
