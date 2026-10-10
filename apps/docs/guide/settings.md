# Settings & Configuration <Badge type="tip" text="Cloud" />

<!-- ENTERPRISE_ONLY_START -->
Manage your workspace, its members, security, routing, billing, notifications and integrations from one page.

The workspace settings behind these tabs can also be read and changed with `intutic settings get` and `intutic settings set`, through `PUT /api/v1/workspace/settings`, or with Terraform; [Workspace settings](/reference/workspace-settings) lists every key.

## Accessing Settings

Open **Settings** in the sidebar. The Settings area has three pages: **Settings** itself, **Upgrade** (plan choice), and, for Owners and Admins, [Audit Timeline](/guide/audit-timeline). The Settings page is organized into tabs, in this order: General, Team Members, Security, AI Routing & Caching, Billing, Sync Status, Notifications and Integrations. Each tab has a guide link in the page header that opens its section below (Security opens [Security & Identity](/guide/security), Billing opens [Budgets & FinOps](/guide/budgets)).

---

## General {#general}

Your workspace, its plan, and your own profile and password.

- **Workspace** — the **Workspace ID** (used in API calls and CLI configuration) and the **Plan**, marked Trial or Active, with the days left in a trial. Below them, the plan limits: tokens per day, sessions per day and active guidelines.
- **Workspace Policies** — **Governance card labeling**: ask for adoption labels on corrective cards, to tune the judge. Turning it off stops label collection only; cards are still created and delivered.
- **Trace Storage** — whether traces mirror to, or live only in, a bucket you own, and a check that the bucket is still reachable. The bucket is set with `PUT /api/v1/workspace/settings` (a `byocStorage` object); its credentials are encrypted at rest and never returned.
- **Profile** — your email (read-only), display name and avatar URL.
- **Change Password** — current password, new password and confirmation. Passwords must be 8–128 characters.
- **Delete Workspace** — deletion is done by Intutic support; **Contact support** opens an email.

---

## Team Members {#members}

Who can sign in and with which role, the teams in your organization, and the guidelines every workspace inherits.

### Members

The **Invite a teammate** form takes a display name, an email address and a role, and **Create Account** creates the account directly; no invitation email is sent. The dashboard generates a temporary password and shows it once, in the **Account Created** dialog, for you to copy and share. The new member is asked to change it at first sign-in. A **Seats used** meter shows the seats in use against the plan's limit. On an organization's plan the seats are the distinct people active across all its workspaces, so someone in two teams holds one seat. At the limit, deactivate a member or upgrade to add another.

Each member row has a role selector and **Deactivate** (or **Reactivate**). The roles:

| Role | Access Level |
|------|-------------|
| **Owner** | Full control — billing, settings, member management |
| **Admin** | Workspace policy and configuration — SOPs, custom filters, budgets, integrations |
| **EM** | Run-time interventions and review — approve holds, kill runs, label findings |
| **Developer** | Use agents; end or kill their own loop runs |
| **Viewer** | Read-only dashboard access |

