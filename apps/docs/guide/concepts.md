# Core Concepts <Badge type="tip" text="Open-Core" />

Intutic introduces a handful of key abstractions you'll encounter throughout the platform. This page is your glossary — bookmark it and come back whenever you need a refresher.

## What you'll learn

- The organizational and runtime building blocks of Intutic
- How policies, enforcement, anomaly detection, and scoring fit together
- The role-based access model and budget tiers

## Workspaces

A **workspace** is the top-level organizational unit in Intutic. Everything — harnesses, SOPs, traces, budgets, and team members — lives inside a workspace.

- IDs use the `wk_` prefix (e.g., `wk_abc123`)
- On the **Free** and **Pro** plans you get one workspace; **Team** and **Enterprise** support unlimited workspaces
- Each workspace has its own virtual API key (`vk_*`) that the proxy uses for authentication

::: tip One workspace per repo
Most teams map one workspace to one code repository. This keeps governance rules scoped to the project they apply to.
:::

## Harnesses

A **harness** is any AI coding agent that Intutic governs. Intutic currently supports **18 harnesses**:

| Category | Harnesses |
|----------|-----------|
| IDE agents | Cursor, Windsurf, Continue, Cline, Roo Code, GitHub Copilot |
| CLI agents | Claude Code, Aider, Codex, Goose, Pi |
| Platform agents | Antigravity, OpenHands, n8n, Claude Desktop, Open WebUI |
| Specialized | OpenClaw, Hermes |

The `intutic init` command auto-detects which harnesses are present in your repo and writes governance config into each one's native config file. See [How It Works](/guide/how-it-works) for details on per-harness routing.

## SOPs (Agent Guidelines)

**Standard Operating Procedures** are the policy documents that tell your agents what they can and cannot do. Think of them as enforceable coding standards for AI.

Each SOP has:
- **Title** and **markdown content** — the human-readable rules
- **Risk tier** — `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`
- **Complexity tier** — the task complexity level this SOP targets
- **Dependencies** — other SOPs this one builds on

### SOP lifecycle

SOPs follow a 7-state lifecycle:

| State | Meaning |
|-------|---------|
| `DRAFT` | Initial authoring — not enforced yet |
| `PENDING_REVIEW` | Submitted for team review |
| `GENERATED` | Auto-generated from observed agent patterns |
| `HYPOTHESIZED` | Proposed rule being tested against real traffic |
| `REFINED` | Iteratively improved based on feedback and data |
| `VALIDATED` | Active and enforced by the proxy |
| `INVALIDATED` | Retired or superseded by another SOP |

Only SOPs in the `VALIDATED` state are actively enforced. Learn more in [Standard Operating Procedures](/concepts/sops).

## Enforcement Actions (PCAS)

The **Policy Compliance and Action System** evaluates every LLM request against your active SOPs and applies one of four actions:

| Action | Effect | Example scenario |
|--------|--------|-----------------|
| **BYPASS** | Request passes through unmodified | Fully compliant with all policies |
| **ENHANCE** | Request is enriched (prompt injection, context added) | SOP suggests adding security context to the prompt |
| **HIJACK** | Request is rerouted to a different model | Downgrading `gpt-4o` to `gpt-4o-mini` for a simple task |
| **KILL** | Request is blocked entirely | Budget exceeded, unauthorized tool call, or policy violation |

::: info HIJACK decisions require review
When PCAS applies a HIJACK action, the decision is routed to the human review queue so an administrator can approve or reject it.
:::

## Traces

A **trace** is the audit record of a single LLM request. Every request that flows through the Intutic proxy produces a trace (prefixed `tr_`).

Each trace captures:
- **Model** used and **token counts** (input + output)
- **Cost** in USD
- **Enforcement action** applied (BYPASS / ENHANCE / HIJACK / KILL)
- **Compliance score** — how well the request matched active SOPs
- **Token utility** — classified as `USEFUL` or `WASTED`

Traces are the foundation for cost tracking, anomaly detection, and compliance auditing.

## Reasoning/Thinking Tokens

**Reasoning tokens** (or thinking tokens) are special, non-content tokens generated internally by advanced reasoning models (e.g. Claude 3.7 Sonnet thinking mode, OpenAI o1/o3 series) during deep-thinking cycles.
* Intutic's proxy automatically extracts these tokens (`token/reasoning_extractor.rs`) to report actual raw vs. reasoning cost proportions in the trace ledger.
* Tracking reasoning tokens helps teams evaluate where agents spent computation time vs. where they output final code structure.

