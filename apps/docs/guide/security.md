# Security & Identity <Badge type="danger" text="Enterprise" />

<!-- ENTERPRISE_ONLY_START -->
Protect your workspace with enterprise-grade authentication, role-based access control, and scoped agent credentials.

## Single Sign-On (SSO)

Intutic supports OpenID Connect (OIDC) Single Sign-On for seamless integration with your corporate identity provider.

### Setting Up SSO

1. Open **Settings › Security**
2. On the **Single Sign-On (SSO)** card, click **Configure SSO**
3. Enter your OIDC identity provider's configuration:
   - **Provider Type** &mdash; Select your provider (Okta, Microsoft Entra ID, Google, Ping Identity, or Custom OIDC)
   - **Issuer URL** &mdash; Your identity provider's unique issuer OIDC endpoint URL
   - **Client ID** &mdash; The application client ID assigned by your provider
   - **Client Secret** &mdash; The secure OIDC client secret key
   - **Scopes** &mdash; Permissions scopes (defaults to `openid,profile,email`)
4. Save the provider and configure redirection rules on your provider console to send users to:
   ```
   http://localhost:5174/api/v1/auth/callback
   ```

::: tip
Once SSO is configured, team members can log in using their corporate SSO ID. You can enforce auto-provisioning of members on their first login.
:::

### Supported Providers

Any OIDC compliant identity provider works with Intutic, including:
- Okta (Web Application OIDC integration)
- Microsoft Entra ID (Azure AD app registration)
- Google Workspace (OAuth credentials)
- Ping Identity
- Custom OIDC (Keycloak, Auth0, etc.)

---

## API Keys

Virtual API keys (`vk_` prefix) provide programmatic access to the Intutic API and are used by the CLI and sync daemon.

### Managing Keys

From **Settings › Security › Virtual API Keys**:

| Action | Description |
|--------|-------------|
| **Create** | Generate a new key with a **Label / Description**, an optional **Expires In (Days)**, and optionally a list of allowed models |
| **Revoke** | Immediately invalidate a key |

There is no rotate action. To replace a key, create a new one, move its clients over, then revoke the old one.

::: warning
Treat API keys as secrets. Never commit them to version control. Use environment variables (`INTUTIC_API_KEY`) instead.
:::

### Key Format

```
vk_abc123def456ghi789
```

All keys use the `vk_` prefix for easy identification.

---

## On-Behalf-Of (OBO) Tokens

OBO tokens solve the "shared API key" problem by issuing short-lived, employee-scoped credentials for agent authentication.

### How OBO Works

1. A developer authenticates with Intutic (via SSO or password)
2. Intutic issues an OBO token scoped to that developer's RBAC role
3. The AI agent uses this token instead of a shared workspace key
4. All actions are attributed to the specific developer
5. The token enforces the developer's permission boundaries

### Benefits

- **Audit trail** — Every agent action is tied to a specific developer
- **Least privilege** — Agents can only do what the developer is allowed to do
- **Time-limited** — Tokens expire automatically, reducing risk from credential leaks

---

## RBAC Roles

Role-Based Access Control determines what each team member can see and do in the dashboard.

| Role | Capabilities |
|------|-------------|
| **Owner** | Full control — billing, workspace settings, member management, all features |
| **Admin** | Manage SOPs, members, budgets, compliance settings |
| **EM** | View reports, manage budgets, review enforcement decisions |
| **Developer** | Use agents, view own traces and compliance scores |
| **Viewer** | Read-only access to the dashboard |

### Role Hierarchy

```
Owner > Admin > EM > Developer > Viewer
```

Higher roles inherit all permissions from lower roles.

### Feature Access by Role

Some dashboard features are restricted to specific roles:

| Feature | Required Role |
|---------|--------------|
| Overview › Spend tab | Owner, Admin, or EM |
| Policies › Enforcement Policies | Owner, Admin, or EM |
| Policies › Policy Guardrails | Owner, Admin, or EM |
| Policies › Custom Filters (WASM) | Owner, Admin, or EM |
| Policies › Emergency Overrides | Owner, Admin, or EM |
| Policies › Compliance Scope | Owner, Admin, or EM |
| Findings › Findings | Owner, Admin, or EM |
| Findings › Incidents | Owner, Admin, or EM |
| Findings › Review Queue | Owner, Admin, or EM |
| Labs › SOP Optimizer | Owner, Admin, or EM |
| Labs › Intelligence | Owner, Admin, or EM |
| Settings › Audit Timeline | Owner or Admin |
| Labs › Evaluator Sandbox | Owner or Admin |

