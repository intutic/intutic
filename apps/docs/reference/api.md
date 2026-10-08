# REST API Reference <Badge type="tip" text="Cloud" />

::: warning Control plane required
The REST API endpoints documented below are exposed by the **Intutic Control Plane**: Intutic Cloud, a Self-host deployment, or a local dev stack on port 3001. The local proxy has a few endpoints of its own, listed under [Proxy endpoints](#proxy-endpoints).
:::

The Intutic control plane exposes a RESTful API under `/api/v1/`. Request and response bodies are JSON.

## Base URL

| Deployment | Base URL |
|---|---|
| Intutic Cloud | `https://api.intutic.ai/api/v1` |
| Self-host | `https://<your Intutic hostname>/api/v1` |
| Local development | `http://localhost:3001/api/v1` |

## Authentication

Every route except the ones in the next section takes a credential, in this order:

1. `Authorization: Bearer <token>`, where the token is either
   - a session access token (a JWT from `POST /api/v1/auth/login`, `/refresh`, SSO or a magic link), or
   - a workspace API key (`vk_…`). An API key works on every authenticated route, with the role of the member it belongs to.
2. The `__Host-intutic_session` cookie, which the dashboard uses when it signs in with a cookie session.

A request with neither, an expired or revoked token, or a revoked key gets `401`. In the [route catalog](#route-catalog), **Authenticated** means any member's session or API key; `OWNER/ADMIN` and similar name the roles allowed, and every other caller gets `403`.

`X-Workspace-Id` is optional. When you send it, it must name the workspace the token or key belongs to, or the request is refused with `403` (`Forbidden: workspace context mismatch`).

### Routes that take no session

Some routes skip the session check because their caller cannot have a session, and authenticate inside the handler instead. The **Auth** column names what each one checks:

| Auth | Who calls it |
|---|---|
| None | Probes, the public plan list, sign-up, sign-in starts, telemetry |
| None (*a credential in the request*) | Sign-in steps that carry their own proof: a password, a refresh token, an OAuth state, a signed SAML assertion |
| API key (`vk_…`) | The proxy's judge and command calls, which send the workspace key and are checked in the handler |
| Gateway token (`gwk_…`) | A self-hosted gateway's heartbeat, config pull and token rotation |
| SCIM token | Your identity provider, on the SCIM 2.0 endpoints under `/scim/v2` |
| Admin token (`x-admin-token`) | Internal operations (trial conversion, offboarding retries) |
| Stripe signature, Slack request signature, AWS SNS signature, Google-signed OIDC token | Webhooks from those services |

### Rate limits

Requests are limited per client IP (the first `X-Forwarded-For` address): 10 a minute for sign-in, sign-up, email verification and magic-link routes; 40 a minute for token refresh; 60 a minute for the plan list; one an hour for changing the workspace region; 300 a minute for everything else. `/healthz` and `/readyz` are not limited. Each limited response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; over the limit, the answer is `429` with `Retry-After`.

### List responses

A list response names where its rows are: `listProperty` is the key that holds them (`traces`, `items`, `events`, …) and `rowCase` says whether row keys are `camel`, `snake` or `mixed`, so `body[body.listProperty]` always reads the rows. Each section below gives the key for its endpoints.

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

**Auth:** Authenticated

**Response:** `200 OK`

```json
{ "loggedOut": true }
```

---

### POST /api/v1/auth/change-password

Change the authenticated user's password.

**Auth:** Authenticated

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

**Auth:** Authenticated

**Response:** `200 OK` with member object

**Error codes:** `404` member not found

---

## Trace Endpoints

### GET /api/v1/traces

List execution traces for the workspace, newest first.

**Auth:** Authenticated

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | `20` | 1–100 |
| `offset` | number | `0` | Pagination offset |
| `since` | ISO 8601 or duration | — | Only traces after this time: a timestamp, or a duration back from now such as `24h` or `7d` |
| `enforcement` | enum | — | `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` |
| `model` | string | — | Filter by model name |

**Response:** `200 OK`. A page of fewer than 20 traces is plain JSON:

```json
{
  "traces": [...],
  "total": 142,
  "limit": 10,
  "offset": 0,
  "listProperty": "traces",
  "rowCase": "camel"
}
```

A page of 20 or more (which includes the default `limit`) comes back TOON-encoded to save bandwidth:

```json
{
  "format": "toon",
  "listProperty": "traces",
  "data": "TOON|traceId,timestamp,requestedModel,...\ntr_abc123|2026-10-08T14:02:11.000Z|claude-sonnet-4-5|...\n",
  "total": 142,
  "rowCase": "camel"
}
```

`data` is a header line `TOON|<columns>` followed by one `|`-separated row per trace. In a cell, `\\`, `\|` and `\n` are an escaped backslash, pipe and newline; `-` is null; `t` and `f` are booleans. Cells longer than 120 characters are cut and end in `…`. Decode `data` and place the rows at `body[body.listProperty]`; `toonDecode` in `@intutic/shared-types` does this. To get plain JSON, ask for fewer than 20 rows per page, and use `GET /api/v1/traces/:id` for a full record.

---

### GET /api/v1/traces/:id

Get a single execution trace by ID.

**Auth:** Authenticated

**Response:** `200 OK` — full trace with token counts, costs, compliance scores, anomaly data

**Error codes:** `404` trace not found

---

## SOP Endpoints

### POST /api/v1/sops

Create a new SOP.

**Auth:** Authenticated

**Request body:**

```json
{
  "title": "Code Review Requirements",
  "markdown_content": "## Rules\n\nAll code must have tests...",
  "risk_tier": "MEDIUM",
  "complexity_tier": "TIER_1",
  "version": "1.0.0",
  "dependencies": ["sp_abc123"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | ✅ | 1–256 chars |
| `markdown_content` | string | ✅ | 1–100,000 chars |
| `risk_tier` | enum | ✅ | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `complexity_tier` | enum | ✅ | `TIER_0`, `TIER_1`, `TIER_2` (see below) |
| `version` | string | ❌ | 1–16 chars |
| `dependencies` | string[] | ❌ | SOP IDs this depends on (each up to 64 chars) |

`complexity_tier` is the complexity of the work the SOP governs, from `TIER_0` (simplest) to `TIER_2` (most complex). [Intelligent routing](/guide/intelligent-routing) keeps separate model statistics per tier: the tier of the workspace's most recently created or edited active SOP becomes the tier its requests are routed under, and `TIER_1` applies when there is none.

**Response:** `201 Created` with the SOP

---

### GET /api/v1/sops

List SOPs with pagination and filters. Rows are under `items`.

**Auth:** Authenticated

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (min 1) |
| `limit` | number | `50` | 1–100 |
| `lifecycle_state` | enum | — | Filter by state |
| `risk_tier` | enum | — | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `complexity_tier` | enum | — | `TIER_0`, `TIER_1`, `TIER_2` |
| `all_versions` | boolean | `false` | `true` includes inactive versions; by default only each SOP's active version is listed |

**Lifecycle states:** `DRAFT`, `PENDING_REVIEW`, `GENERATED`, `HYPOTHESIZED`, `REFINED`, `VALIDATED`, `INVALIDATED`

**Response:** `200 OK`

```json
{ "items": [...], "total": 12, "page": 1, "limit": 50, "listProperty": "items", "rowCase": "camel" }
```

---

### GET /api/v1/sops/:sopId

Get SOP detail, with the IDs of the SOPs it depends on.

**Auth:** Authenticated

**Response:** `200 OK` with full SOP object

**Error codes:** `404` SOP not found

---

### PUT /api/v1/sops/:sopId

Update an SOP. A `DRAFT` SOP is updated in place; editing an SOP in any other state creates a new `DRAFT` version and leaves the original as it was.

**Auth:** Authenticated

**Request body:** any of `title`, `markdown_content`, `risk_tier`, `complexity_tier` and `version` (same rules as create; dependencies cannot be changed here), plus:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version_counter` | integer | ❌ | The `versionCounter` you last read. When it no longer matches, someone else saved first and the update is refused with `409` |

**Response:** `200 OK` with `{ "sop": {...}, "antiGaming": {...} }`. `antiGaming` is present when `markdown_content` changed and classifies the change against the SOP's history.

**Error codes:** `404` SOP not found, `409` `CONCURRENCY_CONFLICT`

---

### DELETE /api/v1/sops/:sopId

Soft-delete SOP.

**Auth:** Authenticated

**Response:** `200 OK`

```json
{ "deleted": true }
```

**Error codes:** `404` SOP not found

---

### POST /api/v1/sops/:sopId/transition

Lifecycle state transition.

**Auth:** Authenticated

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
| `acknowledge_uncompiled` | boolean | ❌ | Promote to `VALIDATED` even though the SOP's compiled rule graph is missing or older than its text. Requires `reason` |

**Response:** `200 OK` on success

**Error codes:** `409` transition not allowed (the body says why)

---

### POST /api/v1/sops/:sopId/invalidate

Cascade invalidation — invalidates this SOP and all dependents.

**Auth:** Authenticated

**Response:** `200 OK`

---

### GET /api/v1/sops/:sopId/dependencies

Get SOP dependency graph.

**Auth:** Authenticated

**Response:** `200 OK`

```json
{
  "sop_id": "sp_abc123",
  "dependencies": [...]
}
```

---

### GET /api/v1/sops/:sopId/health

Get SOP health metrics.

**Auth:** Authenticated

**Response:** `200 OK` with health metrics

---

## Usage / FinOps Endpoints

### GET /api/v1/usage/summary

Aggregated usage summary by period.

**Auth:** Authenticated

**Query parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `period` | enum | ✅ | `daily`, `weekly`, `monthly` |
| `start` | ISO 8601 | ✅ | Start date (with offset) |
| `end` | ISO 8601 | ✅ | End date (with offset) |

---

### GET /api/v1/usage/events

Paginated raw execution trace events.

**Auth:** Authenticated

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

**Auth:** Authenticated

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

**Auth:** Authenticated

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

<!-- Written by services/control-plane/scripts/generate-api-catalog.ts. Do not edit by hand: change the route source or api-catalog-annotations.ts and regenerate. -->

## Route Catalog

Every route the control plane serves: 384 routes, grouped by the source file that defines them. The **Auth** column says what a request must carry (see [Authentication](#authentication)). The badge on a section is the plan most of its routes need; a route that needs a different plan carries its own badge.

### `app.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/.well-known/intutic-trace-signing.json` | None | Public key set that verifies signed trace-integrity roots (JWKS) |
| GET | `/healthz` | None | Liveness: `{ status, version, uptime }` |
| GET | `/readyz` | None | Readiness: 200 when Postgres and Valkey answer within 2 seconds, else 503 with `checks` |

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
| POST | `/api/v1/attenuate` | Authenticated | <Badge type="warning" text="Biz Org+" /> Attenuate a parent key into a narrower child key |
| GET | `/api/v1/attenuate/chain/:chainId` | OWNER/ADMIN | Resolve a delegation chain's lineage |
| GET | `/api/v1/attenuate/chains` | OWNER/ADMIN | List recent delegation chains for the workspace |
| POST | `/api/v1/auth/obo-token` | Authenticated | <Badge type="warning" text="Self-serve+" /> Issue an on-behalf-of (OBO) ephemeral session token |

### `audit.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/audit/timeline` | OWNER/ADMIN | Sign-ins, enforcement verdicts, resolved decisions and incidents, settings changes, detector adjudications and MCP server registry decisions for a workspace over a date range. |

### `auth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/change-password` | Authenticated | Change password |
| GET | `/api/v1/auth/key-context` | Authenticated |  |
| POST | `/api/v1/auth/login` | None (email and password) | Login with email/password |
| POST | `/api/v1/auth/logout` | Authenticated | Logout |
| POST | `/api/v1/auth/magic-link/login` | None (one-time link token) | Sign in with a magic-link token |
| POST | `/api/v1/auth/magic-link/request` | None | Email a one-time sign-in link |
| GET | `/api/v1/auth/me` | Authenticated | Get current user info |
| POST | `/api/v1/auth/refresh` | None (refresh token) | Refresh access token |
| POST | `/api/v1/auth/resend-verification` | None | Send the verification email again (2 per minute per address) |
| GET | `/api/v1/auth/session` | Authenticated |  |
| POST | `/api/v1/auth/signup` | None | Self-serve signup with workspace auto-provisioning |
| POST | `/api/v1/auth/signup/org` | None | Sign up and create an organization with its first workspace |
| POST | `/api/v1/auth/verify-email` | None (verification token) | Confirm an email address with the emailed token |

### `billing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/billing/checkout` | OWNER/ADMIN | Buy a plan: a Stripe Checkout session, or the change to an existing subscription |
| GET | `/api/v1/billing/invoices` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/aws/register` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/aws/webhook` | AWS SNS message signature | AWS Marketplace subscription events |
| POST | `/api/v1/billing/marketplace/gcp/register` | Authenticated |  |
| POST | `/api/v1/billing/marketplace/gcp/webhook` | Google-signed OIDC token | Google Cloud Marketplace entitlement events |
| POST | `/api/v1/billing/portal` | OWNER/ADMIN | One-time link to the Stripe billing portal; 404 when the workspace is not billed through Stripe |
| GET | `/api/v1/billing/usage-rate` | Authenticated | This workspace's rate per 1,000 Governed Requests |
| POST | `/api/v1/billing/webhook` | Stripe signature | Stripe webhook |

### `breakGlass.ts` <Badge type="tip" text="Cloud" />

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
| GET | `/api/v1/compliance/frameworks/:frameworkId/coverage` | Authenticated | Coverage of one framework (eu_ai_act, iso_42001, nist_ai_rmf) from the latest probe results; ?format=markdown for the readable report |
| GET | `/api/v1/compliance/human-oversight-export` | OWNER/ADMIN | Signed export of plan decisions, plan deviations and review-hold decisions between from and to (default: the trailing 90 days) |
| GET | `/api/v1/compliance/probes/history` | Authenticated |  |
| GET | `/api/v1/compliance/probes/latest` | Authenticated |  |
| POST | `/api/v1/compliance/probes/run` | OWNER/ADMIN | Run compliance probes now (all, or the `probes` listed) |
| POST | `/api/v1/compliance/soc2-collect` | OWNER/ADMIN |  |
| GET | `/api/v1/compliance/soc2-export/:runId` | OWNER/ADMIN |  |
| GET | `/api/v1/compliance/soc2-status` | Authenticated |  |

### `connectors.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/connectors` | Authenticated | List connectors |
| POST | `/api/v1/connectors` | Authenticated (OWNER/ADMIN for `gdrive`) | Create connector |
| DELETE | `/api/v1/connectors/:connectorId` | Authenticated (OWNER/ADMIN for `gdrive`) | Delete a connector |
| PATCH | `/api/v1/connectors/:connectorId` | Authenticated (OWNER/ADMIN for `gdrive`) | Update a connector |
| POST | `/api/v1/connectors/:connectorId/sync` | Authenticated (OWNER/ADMIN for `gdrive`) | Sync a connector now |
| POST | `/api/v1/connectors/:connectorId/test` | Authenticated (OWNER/ADMIN for `gdrive`) | Probe a memory provider, or a Google Drive source (lists one document with the stored credential) |
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
| POST | `/api/v1/decisions/:entryId/review` | OWNER/ADMIN/EM |  |
| GET | `/api/v1/decisions/analysis` | Authenticated | Aggregated pattern analysis |
| GET | `/api/v1/decisions/approved-bypasses` | Authenticated |  |
| POST | `/api/v1/decisions/substitutions` | Authenticated | Ingest tool calls the proxy rewrote |
| POST | `/api/v1/rule-candidates/:candidateId/bundle` | Authenticated |  |
| POST | `/api/v1/rule-candidates/:candidateId/mocks` | Authenticated |  |
| POST | `/api/v1/rule-candidates/:candidateId/promote` | Authenticated |  |
| GET | `/api/v1/rule-candidates/:candidateId/source` | Authenticated | The candidate's AssemblyScript source of record and its sha256 |
| GET | `/api/v1/workspaces/:workspaceId/hold-candidates` | Authenticated |  |
| GET | `/api/v1/workspaces/:workspaceId/rule-candidates` | Authenticated |  |

### `deployment.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/deployment` | None | Deployment kind (`saas` or `self_host`), the docs address and whether sign-up is open |
| GET | `/api/v1/license` | Authenticated | The Self-host license's status, customer and dates; 404 on Intutic Cloud |
| PUT | `/api/v1/license` | OWNER | Install a license file (`{ license }`); refused unless it verifies against this image |

### `devices.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/devices` | OWNER/ADMIN | list enrolled devices |
| DELETE | `/api/v1/devices/:id` | OWNER/ADMIN | retire a device (soft delete) |
| GET | `/api/v1/devices/:id` | OWNER/ADMIN | one device |
| POST | `/api/v1/devices/report` | Authenticated | report this device (upserts on workspace and fingerprint) |

### `domainVerification.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/domain-verification/:id` | Authenticated |  |
| POST | `/api/v1/domain-verification/start` | Authenticated |  |

### `dreamCycle.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/dream-cycle/queue` | Authenticated |  |
| POST | `/api/v1/dream-cycle/queue/:id/approve` | OWNER/ADMIN |  |
| POST | `/api/v1/dream-cycle/queue/:id/reject` | OWNER/ADMIN |  |
| GET | `/api/v1/dream-cycle/settings` | Authenticated |  |
| PUT | `/api/v1/dream-cycle/settings` | OWNER/ADMIN |  |
| POST | `/api/v1/dream-cycle/trigger` | OWNER/ADMIN |  |

### `enterpriseTrial.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/enterprise/trial/:id/convert` | Admin token (`x-admin-token`) | Sales conversion (internal) |
| POST | `/api/v1/enterprise/trial/start` | OWNER | Start trial (canonical implemented path) |
| GET | `/api/v1/enterprise/trial/status` | Authenticated | Trial status for workspace |
| GET | `/api/v1/enterprise/usage` | Authenticated | Current period usage summary |
| GET | `/api/v1/enterprise/usage/history` | Authenticated | Historical daily meters |

### `evaluate.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/policy/check` | API key (`vk_…`) | Check if a model check is allowed |
| GET | `/api/v1/policy/resolve` | Authenticated | Resolve active rules for workspace |

### `evaluatorSandbox.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/evaluator/sandbox/:runId/deploy` | OWNER/ADMIN |  |
| GET | `/api/v1/evaluator/sandbox/:runId/results` | OWNER/ADMIN |  |
| GET | `/api/v1/evaluator/sandbox/datasets` | OWNER/ADMIN |  |
| POST | `/api/v1/evaluator/sandbox/datasets` | OWNER/ADMIN |  |
| POST | `/api/v1/evaluator/sandbox/run` | OWNER/ADMIN |  |

### `findings.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/findings` | Authenticated | Detector findings; outcome notes on `response_injection:*` findings are shown to OWNER/ADMIN only |
| POST | `/api/v1/findings/:findingId/adjudicate` | Authenticated (OWNER/ADMIN for `response_injection:*` findings) | Rule a finding a true or false positive |
| GET | `/api/v1/findings/:findingId/snippet` | OWNER/ADMIN |  |
| GET | `/api/v1/findings/adjudicated` | Authenticated | Adjudicated findings; outcome notes on `response_injection:*` findings are shown to OWNER/ADMIN only |
| GET | `/api/v1/findings/promotion-status` | Authenticated | Progress of shadow-only detectors toward promotion: adjudications and false-positive rate |
| GET | `/api/v1/findings/response-echo/report` | Authenticated |  |
| GET | `/api/v1/findings/stats` | Authenticated |  |

### `fixEnhance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/fix/enhance` | Authenticated |  |

### `gateLiveness.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/governance/gate-liveness` | OWNER/ADMIN/EM | Per-harness gate status (reporting, silent or new) and whether a silent-gate alert is open |

### `gatewayHeartbeat.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/gateways/:id/config` | Gateway token (`gwk_…`) |  |
| POST | `/api/v1/gateways/:id/heartbeat` | Gateway token (`gwk_…`) |  |

### `gateways.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/gateways` | Authenticated |  |
| POST | `/api/v1/gateways` | OWNER/ADMIN | <Badge type="danger" text="Enterprise" /> |
| DELETE | `/api/v1/gateways/:id` | OWNER/ADMIN |  |
| PATCH | `/api/v1/gateways/:id/config` | OWNER/ADMIN |  |
| POST | `/api/v1/gateways/:id/rotate` | OWNER/ADMIN |  |
| POST | `/api/v1/gateways/:id/self-rotate` | Gateway token (`gwk_…`) |  |
| GET | `/api/v1/gateways/:id/status` | Authenticated |  |
| PATCH | `/api/v1/workspace/gateway` | OWNER/ADMIN |  |
| GET | `/api/v1/workspace/gateway-resolution` | Authenticated |  |

### `governanceCards.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/governance/cards` | Authenticated | Corrective-card labels, newest first (`filter=unlabeled` for the queue) |
| GET | `/api/v1/governance/cards/:cardId` | Authenticated | One card's label state |
| POST | `/api/v1/governance/cards/:cardId/label` | Authenticated | Record a person's ruling on a card; overrides an automatic label |

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
| POST | `/api/v1/skillopt/:suggestionId/revert` | Authenticated | Revert an applied suggestion |
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
| POST | `/api/v1/judge/chunk` | API key (`vk_…`) |  |
| POST | `/api/v1/judge/finalize` | API key (`vk_…`) |  |

### `judgeReviews.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/governance/judge-reviews` | OWNER/ADMIN/EM | Judge responses waiting for a person (`status=PENDING\|VIOLATION\|CLEAN`) |
| POST | `/api/v1/governance/judge-reviews/:reviewId/decide` | OWNER/ADMIN/EM | `{ decision, note? }`: a VIOLATION opens an incident, a CLEAN resolves the interim one |
| GET | `/api/v1/governance/judge-reviews/stats` | OWNER/ADMIN/EM | Rulings per SOP and per stage-1 score bucket |

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
| GET | `/api/v1/loops/reviews` | OWNER/ADMIN/EM |  |
| POST | `/api/v1/loops/start` | Authenticated |  |

### `mcpDaemon.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/mcp-daemon/policy-invalidate` | Authenticated | make every connected daemon re-pull policy now. |
| POST | `/api/v1/mcp-daemon/report` | Authenticated | upload one status snapshot from the MCP daemon, with the workspace API key. A daemon that stops reporting reads as running: false after three missed intervals. |
| GET | `/api/v1/mcp-daemon/status` | Authenticated | the last snapshot; with none, a not-running daemon with empty counters. |

### `mcpServers.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/mcp/servers` | Authenticated | Every MCP server seen, with its status, the tools a proxy last saw it declare and which are disabled, plus the workspace's default policy. |
| POST | `/api/v1/mcp/servers/:serverId/status` | OWNER/ADMIN | Approve, block, or return a server to the approval queue. |
| POST | `/api/v1/mcp/servers/:serverId/tools` | OWNER/ADMIN | Switch one tool within a server on or off. |
| POST | `/api/v1/mcp/servers/observe` | Authenticated | An MCP proxy reports the server it fronts and its tool names; a first sighting creates a candidate and sends mcp.server.candidate. |

### `members.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/members` | Authenticated | List workspace members |
| DELETE | `/api/v1/members/:id` | OWNER/ADMIN | Deactivate a member |
| POST | `/api/v1/members/:id/reactivate` | OWNER/ADMIN |  |
| PUT | `/api/v1/members/:id/role` | OWNER/ADMIN | Update a member's role |
| POST | `/api/v1/members/invite` | OWNER/ADMIN | Invite a new member to the workspace |
| GET | `/api/v1/members/seats` | Authenticated | Active seats and the seat limit (`-1` is unlimited) |

### `metaclaw.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/metaclaw/proposals` | Authenticated |  |
| GET | `/api/v1/metaclaw/runs` | Authenticated |  |
| GET | `/api/v1/metaclaw/runs/:id` | Authenticated |  |
| POST | `/api/v1/metaclaw/trigger` | Authenticated | <Badge type="warning" text="Biz Org+" /> |

### `notifications.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/notifications/log` | Authenticated | Notification history |
| GET | `/api/v1/notifications/rules` | Authenticated | List rules |
| POST | `/api/v1/notifications/rules` | Authenticated | Create rule |
| DELETE | `/api/v1/notifications/rules/:ruleId` | Authenticated | Delete rule |
| PUT | `/api/v1/notifications/rules/:ruleId` | Authenticated | Update rule |
| POST | `/api/v1/notifications/rules/:ruleId/signing-secret` | Authenticated | Replace a webhook rule's signing secret (returned once) |

### `oauth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/auth/methods` | None | Which auth methods are configured |
| GET | `/api/v1/auth/oauth/github` | None | Redirect to GitHub authorize URL |
| GET | `/api/v1/auth/oauth/github/callback` | None (OAuth state) | Handle GitHub callback |
| GET | `/api/v1/auth/oauth/google` | None | Redirect to Google authorize URL |
| GET | `/api/v1/auth/oauth/google/callback` | None (OAuth state) | Handle Google callback |

### `openaiAgentTraces.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/integrations/openai-agents/traces/ingest` | Authenticated | Ingest the OpenAI Agents SDK's trace export; generation spans become usage records, DLP-scanned first |

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
| GET | `/api/v1/policies` | OWNER/ADMIN/EM | List live (non-deleted) policies |
| POST | `/api/v1/policies` | OWNER/ADMIN | Create a policy (records version 1) |
| DELETE | `/api/v1/policies/:policyId` | OWNER/ADMIN | Soft delete (version history is kept for audit) |
| PUT | `/api/v1/policies/:policyId` | OWNER/ADMIN | Partial update; bumps the version and keeps a snapshot |
| POST | `/api/v1/policies/:policyId/disable` | OWNER/ADMIN |  |
| POST | `/api/v1/policies/:policyId/enable` | OWNER/ADMIN |  |
| POST | `/api/v1/policies/:policyId/rollback` | OWNER/ADMIN | Body `{"version": N}`: restores that version as a new one |
| GET | `/api/v1/policies/:policyId/versions` | OWNER/ADMIN/EM | Version history, newest first |

### `policyGuardrails.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/policy-guardrails/conflicts` | OWNER/ADMIN/EM | Pairs of guardrails that cannot describe one policy |
| GET | `/api/v1/policy-guardrails/coverage` | OWNER/ADMIN/EM | Which passages and guardrails cover a token (`token=`) |
| GET | `/api/v1/policy-guardrails/documents` | OWNER/ADMIN/EM | Policy documents in the ledger |
| GET | `/api/v1/policy-guardrails/documents/:docId` | OWNER/ADMIN/EM | One document with its passages, clauses and extraction runs |
| POST | `/api/v1/policy-guardrails/documents/:docId/extract` | OWNER/ADMIN | <Badge type="warning" text="Self-serve+" /> Extract cited guardrail proposals from a document's passages |
| POST | `/api/v1/policy-guardrails/documents/upload` | OWNER/ADMIN | Upload a document with no connector behind it: multipart `file` (+ `title`), Markdown, text or HTML up to 1 MiB, Word or PDF up to 10 MiB |
| GET | `/api/v1/policy-guardrails/duplicates` | OWNER/ADMIN/EM | Overlapping passages and rules cited twice |
| GET | `/api/v1/policy-guardrails/graph` | OWNER/ADMIN/EM | The ledger as nodes and named edges (`docId=` to narrow) |
| GET | `/api/v1/policy-guardrails/guardrails` | OWNER/ADMIN/EM | Guardrails, filterable by `status`, `target` and `docId` |
| GET | `/api/v1/policy-guardrails/guardrails/:guardrailId` | OWNER/ADMIN/EM | One guardrail with its validation checks, cited passage and events |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/approve-shadow` | OWNER/ADMIN | Approve a proposal into shadow |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/promote` | OWNER/ADMIN | Promote to enforcing once the shadow evidence meets the thresholds (`acknowledgeNoTraffic` for a rule that never fired) |
| GET | `/api/v1/policy-guardrails/guardrails/:guardrailId/readiness` | OWNER/ADMIN/EM | How close a guardrail is to the promotion thresholds |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/reconfirm` | OWNER/ADMIN | Clear a stale-source flag after re-reading the passage; refused when the quote is no longer in the document |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/reject` | OWNER/ADMIN | Reject a guardrail (`reason` required) |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/replay` | OWNER/ADMIN/EM | How many captured calls the guardrail would have fired on |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/retire` | OWNER/ADMIN | Retire a guardrail and undo what it wrote |
| GET | `/api/v1/policy-guardrails/impact` | OWNER/ADMIN/EM | What a change to a document or passage reaches (`docId=` or `passageId=`) |
| GET | `/api/v1/policy-guardrails/search` | OWNER/ADMIN/EM | Full-text search over live passages (`q=`) |
| GET | `/api/v1/policy-guardrails/thresholds` | OWNER/ADMIN/EM | The promotion thresholds and the daily extraction cap |

### `providerCredentials.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/workspace/provider-credentials` | Authenticated | provisioning status, every registry provider |
| DELETE | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | de-provision |
| PUT | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | provision/rotate |
| POST | `/api/v1/workspace/provider-credentials/:provider/verify` | OWNER/ADMIN | test the stored credential against the provider's own API |

### `providerIncidents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/provider-incidents` | Authenticated |  |
| POST | `/api/v1/provider-incidents/sla-evidence` | OWNER/ADMIN |  |
| GET | `/api/v1/provider-incidents/sla-evidence/:runId` | OWNER/ADMIN |  |

### `qmSecurityScreen.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/integrations/qm/security-screen` | API key (`vk_…`) |  |

### `routing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/routing/bandit/status` | Authenticated | arm table + convergence summary |
| GET | `/api/v1/routing/cache/stats` | Authenticated | cache counters |
| GET | `/api/v1/routing/mirror-adoption-report` | Authenticated | win/loss/ tie, fault-rate delta, cost delta, latency delta for one mirror candidate |
| GET | `/api/v1/routing/shadow-savings` | Authenticated | shadow-routing cost comparison, grouped by (actual model routed, shadow model) |

### `saml.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/saml/acs` | None (signed SAML assertion) | Assertion Consumer Service |
| GET | `/api/v1/auth/saml/login/:providerId` | None | redirect to the IdP |
| GET | `/api/v1/auth/saml/metadata/:providerId` | None | <Badge type="tip" text="Cloud" /> SP metadata XML for the IdP admin |

### `scim.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/admin/offboarding/retry` | Admin token (`x-admin-token`) | <Badge type="tip" text="Cloud" /> |
| GET | `/scim/v2/Groups` | SCIM token |  |
| POST | `/scim/v2/Groups` | SCIM token |  |
| DELETE | `/scim/v2/Groups/:id` | SCIM token |  |
| GET | `/scim/v2/Groups/:id` | SCIM token |  |
| PATCH | `/scim/v2/Groups/:id` | SCIM token |  |
| PUT | `/scim/v2/Groups/:id` | SCIM token |  |
| GET | `/scim/v2/Users` | SCIM token | List users with filter/pagination |
| POST | `/scim/v2/Users` | SCIM token | Provision new user |
| DELETE | `/scim/v2/Users/:id` | SCIM token | Deprovision (full offboarding cascade) |
| GET | `/scim/v2/Users/:id` | SCIM token | Get single user |
| PATCH | `/scim/v2/Users/:id` | SCIM token | Partial update (e.g., deactivate) |
| PUT | `/scim/v2/Users/:id` | SCIM token |  |

### `scimTokens.ts` <Badge type="tip" text="Cloud" />

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

### `siem.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/siem/destinations` | Authenticated | List destinations (masks credentials) and the source names a destination can filter on |
| POST | `/api/v1/siem/destinations` | OWNER/ADMIN | Create a destination (encrypts credentials) |
| DELETE | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | Deactivate a destination |
| GET | `/api/v1/siem/destinations/:id` | Authenticated | Get destination details (masks credentials) |
| PUT | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | Update destination details |
| POST | `/api/v1/siem/destinations/:id/signing-secret` | OWNER/ADMIN | Replace a webhook destination's signing secret (returned once) |
| POST | `/api/v1/siem/destinations/:id/test` | OWNER/ADMIN | Health-check a destination |
| GET | `/api/v1/siem/dlq` | Authenticated | List DLQ failed events |
| POST | `/api/v1/siem/dlq/retry` | OWNER/ADMIN | Trigger a manual DLQ retry pass |

### `slackCommands.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/commands` | Slack request signature |  |

### `slackEvents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/events` | Slack request signature |  |

### `slackInteractions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/adapters/slack/interactions` | Slack request signature |  |

### `slackOAuth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| DELETE | `/api/v1/adapters/slack` | Authenticated | Remove installation |
| POST | `/api/v1/adapters/slack/link-code` | Authenticated | Issue an account-link code |
| GET | `/api/v1/adapters/slack/oauth/authorize` | Authenticated | Start OAuth (redirect) |
| GET | `/api/v1/adapters/slack/oauth/callback` | None (OAuth state) | OAuth callback |
| GET | `/api/v1/adapters/slack/oauth/url` | Authenticated |  |
| GET | `/api/v1/adapters/slack/status` | Authenticated | Installation status |

### `slashCommand.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/slash-command` | None (a live session id in the named workspace) | Run an `/intutic …` chat command the proxy intercepted; `help` needs no session |

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
| GET | `/api/v1/sops/:sopId/duplicates` | Authenticated | Similarity scores against the workspace's other SOPs |
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

### `sso.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/auth/sso/callback` | None (OIDC state and code) | The OIDC redirect URI: exchange the code, start a session |
| GET | `/api/v1/auth/sso/login/:providerId` | None | Redirect to the identity provider |
| GET | `/api/v1/auth/sso/providers` | OWNER/ADMIN | List SSO providers |
| POST | `/api/v1/auth/sso/providers` | OWNER | Create an OIDC provider |
| DELETE | `/api/v1/auth/sso/providers/:providerId` | OWNER | Delete a provider |

### `sync.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/sync/config` | Authenticated | Push workspace config to daemon |
| GET | `/api/v1/sync/report` | Authenticated |  |
| POST | `/api/v1/sync/sop-hash` | Authenticated | Receive SOP hash integrity report |
| POST | `/api/v1/sync/status` | Authenticated | Record daemon heartbeat |
| GET | `/api/v1/sync/ws` | API key (`?token=vk_…`) |  |

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
| POST | `/api/v1/telemetry/event` | None | Forward a telemetry event |

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
| GET | `/api/v1/trial/status` | Authenticated | trial and plan status for the workspace |
| GET | `/api/v1/trial/tiers` | None | the plans on sale, with prices and features |

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
| GET | `/api/v1/usage/virtual-keys` | Authenticated | Per-virtual-key cost breakdown (Wave 9) |

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
| GET | `/api/v1/workspace/leaderboard` | Authenticated |  |
| GET | `/api/v1/workspace/onboarding-status` | Authenticated |  |
| POST | `/api/v1/workspace/onboarding/complete` | Authenticated |  |
| GET | `/api/v1/workspace/posture` | Authenticated |  |
| POST | `/api/v1/workspace/posture` | OWNER/ADMIN |  |
| GET | `/api/v1/workspace/region` | OWNER/ADMIN | Workspace region and residency enforcement |
| PATCH | `/api/v1/workspace/region` | OWNER | <Badge type="danger" text="Enterprise" /> Set the workspace region and residency enforcement |
| GET | `/api/v1/workspace/settings` | Authenticated | Read workspace settings (resolved with defaults) |
| PUT | `/api/v1/workspace/settings` | OWNER/ADMIN | Update workspace settings (ADMIN+) |
| GET | `/api/v1/workspace/sops-policy` | Authenticated |  |

<!-- GENERATED:ROUTE-CATALOG:END -->

---

## Member Invite Endpoint

### POST /api/v1/members/invite

Provision a new workspace member with a temporary password. The admin must share the credentials out-of-band (Intutic does not send invitation emails).

**Auth:** OWNER or ADMIN

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
  "memberId": "mbr_abc123",
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

---

## Proxy endpoints <Badge type="tip" text="Open-Core" />

The Intutic proxy (default port `4000`, set by `PORT`) serves these besides the provider APIs it governs. It listens on every interface, so the routes marked loopback answer `403` (`{"error": "loopback only"}`) to any caller not on the same machine.

| Method | Path | Access | Returns |
|---|---|---|---|
| POST | `/v1/messages` | Your provider credential or a `vk_` key | Anthropic Messages API, governed |
| POST | `/v1/chat/completions` | Your provider credential or a `vk_` key | OpenAI Chat Completions, governed |
| POST | `/v1/responses` | Your provider credential or a `vk_` key | OpenAI Responses API, governed |
| CONNECT | any host | — | HTTPS tunnel for clients that use the proxy as `HTTPS_PROXY`. AI provider hosts are decrypted and governed; other hosts follow the [egress policy](/reference/configuration#egress-control) |
| GET | `/health` | Open | `{ status, service, version }` |
| GET | `/` | Open | Service name, version and the protocols that work end to end |
| GET | `/intutic/egress` | Open | Egress posture: `{ mode, denied, would_deny }`, where `mode` is `off`, `monitor` or `enforce` and the counts run since the proxy started |
| GET | `/intutic/spend` | Loopback | Today's spend on this machine: `{ local_spend_usd_today, local_cap_usd, enforced }` |
| GET | `/intutic/instance` | Loopback | `{ proxy_instance_id, shared_gateway }`, the id every trace from this process carries |
| GET | `/intutic/probes` | Loopback | The last scheduled guard self-test: `{ probes, total, failed, ran_at }`; `503` before the first run finishes |
| POST | `/intutic/attest-sandbox` | The request's `Authorization` bearer | Called from inside an `intutic exec --sandbox` container, whose firewall lets it reach only the proxy. Forwards `{ "sessionId": "…" }` to the control plane's `PATCH /api/v1/sessions/:sessionId/attest-sandbox` and answers `{ attested }`. `400` without `sessionId`, `401` without a bearer, `503` when no control plane is configured, `502` when it cannot be reached |

`/v1beta/models/:model` (Gemini) is routed but not translated, so Gemini requests do not work through the proxy yet.
