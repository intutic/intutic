# REST API Reference <Badge type="tip" text="Cloud" />

::: warning Control plane required
The REST API endpoints documented below are exposed by the **Intutic Control Plane**: Intutic Cloud, a Self-host deployment, or a local dev stack on port 3001. The local proxy has a few endpoints of its own, listed under [Proxy endpoints](#proxy-endpoints).
:::

The Intutic control plane exposes a RESTful API under `/api/v1/`. Request and response bodies are JSON.

The same routes are published as an OpenAPI 3.1 document, [`openapi.json`](/openapi.json), with the request schemas the handlers validate against and the response schemas they answer with: browse it in the [OpenAPI Reference](/reference/openapi).

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
   - a workspace API key (`vk_…`). A key acts with the role of the member it belongs to, and only within its [scopes](#api-key-scopes).
2. The `__Host-intutic_session` cookie, which the dashboard uses when it signs in with a cookie session.

A request with neither, an expired or revoked token, or a revoked key gets `401`. In the [route catalog](#route-catalog), **Authenticated** means any member's session or API key; `OWNER/ADMIN` and similar name the roles allowed, and every other caller gets `403`. The **Key scope** column says which scopes cover the route for an API key.

`X-Workspace-Id` is optional. When you send it, it must name the workspace the token or key belongs to, or the request is refused with `403` (`Forbidden: workspace context mismatch`).

### API key scopes

A request made with an API key must pass two checks: the key owner's role must allow the route, and the key's scopes must cover it. A dashboard session has no scopes; only its role applies.

- `*`, the default, covers everything the owner's role allows. Keys made before scopes were enforced hold `*`.
- `gateway:use` covers agent traffic: LLM calls through the proxy, hook-gate checks, hook events, trace sync-back, agent sessions, holds, the SOP rules, the policy snapshot and reading the workspace settings. The **Key scope** column marks each route it covers. It is the scope for a key that only runs agents, CI jobs or a proxy, and the dashboard offers it as the automation preset. The proxy refuses LLM traffic from a key without it.
- `<area>:read` covers an area's `GET` routes and `<area>:write` all of them; `write` includes `read`. A few `POST` routes that only compute an answer need `read`.

A request the scopes do not cover gets `403`:

```json
{
  "error": "Forbidden",
  "code": "INSUFFICIENT_SCOPE",
  "detail": "This API key lacks the settings:write scope needed for PUT /api/v1/workspace/settings. Its scopes: settings:read",
  "requiredScopes": ["settings:write"]
}
```

`requiredScopes` lists the scopes that would cover the route, any one of them. Creating or editing a key with a scope not in the table below is refused with `400`, and the message names the valid scopes. A request authenticated with a key cannot give a new key, or an existing one, a scope it does not hold itself. An [attenuated child key](#route-catalog) (`POST /api/v1/attenuate`) can only narrow: each scope it asks for must be granted by its parent and by the key that asks, the parent must be the caller's own key, and the child is held to its parent's scopes on every request, so narrowing a parent narrows its children.

A stored scope outside this table grants nothing. A key holding only such strings, free-form scopes written before scopes were enforced, is refused with `403 INSUFFICIENT_SCOPE` on every route; set its scopes, or replace it.

<!-- GENERATED:KEY-SCOPES:START -->

<!-- Written by services/control-plane/scripts/generate-api-catalog.ts from packages/shared-types/src/apiKeyScopes.ts. Do not edit by hand. -->

| Scope | Grants |
|-------|--------|
| `*` | Everything the key owner's role allows (the default) |
| `gateway:use` | Agent traffic: LLM calls through the proxy, hook-gate checks, hook events, trace sync-back, sessions, holds, SOP rules, the policy snapshot and the workspace settings agents read |
| `traces:read` | Read traces, agent sessions, plans, loop runs, trajectories, agents and the tamper-evident trace chain |
| `traces:write` | Read and change traces, agent sessions, plans, loop runs, trajectories, agents and the tamper-evident trace chain |
| `usage:read` | Read usage, cost and routing analytics, cost prediction and provider incidents |
| `usage:write` | Read and change usage, cost and routing analytics, cost prediction and provider incidents |
| `findings:read` | Read findings, incidents, anomalies, holds and decisions, judge reviews, governance cards, trust scores and break-glass |
| `findings:write` | Read and change findings, incidents, anomalies, holds and decisions, judge reviews, governance cards, trust scores and break-glass |
| `sops:read` | Read SOPs and their lifecycle, skills, the dream cycle, MetaClaw and optimisation suggestions |
| `sops:write` | Read and change SOPs and their lifecycle, skills, the dream cycle, MetaClaw and optimisation suggestions |
| `policies:read` | Read guardrails and policy documents, WASM rules, rule candidates and the evaluator sandbox |
| `policies:write` | Read and change guardrails and policy documents, WASM rules, rule candidates and the evaluator sandbox |
| `compliance:read` | Read compliance coverage, probes and evidence exports, and the audit timeline |
| `compliance:write` | Read and change compliance coverage, probes and evidence exports, and the audit timeline |
| `inventory:read` | Read developer machines, harnesses, MCP servers, self-hosted gateways and governance coverage |
| `inventory:write` | Read and change developer machines, harnesses, MCP servers, self-hosted gateways and governance coverage |
| `settings:read` | Read workspace settings, provider credentials, region, orgs and teams, domains, SSO providers and the license |
| `settings:write` | Read and change workspace settings, provider credentials, region, orgs and teams, domains, SSO providers and the license |
| `members:read` | Read members, invitations, roles, profiles and SCIM tokens |
| `members:write` | Read and change members, invitations, roles, profiles and SCIM tokens |
| `keys:read` | Read API keys, attenuated child keys and on-behalf-of tokens |
| `keys:write` | Read and change API keys, attenuated child keys and on-behalf-of tokens |
| `billing:read` | Read billing, invoices, budgets and trials |
| `billing:write` | Read and change billing, invoices, budgets and trials |
| `siem:read` | Read SIEM destinations and their dead-letter queue, and notification rules |
| `siem:write` | Read and change SIEM destinations and their dead-letter queue, and notification rules |
| `integrations:read` | Read connectors and the GitHub, Slack and task-tracker integrations |
| `integrations:write` | Read and change connectors and the GitHub, Slack and task-tracker integrations |

<!-- GENERATED:KEY-SCOPES:END -->

### Routes that take no session

Some routes skip the session check because their caller cannot have a session, and authenticate inside the handler instead. The **Auth** column names what each one checks:

| Auth | Who calls it |
|---|---|
| None | Probes, the public plan list, sign-up, sign-in starts, telemetry |
| None (*a credential in the request*) | Sign-in steps that carry their own proof: a password, a refresh token, an OAuth state, a signed SAML assertion |
| API key (`vk_…`) | The proxy's judge, policy and command calls, which send the workspace key and are checked in the handler, scope included |
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

Refresh an access token using a refresh token, from the request body or from the `HttpOnly` refresh cookie a browser sign-in sets.

**Auth:** None (public)

**Request body** (API clients; omit it to use the cookie):

```json
{
  "refreshToken": "rt_..."
}
```

Refreshing from the cookie (`__Secure-intutic_refresh`, sent only to `/api/v1/auth/`) requires the `X-Intutic-CSRF` header, any value.

**Response:** `200 OK` with a new access token and new session cookies. The body also carries the new refresh token, except to a request that sent `X-Intutic-CSRF`, which gets it as the cookie only.

**Error codes:** `400` validation, `401` expired, invalid or missing token, `403` cookie refresh without `X-Intutic-CSRF`

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

**Error codes:** `404` E_NOT_FOUND (no account with that address), `409` ALREADY_VERIFIED, `429` over the rate limit (with `Retry-After`)

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

**Error codes:** `404` member not found (a valid token for a member removed since it was issued), as `{ "error": "Member not found", "code": "E_NOT_FOUND", "requestId": ... }`

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

Every route the control plane serves: 408 routes, grouped by the source file that defines them. The **Auth** column says what a request must carry (see [Authentication](#authentication)); the **Key scope** column, which scopes cover it for an API key, any one of them (see [API key scopes](#api-key-scopes)). The badge on a section is the plan most of its routes need; a route that needs a different plan carries its own badge.

### `app.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/.well-known/intutic-trace-signing.json` | None | — | Public key set that verifies signed trace-integrity roots (JWKS) |
| GET | `/healthz` | None | — | Liveness: `{ status, version, uptime }` |
| GET | `/readyz` | None | — | Readiness: 200 when Postgres and Valkey answer within 2 seconds, else 503 with `checks` |

### `agentcoreGateway.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/integrations/agentcore/gateway-check` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` |  |

### `agents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/agents` | Authenticated | `traces:read` | list agents in the workspace |
| GET | `/api/v1/agents/:id` | Authenticated | `traces:read` | one agent, its facets, posture, live sessions |
| POST | `/api/v1/agents/:id/judge-score` | OWNER/ADMIN/EM | `traces:write` |  |
| GET | `/api/v1/agents/graph` | Authenticated | `traces:read` | nodes + edges + posture for the viz |
| POST | `/api/v1/agents/report` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` | daemon upserts an agent + facets (rescored), or reports its machine's AI inventory |

### `anomaly.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/anomalies` | OWNER/ADMIN/EM | `findings:read` | Paginated anomaly list |
| GET | `/api/v1/capability-misses` | OWNER/ADMIN/EM | `findings:read` | Capability miss events |
| POST | `/api/v1/capability-misses` | OWNER/ADMIN/EM/DEVELOPER | `findings:write` |  |
| POST | `/api/v1/capability-misses/:missId/review` | OWNER/ADMIN/EM | `findings:write` |  |

### `attenuate.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/attenuate` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `keys:write` | <Badge type="warning" text="Biz Org+" /> Attenuate a parent key into a narrower child key |
| GET | `/api/v1/attenuate/chain/:chainId` | OWNER/ADMIN | `keys:read` | Resolve a delegation chain's lineage |
| GET | `/api/v1/attenuate/chains` | OWNER/ADMIN | `keys:read` | List recent delegation chains for the workspace |
| POST | `/api/v1/auth/obo-token` | OWNER/ADMIN/EM/DEVELOPER | `keys:write` | <Badge type="warning" text="Self-serve+" /> Issue an on-behalf-of (OBO) ephemeral token |
| POST | `/api/v1/auth/obo-token/verify` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `keys:read` | Verify an OBO token, and that its scope covers a tool |

### `audit.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/audit/timeline` | OWNER/ADMIN | `compliance:read` | Sign-ins, enforcement verdicts, resolved decisions and incidents, settings changes, detector adjudications, MCP server registry decisions, evidence downloads and credential changes for a workspace over a date range. |

### `auth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/auth/change-password` | Authenticated | `members:write` | Change password |
| GET | `/api/v1/auth/key-context` | Authenticated | `gateway:use` |  |
| POST | `/api/v1/auth/login` | None (email and password) | — | Login with email/password |
| POST | `/api/v1/auth/logout` | Authenticated | Any | Logout |
| POST | `/api/v1/auth/magic-link/login` | None (one-time link token) | — | Sign in with a magic-link token |
| POST | `/api/v1/auth/magic-link/request` | None | — | Email a one-time sign-in link |
| GET | `/api/v1/auth/me` | Authenticated | Any | Get current user info |
| POST | `/api/v1/auth/refresh` | None (refresh token in the body, or the refresh cookie with X-Intutic-CSRF) | — | Refresh access token |
| POST | `/api/v1/auth/resend-verification` | None | — | Send the verification email again (2 per minute per address) |
| GET | `/api/v1/auth/session` | Authenticated | Any |  |
| POST | `/api/v1/auth/signup` | None | — | Self-serve signup with workspace auto-provisioning |
| POST | `/api/v1/auth/signup/org` | None | — | Sign up and create an organization with its first workspace |
| GET | `/api/v1/auth/terms` | Authenticated | Any | The caller's standing against the current terms |
| POST | `/api/v1/auth/terms/accept` | Authenticated | Any | Accept the current terms version |
| POST | `/api/v1/auth/verify-email` | None (verification token) | — | Confirm an email address with the emailed token |

### `billing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/billing/checkout` | OWNER/ADMIN | `billing:write` | Buy a plan: a Stripe Checkout session, or the change to an existing subscription |
| GET | `/api/v1/billing/invoices` | Authenticated | `billing:read` |  |
| POST | `/api/v1/billing/marketplace/aws/register` | OWNER/ADMIN | `billing:write` |  |
| POST | `/api/v1/billing/marketplace/aws/webhook` | AWS SNS message signature | — | AWS Marketplace subscription events |
| POST | `/api/v1/billing/marketplace/gcp/register` | OWNER/ADMIN | `billing:write` |  |
| POST | `/api/v1/billing/marketplace/gcp/webhook` | Google-signed OIDC token | — | Google Cloud Marketplace entitlement events |
| POST | `/api/v1/billing/portal` | OWNER/ADMIN | `billing:write` | One-time link to the Stripe billing portal; 404 when the workspace is not billed through Stripe |
| GET | `/api/v1/billing/usage-rate` | Authenticated | `billing:read` | This workspace's rate per 1,000 Governed Requests |
| POST | `/api/v1/billing/webhook` | Stripe signature | — | Stripe webhook |

### `breakGlass.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/break-glass/approve` | OWNER/ADMIN/EM | `findings:write` |  |
| POST | `/api/v1/break-glass/request` | OWNER/ADMIN/EM/DEVELOPER | `findings:write` |  |
| GET | `/api/v1/break-glass/requests` | Authenticated | `findings:read` |  |

### `budget.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/budget` | Authenticated | `billing:read` | Current budget status |
| PUT | `/api/v1/budget` | OWNER/ADMIN | `billing:write` | Update budget settings |
| GET | `/api/v1/budget/alerts` | Authenticated | `billing:read` | Budget alert history |
| POST | `/api/v1/budget/alerts/:alertId/acknowledge` | OWNER/ADMIN/EM | `billing:write` | Acknowledge an alert |
| GET | `/api/v1/budget/keys` | OWNER/ADMIN/EM; anyone else (own keys) | `billing:read` | Each virtual key's budgets, rate limit and spend |
| GET | `/api/v1/budget/members` | OWNER/ADMIN/EM; anyone else (themselves) | `billing:read` | <Badge type="warning" text="Biz Org+" /> Each member's budgets and spend, and the default member budget |
| DELETE | `/api/v1/budget/members/:memberId` | OWNER/ADMIN | `billing:write` | <Badge type="warning" text="Biz Org+" /> Remove a member's budgets, or the default member budget |
| PUT | `/api/v1/budget/members/:memberId` | OWNER/ADMIN | `billing:write` | <Badge type="warning" text="Biz Org+" /> Set a member's budgets, or the default member budget |

### `compliance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/compliance/frameworks/:frameworkId/coverage` | Authenticated | `compliance:read` | Coverage of one framework (eu_ai_act, iso_42001, nist_ai_rmf, mitre_atlas) from the latest probe results; ?format=markdown, csv or pdf for the report as a file, unsigned (the evidence pack seals the signed copies) |
| GET | `/api/v1/compliance/human-oversight-export` | OWNER/ADMIN | `compliance:read` | Export of plan decisions, plan deviations and review-hold decisions between from and to (default: the trailing 90 days), signed when the deployment has a signing key |
| GET | `/api/v1/compliance/probes/history` | Authenticated | `compliance:read` |  |
| GET | `/api/v1/compliance/probes/latest` | Authenticated | `compliance:read` |  |
| POST | `/api/v1/compliance/probes/run` | OWNER/ADMIN | `compliance:write` | Run compliance probes now (all, or the `probes` listed) |
| POST | `/api/v1/compliance/soc2-collect` | OWNER/ADMIN | `compliance:write` |  |
| GET | `/api/v1/compliance/soc2-export/:runId` | OWNER/ADMIN | `compliance:read` |  |
| GET | `/api/v1/compliance/soc2-status` | Authenticated | `compliance:read` |  |

### `connectors.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/connectors` | Authenticated | `integrations:read` | List connectors |
| POST | `/api/v1/connectors` | OWNER/ADMIN | `integrations:write` | Create connector |
| DELETE | `/api/v1/connectors/:connectorId` | OWNER/ADMIN | `integrations:write` | Delete a connector |
| PATCH | `/api/v1/connectors/:connectorId` | OWNER/ADMIN | `integrations:write` | Update a connector |
| POST | `/api/v1/connectors/:connectorId/sync` | OWNER/ADMIN | `integrations:write` | Sync a connector now |
| POST | `/api/v1/connectors/:connectorId/test` | OWNER/ADMIN | `integrations:write` | Probe a memory provider, or a Google Drive source (lists one document with the stored credential) |
| DELETE | `/api/v1/connectors/virustotal` | OWNER/ADMIN | `integrations:write` | Remove the stored VT API key (OWNER/ADMIN) |
| GET | `/api/v1/connectors/virustotal` | OWNER/ADMIN | `integrations:read` | Read masked VT credential status (OWNER/ADMIN) |
| POST | `/api/v1/connectors/virustotal` | OWNER/ADMIN | `integrations:write` | Upsert the workspace's VT API key (OWNER/ADMIN) |
| GET | `/api/v1/connectors/virustotal/budget` | OWNER/ADMIN | `integrations:read` | Today's lookup budget usage (OWNER/ADMIN) |
| POST | `/api/v1/connectors/virustotal/test` | OWNER/ADMIN | `integrations:write` | Validate the stored key against a benign hash (OWNER/ADMIN) |

### `decisions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/decisions` | Authenticated | `gateway:use` or `findings:read` | List decisions (paginated) |
| POST | `/api/v1/decisions` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `findings:write` | Ingest review holds from the daemon |
| GET | `/api/v1/decisions/:entryId` | Authenticated | `gateway:use` or `findings:read` | Get decision detail |
| POST | `/api/v1/decisions/:entryId/review` | OWNER/ADMIN/EM | `findings:write` |  |
| GET | `/api/v1/decisions/analysis` | Authenticated | `findings:read` | Aggregated pattern analysis |
| GET | `/api/v1/decisions/approved-bypasses` | Authenticated | `gateway:use` or `findings:read` |  |
| POST | `/api/v1/decisions/substitutions` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `findings:write` | Ingest tool calls the proxy rewrote |
| POST | `/api/v1/rule-candidates/:candidateId/bundle` | OWNER/ADMIN | `policies:write` |  |
| POST | `/api/v1/rule-candidates/:candidateId/mocks` | OWNER/ADMIN | `policies:write` |  |
| POST | `/api/v1/rule-candidates/:candidateId/promote` | OWNER/ADMIN | `policies:write` |  |
| GET | `/api/v1/rule-candidates/:candidateId/source` | Authenticated | `policies:read` | The candidate's AssemblyScript source of record and its sha256 |
| GET | `/api/v1/workspaces/:workspaceId/hold-candidates` | Authenticated | `findings:read` |  |
| GET | `/api/v1/workspaces/:workspaceId/rule-candidates` | Authenticated | `policies:read` |  |

### `deployment.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/deployment` | None | — | Deployment kind (`saas` or `self_host`), the docs address and whether sign-up is open |
| GET | `/api/v1/license` | Authenticated | `settings:read` | The Self-host license's status, customer and dates; 404 on Intutic Cloud |
| PUT | `/api/v1/license` | OWNER | `settings:write` | Install a license file (`{ license }`); refused unless it verifies against this image |

### `devices.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/devices` | OWNER/ADMIN | `inventory:read` | list enrolled devices |
| DELETE | `/api/v1/devices/:id` | OWNER/ADMIN | `inventory:write` | retire a device (soft delete) |
| GET | `/api/v1/devices/:id` | OWNER/ADMIN | `inventory:read` | one device |
| POST | `/api/v1/devices/disconnect` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | report that intutic disconnect ran on this device |
| POST | `/api/v1/devices/report` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | report this device (upserts on workspace and fingerprint) |

### `domainVerification.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/domain-verification/:id` | Authenticated | `settings:read` |  |
| POST | `/api/v1/domain-verification/start` | Authenticated | `settings:write` |  |

### `dreamCycle.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/dream-cycle/queue` | Authenticated | `sops:read` |  |
| POST | `/api/v1/dream-cycle/queue/:id/approve` | OWNER/ADMIN | `sops:write` |  |
| POST | `/api/v1/dream-cycle/queue/:id/reject` | OWNER/ADMIN | `sops:write` |  |
| GET | `/api/v1/dream-cycle/settings` | Authenticated | `sops:read` |  |
| PUT | `/api/v1/dream-cycle/settings` | OWNER/ADMIN | `sops:write` |  |
| POST | `/api/v1/dream-cycle/trigger` | OWNER/ADMIN | `sops:write` |  |

### `emailUnsubscribe.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/email/unsubscribe` | Signed unsubscribe token (`token` query) | — | The confirmation page behind the unsubscribe link in promotional email; records nothing |
| POST | `/api/v1/email/unsubscribe` | Signed unsubscribe token (`token` query) | — | Records the opt-out from promotional email: the confirmation page, or a mail client's one-click request (RFC 8058) |

### `enterpriseTrial.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/enterprise/trial/:id/convert` | Admin token (`x-admin-token`) | — | Sales conversion (internal) |
| POST | `/api/v1/enterprise/trial/start` | OWNER | `billing:write` | Start trial (canonical implemented path) |
| GET | `/api/v1/enterprise/trial/status` | Authenticated | `billing:read` | Trial status for workspace |
| GET | `/api/v1/enterprise/usage` | Authenticated | `usage:read` | Current period usage summary |
| GET | `/api/v1/enterprise/usage/history` | Authenticated | `usage:read` | Historical daily meters |

### `evaluate.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/policy/check` | API key (`vk_…`) | `gateway:use` | Check if a model check is allowed |
| GET | `/api/v1/policy/resolve` | Authenticated | `gateway:use` or `policies:read` | Resolve active rules for workspace |

### `evaluatorSandbox.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/evaluator/sandbox/:runId/deploy` | OWNER/ADMIN | `policies:write` |  |
| GET | `/api/v1/evaluator/sandbox/:runId/results` | OWNER/ADMIN | `policies:read` |  |
| GET | `/api/v1/evaluator/sandbox/datasets` | OWNER/ADMIN | `policies:read` |  |
| POST | `/api/v1/evaluator/sandbox/datasets` | OWNER/ADMIN | `policies:write` |  |
| POST | `/api/v1/evaluator/sandbox/run` | OWNER/ADMIN | `policies:write` |  |

### `findings.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/findings` | Authenticated | `findings:read` | Detector findings; outcome notes on `response_injection:*` findings are shown to OWNER/ADMIN only |
| POST | `/api/v1/findings/:findingId/adjudicate` | OWNER/ADMIN/EM (OWNER/ADMIN for `response_injection:*` findings) | `findings:write` | Rule a finding a true or false positive |
| GET | `/api/v1/findings/:findingId/snippet` | OWNER/ADMIN | `findings:read` |  |
| GET | `/api/v1/findings/adjudicated` | Authenticated | `findings:read` | Adjudicated findings; outcome notes on `response_injection:*` findings are shown to OWNER/ADMIN only |
| GET | `/api/v1/findings/promotion-status` | Authenticated | `findings:read` | Progress of shadow-only detectors toward promotion: adjudications and false-positive rate |
| GET | `/api/v1/findings/response-echo/report` | Authenticated | `findings:read` |  |
| GET | `/api/v1/findings/stats` | Authenticated | `findings:read` |  |

### `fixEnhance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/fix/enhance` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` |  |

### `gateLiveness.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/governance/gate-liveness` | OWNER/ADMIN/EM | `inventory:read` | Per-harness gate status (reporting, silent or new) and whether a silent-gate alert is open |

### `gatewayHeartbeat.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/gateways/:id/config` | Gateway token (`gwk_…`, its own gateway); Authenticated (a member of its org) | — | The gateway's config and its version |
| POST | `/api/v1/gateways/:id/heartbeat` | Gateway token (`gwk_…`) | — |  |

### `gateways.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/gateways` | Authenticated | `inventory:read` |  |
| POST | `/api/v1/gateways` | OWNER/ADMIN | `inventory:write` | <Badge type="danger" text="Enterprise" /> |
| DELETE | `/api/v1/gateways/:id` | OWNER/ADMIN | `inventory:write` |  |
| PATCH | `/api/v1/gateways/:id/config` | OWNER/ADMIN | `inventory:write` | <Badge type="danger" text="Enterprise" /> |
| POST | `/api/v1/gateways/:id/rotate` | OWNER/ADMIN | `inventory:write` |  |
| POST | `/api/v1/gateways/:id/self-rotate` | Gateway token (`gwk_…`) | — |  |
| GET | `/api/v1/gateways/:id/status` | Authenticated | `inventory:read` |  |
| PATCH | `/api/v1/workspace/gateway` | OWNER/ADMIN | `settings:write` |  |
| GET | `/api/v1/workspace/gateway-resolution` | Authenticated | `settings:read` |  |

### `githubWebhooks.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/integrations/github/webhook` | OWNER/ADMIN | `integrations:read` | The webhook's payload URL and when its secret was made |
| POST | `/api/v1/integrations/github/webhook/secret` | OWNER/ADMIN | `integrations:write` | Make the webhook, or replace its secret; the secret is returned once |
| POST | `/api/v1/webhooks/github/:hookId` | GitHub signature (`X-Hub-Signature-256`) | — | Receives GitHub pull_request events, signed with the workspace's secret |

### `governanceCards.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/governance/cards` | Authenticated | `findings:read` | Corrective-card labels, newest first (`filter=unlabeled` for the queue) |
| GET | `/api/v1/governance/cards/:cardId` | Authenticated | `findings:read` | One card's label state |
| POST | `/api/v1/governance/cards/:cardId/label` | OWNER/ADMIN/EM | `findings:write` | Record a person's ruling on a card; overrides an automatic label |

### `governanceCoverage.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/governance-coverage` | Authenticated | `inventory:read` |  |
| GET | `/api/v1/governance-coverage/:harnessType` | Authenticated | `inventory:read` |  |
| POST | `/api/v1/governance-coverage/snapshot` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` |  |

### `harnessConfig.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/config/capture` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | Capture config snapshot |
| POST | `/api/v1/skillopt/:suggestionId/apply` | OWNER/ADMIN | `sops:write` |  |
| POST | `/api/v1/skillopt/:suggestionId/apply-result` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `sops:write` | Sync daemon's ack of an apply attempt |
| POST | `/api/v1/skillopt/:suggestionId/dismiss` | OWNER/ADMIN/EM | `sops:write` |  |
| POST | `/api/v1/skillopt/:suggestionId/revert` | OWNER/ADMIN | `sops:write` | Revert an applied suggestion |
| GET | `/api/v1/workspaces/:workspaceId/config-snapshots` | Authenticated | `sops:read` |  |
| GET | `/api/v1/workspaces/:workspaceId/config-snapshots/:snapshotId/diff` | OWNER/ADMIN/EM | `sops:read` |  |
| GET | `/api/v1/workspaces/:workspaceId/skillopt-suggestions` | Authenticated | `sops:read` |  |
| POST | `/api/v1/workspaces/:workspaceId/skillopt/generate` | OWNER/ADMIN | `sops:write` |  |
| GET | `/api/v1/workspaces/:workspaceId/skills/report` | Authenticated | `sops:read` |  |
| POST | `/api/v1/workspaces/:workspaceId/skills/report` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `sops:write` |  |

### `hookEvents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/hook-events` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` |  |
| POST | `/api/v1/hook-gate` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` |  |

### `incidents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/incidents` | OWNER/ADMIN/EM | `gateway:use` or `findings:read` | Paginated incident list |
| GET | `/api/v1/incidents/:id` | OWNER/ADMIN/EM | `findings:read` | Single incident detail |
| POST | `/api/v1/incidents/:id/resolve` | OWNER/ADMIN/EM | `findings:write` | Resolve an incident |

### `integrity.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/integrity/chain` | Authenticated | `traces:read` |  |
| GET | `/api/v1/integrity/config-chain` | Authenticated | `traces:read` |  |
| GET | `/api/v1/integrity/roots` | Authenticated | `traces:read` |  |
| GET | `/api/v1/integrity/roots/:rootId` | Authenticated | `traces:read` |  |
| GET | `/api/v1/integrity/roots/:rootId/proof/:traceId` | Authenticated | `traces:read` |  |
| POST | `/api/v1/integrity/roots/:rootId/recompute` | Authenticated | `traces:read` |  |
| GET | `/api/v1/integrity/traces/:traceId/leaf` | Authenticated | `traces:read` |  |

### `intelligence.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/predict-cost` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `usage:read` | Cost prediction |
| POST | `/api/v1/recommendations/:recommendationId/apply` | OWNER/ADMIN/EM | `findings:write` |  |
| POST | `/api/v1/recommendations/:recommendationId/dismiss` | OWNER/ADMIN/EM | `findings:write` |  |
| GET | `/api/v1/traces/:traceId/token-breakdown` | Authenticated | `traces:read` | Per-tool token breakdown |
| GET | `/api/v1/workspaces/:workspaceId/optimization-recommendations` | Authenticated | `sops:read` |  |
| GET | `/api/v1/workspaces/:workspaceId/waste-patterns` | Authenticated | `usage:read` |  |

### `inventory.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/inventory/devices` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | One row per machine with its counts, last report and guard-probe result |
| GET | `/api/v1/inventory/disconnects` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | Machines that ran intutic disconnect, newest first: hostname, scope, harnesses, who and when |
| GET | `/api/v1/inventory/harnesses` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | Harnesses by machine with gate state and status; filter by status, harness, device and q, or download with format=csv |
| GET | `/api/v1/inventory/mcp-servers` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | MCP servers by machine, wrapped by the MCP proxy or not; the same filters and CSV download |
| GET | `/api/v1/inventory/skills` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | Skill bundles by machine, by name, source and hash; filter by device and q |
| GET | `/api/v1/inventory/summary` | OWNER/ADMIN/EM; DEVELOPER (own machines) | `inventory:read` | Counts: machines, stale machines, harnesses, governed percentage, ungoverned harnesses and MCP servers, skills |

### `judge.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/judge/chunk` | API key (`vk_…`) | `gateway:use` |  |
| POST | `/api/v1/judge/finalize` | API key (`vk_…`) | `gateway:use` |  |

### `judgeReviews.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/governance/judge-reviews` | OWNER/ADMIN/EM | `findings:read` | Judge responses waiting for a person (`status=PENDING\|VIOLATION\|CLEAN`) |
| POST | `/api/v1/governance/judge-reviews/:reviewId/decide` | OWNER/ADMIN/EM | `findings:write` | `{ decision, note? }`: a VIOLATION opens an incident, a CLEAN resolves the interim one |
| GET | `/api/v1/governance/judge-reviews/stats` | OWNER/ADMIN/EM | `findings:read` | Rulings per SOP and per stage-1 score bucket |

### `keys.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/keys` | Authenticated | `keys:read` | List API keys for the workspace |
| POST | `/api/v1/keys` | Authenticated | `keys:write` | Create a new API key |
| DELETE | `/api/v1/keys/:id` | Authenticated | `keys:write` | Revoke an API key |
| PATCH | `/api/v1/keys/:id` | OWNER/ADMIN | `keys:write` | Set a key's spend budgets, rate limit and scopes |

### `loops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/loops` | Authenticated | `traces:read` |  |
| GET | `/api/v1/loops/:loopRunId` | Authenticated | `gateway:use` or `traces:read` |  |
| POST | `/api/v1/loops/:loopRunId/complete` | OWNER/ADMIN/EM; DEVELOPER (own run) | `gateway:use` or `traces:write` |  |
| GET | `/api/v1/loops/:loopRunId/duplicates` | Authenticated | `traces:read` |  |
| POST | `/api/v1/loops/:loopRunId/kill` | OWNER/ADMIN/EM; DEVELOPER (own run) | `gateway:use` or `traces:write` |  |
| POST | `/api/v1/loops/:loopRunId/review` | OWNER/ADMIN/EM | `traces:write` |  |
| POST | `/api/v1/loops/:loopRunId/verify` | OWNER/ADMIN/EM; DEVELOPER (own run) | `gateway:use` or `traces:write` |  |
| GET | `/api/v1/loops/reviews` | OWNER/ADMIN/EM | `traces:read` |  |
| POST | `/api/v1/loops/start` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` |  |

### `mcpDaemon.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/mcp-daemon/policy-invalidate` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | make every connected daemon re-pull policy now. |
| POST | `/api/v1/mcp-daemon/report` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | upload one status snapshot from the MCP daemon, with the workspace API key. A daemon that stops reporting reads as running: false after three missed intervals. |
| GET | `/api/v1/mcp-daemon/status` | Authenticated | `gateway:use` or `inventory:read` | the last snapshot; with none, a not-running daemon with empty counters. |

### `mcpServers.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/mcp/servers` | Authenticated | `gateway:use` or `inventory:read` | Every MCP server seen, with its status, the tools a proxy last saw it declare and which are disabled, the latest scored change to its tool set, plus the workspace's default policy, its high-risk tool-change setting and its MCP call budgets. |
| POST | `/api/v1/mcp/servers/:serverId/status` | OWNER/ADMIN | `inventory:write` | Approve, block, or return a server to the approval queue. |
| POST | `/api/v1/mcp/servers/:serverId/tools` | OWNER/ADMIN | `inventory:write` | Switch one tool within a server on or off. |
| POST | `/api/v1/mcp/servers/observe` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | An MCP proxy reports the server it fronts, its tool names and their definitions; a first sighting creates a candidate and sends mcp.server.candidate, and changed definitions are scored for risk and recorded. |

### `members.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/members` | Authenticated | `members:read` | List workspace members |
| DELETE | `/api/v1/members/:id` | OWNER/ADMIN | `members:write` | Deactivate a member |
| POST | `/api/v1/members/:id/reactivate` | OWNER/ADMIN | `members:write` |  |
| PUT | `/api/v1/members/:id/role` | OWNER/ADMIN | `members:write` | Update a member's role |
| POST | `/api/v1/members/invite` | OWNER/ADMIN | `members:write` | Invite a new member to the workspace |
| GET | `/api/v1/members/seats` | Authenticated | `members:read` | Active seats and the seat limit (`-1` is unlimited) |

### `metaclaw.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/metaclaw/proposals` | Authenticated | `sops:read` |  |
| GET | `/api/v1/metaclaw/runs` | Authenticated | `sops:read` |  |
| GET | `/api/v1/metaclaw/runs/:id` | Authenticated | `sops:read` |  |
| POST | `/api/v1/metaclaw/trigger` | OWNER/ADMIN | `sops:write` | <Badge type="warning" text="Biz Org+" /> |

### `notifications.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/notifications/log` | Authenticated | `siem:read` | Notification history |
| GET | `/api/v1/notifications/rules` | Authenticated | `siem:read` | List rules |
| POST | `/api/v1/notifications/rules` | OWNER/ADMIN | `siem:write` | Create rule |
| DELETE | `/api/v1/notifications/rules/:ruleId` | OWNER/ADMIN | `siem:write` | Delete rule |
| PUT | `/api/v1/notifications/rules/:ruleId` | OWNER/ADMIN | `siem:write` | Update rule |
| POST | `/api/v1/notifications/rules/:ruleId/signing-secret` | OWNER/ADMIN | `siem:write` | Replace a webhook rule's signing secret (returned once) |

### `oauth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/auth/methods` | None | — | Which auth methods are configured |
| GET | `/api/v1/auth/oauth/github` | None | — | Redirect to GitHub authorize URL |
| GET | `/api/v1/auth/oauth/github/callback` | None (OAuth state) | — | Handle GitHub callback |
| GET | `/api/v1/auth/oauth/google` | None | — | Redirect to Google authorize URL |
| GET | `/api/v1/auth/oauth/google/callback` | None (OAuth state) | — | Handle Google callback |

### `openaiAgentTraces.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/integrations/openai-agents/traces/ingest` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` | Ingest the OpenAI Agents SDK's trace export; generation spans become usage records, DLP-scanned first |

### `orgs.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/orgs` | Authenticated | `settings:write` |  |
| POST | `/api/v1/orgs/:orgId/billing/checkout` | Authenticated | `billing:write` |  |
| PATCH | `/api/v1/orgs/:orgId/gateway` | Authenticated | `settings:write` |  |
| GET | `/api/v1/orgs/regions` | Authenticated | `settings:read` |  |

### `orgSops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/workspace/org-sops` | Authenticated | `sops:read` |  |
| POST | `/api/v1/workspace/org-sops` | Authenticated | `sops:write` |  |
| DELETE | `/api/v1/workspace/org-sops/:orgSopId` | Authenticated | `sops:write` |  |

### `plans.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/plans/:planId` | Authenticated | `traces:read` | Get plan details |
| GET | `/api/v1/plans/:planId/adherence` | Authenticated | `traces:read` | Get adherence score |
| POST | `/api/v1/plans/:planId/approve` | OWNER/ADMIN/EM | `traces:write` | Approve plan (OWNER/ADMIN/EM) |
| POST | `/api/v1/plans/:planId/close` | OWNER/ADMIN/EM | `traces:write` | Close plan with a final outcome (OWNER/ADMIN/EM) |
| GET | `/api/v1/plans/:planId/deviation` | Authenticated | `traces:read` | Get deviation log |
| POST | `/api/v1/plans/:planId/reject` | OWNER/ADMIN/EM | `traces:write` | Reject plan before it executes (OWNER/ADMIN/EM) |
| POST | `/api/v1/plans/capture` | OWNER/ADMIN/EM/DEVELOPER | `traces:write` | Capture a plan artifact |
| GET | `/api/v1/plans/session/:sessionId` | Authenticated | `traces:read` |  |
| GET | `/api/v1/sops/:sopId/proof-tree` | Authenticated | `sops:read` | Get latest proof tree |
| POST | `/api/v1/sops/:sopId/proof-tree` | OWNER/ADMIN | `sops:write` | Create/update proof tree |
| GET | `/api/v1/sops/:sopId/proof-tree/diff` | Authenticated | `sops:read` | Diff proof tree versions |

### `policyGuardrails.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/policy-guardrails/conflicts` | OWNER/ADMIN/EM | `policies:read` | Pairs of guardrails that cannot describe one policy |
| GET | `/api/v1/policy-guardrails/coverage` | OWNER/ADMIN/EM | `policies:read` | Which passages and guardrails cover a token (`token=`) |
| GET | `/api/v1/policy-guardrails/documents` | OWNER/ADMIN/EM | `policies:read` | Policy documents in the ledger |
| GET | `/api/v1/policy-guardrails/documents/:docId` | OWNER/ADMIN/EM | `policies:read` | One document with its passages, clauses and extraction runs |
| POST | `/api/v1/policy-guardrails/documents/:docId/extract` | OWNER/ADMIN | `policies:write` | <Badge type="warning" text="Self-serve+" /> Extract cited guardrail proposals from a document's passages |
| POST | `/api/v1/policy-guardrails/documents/upload` | OWNER/ADMIN | `policies:write` | Upload a document with no connector behind it: multipart `file` (+ `title`), Markdown, text or HTML up to 1 MiB, Word or PDF up to 10 MiB |
| GET | `/api/v1/policy-guardrails/duplicates` | OWNER/ADMIN/EM | `policies:read` | Overlapping passages and rules cited twice |
| GET | `/api/v1/policy-guardrails/graph` | OWNER/ADMIN/EM | `policies:read` | The ledger as nodes and named edges (`docId=` to narrow) |
| GET | `/api/v1/policy-guardrails/guardrails` | OWNER/ADMIN/EM | `policies:read` | Guardrails, filterable by `status`, `target`, `provenance` (`extracted` or `authored`) and `docId` |
| POST | `/api/v1/policy-guardrails/guardrails` | OWNER/ADMIN | `policies:write` | Author a guardrail directly (`name`, `description`, `ir`): the same IR and validator as an extracted one; created PROPOSED |
| DELETE | `/api/v1/policy-guardrails/guardrails/:guardrailId` | OWNER/ADMIN | `policies:write` | Retire an authored guardrail and undo what it wrote; its history is kept |
| GET | `/api/v1/policy-guardrails/guardrails/:guardrailId` | OWNER/ADMIN/EM | `policies:read` | One guardrail with its validation checks, cited passage (none for an authored guardrail), events and `supersededBy` |
| PUT | `/api/v1/policy-guardrails/guardrails/:guardrailId` | OWNER/ADMIN | `policies:write` | Edit an authored guardrail: a name or description in place; a changed `ir` creates the next version, PROPOSED, and retires this one |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/approve-shadow` | OWNER/ADMIN | `policies:write` | Approve a proposal into shadow |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/promote` | OWNER/ADMIN | `policies:write` | Promote to enforcing once the shadow evidence meets the thresholds (`acknowledgeNoTraffic` for a rule that never fired) |
| GET | `/api/v1/policy-guardrails/guardrails/:guardrailId/readiness` | OWNER/ADMIN/EM | `policies:read` | How close a guardrail is to the promotion thresholds |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/reconfirm` | OWNER/ADMIN | `policies:write` | Clear a stale-source flag after re-reading the passage; refused when the quote is no longer in the document |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/reject` | OWNER/ADMIN | `policies:write` | Reject a guardrail (`reason` required) |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/replay` | OWNER/ADMIN/EM | `policies:write` | How many captured calls the guardrail would have fired on |
| POST | `/api/v1/policy-guardrails/guardrails/:guardrailId/retire` | OWNER/ADMIN | `policies:write` | Retire a guardrail and undo what it wrote |
| POST | `/api/v1/policy-guardrails/guardrails/validate` | OWNER/ADMIN/EM | `policies:read` | Run the authored-guardrail checks on `name`, `description` and `ir` without writing anything |
| GET | `/api/v1/policy-guardrails/impact` | OWNER/ADMIN/EM | `policies:read` | What a change to a document or passage reaches (`docId=` or `passageId=`) |
| GET | `/api/v1/policy-guardrails/search` | OWNER/ADMIN/EM | `policies:read` | Full-text search over live passages (`q=`) |
| GET | `/api/v1/policy-guardrails/thresholds` | OWNER/ADMIN/EM | `policies:read` | The promotion thresholds and the daily extraction cap |

### `providerCredentials.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/workspace/provider-credentials` | Authenticated | `settings:read` | provisioning status, every registry provider |
| DELETE | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | `settings:write` | de-provision |
| PUT | `/api/v1/workspace/provider-credentials/:provider` | OWNER/ADMIN | `settings:write` | provision/rotate |
| GET | `/api/v1/workspace/provider-credentials/:provider/models` | Authenticated | `settings:read` | the models the provider listed the last time the credential verified as valid |
| POST | `/api/v1/workspace/provider-credentials/:provider/verify` | OWNER/ADMIN | `settings:write` | test the stored credential against the provider's own API |

### `providerIncidents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/provider-incidents` | Authenticated | `usage:read` |  |
| POST | `/api/v1/provider-incidents/sla-evidence` | OWNER/ADMIN | `compliance:write` |  |
| GET | `/api/v1/provider-incidents/sla-evidence/:runId` | OWNER/ADMIN | `compliance:read` |  |

### `qmSecurityScreen.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/integrations/qm/security-screen` | API key (`vk_…`) | `gateway:use` |  |

### `routing.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/routing/bandit/status` | Authenticated | `usage:read` | arm table + convergence summary |
| GET | `/api/v1/routing/cache/stats` | Authenticated | `usage:read` | cache counters |
| GET | `/api/v1/routing/mirror-adoption-report` | Authenticated | `usage:read` | win/loss/ tie, fault-rate delta, cost delta, latency delta for one mirror candidate |
| GET | `/api/v1/routing/shadow-savings` | Authenticated | `usage:read` | shadow-routing cost comparison, grouped by (actual model routed, shadow model) |

### `saml.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/auth/saml/acs` | None (signed SAML assertion) | — | Assertion Consumer Service |
| GET | `/api/v1/auth/saml/login/:providerId` | None | — | redirect to the IdP |
| GET | `/api/v1/auth/saml/metadata/:providerId` | None | — | <Badge type="tip" text="Cloud" /> SP metadata XML for the IdP admin |

### `scim.ts` <Badge type="danger" text="Enterprise" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/admin/offboarding/retry` | Admin token (`x-admin-token`) | — | <Badge type="tip" text="Cloud" /> |
| GET | `/scim/v2/Groups` | SCIM token | — |  |
| POST | `/scim/v2/Groups` | SCIM token | — |  |
| DELETE | `/scim/v2/Groups/:id` | SCIM token | — |  |
| GET | `/scim/v2/Groups/:id` | SCIM token | — |  |
| PATCH | `/scim/v2/Groups/:id` | SCIM token | — |  |
| PUT | `/scim/v2/Groups/:id` | SCIM token | — |  |
| GET | `/scim/v2/Users` | SCIM token | — | List users with filter/pagination |
| POST | `/scim/v2/Users` | SCIM token | — | Provision new user |
| DELETE | `/scim/v2/Users/:id` | SCIM token | — | Deprovision (full offboarding cascade) |
| GET | `/scim/v2/Users/:id` | SCIM token | — | Get single user |
| PATCH | `/scim/v2/Users/:id` | SCIM token | — | Partial update (e.g., deactivate) |
| PUT | `/scim/v2/Users/:id` | SCIM token | — |  |

### `scimTokens.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/scim/tokens` | OWNER/ADMIN | `members:read` |  |
| POST | `/api/v1/scim/tokens` | OWNER/ADMIN | `members:write` | <Badge type="danger" text="Enterprise" /> |
| DELETE | `/api/v1/scim/tokens/:id` | OWNER/ADMIN | `members:write` |  |

### `sessions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/sessions` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` |  |
| GET | `/api/v1/sessions/:sessionId` | Authenticated | `traces:read` |  |
| PATCH | `/api/v1/sessions/:sessionId/attest-sandbox` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` |  |
| PATCH | `/api/v1/sessions/:sessionId/end` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` |  |

### `siem.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/siem/destinations` | Authenticated | `siem:read` | List destinations (masks credentials) and the source names a destination can filter on |
| POST | `/api/v1/siem/destinations` | OWNER/ADMIN | `siem:write` | <Badge type="warning" text="Biz Org+" /> Create a destination (encrypts credentials) |
| DELETE | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | `siem:write` | Deactivate a destination |
| GET | `/api/v1/siem/destinations/:id` | Authenticated | `siem:read` | Get destination details (masks credentials) |
| PUT | `/api/v1/siem/destinations/:id` | OWNER/ADMIN | `siem:write` | <Badge type="warning" text="Biz Org+" /> Update destination details |
| POST | `/api/v1/siem/destinations/:id/signing-secret` | OWNER/ADMIN | `siem:write` | <Badge type="warning" text="Biz Org+" /> Replace a webhook destination's signing secret (returned once) |
| POST | `/api/v1/siem/destinations/:id/test` | OWNER/ADMIN | `siem:write` | <Badge type="warning" text="Biz Org+" /> Health-check a destination |
| GET | `/api/v1/siem/dlq` | Authenticated | `siem:read` | List DLQ failed events |
| POST | `/api/v1/siem/dlq/retry` | OWNER/ADMIN | `siem:write` | Trigger a manual DLQ retry pass |

### `slackCommands.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/adapters/slack/commands` | Slack request signature | — |  |

### `slackEvents.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/adapters/slack/events` | Slack request signature | — |  |

### `slackInteractions.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/adapters/slack/interactions` | Slack request signature | — |  |

### `slackOAuth.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| DELETE | `/api/v1/adapters/slack` | OWNER/ADMIN | `integrations:write` | Remove installation |
| POST | `/api/v1/adapters/slack/link-code` | Authenticated | `integrations:write` | Issue an account-link code |
| GET | `/api/v1/adapters/slack/oauth/authorize` | OWNER/ADMIN | `integrations:read` | Start OAuth (redirect) |
| GET | `/api/v1/adapters/slack/oauth/callback` | None (OAuth state) | — | OAuth callback |
| GET | `/api/v1/adapters/slack/oauth/url` | OWNER/ADMIN | `integrations:read` |  |
| GET | `/api/v1/adapters/slack/status` | Authenticated | `integrations:read` | Installation status |

### `slashCommand.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/slash-command` | None (a live session id in the named workspace) | — | Run an `/intutic …` chat command the proxy intercepted; `help` needs no session |

### `sops.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/sop/dependency-graph` | Authenticated | `sops:read` |  |
| GET | `/api/v1/sop/rules` | Authenticated | `gateway:use` or `sops:read` |  |
| GET | `/api/v1/sops` | Authenticated | `gateway:use` or `sops:read` | List SOPs (paginated) |
| POST | `/api/v1/sops` | OWNER/ADMIN | `sops:write` | Create SOP |
| DELETE | `/api/v1/sops/:sopId` | OWNER/ADMIN | `sops:write` | Soft-delete SOP |
| GET | `/api/v1/sops/:sopId` | Authenticated | `sops:read` | Get SOP detail |
| PUT | `/api/v1/sops/:sopId` | OWNER/ADMIN | `sops:write` | Update SOP |
| GET | `/api/v1/sops/:sopId/dependencies` | Authenticated | `sops:read` | Get dependency graph |
| GET | `/api/v1/sops/:sopId/duplicates` | Authenticated | `sops:read` | Similarity scores against the workspace's other SOPs |
| POST | `/api/v1/sops/:sopId/godel-probe` | OWNER/ADMIN/EM | `sops:write` |  |
| GET | `/api/v1/sops/:sopId/health` | Authenticated | `sops:read` | Get health metrics |
| POST | `/api/v1/sops/:sopId/holds` | OWNER/ADMIN/EM | `sops:write` |  |
| POST | `/api/v1/sops/:sopId/invalidate` | OWNER/ADMIN | `sops:write` | Cascade invalidation |
| POST | `/api/v1/sops/:sopId/transition` | OWNER/ADMIN | `sops:write` | Lifecycle transition |
| GET | `/api/v1/sops/:sopId/versions` | Authenticated | `sops:read` |  |
| POST | `/api/v1/sops/git-drift-report` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `sops:write` | Record sops status drift results |

### `sslCompliance.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/sessions/:sessionId/ssl-audit` | OWNER/ADMIN/EM/DEVELOPER | `traces:write` |  |
| GET | `/api/v1/sessions/:sessionId/ssl-state` | Authenticated | `traces:read` |  |
| GET | `/api/v1/workspaces/:workspaceId/ssl-compliance` | Authenticated | `sops:read` |  |

### `sso.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/auth/sso/callback` | None (OIDC state and code) | — | The OIDC redirect URI: exchange the code, start a session |
| GET | `/api/v1/auth/sso/login/:providerId` | None | — | Redirect to the identity provider |
| GET | `/api/v1/auth/sso/providers` | OWNER/ADMIN | `settings:read` | List SSO providers |
| POST | `/api/v1/auth/sso/providers` | OWNER | `settings:write` | Create an OIDC provider |
| DELETE | `/api/v1/auth/sso/providers/:providerId` | OWNER | `settings:write` | Delete a provider |

### `sync.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/sync/config` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | Push workspace config to daemon |
| GET | `/api/v1/sync/report` | Authenticated | `inventory:read` |  |
| POST | `/api/v1/sync/sop-hash` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | Receive SOP hash integrity report |
| POST | `/api/v1/sync/status` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `inventory:write` | Record daemon heartbeat |
| GET | `/api/v1/sync/ws` | API key (`?token=vk_…`) | `gateway:use` |  |

### `taskManagement.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/task-management/connections` | Authenticated | `integrations:read` | List task connections |
| POST | `/api/v1/task-management/connections` | OWNER/ADMIN | `integrations:write` | Create task connection |
| DELETE | `/api/v1/task-management/connections/:connectionId` | OWNER/ADMIN | `integrations:write` |  |
| POST | `/api/v1/task-management/connections/:connectionId/test` | OWNER/ADMIN | `integrations:write` |  |

### `teams.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/orgs/:orgId/teams` | Authenticated | `settings:read` |  |
| POST | `/api/v1/orgs/:orgId/teams` | Authenticated | `settings:write` |  |
| GET | `/api/v1/teams/:teamId/workspaces` | Authenticated | `settings:read` |  |
| POST | `/api/v1/teams/:teamId/workspaces` | Authenticated | `settings:write` |  |

### `telemetry.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/telemetry/event` | None | — | Forward a telemetry event |

### `traces.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/traces` | Authenticated | `traces:read` | List traces with filtering and pagination |
| GET | `/api/v1/traces/:id` | Authenticated | `traces:read` | Get a single trace by ID |
| GET | `/api/v1/traces/:id/dag` | Authenticated | `traces:read` |  |
| POST | `/api/v1/traces/sync-back` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` |  |

### `trajectory.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/trajectory/alerts` | OWNER/ADMIN/EM | `traces:read` | List trajectory alerts for workspace |
| GET | `/api/v1/trajectory/alerts/:alertId` | OWNER/ADMIN/EM | `traces:read` |  |
| POST | `/api/v1/trajectory/analyze` | OWNER/ADMIN/EM/DEVELOPER | `gateway:use` or `traces:write` | Submit trajectory summary for analysis |
| GET | `/api/v1/trajectory/status/:sessionId` | OWNER/ADMIN/EM | `traces:read` |  |

### `trial.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/trial/status` | Authenticated | `billing:read` | trial and plan status for the workspace |
| GET | `/api/v1/trial/tiers` | None | — | the plans on sale, with prices and features |

### `trust.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/trust-scores` | Authenticated | `findings:read` | All trust scores for a workspace |
| GET | `/api/v1/trust-scores/:userId` | Authenticated | `findings:read` | Single user trust score |

### `usage.ts` <Badge type="warning" text="Biz Org+" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/usage/branches` | Authenticated | `usage:read` | Usage per repository and branch |
| POST | `/api/v1/usage/classify` | OWNER/ADMIN/EM | `usage:write` | <Badge type="tip" text="Cloud" /> Classify tokens as USEFUL or WASTED |
| GET | `/api/v1/usage/commits` | Authenticated | `usage:read` | Usage per HEAD commit |
| GET | `/api/v1/usage/events` | Authenticated | `usage:read` | <Badge type="tip" text="Cloud" /> Paginated raw execution trace events |
| GET | `/api/v1/usage/members` | Authenticated | `usage:read` | Per-developer usage (own row only below EM) |
| GET | `/api/v1/usage/models` | Authenticated | `usage:read` | <Badge type="tip" text="Cloud" /> Per-model cost breakdown |
| GET | `/api/v1/usage/pull-requests` | Authenticated | `usage:read` | Usage per GitHub pull request |
| POST | `/api/v1/usage/pull-requests/refresh` | OWNER/ADMIN/EM | `usage:write` | Look up the branches' pull requests on GitHub now |
| GET | `/api/v1/usage/summary` | Authenticated | `usage:read` | <Badge type="tip" text="Cloud" /> Aggregated usage summary by period |
| GET | `/api/v1/usage/teams` | OWNER/ADMIN/EM | `usage:read` | Per-team usage by SCIM group |
| GET | `/api/v1/usage/virtual-keys` | Authenticated | `usage:read` | <Badge type="tip" text="Cloud" /> Per-virtual-key cost breakdown (Wave 9) |

### `users.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/users/me` | Authenticated | Any | Get current user profile + workspaces |
| PUT | `/api/v1/users/me` | Authenticated | `members:write` | Update display name / avatar |

### `wasmRules.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| GET | `/api/v1/wasm-rules` | OWNER/ADMIN/EM | `policies:read` |  |
| POST | `/api/v1/wasm-rules` | OWNER/ADMIN | `policies:write` |  |
| DELETE | `/api/v1/wasm-rules/:ruleId` | OWNER/ADMIN | `policies:write` |  |
| GET | `/api/v1/wasm-rules/:ruleId` | OWNER/ADMIN/EM | `policies:read` |  |
| PUT | `/api/v1/wasm-rules/:ruleId` | OWNER/ADMIN | `policies:write` |  |
| POST | `/api/v1/wasm-rules/:ruleId/replay` | OWNER/ADMIN/EM | `policies:write` |  |
| GET | `/api/v1/wasm-rules/binaries/:sha256` | Authenticated | `gateway:use` or `policies:read` |  |

### `workspace.ts` <Badge type="tip" text="Cloud" />

| Method | Path | Auth | Key scope | Description |
|--------|------|------|-----------|-------------|
| POST | `/api/v1/workspace/byoc/test` | OWNER/ADMIN | `settings:write` |  |
| GET | `/api/v1/workspace/dashboard` | Authenticated | `usage:read` | Aggregated dashboard summary |
| GET | `/api/v1/workspace/decisions-digest` | Authenticated | `gateway:use` or `findings:read` |  |
| GET | `/api/v1/workspace/egress-policy` | Authenticated | `gateway:use` or `policies:read` |  |
| GET | `/api/v1/workspace/leaderboard` | Authenticated | `usage:read` |  |
| GET | `/api/v1/workspace/onboarding-status` | Authenticated | `settings:read` |  |
| POST | `/api/v1/workspace/onboarding/complete` | OWNER/ADMIN/EM/DEVELOPER | `settings:write` |  |
| GET | `/api/v1/workspace/posture` | Authenticated | `settings:read` |  |
| POST | `/api/v1/workspace/posture` | OWNER/ADMIN | `settings:write` |  |
| GET | `/api/v1/workspace/region` | OWNER/ADMIN | `settings:read` | Workspace region and residency enforcement |
| PATCH | `/api/v1/workspace/region` | OWNER | `settings:write` | <Badge type="danger" text="Enterprise" /> Set the workspace region and residency enforcement |
| GET | `/api/v1/workspace/settings` | Authenticated | `gateway:use` or `settings:read` | Read workspace settings (resolved with defaults) |
| PUT | `/api/v1/workspace/settings` | OWNER/ADMIN | `settings:write` | Update workspace settings (ADMIN+) |
| GET | `/api/v1/workspace/sops-policy` | Authenticated | `gateway:use` or `sops:read` |  |

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

The Intutic proxy (default port `4000`, set by `PORT`) serves these besides the provider APIs it governs. It listens on loopback unless [`INTUTIC_PROXY_BIND`](/reference/configuration#core) opens it (the container image and a gateway listen on every interface), and the routes marked loopback answer `403` (`{"error": "loopback only"}`) to any caller not on the same machine.

| Method | Path | Access | Returns |
|---|---|---|---|
| POST | `/v1/messages` | Your provider credential or a `vk_` key | Anthropic Messages API, governed |
| POST | `/v1/chat/completions` | Your provider credential or a `vk_` key | OpenAI Chat Completions, governed |
| POST | `/v1/responses` | Your provider credential or a `vk_` key | OpenAI Responses API, governed |
| CONNECT | any host | This machine; from elsewhere, an Intutic key in `Proxy-Authorization` on a listener opened with `INTUTIC_PROXY_BIND` | HTTPS tunnel for clients that use the proxy as `HTTPS_PROXY`. AI provider hosts are decrypted and governed; other hosts follow the [egress policy](/reference/configuration#egress-control). From another machine: `403` when the listener is loopback-only, `407` without a key or with one the control plane rejects |
| GET | `/health` | Open | `{ status, service, version }` |
| GET | `/` | Open | Service name, version and the protocols that work end to end |
| GET | `/intutic/egress` | Open | Egress posture: `{ mode, denied, would_deny }`, where `mode` is `off`, `monitor` or `enforce` and the counts run since the proxy started |
| GET | `/intutic/spend` | Loopback | Today's spend on this machine: `{ local_spend_usd_today, local_cap_usd, enforced }` |
| GET | `/intutic/instance` | Loopback | `{ proxy_instance_id, shared_gateway }`, the id every trace from this process carries |
| GET | `/intutic/probes` | Loopback | The last scheduled guard self-test: `{ probes, total, failed, ran_at }`; `503` before the first run finishes |
| POST | `/intutic/attest-sandbox` | The request's `Authorization` bearer, an Intutic key (`vk_…`) the control plane accepts, from this machine or a network the listener was opened to | Called from inside an `intutic exec --sandbox` container, whose firewall lets it reach only the proxy. Forwards `{ "sessionId": "…" }` to the control plane's `PATCH /api/v1/sessions/:sessionId/attest-sandbox` and answers `{ attested }`. `400` without `sessionId`, `401` without a bearer, with one that is not an Intutic key or with a key the control plane rejects, `403` from another machine when the listener is loopback-only, `503` when no control plane is configured or the key cannot be checked, `502` when it cannot be reached |

`/v1beta/models/:model` (Gemini's own route) is refused with `400 unsupported_route`: the proxy reads a request's model from its body, and this route names it in the URL. Gemini models are served on `/v1/messages`, `/v1/chat/completions` and `/v1/responses`, translated to the Gemini API.
