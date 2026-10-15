# Dashboard <Badge type="tip" text="Cloud" />

<!-- ENTERPRISE_ONLY_START -->
The Intutic dashboard is a Vite + React 19 SPA that provides real-time visibility into your AI agent governance.
The dashboard runs on port `5174` in local development and connects to the control plane API at `/api/v1/`.

## Overview

**Overview** is the first area in the sidebar, and the page it opens is headed
**Dashboard**: what your agents did, what Intutic stopped, and what it cost.

### Workspace at a glance

A strip of five figures sits above every tab, most urgent first:

| Figure | What it shows |
|--------|---------------|
| **Anomalies** | Anomalies in the last 24 hours |
| **Budget used** | Spend against the workspace budget, as a percentage and in dollars; amber from 70%, red from 90% |
| **SOPs enforced** | Guidelines a runtime gate enforces, out of all guidelines. Advisory guidelines (synced into the agent's context, but with no gate that blocks) are counted separately |
| **Active sessions** | Agent sessions running now |
| **Sandboxed runs** | Sessions that ran in a sandbox in the last 30 days |

### Overview & System Success

- **Agent Success Rate** — the share of agent actions each day that finished without an error or a policy violation.
- **Share Scorecard** — this period's success, savings and adherence as an image: **Download PNG**, or **Copy to Clipboard** to paste into a message.

### Cost & Token Efficiency

- **Cost Savings** — what prompt caching and model routing saved against the cost of the requests as sent (Raw Cost against Actual Cost). Runaway spend averted by blocked sessions is shown on its own line, marked as extrapolated, and never added to the savings figure.
- **Token Efficiency by Model** — input and output tokens per model, and the tokens spent on traces scoring below 0.8 SOP compliance.
- **Token Spend by Compliance** — tokens on traces scoring under 0.8 compliance against the rest of the window. When the compactor has trimmed tool output, a note under the chart gives the bytes trimmed; that saving shows up in the next turn's prompt.
- **Cost by Virtual Key** — cost, raw cost and calls per virtual key, today or this month. Mint one key per traffic class (desktop, CI, production) under **Settings › Security › Virtual API Keys** to split cost by class.
- **Cost by Developer**, **Cost by Team**, **Cost by Branch** and **Cost by Pull Request** — fleet cost, today or this month, on Biz Org and above; Cost by Team is for Owners, Admins and Engineering Managers. See [Budgets & FinOps](/guide/budgets#dashboard-widgets).

### Governance & Guidelines

- **SOP Adherence Trend** — the share of agent runs each day that followed every active SOP, against the workspace threshold.
- **Recurring Failures** — failures and policy exceptions that keep happening, most frequent first, with a count and severity.
- **Recent Incidents** — the latest governance incidents across the workspace.
- **Team Leaderboard** — members ranked by SOP adherence and token efficiency over their agent sessions.

### Spend

Owners, Admins and Engineering Managers only. One period (24h, 7d or 30d) applies to both sections:

- **Inefficient Spend** — tokens and money spent on requests that did not need them: wasted cost, wasted tokens, traces analyzed, and a table of waste patterns. The one pattern computed today is the oversized prompt; see [Token Waste Patterns](/guide/intelligence#token-waste-patterns).
- **Shadow Routing Savings** — what shadow routing would have picked against what was actually routed, and what it would have cost at list price, by model pair.

See [Intelligence Engine](/guide/intelligence) for how these figures are computed.

Below the tabs, a card links to the setup guide for [Kitkat](/integrations/kitkat), the governed agentic developer skill, and offers its `SKILL.md` for download.

## Where the rest lives

The other areas carry what used to sit on the dashboard itself:

- **Traces** — **Activity › Traces** (page heading **Activity Logs**). See [Activity Logs](/guide/traces).
- **Agent Guidelines** — **Policies › Agent Guidelines**. See [Agent Guidelines](/guide/sops).
- **Anomalies and incidents** — **Findings › Incidents**, whose tabs include **Anomalies** and **Drift Alerts**. Incidents move through `OPEN`, `RESOLVED` and `AUTO_RESOLVED`, and the list filters by status, severity and [type](/guide/concepts#incident-types).
- **Trust scores** — **Developer Trust Scores**, per developer, on **Activity › Developer Sessions**. See [Developer Sessions](/guide/agent-top).

### Trace Integrity

Sits on **Activity › Traces**, directly below the trace list, and covers two separate
records: the sealed Merkle roots over what an agent *did*, and the harness config
snapshot chain over what it was *told to do*. They are shown together and never
merged into one verdict — each can be tampered with independently, and the
remedies differ.

**Sealed roots.** One row per root from `GET /api/v1/integrity/roots`, newest
first (the server caps the page at 50). The Signature column on an unchecked row
reports only whether the key the root names is published — the listing does not
carry the signature itself, so *"Key published"* is the strongest true statement
available before a check, and *"Unverifiable — key not published"* is amber
rather than red because it is a key-retention gap, not a rejected signature.

**Verify** re-derives one root: it reads `GET /api/v1/integrity/roots/{rootId}`
and `POST /api/v1/integrity/roots/{rootId}/recompute`, then checks the signature
**in the browser** against `/.well-known/intutic-trace-signing.json`. The verdict
is `Match`, `Mismatch`, or `Missing traces`, and a failing verdict names the
trace ids rather than only counting them.

**Harness config snapshot chain.** A second block under the roots table, from
`GET /api/v1/integrity/config-chain` — the same walk `intutic integrity
config-chain` runs, in the same vocabulary. It checks both halves of the chain,
and reports what it finds as one of four states:

| State | What it means |
|-------|---------------|
| **Intact** | Across the walked snapshots, every one names the snapshot that actually precedes it and every stored body still hashes to its recorded `content_hash`. |
| **Nothing verified — no snapshots** | The workspace has no config snapshots. Amber, never green: an absent chain is not a clean one. `intutic connect` captures snapshots of each harness rules file; a connected workspace with none has a daemon that is not reaching the control plane. |
| **_n_ broken links** | A snapshot names a predecessor that is not the snapshot before it — what deleting a snapshot leaves behind. Both ends are named: the snapshot doing the naming, the hash it named, and the snapshot that actually precedes it. |
| **_n_ content mismatches** | A stored body no longer hashes to the `content_hash` recorded with it — the body was rewritten in place. |

Snapshots captured with **Upload config file content** off carry no text. Their links are checked
like any other's; their content cannot be re-hashed, because it was never uploaded, and the panel
says how many there were without counting them as a finding. See
[Config content upload](/reference/cli#config-content-upload).

A break and a content mismatch are reported as **separate findings**, with their
own counts, even when both are present. They have different causes and different
remedies, and a link walk alone cannot see an edited body just as a re-hash alone
cannot see a deleted snapshot.

Two states deliberately do **not** read as failures. A snapshot naming no
predecessor mid-chain is reported below the verdict as a gap, not a break —
nothing was claimed, so nothing contradicts, though a deletion at that point
would go unseen. And when snapshots older than the most recent 500 fall outside
the walk, the panel says so: an intact window is not an intact history.

::: tip A 409 here is an answer, not an outage
`/api/v1/integrity/config-chain` returns **409** precisely when it found a break
or an edited body, with the walk in the response body. The panel renders that as
a finding. The "Could not walk the config snapshot chain" card appears only for a
request that genuinely failed — and it carries no verdict, because an unreachable
control plane says nothing about the chain.
:::

Concepts and the underlying construction: [Trace integrity](/concepts/trace-integrity).

## Keyboard Shortcuts

The dashboard has no global shortcuts. Two lists take single-key shortcuts while no text field has focus:

| Where | Key | Action |
|-------|-----|--------|
| **Findings › Findings** | `j` / `k` (or ↓ / ↑) | Move to the next / previous finding |
| | `t` | Rule the selected finding a true positive |
| | `f` | Rule the selected finding a false positive |
| **Policies › Policy Guardrails › Review** | `j` / `k` (or ↓ / ↑) | Move to the next / previous guardrail |

## Signing in {#signing-in}

The sign-in page offers a password or an emailed sign-in link:

- **Password**: enter your email and password and click **Sign In**. More than 10 attempts for one address within 15 minutes are refused until the window passes.
- **Sign-in link**: click **Use a sign-in link instead**, enter your email and click **Send sign-in link**. The link is valid for 15 minutes and works once; opening it again shows **Verification Failed**, and you request a new one. The page says the email was sent whether or not the address has an account.
- **GitHub and Google**: **Continue with GitHub** and **Continue with Google** appear only when the deployment has them configured.
- **SSO**: enter the **SSO provider ID** your admin gave you and click **Continue with SSO**. See [Single Sign-On](/guide/security#single-sign-on-sso).

**Sign-up.** **Create one** opens **Create your account**: your name, email, a password of at least 8 characters, a workspace name and an unticked box, **I am 18 or older and agree to the Terms and the Privacy Policy**. **Create Account** and the GitHub and Google buttons stay off until the box is ticked; the control plane refuses an account without it (400 `TERMS_NOT_ACCEPTED`) and records on the new member when it was ticked and which version of the terms it covered. **Create Account** creates the account and its first workspace, on a free trial, and signs you in. Signing in with GitHub or Google from the sign-in page does not create an account: a first-time GitHub or Google user signs up from **Create your account**. Sign-up works only on a deployment that has self-serve sign-up turned on; otherwise it is refused. A self-hosted deployment has no sign-up: an owner invites you.

**Members an administrator adds.** A member who is invited, provisioned through SCIM or created at their first SSO sign-in sees no sign-up form and ticks no box: they use the service under their organization's agreement, which the workspace owner accepted at sign-up.

**Updated terms.** When the Terms or the Privacy Policy change materially, workspace owners are emailed at least 30 days before the change takes effect, and a member who accepted the earlier version sees a notice in the dashboard with the date. From that date the dashboard asks them to tick the same box to accept the new version, or sign out.

**Email verification.** Signing up also sends a verification email. Its link is valid for 24 hours and works once. An expired link offers **Resend verification email**; a link that was already used says so.

**Forgotten password.** **Forgot password?** opens **Reset Password**, which emails the same one-time sign-in link. Once signed in, set a new password under **Settings › General › Change Password**.

## Accessing the Dashboard

### Local Development

```bash
cd apps/dashboard
pnpm dev
# → http://localhost:5174
```

### Production

The dashboard is deployed alongside the control plane and available at your workspace URL.

---

## Member Management & Onboarding

Workspace administrators manage users and team access under **Settings › Team Members**, in the **Members** card:
* **Direct Provisioning**: Intutic uses direct user provisioning. Instead of emailing invitation tokens, admins directly input a display name, email address and role.
* **Temporary Passwords**: The secure temporary password is auto-generated by the UI. Admins copy this password and share it manually with the invitee, maintaining zero external mail server dependencies.
* **Roles**: Roles are aligned with platform capabilities:
  - `ADMIN`: Full system control and billing configuration access.
  - `EM` (Engineering Manager): Review queue, hold approvals and killing runs, the cost views, and read-only settings; SOPs and budgets are changed by Owners and Admins.
  - `DEVELOPER`: Read-only access to dashboard data and full connection rights for the CLI sync daemon.
  - `VIEWER`: Read-only access to telemetry summaries.
<!-- ENTERPRISE_ONLY_END -->

