# SOP Optimizer <Badge type="warning" text="Biz Org+" />

The SOP Optimizer is a self-optimizing prompt compiler that analyzes historical policy violations and trace logs to automatically refine and optimize SOP instructions.

## What you'll learn

- How the optimizer analyzes underperforming SOP clauses
- How to trigger manual optimization cycles
- How to review and approve optimization proposals
- Feature gating and role requirements

::: info
The SOP Optimizer needs a plan that includes it (Biz Org, Enterprise and Self-host, and during a trial) and the `ff_metaclaw_evolution` [workspace setting](/reference/workspace-settings) turned on. Without both, cycles are skipped and **Run optimizer** returns 403.
:::

---

## How the SOP Optimizer Works

The optimizer continuously monitors your SOP enforcement data and identifies rules that aren't performing as intended. It analyzes three key signals:
- **Enforcement patterns** — How often a rule triggers (overly active vs. stale).
- **Compliance scores** — The rate at which developer agent sessions violate or bypass specific rules.
- **Trace logs** — The underlying token prompts and tool calls.

An hourly background sweep runs an evaluation cycle for every eligible workspace automatically. This scheduled path is **proposal-only** — it always generates candidate proposals for human review, regardless of your workspace's auto-apply setting.

### What auto-apply applies

Only a manually triggered cycle (below) can apply a proposal without review, and only when all three hold:

- your workspace has the `ff_metaclaw_auto_apply` setting on;
- the proposal's score reaches the auto-approve threshold;
- the [change classification](/guide/sops#change-classification) of the rewritten guideline is `STRENGTHEN`: it adds a safety rule, removes none, and is not more than a fifth shorter.

Every other proposal — `WEAKEN`, `CLARIFY`, `NARROW`, or one the classifier could not classify — stays in **Pending Proposals** for a person, with its classification and the reason on the card. If classification fails, nothing is applied. An applied change becomes the next version of the guideline in the same lifecycle state (a `VALIDATED` guideline stays enforcing, at the next patch version), the version it replaces is retired, and both carry an audit row with the actor `system:metaclaw`. It never leaves an unreviewed draft in force.

---

## Accessing the Optimizer

Unlike general SOP listings, the optimizer has a dedicated home: **Labs › SOP Optimizer** (`/labs/sop-optimizer`; Owners, Admins and Engineering Managers, on a plan that includes it).

### 1. Manual Trigger
While the optimizer runs hourly compiles in the background, Owners and Admins can trigger an immediate evaluation cycle by clicking **Run optimizer**. They also have **Mine incidents**, which drafts amendments from recent incidents.
- *Rate limits:* Trigger is restricted to once per hour per workspace, independently of the background sweep's own hourly cadence.
- *Report:* On complete, displays candidates evaluated, proposals created, proposals applied (strengthening changes only, see [What auto-apply applies](#what-auto-apply-applies)), and runs skipped.
- *Incident mining:* with the approval mode on **auto**, drafts scoring at or above the threshold are marked auto-approved and leave the review queue. None is written into a guideline; only an approval does that.

---

## Dashboards

The SOP Optimizer page has two tabs. **Pending Proposals** (with the count of proposals waiting) opens first; **Run History** is the second.

### Run History
Lists all completed optimization runs:
- **Guideline** — The targeted SOP and the clause index of the markdown instruction section under audit.
- **Simulated Compliance** — Before/after comparison showing the change in compliance score if the proposal is adopted (e.g. `70% → 95%`).
- **Delta** — The net compliance improvement (runs with a delta < 5% are skipped).
- **Sample Size** — Number of traces evaluated in the simulation.
- **Score** — Composite score: 70% the compliance gain, 30% sample-size confidence. Rejected runs score 0.
- **Status** — Displays whether the outcome was `Accepted` or `Rejected`.

### Pending Proposals
Lists all mutations awaiting review. **Proposal source** filters them: All, LLM-evolved, Incident-mined or Health scan.
- **Proposed title and score** — With a badge for its source.
- **Why, and how it scored** — Plain-text explanation of why the rule mutation was recommended, and for an optimizer proposal its change classification and why it was not applied automatically. Incident-mined and health-scan proposals also show their incident count and threat score.
- **Clause Diff** — A side-by-side comparison of the **Original** clause text vs. the **Optimized** clause text.
- **Actions** — **Approve & Apply** (promotes the mutated clause directly to your active SOP) or **Reject** (dismisses the proposal). Only Owners and Admins can approve or reject.

---

## Related

- [SOPs](/guide/sops) — Manage and configure your workspace rules
- [Core Concepts](/guide/concepts) — Understand the governance model and PCAS actions
