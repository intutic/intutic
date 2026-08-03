# Dashboard <Badge type="warning" text="Cloud / Team" />

<!-- ENTERPRISE_ONLY_START -->
The Intutic dashboard is a Vite + React 19 SPA that provides real-time visibility into your AI agent governance.

## Overview

The dashboard runs on port `5174` in local development and connects to the control plane API at `/api/v1/`.

## Widgets

### Usage Summary

Shows aggregated usage metrics for your workspace:
- **Total tokens** consumed across all models
- **Total cost** in USD
- **Period selection** — daily, weekly, or monthly aggregation
- **Date range picker** — custom start/end dates

Data comes from `GET /api/v1/usage/summary` with `period`, `start`, and `end` query parameters.

### Model Breakdown

A per-model cost breakdown showing which LLMs are consuming your budget:
- Model name and provider
- Token count and cost per model
- Percentage of total spend

Data comes from `GET /api/v1/usage/models` with a `period` parameter (`daily` or `monthly`).

### Enforcement Actions

Real-time view of PCAS enforcement decisions:
- **BYPASS** count — requests that passed through cleanly
- **ENHANCE** count — requests that were enriched
- **HIJACK** count — requests rerouted to different models
- **KILL** count — requests that were blocked

### Trace Timeline

A paginated list of execution traces showing:
- Trace ID
- Timestamp
- Model used
- Input/output token counts
- Cost in USD
- Enforcement action applied
- Token utility classification (USEFUL / WASTED)

Data comes from `GET /api/v1/usage/events` with `page`, `limit`, and optional `session_id` parameters.

### Trace Integrity

Sits on the Traces page, directly below the trace list, and covers two separate
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
| **Nothing verified — no snapshots** | The workspace has no config snapshots. Amber, never green: an absent chain is not a clean one. If configs should be captured here, the sync daemon is not reaching the control plane. |
| **_n_ broken links** | A snapshot names a predecessor that is not the snapshot before it — what deleting a snapshot leaves behind. Both ends are named: the snapshot doing the naming, the hash it named, and the snapshot that actually precedes it. |
| **_n_ content mismatches** | A stored body no longer hashes to the `content_hash` recorded with it — the body was rewritten in place. |

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

### Agent Guidelines (SOP Registry)

Lists all SOPs in your workspace with:
- Title and current lifecycle state
- Risk tier (LOW / MEDIUM / HIGH / CRITICAL)
- Complexity tier
- Version history
- Dependency graph

Filterable by lifecycle state, risk tier, and complexity tier via `GET /api/v1/sops`.

### Anomaly Feed

Real-time anomaly alerts from the Autonomous Reasoning Engine (ARE):
- Anomaly type (12 categories)
- Severity level
- Affected session and trace
- Recommended action

### Incident Tracker

Governance incidents with lifecycle management:
- Status: `OPEN` → `ACKNOWLEDGED` → `RESOLVED` or `FALSE_POSITIVE`
- Linked traces and anomalies
- Resolution notes

### Trust Scores

Per-session trust scores showing agent reliability over time.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `r` | Refresh current view |
| `t` | Jump to traces |
| `s` | Jump to SOPs |

## Accessing the Dashboard

### Local Development

```bash
cd apps/dashboard
npm run dev
# → http://localhost:5174
```

### Production

The dashboard is deployed alongside the control plane and available at your workspace URL.

---

## Member Management & Onboarding

Workspace administrators manage users and team access under the **Settings > Members** panel:
* **Direct Provisioning**: Intutic uses direct user provisioning. Instead of emailing invitation tokens, admins directly input a display name, role, and temporary password.
* **Temporary Passwords**: The secure temporary password is auto-generated by the UI. Admins copy this password and share it manually with the invitee, maintaining zero external mail server dependencies.
* **Roles**: Roles are aligned with platform capabilities:
  - `ADMIN`: Full system control and billing configuration access.
  - `EM` (Engineering Manager): Read/write access to SOPs, budgets, and dashboards.
  - `DEVELOPER`: Read-only access to dashboard data and full connection rights for the CLI sync daemon.
  - `VIEWER`: Read-only access to telemetry summaries.
<!-- ENTERPRISE_ONLY_END -->

