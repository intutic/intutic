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

Set up SAML 2.0 or OIDC-based SSO providers so team members can log in with Okta, Entra ID (Azure AD), Google, or Ping Identity. Refer to the configuration helper links inside the modal for step-by-step setup guides.

### API Keys

Create and manage virtual API keys (`vk_` prefix) for programmatic access to the Intutic API:
- Generate new keys with descriptive labels
- Rotate keys on a schedule
- Revoke compromised keys immediately

### Provider Keys

Provision your workspace's own upstream API key for each model provider — Anthropic, OpenAI,
Gemini, Mistral, and OpenRouter today, with more providers pre-configurable ahead of their
routing support (see below). Configuring your own key means requests bill against your
provider account directly rather than Intutic's shared operator key.

Each provider row shows a **Live** or **Not yet routable** badge. **Live** means the gateway
actually forwards requests to that provider once a key is set. **Not yet routable** means the
key is stored and ready, but the gateway does not yet route to it — routing support for a new
provider is separate engineering work per provider, and the dashboard says so rather than
implying a saved key is already in effect.

If your workspace's gateway has BYO-key enforcement turned on, requests fail with `402
byok_required` until a key is provisioned here for the provider being called. Also available
from the CLI:

```bash
intutic credentials list
intutic credentials set anthropic --field apiKey=sk-ant-...
intutic credentials unset anthropic
```

A provider needing more than one field (e.g. Azure OpenAI: endpoint, deployment, key) takes a
repeated `--field key=value` flag, one per field — the wizard's dynamic form and the CLI submit
the same shape.

New: **Guided Setup**, next to Provider Keys, walks through provisioning a provider, verifying
it against the provider's own API, and (optionally) picking a judge model in one flow. See
[the cohort wizard](/guide/cohort-wizard) for the full step-by-step (it's also available from
the CLI as `intutic setup`, for anyone who'd rather not click through it).

### LLM Judge

Choose a model to run this workspace's LLM-as-judge checks on, instead of Intutic's platform
trusted monitor. The picker lists models from Intutic's [model catalog](/reference/model-catalog),
filtered by default to providers you've already provisioned a credential for under Provider
Keys — a model shown disabled needs either a credential or "Show all providers" to reveal why. A
**Custom model name** field is always available underneath: an on-prem LiteLLM deployment can
serve a model under any alias, and this workspace setting only validates the name's character
shape, never catalog membership, so a custom alias is always accepted, not just tolerated.
Saving a name outside the catalog shows a **custom model** badge rather than an error.

Trade-offs, stated plainly rather than implied:
- Choosing your own judge **replaces** Intutic's independent trusted monitor for this workspace.
  Every verdict is stamped `[workspace-judge]`; a judge equal to the model that produced the work
  is additionally stamped `[self-graded]`.
- Judged content still transits Intutic's gateway to your provider — this is a billing/model-
  choice feature, not a data-locality one. For content to stay entirely on your infrastructure,
  see [the on-prem judge](/external/on-prem-judge).
- Chunk-level judging bills per paragraph, to your provider key.

Use **Test** before saving — it runs one real, tiny completion through the exact path a judge
call would take (your provisioned credential, the platform gateway), so a typo'd model name or
a missing key fails here rather than during a live judge call.

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
Bypass enforcement applies to all 39 supported harnesses. The sync daemon monitors protected configuration paths in real time.
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
- `trajectory.alert` — Triggers on goal drift or looped trace behaviors
- `decision.pending` — Triggers when a hijacked action requires manual administrator review

### Cooldown Throttling

Prevent alert noise by setting a cooldown period (in minutes) for each rule. Consecutive identical alerts inside the cooldown window are suppressed.

---

## Related

- [Security & Identity](/guide/security) — Detailed SSO and authentication setup
- [Configuration Reference](/reference/configuration) — Environment variables and workspace settings