The invite form offers Viewer, Developer, Engineering Manager and Admin. Which dashboard pages each role can open is listed in [Security & Identity](/guide/security#feature-access-by-role), and what each role can change in [What Each Role Can Change](/guide/security#what-each-role-can-change). Controls a role cannot use are disabled or hidden, with a note saying which roles can.

### Teams

Teams group workspaces under your org. A personal org has one team; a second team needs an org on a multi-team plan. See [Organizations, Teams & Billing](/guide/organizations).

### Org-Wide SOP Floor

Mandatory guidelines every workspace under your org is judged and enforced against, in addition to its own SOPs. They are pushed from the CLI with `intutic sops push <name> --org`; the card lists them and can remove one.

---

## Security {#security}

Sign-in, keys and credentials, and the network and runtime limits every agent in the workspace runs under. The tab's cards, in order:

| Card | What it does |
|------|--------------|
| **Single Sign-On (SSO)** | **Configure SSO** connects a SAML or OIDC identity provider (Okta, Entra ID and others). Once a provider exists, the card also offers **Expire API keys without a recent SSO login** and **Directory provisioning (SCIM 2.0)**. On a plan without SSO the card says which plans include it, and SCIM, which needs the Enterprise or Self-host plan, does the same on Biz Org. See [Security & Identity](/guide/security) and [SCIM Provisioning](/guide/scim). |
| **Group policy for high-risk tools** | Which tools only members of named identity-provider groups may run, and which tools need an on-behalf-of token. Needs a plan with SSO. See [below](#group-policy-for-high-risk-tools). |
| **Virtual API Keys** | Keys (`vk_…`) that developers and their agents use to reach the Intutic proxy. See [below](#virtual-api-keys). |
| **Attenuated API Keys** | Child keys minted from a parent key with fewer capabilities by `intutic attenuate`; open a chain to see each step. |
| **On-Behalf-Of Tokens** | A short-lived token that lets an agent act for you with only the tools you pick. See [below](#on-behalf-of-obo-tokens). |
| **Provider Keys** | This workspace's own provider credentials. See [below](#provider-keys). |
| **Gateways** | Register a [self-hosted gateway](/external/self-hosted-gateway) to run the proxy in your own infrastructure. |
| **Data Residency** | Pin the workspace's data to a region, and block requests that violate the pin. Needs the Enterprise or Self-host plan; on another plan the card says so, and a pin set before a downgrade can still be turned off. |
| **Network Egress Control** | The egress mode and allow list every proxy in the workspace hot-reloads. |
| **Sandboxed Execution** | Require agents to run in a sandbox; enforced by the CLI on `intutic exec`. See [Sandboxed Execution](/guide/sandboxed-execution). |
| **PII Detectors** | The action the LLM proxy and the MCP proxy take on card numbers, IBANs, Social Security numbers, email addresses and phone numbers in this workspace's model traffic and MCP tool calls. A developer's own proxy config can only make a detector stricter. See [PII detectors](/guide/policies#setting-detector-actions-for-a-workspace). |
| **Approved Models** | The workspace's model allowlist. See [below](#approved-models). |
| **Repeat-Finding Enforcement** | Act on a sustained pattern of findings in one session, not only record it. |
| **Trajectory Monitoring** | Server-side monitoring of running sessions. See [Trajectory Monitor](/guide/trajectory-monitor). |
| **Gate health** | Whether each installed harness's gate is reporting. A gate reports every tool call, allowed ones included, so one that has sent nothing for 48 hours is **Silent**: its tool calls may not be governed. **Just installed** means the harness connected less than an hour ago. A harness is listed while a connected `intutic connect` reports it: a machine that ran `intutic disconnect`, or whose daemon has not reported for a day, is not waited on. Google Antigravity and Gemini CLI are listed apart. An **SDK gate** (`@intutic/gate`, `intutic_clawde.gate`) has no daemon; it is listed once its events have arrived on three different days within a week, and dropped after a week with none, so a script run once never alerts. Owners, Admins and Engineering Managers can see it. |
| **Devices** | Enforcement posture each developer machine reports: visibility, not attestation. |

### Group policy for high-risk tools <Badge type="warning" text="Biz Org+" />

Three lists, one name per line, matched exactly including case: **High-risk tools**, **Groups
that may run them** and **On-behalf-of only**. A member in one of the groups may run the
high-risk tools; anyone else is refused, and so is a member whose groups a gate does not know.
A tool on the on-behalf-of list is always refused, because no tool-call gate has an
on-behalf-of token to present. Saving all three lists empty removes the policy.

Owners and Admins can edit it; everyone else sees it read-only. It is stored as the
`sso_group_policy` setting, so it can also be set with `PUT /api/v1/workspace/settings`, and
every change is recorded in the [Audit Timeline](/guide/audit-timeline). Where a member's groups
come from, and how fast a change reaches each gate, is in
[SSO group clearance](/concepts/circuit-breaker#_3-sso-group-clearance).

The policy needs single sign-on, where members' groups come from, so it is not enforced on Free
or Self-serve. There the card says which plans include it. A policy saved before a downgrade is
shown read-only, marked **Not enforced on this plan**; Owners and Admins can remove it with
**Clear group policy**. Kept, it applies again after an upgrade.

### Virtual API Keys

Create keys (`vk_` prefix) for developers and their agents to reach the Intutic proxy:
- Give each key a **Label / Description** and, optionally, **Expires In (Days)**
- Optionally limit a key to **Allowed models (optional)**, one model id per line
- Mark a CI or service key **This key is for automation (CI, scripts, a service)**, so the SSO-recency window does not expire it (see [Security & Identity](/guide/security#automation-keys))
- **Revoke** a compromised key immediately

There is no in-place rotation: create a new key, move clients to it, then revoke the old one.

### Provider Keys

Provision your workspace's own upstream API key for each model provider — Anthropic, OpenAI,
Gemini, Mistral, OpenRouter, and DeepSeek today, with more providers pre-configurable ahead of their
routing support (see below). Configuring your own key means requests bill against your
provider account directly rather than Intutic's shared operator key.

Each provider row shows a **Live** or **Not yet routable** badge. **Live** means the gateway
actually forwards requests to that provider once a key is set. **Not yet routable** means the
key is stored and ready, but the gateway does not yet route to it — routing support for a new
provider is separate engineering work per provider, and the dashboard says so rather than
implying a saved key is already in effect.

If your workspace's gateway has BYO-key enforcement turned on, requests fail with `402
byok_required` until a key is provisioned here for the provider being called. A gateway can
enforce this for every workspace or for paid plans only, in which case trials keep using the
gateway's own provider key. Also available
from the CLI:

```bash
intutic credentials list
intutic credentials set anthropic --field apiKey=sk-ant-...
intutic credentials unset anthropic
```

A provider needing more than one field (e.g. Azure OpenAI: endpoint, deployment, key) takes a
repeated `--field key=value` flag, one per field — the wizard's dynamic form and the CLI submit
the same shape.

**Guided setup**, on the Provider Keys card, walks through provisioning a provider and verifying
it against the provider's own API in one flow. See
[the cohort wizard](/guide/cohort-wizard) for the full step-by-step (it's also available from
the CLI as `intutic setup`, for anyone who'd rather not click through it).

### Judges

Judges run only on self-hosted open-weight models. On Intutic SaaS that is Intutic's own
open-weight judge, included with the platform; on a
[self-hosted gateway](/external/self-hosted-gateway) it is the model your own LiteLLM serves
(see [the on-prem judge](/external/on-prem-judge)). No workspace can pick a hosted judge model,
and `PUT /api/v1/workspace/settings` rejects `managedJudgeModel` with `400`.

### On-Behalf-Of (OBO) Tokens

OBO tokens are short-lived, employee-scoped credentials. They let an agent act for you with only the tools you pick (for example, running commands or reading files during a debugging session). A token expires after 15 minutes.
<!-- ENTERPRISE_ONLY_END -->

### Approved Models

The **Approved Models** card holds an optional allowlist of model names this workspace's requests are permitted to use. Leave it
empty and every model is allowed — the allowlist only starts restricting once you add at least
one entry.

Enforcement happens at the proxy, on every request: the workspace's `allowedModels` list is
published to the gateway, and a request naming a model outside that list is rejected before it
reaches a provider. An absent list and an explicitly empty list are treated identically as
"unrestricted" — there is no difference between never configuring this and configuring it with
zero entries.

See [Intelligent Model Routing](/guide/intelligent-routing) — when routing is enabled, the models
it can actually pick from are the intersection of your `candidate_models` configuration and this
allowlist, not either list alone.

A single API key can be scoped below the workspace list: the **Allowed models (optional)** field
under [Virtual API Keys](#virtual-api-keys) takes one model id per line, and the proxy enforces the *intersection*
of the key's list and this one. A key can only narrow what the workspace approves — a model
listed on the key but not here stays refused — and a key with no list of its own inherits this
list unchanged.

#### Standalone: `allowedModels` in `~/.intutic/config.json`

A proxy running with no control plane configured (see
[Standalone](/integrations/standalone#option-b-standalone-intutic-proxy-direct-provider-connection))
has no workspace settings to publish — so it reads the same allowlist from a local file instead,
through the same enforcement path:

```json
{
  "allowedModels": ["claude-sonnet-4-5", "claude-opus-4-1"]
}
```

- The key is `allowedModels`; `allowed_models` is accepted as an alias.
- Absent, empty, or unparseable all mean **unrestricted** — identical to the workspace setting.
- The file is re-read on a 60-second cache, so an edit takes effect within a minute with no
  restart.
- A rejected request names both sources in its error, so a model refused on a connected proxy
  points you at the workspace allowlist, and on a standalone one at this file.

### Harness Config History

`intutic connect` records each harness rules file (`.claude/rules/intutic-governance.md`,
`.cursor/rules/intutic-governance.mdc`, `AGENTS.md` and the others listed under [Config content upload](/reference/cli#config-content-upload)) in the
workspace's config history. The **Upload config file content** switch decides what that record
holds. It is off by default.

| Setting | What is uploaded |
|---------|------------------|
| **Off** *(default)* | Each file's path, the SHA-256 of its redacted text, its size, the harness and the capture time. Never its text. Version History shows when a file changed, not what changed; there are no diffs and no SkillOpt config-edit suggestions |
| **On** | The same, plus the file's text, with API keys, tokens, private keys and other credential-shaped strings replaced by `[redacted]` on the developer's machine before it is sent. Diffs and SkillOpt suggestions use the text |

The control plane refuses text sent while the switch is off. A change reaches each machine at its
next sync and applies from its next capture, within a few minutes. Changing it needs the Owner or
Admin role, and the change is recorded in the settings history like any other. The API key is
`configBodyUpload` in `PUT /api/v1/workspace/settings`.

Only owners, admins and engineering managers can open a diff, because it shows the file's text.
Every member can see the history itself: paths, hashes, sizes and how many lines changed.

---

## AI Routing & Caching {#routing-proxy}

What the proxy does when it cannot reach Intutic, which model serves each request, and what it caches.

### MCP Proxy Enforcement

What the MCP governance proxy does when it cannot reach Intutic, and how firmly it keeps harness config files as Intutic wrote them. It applies to harnesses whose MCP servers run behind the proxy; [MCP Server Governance](/guide/mcp-governance) lists them.

**When Intutic is unreachable**

| Setting | Behavior |
|---------|----------|
| **Fail open** *(recommended)* | The tool call runs, and a warning event reaches the dashboard. Custom rule failures are excluded: a [rule that reaches no verdict](/guide/wasm-rules#when-a-rule-reaches-no-verdict) always refuses the call |
| **Fail closed** | The tool call is blocked with "Governance check failed: Intutic control plane unreachable." The dashboard asks you to confirm before switching to it |

The choice reaches each proxy with its policy. A proxy that has not been able to load policy since it started uses its local `INTUTIC_MCP_FAIL_OPEN` instead — see [When the registry has not loaded](/guide/mcp-governance#when-the-registry-has-not-loaded). It also decides what happens to a call an [MCP call budget](/guide/mcp-governance#call-budgets) covers when the proxy cannot reach Valkey to count it: fail open lets the call through uncounted, fail closed refuses it.

Which MCP servers and tools may run, what a high-risk change to a server's tools does, and the MCP call budgets are set on **Policies › MCP Servers** ([the registry](/guide/mcp-governance#the-registry), [tool-change risk](/guide/mcp-governance#tool-change-risk), [call budgets](/guide/mcp-governance#call-budgets)). They are workspace settings too — `mcpDefaultPolicy`, `mcpHighRiskToolChange` and `mcpBudgets` on `PUT /api/v1/workspace/settings` — so only an owner or admin changes them, and each change is in the settings history on **Settings › Audit Timeline**.

**When someone edits a harness config file by hand**

| Option | Behavior |
|--------|----------|
| **Restore** *(default)* | The sync daemon notices the hand edit and puts the managed file back |
| **Write-protect** *(macOS only)* | The file is locked against edits with the macOS immutable flag (`chflags uchg`) |
| **Record only** | The edit stays, and an incident records the drift |

Gate hook files are restored under every option, Record only included: they are the gates, not your config.

The card also shows the **Proxy mode**: per session.

### Postures

One choice that sets several settings at once, in two groups, **Security** and **Cost**. Changing one of those settings by hand afterwards marks the posture Custom.

### Smart Model Routing & Response Cache

**Saved Response Cache**

*   **Exact Query Match Caching** — serves the cached answer to an identical request.
*   **Semantic Match Caching** — serves the cached answer to a reworded question asked in the same context.

An exact match compares the whole request: the model, every message (assistant turns, tool calls and tool results included), the system prompt, the tools and tool choice, the response format, and every sampling parameter (`temperature`, `top_p`, `top_k`, `max_tokens`, stop sequences, `seed`). Only fields that cannot change the answer are ignored: `stream`, `stream_options`, `metadata`, `user`, `store`, `safety_identifier` and `prompt_cache_key`. A streamed request and the same request unstreamed share an entry, and a hit is served in the mode and wire format the client asked for.

A semantic match is narrower. It applies only to a single plain-text exchange with no tools declared: system or developer messages and the user's question, nothing else. Only the question is compared by similarity; the model, the system prompt and the parameters must match exactly. A conversation with assistant turns, tool calls, tool results, images or other non-text content is matched exactly or not at all.

Some responses are never stored, because a hit replays plain text and these would lose what the client acts on: a response that called a tool or carried anything besides text (thinking, reasoning items, more than one choice), a response output DLP redacted or withheld, and a stream that ended early or was refused by policy. Two kinds of request skip the cache entirely: requests for more than one choice (`n` above 1), and Responses API requests without `"store": false`, which the provider keeps so the client can continue them with `previous_response_id` — a replayed answer would carry an id the provider never issued.

Entries are per workspace and expire after 24 hours.

The cache figures are **Cached answers**, **Cache hit rate** (exact and similar hits) and **Saved (USD)**.

**Intelligent Model Routing**

*   **Enable Intelligent Model Routing** — chooses a model for every task with adaptive reinforcement learning. See [Intelligent Model Routing](/guide/intelligent-routing).
*   **Configurable Task Trigger Words** — the comma-separated keywords the proxy uses to classify a prompt as testing, deployment, review or debugging; one field per task type, saved with **Save Keywords**.

The router figures are:
- **Router state** — *Learning* (still exploring models) or *Converged* (choosing from settled scores).
- **Convergence** — the convergence ratio, as a percentage.
- **Routing decisions** — the number of routing observations.
- **Active Intelligent Routing Configurations** — a table of each configuration's ID, model, security level, task type, requests handled and performance score.

### Contracted Model Rates

Your negotiated per-token prices, in USD per 1,000 tokens. The shadow routing savings report prices a listed model at these rates instead of list price, on both sides of the comparison; models not listed stay at list.

### Mirror-Test Adoption Report

Enter a **Candidate model** and **Load Report** to see how a model mirror-tested against live traffic compared with the model it mirrored. See [Pre-Adoption Report for Model Upgrades](/guide/mirror-adoption-report).

---

<!-- ENTERPRISE_ONLY_START -->
## Billing {#billing}

Usage against your plan, invoices, and the spend caps that stop a runaway agent.

- **Enterprise trial** — for an Owner on an eligible workspace, a banner offers **Start 14-day enterprise trial**; during a trial it shows the days remaining and **Talk to Sales**.
- **Governed Request Usage** — Governed Requests this month against the requests your plan includes (for an organization's plan, counted across all its workspaces), any overage and its charge, the rate per 1,000 Governed Requests your workspace is billed at, and a daily trend.
- **Billing History & Invoices** — invoices Stripe issued to this workspace, newest first.
- **Budget Limits** — meters for **Spent this month** and **Spent today** against their caps; the **Daily cap (USD)**, **Monthly cap (USD)** and **Alert at (% of cap)** fields, saved with **Save limits** (Owners and Admins; other roles see the caps read-only); and **Budget alerts**, each with **Acknowledge** (Owners, Admins and EMs). A workspace that has not saved a daily cap shows the $100 default under the field, which the proxy enforces until you save your own. See [Budgets & FinOps](/guide/budgets).

### Changing plan {#changing-plan}

Open **Settings › Upgrade**. A workspace that already pays changes the subscription it has; it never gets a second one.

- **Upgrading** (Biz Org to Enterprise, or monthly to annual billing) takes effect at once. The prorated difference is charged to the card on file; if the card is declined or needs authentication, nothing changes until you pay that invoice.
- **Downgrading** (Enterprise to Biz Org, or annual to monthly billing) takes effect when the current term ends. Settings › General shows the booked change under **Billing**. To keep your plan instead, choose it again on the Upgrade page (**Keep …**). While a change is booked, **Manage billing** cannot cancel the subscription.
- **From Self-serve** to Biz Org or Enterprise goes through checkout; the Self-serve subscription then ends, with a final invoice for the usage so far.
- **To Self-serve** from Biz Org or Enterprise: cancel in **Manage billing**, then subscribe to Self-serve when the term ends.
- A workspace in an organization that pays for a plan has the organization's plan; change it for the whole organization.
<!-- ENTERPRISE_ONLY_END -->

---

## Sync Status {#mcp-health}

The sync daemon that keeps guidelines current on each machine, and the MCP servers it watches.

- **Sync Daemon** — the daemon's status (Running, or Stopped or degraded), **Policy cache entries** and **Cache hit rate**. **Clear Policy Cache** empties the policy cache.
- **MCP Servers** — each monitored server's name, status (healthy, degraded or unreachable), latency, error rate, credential expiry and last check. A server appears once a connected harness starts it behind the proxy.

::: tip
If agents are using stale governance rules, clear the policy cache from this tab.
:::

---

## Notifications {#notifications}

Route governance events to Slack, PagerDuty, a webhook or email. Each rule (**New Notification Rule**) names one event type and one channel, and can filter by severity. Only an owner or admin can create, change or delete a rule or replace its signing secret, as for SIEM destinations; every member can see the rules and the delivery log. From the CLI, `intutic notifications list`, `create`, `update`, `delete` and `rotate-secret` manage the same rules ([CLI reference](/reference/cli#intutic-notifications-list)).

### Channel Routing

- **Slack** — **Connect Slack** installs the Slack app through OAuth; a rule then sends to a Slack channel ID. **Link your Slack account** gives you a code to run as `/intutic link <code>` in Slack. A review card's **Approve** and **Reject** buttons work only from a linked account, and the review is recorded against you.
- **Email** — Send alerts to up to 20 addresses; each recipient gets their own message.
- **PagerDuty** — Trigger incidents through an Events API v2 routing key.
- **Webhooks** — Send JSON payloads to generic HTTPS endpoints. Every request is signed; see [below](#verifying-webhook-signatures).

### Webhook destinations

A webhook URL must use `https` and reach a public address. Intutic refuses webhook URLs that point at private networks, loopback, link-local or cloud-metadata addresses, or internal hostnames such as `localhost`, `*.internal` or `*.svc.cluster.local`. The check runs when you save the rule and again on every send, against the address the connection actually opens, so a hostname that later resolves inward is refused too. Redirects are not followed.

If you run your own control plane and need webhooks to reach an internal system, such as an on-prem ServiceNow, list those hosts in the control plane's `INTUTIC_WEBHOOK_ALLOWED_HOSTS` environment variable. It is a comma-separated list of exact hostnames, IP addresses or `*.suffix` wildcards:

```bash
INTUTIC_WEBHOOK_ALLOWED_HOSTS=servicenow.corp.example,*.hooks.corp.example
```

A listed host may resolve to a private address; every other destination stays guarded. Even a listed host still needs `https`, and can never reach loopback or link-local (cloud metadata) addresses. The same list also covers SIEM export destinations: webhook, Splunk HEC and Datadog intake URLs, and syslog hosts. If your internal system uses a private certificate authority, give the control plane that CA through `NODE_EXTRA_CA_CERTS`.

### Verifying webhook signatures {#verifying-webhook-signatures}

Every webhook rule signs every request with a secret Intutic generates for it. The secret is shown once, right after you create the rule; copy it then. **New signing secret** on the rule (or `POST /api/v1/notifications/rules/:ruleId/signing-secret`) replaces it and shows the new one once, and requests switch to it straight away. You cannot choose the secret yourself, and there is no unsigned option.

Each request carries two headers:

- `X-Intutic-Timestamp` — the send time, in Unix seconds
- `X-Intutic-Signature` — `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw request body>`, keyed with the rule's secret

[SIEM webhook destinations](/guide/siem-export#verifying-webhook-signatures) are signed exactly the same way, so one function verifies both. To verify:

1. Read the raw body exactly as received, before any JSON parsing.
2. Compute the HMAC over the timestamp header, a `.`, and the raw body, and compare it with the signature header in constant time.
3. Refuse the request if the timestamp is older than five minutes (or more than five minutes ahead of your clock), so a captured request cannot be replayed later. A retry is signed again when it is sent, so it carries a fresh timestamp.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyIntuticWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const timestamp = headers['x-intutic-timestamp']
  const signature = headers['x-intutic-signature'] ?? ''
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
```

```python
import hashlib, hmac, time

def verify_intutic_webhook(raw_body: bytes, headers: dict, secret: str) -> bool:
    timestamp = headers.get("x-intutic-timestamp", "")
    signature = headers.get("x-intutic-signature", "")
    if not timestamp or abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, "sha256=" + mac)
```

### Rule Filters

The **Event Type** list offers only the events the control plane sends:

| Event type | Label in the dashboard |
|------------|------------------------|
| `incident.created` | Incident Created |
| `judge.review.queued` | Judge Review Waiting |
| `anomaly.detected` | Anomaly Detected |
| `anomaly.finding` | Detector Finding (incl. advisory): every detector finding, allowed or blocked; pair it with a severity filter |
| `trajectory.alert` | Trajectory Drift Alert |
| `anomaly.capability_miss` | Capability Miss (ungoverned task) |
| `sop.integrity.drift` | Guideline Integrity Drift |
| `sop.stale.detected` | Guideline Went Stale |
| `sop.cascade.invalidated` | Guideline Cascade Invalidated |
| `sop.upstream.changed` | Guideline Changed Upstream |
| `guardrail.ready` | Policy Guardrail Ready to Enforce |
| `guardrail.stale` | Policy Guardrail Citation Went Stale |
| `mcp.server.candidate` | New MCP Server Awaiting Approval |
| `mcp.server.tool_change_risk` | MCP Server Tool Change Scored High Risk |
| `mcp.server.decided` | MCP Server Approved, Blocked or Reset: an owner or admin's decision in the [MCP server registry](/guide/mcp-governance#the-registry); MEDIUM for a block, INFO otherwise |
| `mcp.server.tool_toggled` | MCP Server Tool Switched On or Off: MEDIUM when a tool is switched off, INFO when on |
| `mcp.budget.threshold` | MCP Call Budget Threshold Reached: once per budget per period |
| `mcp.budget.exceeded` | MCP Call Budget Exceeded: once per budget per period, on the first refused call |
| `finops.budget.threshold` | Budget Threshold Reached |
| `finops.budget.exceeded` | Budget Exceeded |
| `plan.deviation.detected` | Plan Deviation Detected |
| `trial.expired_downgraded` | Trial Expired |
| `gateway.stale.detected` | Self-Hosted Gateway Unreachable |
| `device.enforcement.stale` | Device Enforcement Stale |
| `device.enforcement.disabled` | Device Firewall Disabled |
| `governance.gate.silent` | Gate Stopped Reporting: an installed harness's gate, or an SDK gate in regular use, has sent no event for 48 hours |
| `governance.gate.recovered` | Gate Reporting Again |
| `inventory.ungoverned.detected` | Ungoverned AI Tool Found: a machine's [AI inventory](/guide/ai-inventory) listed an ungoverned harness or MCP server for the first time; once per machine and item |
| `governance.integrity.failed` | Trace Integrity Check Failed: the hourly integrity check found a broken root chain, a trace changed after sealing, a mismatched bucket copy, a bad signature or an altered append-only guard. See [Trace Integrity](/concepts/trace-integrity#alerts) |
| `decision.pending` | Held Decision Waiting for Review: a call was held for approval and the hold was recorded; MEDIUM. On Slack the message carries **Approve** and **Reject** buttons (see [Slack interactive reviews](/guide/decisions#slack-interactive-reviews)) |
| `decision.approved` | Held Decision Approved: an owner, admin or engineering manager approved a [held decision](/guide/decisions#slack-interactive-reviews), in Slack or with `intutic decision approve`; MEDIUM, because the held call can now run |
| `decision.rejected` | Held Decision Rejected: the same, for a rejection; INFO |
| `auth.login.failed` | Sign-in Refused: a sign-in to the workspace was refused (wrong password, deactivated member, an SSO identity the workspace does not admit, a response that failed verification). Names the member, or the email presented, the method, the reason and the address; repeats for the same identity and address within the cooldown send once |
| `scim.user.changed` | User Changed via SCIM: your identity provider provisioned, changed or deprovisioned a user; MEDIUM for a deprovisioning, INFO otherwise |
| `scim.group.changed` | Group Changed via SCIM: your identity provider created, changed or deleted a group; MEDIUM for a deletion, INFO otherwise |
| `webhook.secret.rotated` | Webhook Signing Secret Replaced: an owner or admin replaced the signing secret of a notification webhook, a SIEM webhook destination or the GitHub pull-request webhook. Says whose and who, never the secret |
| `evidence.exported` | Compliance Evidence Downloaded: a member downloaded the SOC 2 evidence archive, a framework coverage report as a file, or the human-oversight export; INFO. The [audit timeline](/guide/audit-timeline#what-it-shows) lists each one |

Tick one or more severities (LOW, MEDIUM, HIGH, CRITICAL) to narrow a rule; leave them all unticked to receive every severity.

### Cooldown Throttling

Prevent alert noise by setting a cooldown period (in minutes) for each rule. Consecutive identical alerts inside the cooldown window are suppressed.

The gate and integrity alerts do not rely on the cooldown. **Gate Stopped Reporting** fires once when a gate goes silent, however long it stays silent, and **Gate Reporting Again** fires once when it comes back; a PagerDuty rule on **Gate Reporting Again** resolves the incident the silent alert opened instead of opening a new one. **Gate Reporting Again** is INFO severity, which none of the severity boxes select, so leave them unticked on its rule; the same goes for the other events that can be INFO (registry approvals, SCIM changes, rejections, evidence downloads). **Trace Integrity Check Failed** fires once for each kind of failure while it keeps failing, and again if it clears and recurs.

**Show Delivery Log** lists each time a rule sent, failed or was filtered, with the event and channel.

---

## Integrations {#integrations}

Task trackers, memory providers, file scanning, the GitHub pull-request webhook and SIEM export.

- **Task Management & Alerting** — connect Jira Cloud, PagerDuty, Linear, GitHub Issues or Asana to sync tickets and route governance alerts. **Add Connection** takes the provider, its base URL, an API token or auth secret, and a project key or routing key.
- **Memory Providers** — connect mem0, Supermemory, AgentMemory or a custom HTTP memory service so the `/fix` command can enhance prompts with what your team already knows. Owners and admins add, test and remove providers; every member sees the list. See [Prompt Commands](/guide/agent-commands).
- **VirusTotal Skill Scanning** — opt in to checking the sha256 hash of skill-bundled scripts against VirusTotal; file content is never uploaded. See [VirusTotal Integration](/guide/virustotal-scanning).
- **GitHub Pull Request Webhook** — the payload URL and signing secret for GitHub's pull request events, which map branches to pull requests for cost per pull request without a GitHub token. **Create webhook** makes it; **Replace secret** makes a new secret and keeps the URL. The secret is shown once. Owners and admins, Biz Org and above. See [Cost per pull request](/guide/budgets#cost-per-pull-request).
- **SIEM Export** — stream governance events to Splunk, Datadog, a webhook, syslog/CEF, S3 or GCS; **Add Destination** creates one, and **Sources** on a destination's row changes which events it receives. Biz Org and above: on another plan the card says so, and destinations kept from before a downgrade show as **Paused**. See [SIEM Export](/guide/siem-export#plans).

---

## Related

- [Security & Identity](/guide/security) — Detailed SSO and authentication setup
- [Configuration Reference](/reference/configuration) — Environment variables and workspace settings