## Token Waste Classification

The Autonomous Reasoning Engine (ARE) auto-classifies trace data to identify inefficient token consumption. It applies **5 waste heuristic rules** (`wasteClassificationService.ts`):
1. **Scaffolding waste** — redundant folder scans and boilerplate prints.
2. **Context bloat** — sending excessively large file reads repetitively.
3. **Loop waste** — repeating identical tool arguments.
4. **Model capability waste** — using staff-grade models for junior tasks.
5. **No-op waste** — calling tools that result in zero-length changes or redundant state checks.

Traces flagged with high waste metrics trigger automated configuration optimizations via the SkillOpt feedback loop.

## Anomaly Detection (ARE)

The **Autonomous Reasoning Engine** monitors agent sessions in real time and flags suspicious behavior across **12 anomaly types**:

| Anomaly | What it catches |
|---------|----------------|
| `TOOL_ABUSE` | Excessive or inappropriate tool calls |
| `TOKEN_WASTE` | Inefficient token usage patterns |
| `LOOP_DETECTED` | Agent stuck in a retry/repeat loop |
| `UNAUTHORIZED_TOOL` | Calling tools outside the allowed set |
| `DATA_EXFILTRATION` | Attempting to leak sensitive data |
| `PROMPT_INJECTION` | Malicious prompt manipulation |
| `HALLUCINATION` | Model generating fabricated information |
| `SCOPE_VIOLATION` | Operating outside the defined task scope |
| `BUDGET_BREACH` | Exceeding the allocated session budget |
| `SPAWN_BUDGET_BREACH` | Sub-agent spawning over limits |
| `WORKFLOW_BUDGET_BREACH` | Multi-step workflow over budget |
| `WORKFLOW_GOAL_DRIFT` | Workflow deviating from its stated objective |

When the ARE flags an anomaly, it can trigger a `KILL` enforcement action and open a governance incident.

## Trust Scores

Every agent session receives a **trust score** — a numerical reliability rating that tracks how well the agent follows governance rules over time. Trust scores factor into enforcement decisions: a session with a declining trust score may trigger stricter PCAS actions.

## Compliance Scores

Each trace receives a **compliance score** indicating how closely the request aligned with active SOPs. High compliance scores mean the agent is working within policy. Low scores trigger review and may feed back into SOP refinement.

## Budget Tiers

Budget tiers control how much each developer can spend on LLM calls. They map to seniority levels:

| Tier | Intended for |
|------|-------------|
| `JUNIOR` | Junior developers — lowest budget ceiling |
| `SENIOR` | Senior developers |
| `STAFF` | Staff engineers |
| `PRINCIPAL` | Principal engineers — highest budget ceiling |

Exceeding your tier's budget triggers a `BUDGET_BREACH` anomaly and a `KILL` enforcement action. Budget caps are enforced per developer session.

## RBAC Roles

Intutic uses role-based access control with five roles:

| Role | Permissions |
|------|------------|
| **OWNER** | Full access — billing, workspace deletion, all admin actions |
| **ADMIN** | Manage SOPs, review queue, team members, settings |
| **EM** | Engineering manager — review queue access, SOP approval, read-only settings |
| **DEVELOPER** | View traces, view SOPs, manage own budget tier |
| **VIEWER** | Read-only access to dashboard and traces |

::: warning Role assignment
Only OWNER and ADMIN roles can assign or change roles for other team members.
:::

## How it all fits together

```
Harnesses → Proxy Gateway → PCAS (evaluates SOPs) → Enforcement Action
                                    ↓
                              ARE (anomalies)
                                    ↓
                        Traces → Compliance Scores → Trust Scores
```

Your SOPs define the rules. PCAS enforces them. The ARE watches for anomalies. Traces record everything. Scores summarize it all.

## Next steps

- [Getting Started](/guide/getting-started) — install the CLI and set up your first workspace
- [How It Works](/guide/how-it-works) — deep dive into the architecture
- [Custom Filters (WASM)](/external/wasm-rules) — custom tool-call filtering policy hooks
- [CLI Reference](/reference/cli) — command line configuration and diagnostics
