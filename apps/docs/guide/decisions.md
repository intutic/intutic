# Review Queue <Badge type="tip" text="Cloud" />

<!-- ENTERPRISE_ONLY_START -->
**Findings › Review Queue** (`/findings/review`) is where a person reviews what Intutic's guardrails stopped, what runs are waiting on, and what the governance judge could not decide alone. It's the human-in-the-loop checkpoint for AI governance.

## What you'll learn

- The three tabs: Override Requests, Held Changes and Judge Reviews
- How each kind of item is approved, rejected or ruled on
- Filtering and role requirements

## Override Requests

Agent actions a guardrail intercepted. Two kinds of entry land here:

- A **review hold**: a harness's pre-execution hook held the action before it ran. Nothing ran instead.
- A **substitution**: the proxy rewrote a tool call, for example when output DLP redacted a secret from its arguments. The corrected call is the one that ran, so the entry is a record rather than a request, marked **Auto-enforced**.

::: info Not every action reaches the queue
**BYPASS** (pass-through) and **ENHANCE** (minor enrichment) never appear here. A **KILL** (block) is logged as it happens and does not wait in a queue.
:::

### Reviewing an override request

The table lists each entry's **Alert** id, what was **Requested by the agent**, **What ran instead** ("Blocked — no replacement" for a hold), its **Review state** and the time. Click a row to open the drawer, titled **Alert** and the entry id. It shows:

| Field | Description |
|-------|-------------|
| **Session** | The agent session the action came from |
| **Time** | When the guardrail acted |
| **Requested action (agent)** | The tool call the agent asked for |
| **Enforced safe action (hijacked)** or **Action blocked, no replacement** | The call that ran instead, or, for a hold, a note that nothing ran |
| **Why the guardrail acted** | The rationale recorded with the entry |

### Approving or rejecting

Override requests are approved or rejected from their **Slack notification**, with [`intutic decision approve|reject`](/reference/cli#intutic-decision-approve), or through the API, not from the dashboard; the outcome then shows here.

```
POST /api/v1/decisions/:entryId/review
{ "action": "approve" }   # or "reject", with an optional "reason"
```

All three take the same path and need the OWNER, ADMIN or EM role. The reviewer is recorded as the member: the authenticated member for the CLI and the API, the linked member for Slack. Approving a review hold lets the identical retry pass only while the workspace's review-hold bypass (`reviewHoldBypassEnabled`, off by default) is on, for `reviewHoldBypassTtlMinutes` (10 by default); otherwise it records the decision.

### Filtering by review state

Above the table, the **Review state** tabs pick which entries to show: **Pending Review** (the default), **Approved**, **Rejected** and **Promoted to SOP**. There are no other filters.

### Repeat exceptions

Below the table, **Repeat exceptions** adds up the intercepts so far: the number of **Intercepts**, the share **Approved** and **Rejected**, and a **Recommendation**, for example to relax a threshold that produces too many false positives, or to refine the SOP behind it.

## Held Changes

Runs stopped mid-flight because an SOP declared the action needed a human first, with `review_before:` (for example `review_before: action:deploy`). Nothing is held unless an SOP asks for it. Each card shows why the run was held, when, who started it, and the change manifest: every operation, target and tool it was about to run, riskiest first.

- **Approve and resume** lets the run continue.
- **Reject and stop** kills the run where it was held. Nothing it was about to change is applied, and it cannot be resumed. The dashboard asks you to confirm.

See [Session Safety & Budgets](/guide/loops).

## Judge Reviews

Agent responses the governance judge could not decide on its own. The judge's interim verdict has already answered the agent; your ruling decides whether an incident stands. Each card shows the SOP it is most likely about, the judge's score, the interim verdict (flagged or passed) and the response excerpt.

- **Violation** opens an incident.
- **Clean** closes the incident the interim verdict opened.

**How to rule** sets out the rule reviewers apply: rule on what the response itself did, not on what the agent might do next. Above the queue, **Reviews by SOP** counts the reviews waiting and ruled for each SOP, and marks an SOP whose reviews are mostly ruled clean as one to consider rewording.

## Role requirements

Not everyone on your team can access the Review Queue. Access requires one of these roles:

| Role | Access level |
|------|-------------|
| **OWNER** | Full access to all three tabs |
| **ADMIN** | Full access to all three tabs |
| **EM** | Full access to all three tabs |
| **DEVELOPER** | No access to the Review Queue |
| **VIEWER** | No access to the Review Queue |

## Slack Interactive Reviews (Enterprise)

When Slack OAuth is configured and `FF_NOTIFICATION_HUB=true` is enabled, pending override requests are automatically routed to the Slack team workspace as rich Block Kit cards.

* **Interactive Actions**: Workspace owners, admins and engineering managers can click **Approve** or **Reject** directly from the Slack message card without having to open the dashboard UI. A Slack approval is the same review as `intutic decision approve`: it records the decision, and lets the identical retry pass only while the workspace's review-hold bypass is on.
* **Linked accounts only**: The click counts only from a Slack account linked to an active member of the workspace (**Settings › Notifications › Link your Slack account**, then `/intutic link <code>` in Slack), and is recorded against that member. An unlinked account, or a member without one of those roles, is refused, and Slack tells the person why.
* **Review Mapping**: Clicking these buttons sends an interactive payload to `/api/v1/adapters/slack/interactions`, which reviews the decision in the workspace the Slack app is installed for.

## Related

- [Core Concepts](/guide/concepts) — understand PCAS enforcement actions
- [Agent Guidelines (SOPs)](/guide/sops) — create and manage governance rules
- [How It Works](/guide/how-it-works) — architecture of the enforcement pipeline
- [Governed Decisions Log](/guide/decisions-log) — surfaces decisions made here directly as context your coding agent reads
<!-- ENTERPRISE_ONLY_END -->