Every other page is open to every role. Policy Guardrails, Custom Filters, SOP Optimizer and Evaluator Sandbox also need a plan that includes them; see the [Tier Matrix](/guide/tier-matrix).

---

## Member Management

Manage your team from **Settings › Team Members**.

### Inviting Members

Intutic uses **direct provisioning** — there is no invitation email. The admin creates the account and shares credentials out-of-band.

1. Find the **Invite a teammate** form on the Members card
2. Fill in the form:
   - **Display name** — How they appear in the dashboard and audit logs
   - **Email address** — The new member's email address (used as their login identifier)
   - **Role** — Viewer, Developer, Engineering Manager or Admin
3. Click **Create Account** — the system provisions the account immediately and generates a temporary password for you
4. In the **Account Created** dialog, **Copy Password** and share it with the new member through a secure channel (e.g., a password manager, encrypted message, or in person). It is not shown again
5. The new member logs in with their email and the temporary password, and is prompted to change it
6. They can change it again at any time from **Settings › General › Change Password**
<!-- ENTERPRISE_ONLY_END -->

::: warning
Intutic does not send invitation emails. The admin is responsible for securely communicating the temporary password to the new member. Never share credentials via unencrypted channels.
:::

### Removing Members

Remove a member to immediately revoke their access. Their historical traces and audit data are preserved.

### Changing Roles

Adjust a member's role at any time. Changes take effect immediately.

---

## Offboarding <Badge type="danger" text="Enterprise" />

The reliable path is **SCIM 2.0 provisioning** — see the
[SCIM guide](/guide/scim). With it configured, removing a user in your identity
provider sends `active: false`, which runs the deprovisioning cascade here: their API
keys are revoked, the cached auth contexts the proxy reads are purged, and their
sessions are killed. Nothing waits on a human.

::: warning Without SCIM, IdP removal does not stop agents on its own
API keys authenticate independently of SSO — Intutic checks the key hash and whether
the member is active, never whether an SSO session is still valid. So a developer
removed in Okta can no longer sign in to the dashboard, but an agent already running
with their key keeps working until either the SSO-recency window elapses (30 days by
default) or someone deactivates the member.
:::

### If you are not using SCIM

Deactivate the member in Intutic as well:

```
DELETE /api/v1/members/:memberId
```

or **Settings › Team Members › Deactivate**. This takes effect
immediately — every key the member holds stops authenticating at the control plane
and at the proxy on the next request, not after a cache expiry.

Deactivation does not revoke the keys, only refuses them, so reactivating the
member restores their access without reissuing anything.

### Making IdP removal sufficient

A second layer, on by default: an SSO-recency window. A key is refused once its
owner has not completed an SSO login inside it, so removal at the identity provider
expires their keys even without SCIM.

**The default is 30 days.** It applies only to workspaces that have an SSO provider
configured, exempts keys marked for automation, and grants every member a full
window from when they joined before it can refuse anything — so enabling it, or
inheriting the default, never cuts anyone off on the spot.

```
PUT /api/v1/workspace/settings
{ "ssoKeyMaxIdleDays": 30 }
```

Send `null` to turn it off, or adjust the window under
**Settings › Security › Single Sign-On (SSO)**, in **Expire API keys without a recent SSO login** (Off, 7, 30 or 90 days). That control appears once an SSO provider is configured.

Signing in through SSO re-stamps the timestamp and restores the keys; no
re-issuing is needed.

### Automation keys

Mark a key **This key is for automation (CI, scripts, a service)** when you create it (Settings › Security › Virtual API Keys) and
the window does not apply to it — no person signs in for a pipeline. Such a key is
still revocable, and it still stops working the moment its owner is deactivated, so
it is exempt from the recency policy only, not from offboarding.

Set this on your CI keys before enabling a window, or those pipelines will start
failing when it elapses.

### Undoing a deactivation

Deactivation refuses a member's keys rather than revoking them, so reversing it
restores access with no re-issuing:

```
POST /api/v1/members/:memberId/reactivate
```

or **Settings › Team Members › Reactivate** on an inactive member.

## Password Management

Change your account password from **Settings › General › Change Password**.

- Passwords must be 8–128 characters
- We recommend using a password manager
- If SSO is enabled, you may not need a password at all

---

## Related

- [Settings & Configuration](/guide/settings) — Full settings overview
- [Core Concepts](/guide/concepts) — RBAC roles and workspace hierarchy
- [Configuration Reference](/reference/configuration) — Environment variables and workspace roles
