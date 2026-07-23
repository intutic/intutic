# Settings & Configuration <Badge type="warning" text="Cloud / Team" />

<!-- ENTERPRISE_ONLY_START -->
Manage your workspace preferences, security, billing, compliance, and integrations from a single control panel.

## Accessing Settings

Navigate to **Settings** in the dashboard sidebar. The settings page is organized into tabs, each covering a different area of workspace management.

---

## General

The General tab covers your basic workspace identity.

### Workspace Info

- **Workspace Name** — The display name for your workspace
- **Workspace ID** — Your unique workspace identifier (`wk_` prefix), used in API calls and CLI configuration

---

## Team Members

The Team Members tab lets you invite, remove, and manage team members and assign RBAC roles:

| Role | Access Level |
|------|-------------|
| **Owner** | Full control — billing, settings, member management |
| **Admin** | Manage SOPs, members, budgets |
| **EM** | View reports, manage budgets |
| **Developer** | Use agents, view own traces |
| **Viewer** | Read-only dashboard access |

---

## Security

Configure authentication, access control, and API credentials for your workspace.

### Single Sign-On (SSO)

Set up SAML/OIDC-based SSO providers so team members can log in with Okta, Entra ID (Azure AD), Google, or Ping Identity. Refer to the configuration helper links inside the modal for step-by-step setup guides.

### API Keys

Create and manage virtual API keys (`vk_` prefix) for programmatic access to the Intutic API:
- Generate new keys with descriptive labels
- Rotate keys on a schedule
- Revoke compromised keys immediately

### On-Behalf-Of (OBO) Tokens

OBO tokens are short-lived, employee-scoped credentials. OBO Scoping allows you to temporarily grant limited permission clearance to an AI agent acting on your behalf (e.g., executing commands or reading files during a debug task). This token automatically expires in 15 minutes to guarantee security.

### Password Management

Change your account password. Passwords must be 8–128 characters.
<!-- ENTERPRISE_ONLY_END -->

---

## AI Routing & Proxy

Manage dynamic model routing preferences, governance bypass controls, and saved response caching.

### Smart Routing & Response Cache

Optimize AI model selection dynamically to balance cost and response speed, and manage cached answers to minimize token expenses. You can configure these settings directly:

*   **Exact Query Match Caching** — Serves cached answers for identical queries.
*   **Semantic Match Caching** — Serves cached answers for conceptually equivalent queries.
*   **Enable Intelligent Model Routing** — Dynamically optimizes model selection for every task using adaptive reinforcement learning.
*   **Configurable Task Trigger Words** — Customize the comma-separated keywords used to automatically classify prompt tasks (testing, deployment, review, debugging) at the proxy gateway.
*   **Reset Router Memory** — Clears the active routing history, restarting the learning process.

Monitoring metrics include:
- **Optimization Status** — Indicates if the router learning process is actively *LEARNING* or has reached *OPTIMIZED*.
- **Optimization Progress** — Shows convergence ratio progress.
- **Routing Decisions** — Counts total observations handled.
- **Active Routing Configurations** — Simplified table displaying model arm IDs, task types, security levels, and performance scores.

### MCP Proxy Enforcement

Controls how the Intutic governance proxy behaves when it can't reach the control plane.

| Setting | Behavior |
|---------|----------|
| **Fail-Open** *(recommended)* | Tool calls pass through when the control plane is unreachable. A warning event is logged to the dashboard |
| **Fail-Closed** | Tool calls are blocked with an error message when the control plane is unreachable |

### Bypass Enforcement

Determines how aggressively the sync daemon protects harness config files from manual edits.

| Tier | Behavior |
|------|----------|
| **Rewrite** *(default)* | The drift watcher detects edits within ~1 second and immediately rewrites the config |
| **Immutable** *(macOS only)* | After each write, sets system-level immutable flags on the config file |
| **Alert Only** | Drift creates a governance incident but does not rewrite the config |

::: info
Bypass enforcement applies to all 18 supported harnesses. The sync daemon monitors protected configuration paths in real time.
:::

---

## MCP Health

Monitor the health of the MCP governance proxy daemon.

- **Daemon Status** — View the current state of the MCP proxy daemon across your workspace
- **Cache Management** — View and invalidate the MCP tool resolution cache

::: tip
If agents are using stale governance rules, try invalidating the MCP cache from this tab.
:::

---

## Notifications

Route governance events and alerts to external channels like Slack, webhooks, or email.

### Channel Routing

- **Slack Integration** — Connect your Slack workspace via OAuth and route alerts to specific Slack channel IDs.
- **Webhooks** — Send JSON payloads to generic HTTP endpoints. Secure webhooks with an optional HMAC signing secret.

### Rule Filters

Define custom routing rules filtering by event types:
- `anomaly.detected` — Triggers when an ARE anomaly is flagged
- `budget.threshold` — Triggers when a workspace/department budget limit is breached
- `ssl.enforcement.violation` — Triggers when an SSL enforcement check fails
- `trajectory.alert` — Triggers on goal drift or looped trace behaviors
- `decision.pending` — Triggers when a hijacked action requires manual administrator review

### Cooldown Throttling

Prevent alert noise by setting a cooldown period (in minutes) for each rule. Consecutive identical alerts inside the cooldown window are suppressed.

---

## Related

- [Security & Identity](/guide/security) — Detailed SSO and authentication setup
- [Configuration Reference](/reference/configuration) — Environment variables and workspace settings
