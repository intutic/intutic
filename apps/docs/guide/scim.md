# SCIM 2.0 Provisioning <Badge type="danger" text="Enterprise" />

Automate user lifecycle management with SCIM 2.0 (System for Cross-domain Identity Management) to keep your Intutic workspace in sync with your corporate identity provider.

## Overview

Intutic implements the **SCIM 2.0** protocol per [RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643) (Core Schema) and [RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644) (Protocol) for automated user provisioning and deprovisioning. When connected to an IdP such as Okta, Microsoft Entra ID, or OneLogin, user accounts are automatically created, updated, and removed in Intutic as changes occur in your directory.

### Key Capabilities

- **Just-in-time provisioning** — New directory users are automatically created in Intutic
- **Attribute synchronization** — Name, email, and role changes propagate automatically
- **Automated offboarding** — Deprovisioned users trigger a 7-step security cascade
- **Group-to-role mapping** — IdP groups map to Intutic RBAC roles

---

## Authentication

All SCIM endpoints are protected by the `scimAuth` middleware. Requests must include a **SCIM bearer token** in the `Authorization` header:

```
Authorization: Bearer <scim_bearer_token>
```

::: tip
Issue a SCIM token from **Settings → Single Sign-On → Directory provisioning
(SCIM 2.0)**, or via the API:

```
POST /api/v1/scim/tokens
{ "label": "Okta production", "expiresInDays": 365 }
```

The response carries the token and the SCIM base URL to configure in your IdP. It is
shown **once** — only a hash is stored, so a database dump cannot yield working
directory credentials. Revoke from the same panel or
`DELETE /api/v1/scim/tokens/:tokenId`; revocation takes effect on the next request.

The token is workspace-scoped and separate from regular API keys.
:::

---

## User Endpoints

### POST /scim/v2/Users — Provision User

Create a new user in the workspace.

**Request body:**

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "jane.doe@example.com",
  "name": {
    "givenName": "Jane",
    "familyName": "Doe"
  },
  "emails": [
    {
      "value": "jane.doe@example.com",
      "primary": true
    }
  ],
  "active": true
}
```

**Response:** `201 Created` with SCIM User resource

---

### GET /scim/v2/Users — List Users

List all provisioned users in the workspace with optional filtering and pagination.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `filter` | string | SCIM filter expression (e.g., `userName eq "jane@example.com"`) |
| `startIndex` | number | 1-based pagination start index |
| `count` | number | Maximum results per page |

**Response:** `200 OK`

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  "totalResults": 15,
  "startIndex": 1,
  "itemsPerPage": 15,
  "Resources": [...]
}
```

---

### GET /scim/v2/Users/:id — Get User

Retrieve a single user by their Intutic user ID.

**Response:** `200 OK` with SCIM User resource

**Error codes:** `404` user not found in workspace

---

### PATCH /scim/v2/Users/:id — Update User

Partial update of user attributes. Commonly used by IdPs to deactivate users (`active: false`).

**Request body:**

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {
      "op": "replace",
      "path": "active",
      "value": false
    }
  ]
}
```

**Response:** `200 OK` with updated SCIM User resource

::: info
Setting `active: false` via PATCH triggers the full offboarding cascade (see below).
:::

---

### PUT /scim/v2/Users/:id — Replace User

Some providers are configured to replace rather than patch (RFC 7644 §3.5.1). A
replace carrying `"active": false` deprovisions exactly as the equivalent PATCH
does — it runs the same cascade. Only `userName`, `name` and `active` are modelled;
other attributes in the payload are ignored rather than stored.

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "jane@corp.com",
  "active": false
}
```

### DELETE /scim/v2/Users/:id — Deprovision User

Fully remove a user from the workspace, triggering the offboarding cascade.

**Response:** `204 No Content`

**Error codes:** `404` user not found, `409` offboarding already in progress, `503` cache unavailable

---

## Group Endpoints

SCIM Groups map IdP groups to Intutic RBAC role assignments. Each workspace role (`OWNER`, `ADMIN`, `EM`, `DEVELOPER`, `VIEWER`) is represented as a synthetic SCIM Group with ID `role-<rolename>`.

### GET /scim/v2/Groups — List Groups

Returns all active roles as SCIM Group resources.

