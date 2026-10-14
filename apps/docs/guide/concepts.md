# Core Concepts <Badge type="tip" text="Open-Core" />

Intutic introduces a handful of key abstractions you'll encounter throughout the platform. This page is your glossary — bookmark it and come back whenever you need a refresher.

## What you'll learn

- The organizational and runtime building blocks of Intutic
- How policies, enforcement, anomaly detection, and scoring fit together
- The role-based access model and budget tiers

## Workspaces

A **workspace** is the top-level organizational unit in Intutic. Everything — harnesses, SOPs, traces, budgets, and team members — lives inside a workspace.

- IDs use the `ws_` prefix (e.g., `ws_V1StGXR8_Z5jdHi6B-myT`)
- A personal account has one workspace. An organization on **Biz Org**, **Enterprise** or **Self-host** can create more teams, each with its own workspace (5, 25 and unlimited)
- Virtual API keys (`vk_*`) belong to one workspace; each member creates their own, and the proxy uses them for authentication

::: tip One workspace per repo
Most teams map one workspace to one code repository. This keeps governance rules scoped to the project they apply to.
:::

## Harnesses

A **harness** is any AI coding agent that Intutic governs. Intutic ships **43 harness adapters**, and the headline count is the same **43 supported harnesses** — no adapter carries an open support gap today (AutoGen's closed with its workbench gate and the Agentic Orchestrator's with OpenCode's own adapter, both in September 2026) — 42 adapters auto-detected and config-synced by `intutic init`/`intutic connect` (some write directly into a generated hook file, others write `.env.intutic` pointing at a dedicated SDK-side gate (`@intutic/gate` / `intutic-clawde`) that lives in your own code), plus 1 that is operator-deployed rather than repo-detected (see the bridge-gated row below):

| Category | Harnesses |
|----------|-----------|
| IDE agents | Cursor, Windsurf, Continue, Cline, Roo Code, GitHub Copilot |
| CLI agents | Claude Code, Aider, Codex, Goose, Pi, Grok Build, Muse Code, OpenCode, dsh (preview) |
| Platform agents | Antigravity, OpenHands, n8n, Claude Desktop, Open WebUI |
| Specialized | OpenClaw, Hermes, LangGraph |
| Orchestrators (delegate to already-gated harnesses) | Spotify Xirp, DoorDash Agentic Orchestrator, AWS Bedrock AgentCore Runtime |
| SDK-gated frameworks (`@intutic/gate` / `intutic-clawde`; `.env.intutic` points at the SDK gate instead of a generated hook file) | LangChain, CrewAI, AutoGen, AG2, Google ADK, OpenAI Agents SDK, Pydantic AI, smolagents, AWS Strands Agents, Microsoft Agent Framework, Mastra, Vercel AI SDK, eve, TrueForge (embedded), AI SDK Harness, AI SDK Workflow |
| Bridge-gated (out-of-process Intutic-operated service; not auto-detected by `intutic init` — operator-deployed instead) | TrueForge (standalone/hosted server — `services/trueforge-bridge`) |

The `intutic init` command auto-detects which harnesses are present in your repo and writes governance config into each one's native config file. See [How It Works](/guide/how-it-works) for details on per-harness routing.

A separate, smaller set of **server-side platform integrations** — QM, Anthropic Managed Agents, and AWS Bedrock AgentCore Gateway — call Intutic directly over HTTP as part of their own contract. They have no `HarnessType` and are not detected by `intutic init`; see the [Integrations Hub](/integrations/#server-side-platform-integrations) for details.

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
| `GENERATED` | Passed the Gödel score check on the way out of review |
| `HYPOTHESIZED` | Proposed rule being tested against real traffic |
| `REFINED` | Iteratively improved based on feedback and data |
| `VALIDATED` | Active and enforced by the proxy |
| `INVALIDATED` | Retired or superseded by another SOP |

Only SOPs in the `VALIDATED` state are actively enforced. Learn more in [Standard Operating Procedures](/concepts/sops).

## Enforcement Actions (PCAS)

The **Policy Compliance and Action System** evaluates every LLM request against your active SOPs and applies one of five actions. The rules that choose an action are SOPs, policy guardrails, custom filters and the detectors.

| Action | Effect | Example scenario |
|--------|--------|-----------------|
| **BYPASS** | Request passes through unmodified | Fully compliant with all policies |
| **ENHANCE** | Request passes through unmodified, with governance metadata attached. A policy and evaluator action: the proxy records no ENHANCE trace | A detector raises an advisory finding |
| **HIJACK** | Request is modified or steered before it proceeds (a corrective notice for the agent, a redacted credential) | A detector finding steers the agent back toward its SOP |
| **REASK** | The attempt is refused and the reason handed back to the agent, which may retry a bounded number of times before it escalates to a block | An agent repeating the same call in a loop |
| **KILL** | Request is blocked entirely | Budget exceeded, unauthorized tool call, or policy violation |

::: info HIJACK is applied, not proposed
A HIJACK takes effect without waiting for anyone: the steered or redacted call proceeds. A tool call the response DLP rewrote is recorded as an enforced decision, for audit, with nothing to approve. A call that must wait for a person's approval is a hold (a `REQUIRE_APPROVAL:` rule), not a HIJACK.
:::

## Traces

A **trace** is the audit record of a single LLM request. Every request that flows through the Intutic proxy produces a trace, identified by a UUID.

Each trace captures:
- **Model** used and **token counts** (input + output)
- **Cost** in USD
- **Enforcement action** applied (BYPASS / ENHANCE / HIJACK / REASK / KILL, or OBSERVED when the provider itself failed)
- **Compliance score** — how well the request matched active SOPs
- **Token utility** — classified as `USEFUL` or `WASTED`

Traces are the foundation for cost tracking, anomaly detection, and compliance auditing.

## Reasoning/Thinking Tokens

**Reasoning tokens** (or thinking tokens) are special, non-content tokens generated internally by advanced reasoning models (e.g. Claude 3.7 Sonnet thinking mode, OpenAI o1/o3 series) during deep-thinking cycles.
* The proxy records the provider's own count of them on the trace as `reasoningTokens`, where the provider reports one: OpenAI's `reasoning_tokens` (Chat Completions and Responses) and Gemini's `thoughtsTokenCount`. They are part of the output tokens and priced with them, never added on top. Anthropic counts thinking inside `output_tokens` and reports no breakdown, so its traces carry none.
* Tracking reasoning tokens helps teams evaluate where agents spent computation time vs. where they output final code structure.

## Token Waste Classification

The Intelligence Engine classifies trace data to identify inefficient token consumption. `wastePatternService.ts` computes **one waste pattern**, derived from columns that exist on `execution_traces`, and it carries a confidence reflecting how it was derived — so the UI never presents an inference as a measurement:
- **Oversized prompt** (heuristic, confidence 0.6) — traces whose raw input exceeds 3× the workspace median, with the excess over three times the median attributed as waste. A legitimately large task looks the same, hence the reduced confidence.

A second pattern, **context bloat** (raw minus compressed input tokens), has been removed: the proxy writes those two figures equal on every trace path, so it could never fire. The compactor's real saving is reported separately, in bytes, and is not counted as waste.

Traces flagged with high waste metrics trigger automated configuration optimizations via the SkillOpt feedback loop.

## Anomaly Detection (ARE)

The **Autonomous Reasoning Engine** runs on the control plane over the traces and hook events it ingests — a heuristic classifier per trace plus a baseline sweep — and flags suspicious behavior across **12 anomaly types**. It is not on the request path: the checks that act on a request as it happens are the proxy's own detectors and DLP, the response judge, the MCP interceptor and the harness hook gates.

| Anomaly | What it catches |
|---------|----------------|
| `TOOL_ABUSE` | Excessive or inappropriate tool calls |
| `TOKEN_WASTE` | Inefficient token usage patterns |
| `LOOP_DETECTED` | Agent stuck in a retry/repeat loop |
| `UNAUTHORIZED_TOOL` | Calling tools outside the allowed set |
| `DATA_EXFILTRATION` | Attempting to leak sensitive data |
| `PROMPT_INJECTION` | Malicious prompt manipulation |
| `HALLUCINATION` | An agent still working for a parent that is gone — its results have nowhere to go |
| `SCOPE_VIOLATION` | Operating outside the defined task scope |
| `BUDGET_BREACH` | Exceeding the allocated session budget |
| `SPAWN_BUDGET_BREACH` | Sub-agent spawning over limits |
| `WORKFLOW_BUDGET_BREACH` | Multi-step workflow over budget |
| `WORKFLOW_GOAL_DRIFT` | Workflow deviating from its stated objective |

When the ARE flags an anomaly it records the finding and can open a governance incident. A finding blocks nothing on its own; it reaches enforcement only through the [promotion rule](/concepts/enforcement-actions#the-promotion-rule).

### Incident types

A governance incident's type is one of the twelve anomaly types above, or one of two system incident types. A system incident is not an anomaly: no agent caused it, nothing detects it on the request path, and it never reaches enforcement.

| Type | What it records |
|------|-----------------|
| `WASM_RULE_REFUSED` | A proxy refused to load a version of a [custom filter](/guide/wasm-rules#when-a-rule-cannot-load) |
| `SYSTEM_ANOMALY` | A proxy could not reach something it depends on: the LLM provider, or the semantic cache's embedding service or vector store |

Before 2.4.0 both were filed as `SCOPE_VIOLATION`, and those incidents keep that type. A refused filter filed then still carries `escalation_chain.kind` `wasm_rule_refused`; a system anomaly filed then has no `escalation_chain`.

**Findings › Incidents** filters the list by type, as `GET /api/v1/incidents` does with `?type=` (for example `?type=SYSTEM_ANOMALY`); an unknown type is refused with `400`. The `incident.created` notification is sent at the incident's own severity, so a rule's [severity filter](/guide/settings#rule-filters) applies to incidents.

## Trust Scores

Every member receives a **trust score** — a 0–100 reliability rating, starting at 80, that tracks how well their agents follow governance rules over time: it falls (×0.85) with each incident filed against one of their sessions, and rises (×1.02) when a session ends with none filed against it. It is shown with the session in the dashboard and returned by `GET /api/v1/trust-scores`; no enforcement decision reads it.

## Compliance Scores

Each trace receives a **compliance score** indicating how closely the request aligned with active SOPs. High compliance scores mean the agent is working within policy. Low scores trigger review and may feed back into SOP refinement.

## Budget Tiers

Each session carries a budget tier label (`JUNIOR`, `SENIOR`, `STAFF` or `PRINCIPAL`, `JUNIOR` unless set), shown with the session in the dashboard. The tier sets no spending limit: spend is limited by the workspace's caps and by budgets on virtual keys and members. See [Budgets](/guide/budgets#setting-up-budget-limits).

<!-- ENTERPRISE_ONLY_START -->
## RBAC Roles

Intutic uses role-based access control with five roles:

| Role | Permissions |
|------|------------|
| **OWNER** | Full access — billing, workspace deletion, all admin actions |
| **ADMIN** | Manage SOPs, policy, budgets, integrations, team members, settings |
| **EM** | Engineering manager — review queue, hold approvals, killing runs, read-only settings |
| **DEVELOPER** | Use agents, view traces and SOPs, end or kill their own loop runs |
| **VIEWER** | Read-only access to dashboard and traces |

::: warning Role assignment
Only OWNER and ADMIN roles can assign or change roles for other team members.
:::
<!-- ENTERPRISE_ONLY_END -->

## How it all fits together

```
Harnesses → Proxy Gateway → PCAS (evaluates SOPs) → Enforcement Action
                                    ↓
                        Traces → Compliance Scores
                                    ↓
                     ARE (anomalies) → Incidents → Trust Scores
```

Your SOPs define the rules. PCAS enforces them. The ARE watches for anomalies. Traces record everything. Scores summarize it all.

## Next steps

- [Getting Started](/guide/getting-started) — install the CLI and set up your first workspace
- [How It Works](/guide/how-it-works) — deep dive into the architecture
- [Custom Filters (WASM)](/external/wasm-rules) — custom tool-call filtering policy hooks
- [CLI Reference](/reference/cli) — command line configuration and diagnostics
