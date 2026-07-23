# Review Queue <Badge type="warning" text="Cloud / Team" />

<!-- ENTERPRISE_ONLY_START -->
The Review Queue is where you approve or reject enforcement decisions that Intutic made on behalf of your team. It's the human-in-the-loop checkpoint for AI governance.

## What you'll learn

- When and why decisions appear in the queue
- How to review, approve, or reject a decision
- How to promote a decision into a permanent SOP rule
- Filtering and role requirements

## When decisions appear

A decision enters the Review Queue whenever PCAS applies a **HIJACK** enforcement action. HIJACK means the proxy rerouted or substantially modified an agent's request — for example, downgrading an expensive model to a cheaper alternative or rewriting a prompt to comply with policy.

::: info Not all actions require review
**BYPASS** (pass-through) and **ENHANCE** (minor enrichment) don't require human approval. **KILL** (block) decisions are logged but are immediate — they don't wait in a queue.
:::

## Reviewing a decision

Each decision in the queue shows:

| Field | Description |
|-------|-------------|
| **Original request** | The agent's request before modification |
| **Modification applied** | What the proxy changed (model swap, prompt rewrite, etc.) |
| **Reason** | Why PCAS chose this action (SOP rule, cost policy, anomaly signal) |
| **Trace link** | Link to the full execution trace |
| **Timestamp** | When the decision was made |
| **Model** | The original and modified model (if changed) |

Click on any decision to expand the full detail view, where you can compare the original and modified requests side-by-side.

## Approving or rejecting

After reviewing a decision, you have two options:

### Approve
Confirms the decision was correct. The proxy will continue applying this type of enforcement for similar future requests. Approval feeds into the system's confidence scoring.

### Reject
Marks the decision as incorrect. The proxy takes note and adjusts its enforcement thresholds. You can optionally add a reason for the rejection, which helps refine future PCAS behavior.

::: tip Bulk actions
You can select multiple decisions and approve or reject them in bulk using the checkboxes and the action bar at the top of the queue.
:::

## Promoting to an SOP

If a HIJACK decision represents a rule you want to enforce permanently, you can **promote** it into an SOP:

1. Open the decision detail view
2. Click **Promote to SOP**
3. Intutic pre-fills a new SOP with the rule derived from the decision
4. Edit the title, content, and risk tier as needed
5. Save — the SOP starts in `DRAFT` state for you to review and validate

This is a powerful way to build your governance rules organically from real enforcement patterns.

## Filtering the queue

Use the filter bar to narrow down the queue:

| Filter | Options |
|--------|---------|
| **Status** | `PENDING`, `APPROVED`, `REJECTED` |
| **Date range** | Custom start and end dates |
| **Model** | Filter by the model involved in the decision |

By default, the queue shows `PENDING` decisions sorted newest-first.

## Role requirements

Not everyone on your team can access the Review Queue. Access requires one of these roles:

| Role | Access level |
|------|-------------|
| **OWNER** | Full access — approve, reject, promote, bulk actions |
| **ADMIN** | Full access — approve, reject, promote, bulk actions |
| **EM** | Full access — approve, reject, promote, bulk actions |
| **DEVELOPER** | No access to the Review Queue |
| **VIEWER** | No access to the Review Queue |

::: warning Pending decisions don't block agents
HIJACK decisions are applied immediately. The Review Queue is for after-the-fact review, not a pre-approval gate. If you reject a decision, the system adjusts future behavior — it doesn't undo the original action.
:::

## Slack Interactive Reviews (Enterprise)

When Slack OAuth is configured and `FF_NOTIFICATION_HUB=true` is enabled, pending HIJACK decisions are automatically routed to the Slack team workspace as rich Block Kit cards.

* **Interactive Actions**: Workspace owners and admins can click **Approve** or **Reject** directly from the Slack message card without having to open the dashboard UI.
* **Review Mapping**: Clicking these buttons sends an interactive payload to `/api/v1/adapters/slack/interactions` which updates the control plane's `decision_mining_queue` state.
* **Slack User Mapping**: The control plane maps the interacting Slack member's ID to their corresponding Intutic workspace profile using the `slack_user_mappings` database table to record who made the review decision. If no mapping exists, it defaults to the installation manager or prompts the user to map their profile.

## Related

- [Core Concepts](/guide/concepts) — understand PCAS enforcement actions
- [Agent Guidelines (SOPs)](/guide/sops) — create and manage governance rules
- [How It Works](/guide/how-it-works) — architecture of the enforcement pipeline
<!-- ENTERPRISE_ONLY_END -->
