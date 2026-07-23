# SOP Optimizer <Badge type="warning" text="Cloud / Team" />

The SOP Optimizer is a self-optimizing prompt compiler that analyzes historical policy violations and trace logs to automatically refine and optimize SOP instructions.

## What you'll learn

- How the optimizer analyzes underperforming SOP clauses
- How to trigger manual optimization cycles
- How to review and approve optimization proposals
- Feature gating and role requirements

::: info
The SOP Optimizer requires the `feature.metaclaw` flag to be enabled for your workspace. This feature is available on the Enterprise plan.
:::

---

## How the SOP Optimizer Works

The optimizer continuously monitors your SOP enforcement data and identifies rules that aren't performing as intended. It analyzes three key signals:
- **Enforcement patterns** — How often a rule triggers (overly active vs. stale).
- **Compliance scores** — The rate at which developer agent sessions violate or bypass specific rules.
- **Trace logs** — The underlying token prompts and tool calls.

---

## Accessing the Optimizer

Unlike general SOP listings, the optimizer has a dedicated home. Click the **SOP Optimizer** sidebar link (under Governance & Policies) to access the compiler.

### 1. Manual Trigger
While the optimizer runs nightly compiles in the background, you can trigger an immediate evaluation cycle by clicking the **Trigger Optimizer Cycle** button.
- *Rate limits:* Trigger is restricted to once per hour per workspace.
- *Report:* On complete, displays candidates evaluated, proposals created, and runs skipped.

---

## Dashboards

The SOP Optimizer dashboard is divided into two views:

### Run History
Lists all completed optimization runs:
- **SOP Title / Clause Index** — The targeted SOP ID and specific markdown instruction section under audit.
- **Simulated Compliance** — Before/after comparison showing the change in compliance score if the proposal is adopted (e.g. `70% → 95%`).
- **Delta** — The net compliance improvement (runs with a delta < 5% are skipped).
- **Sample Size** — Number of traces evaluated in the simulation.
- **Score** — Semantic alignment rating of the mutated rule.
- **Status** — Displays whether the outcome was `Accepted` or `Rejected`.

### Pending Proposals
Lists all mutations awaiting review:
- **Proposed Title & Rating** — Description and rating score.
- **Reasoning & Simulation Results** — Plain-text explanation of why the rule mutation was recommended.
- **Clause Diff** — A side-by-side comparison of the **Original** clause text vs. the **Optimized** clause text.
- **Actions** — **Approve & Apply** (promotes the mutated clause directly to your active SOP) or **Reject** (dismisses the proposal).

---

## Related

- [SOPs](/guide/sops) — Manage and configure your workspace rules
- [Core Concepts](/guide/concepts) — Understand the governance model and PCAS actions
