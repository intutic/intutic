# Security & Identity <Badge type="danger" text="Enterprise" />

<!-- ENTERPRISE_ONLY_START -->
Protect your workspace with enterprise-grade authentication, role-based access control, and scoped agent credentials.

## Single Sign-On (SSO)

Intutic supports OpenID Connect (OIDC) Single Sign-On for seamless integration with your corporate identity provider.

### Setting Up SSO

1. Navigate to **Settings &rarr; Security**
2. Click **Configure SSO**
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

From **Settings → Security → API Keys**:

| Action | Description |
|--------|-------------|
| **Create** | Generate a new key with a descriptive label |
| **Rotate** | Generate a replacement key and invalidate the old one |
| **Revoke** | Immediately invalidate a key |

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
| Review Queue | Owner, Admin, or EM |
| Compliance Scope | Owner, Admin, or EM |
| Custom Filters (WASM) | Owner, Admin, or EM |
| Network Policies | Owner or Admin |
| Simulation Sandbox | Owner or Admin |
| Compute Metrics | Owner or Admin |

---

## Member Management

Manage your team from **Settings &rarr; Team Members**.

### Inviting Members

Intutic uses **direct provisioning** — there is no invitation email. The admin creates the account and shares credentials out-of-band.

1. Click **Invite Member** in the Team Members panel
2. Fill in the provisioning form:
   - **Email** — The new member's email address (used as their login identifier)
   - **Display Name** — How they appear in the dashboard and audit logs
   - **Role** — Select an RBAC role (`ADMIN`, `EM`, `DEVELOPER`, or `VIEWER`)
   - **Temporary Password** — Set an initial password (8–128 characters)
3. Click **Create** — the system provisions the account immediately
4. **Copy the temporary password** and share it with the new member through a secure channel (e.g., a password manager, encrypted message, or in person)
5. The new member logs in with their email and the temporary password
6. They should change their password immediately from **Settings → Security → Change Password**
<!-- ENTERPRISE_ONLY_END -->

::: warning
Intutic does not send invitation emails. The admin is responsible for securely communicating the temporary password to the new member. Never share credentials via unencrypted channels.
:::

### Removing Members

Remove a member to immediately revoke their access. Their historical traces and audit data are preserved.

### Changing Roles

Adjust a member's role at any time. Changes take effect immediately.

---

## Password Management

Change your account password from **Settings → Security → Change Password**.

- Passwords must be 8–128 characters
- We recommend using a password manager
- If SSO is enabled, you may not need a password at all

---

## Related

- [Settings & Configuration](/guide/settings) — Full settings overview
- [Core Concepts](/guide/concepts) — RBAC roles and workspace hierarchy
- [Configuration Reference](/reference/configuration) — Environment variables and workspace roles