**Response:** `200 OK`

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  "totalResults": 4,
  "Resources": [
    {
      "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      "id": "role-admin",
      "displayName": "ADMIN",
      "members": []
    }
  ]
}
```

---

### GET /scim/v2/Groups/:id — Get Group

Retrieve a single group by its synthetic ID (e.g., `role-admin`).

---

### POST /scim/v2/Groups — Create Group

Create a new role-based group. The group ID is derived from the `displayName`.

**Request body:**

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "displayName": "Engineering Leads"
}
```

**Response:** `201 Created`

---

### PATCH /scim/v2/Groups/:id — Update Group Membership

Add or remove members from a role group using SCIM PatchOp.

**Request body:**

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {
      "op": "add",
      "path": "members",
      "value": [{ "value": "usr_abc123" }]
    }
  ]
}
```

| Operation | Effect |
|-----------|--------|
| `add` / `replace` | Assigns the user to the target role |
| `remove` | Demotes the user to `DEVELOPER` role |

**Response:** `200 OK` with updated Group resource

---

### DELETE /scim/v2/Groups/:id — Delete Group

Demotes all members of the target role to `DEVELOPER`.

**Response:** `204 No Content`

---

## Offboarding Cascade

When a user is deprovisioned (via `DELETE /scim/v2/Users/:id` or `PATCH` with `active: false`), Intutic executes a **7-step offboarding cascade** to ensure complete security cleanup:

| Step | Action | Description |
|------|--------|-------------|
| 1 | **Revoke API Keys** | All virtual API keys (`vk_` prefix) belonging to the member are immediately invalidated |
| 2 | **Kill Sessions** | All active sessions and refresh tokens are terminated; Valkey session cache is purged |
| 3 | **Prune Context Graph** | The member's entries in the cross-harness context graph are removed |
| 4 | **Reassign SOPs** | Any SOPs owned by the departing member are reassigned to the workspace owner |
| 5 | **Archive Traces** | The member's execution traces are marked as archived (preserved for audit, but excluded from active queries) |
| 6 | **Prune State** | Residual Valkey cache entries and ephemeral state tied to the user are cleaned up |
| 7 | **Notify** | An offboarding completion event is emitted to the workspace event bus |

::: warning
The offboarding cascade is **idempotent** but uses a distributed lock (Valkey) to prevent concurrent executions for the same user. If the lock cannot be acquired, the request returns `409 Conflict`.
:::

### Offboarding Events

Each cascade execution is recorded in the `offboarding_events` table with:
- Event ID, user ID, member ID, workspace ID
- Trigger source (`scim`)
- Status (`in_progress` → `completed`)
- Individual step results with timing

---

## Admin: Retry Failed Offboardings

If an offboarding cascade partially fails (e.g., due to a transient database error), an admin can retry stale events:

### POST /api/v1/admin/offboarding/retry

**Auth:** SCIM bearer token

**Response:** `200 OK`

```json
{
  "ok": true,
  "retriedCount": 2,
  "conflictCount": 0,
  "errorCount": 0,
  "results": [
    { "eventId": "ofb_abc123", "status": "retried" },
    { "eventId": "ofb_def456", "status": "retried" }
  ]
}
```

| Status | Meaning |
|--------|---------|
| `retried` | The offboarding cascade was re-executed successfully |
| `lock_conflict` | Another retry is already in progress for this user |
| `error` | The retry failed (check logs for details) |

---

## IdP Configuration Examples

### Okta

1. In Okta Admin Console, go to **Applications → Create App Integration**
2. Select **SCIM 2.0 Test App (Header Auth)**
3. Configure:
   - **SCIM Connector Base URL:** `https://api.intutic.ai/scim/v2`
   - **Unique Identifier:** `userName`
   - **Authentication Mode:** HTTP Header → paste your SCIM bearer token
4. Enable **Push New Users**, **Push Profile Updates**, and **Push Groups**

### Microsoft Entra ID

1. In Azure Portal, go to **Enterprise Applications → Your Intutic App → Provisioning**
2. Set **Provisioning Mode** to **Automatic**
3. Configure:
   - **Tenant URL:** `https://api.intutic.ai/scim/v2`
   - **Secret Token:** Your SCIM bearer token
4. Test connection and start provisioning

---

## Related

- [Security & Identity](/guide/security) — SSO, RBAC, and API key management
- [Settings & Configuration](/guide/settings) — SCIM token generation
- [REST API Reference](/reference/api) — Full API documentation
