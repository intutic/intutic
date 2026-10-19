---
title: Tier Matrix
description: What runs entirely on your machine in open core, what needs a control plane, and what a paid workspace tier unlocks on top of a free one — one table, not three scattered pages.
---

# Tier Matrix <Badge type="tip" text="Open-Core" />

Four separate pages each describe part of the boundary between what Intutic
does with no account at all and what it does once a control plane is
involved: [Getting Started](/guide/getting-started) has the standalone
architecture, [Security](/security) has the Standalone-vs-Connected data-flow
diagrams and the Enterprise-tier identity/compliance summary,
[Security & Identity](/guide/security) has the full team-role table, and the
[FAQ](/guide/faqs) has the standalone works/doesn't-work split<!-- ENTERPRISE_ONLY_START --> and the
upgrade narrative<!-- ENTERPRISE_ONLY_END -->. This page is the one place that
states the whole boundary at once — everything below is drawn from those
pages, not new content, so treat this as the index and follow the links for
the full detail on any row.

There are three tiers, not two:

1. **Standalone (Open-Core)** — no account, no control plane, runs entirely
   on your machine.
2. **Connected, Free** — connected to a control plane, in a workspace with no paid plan.
3. **Connected, Paid** — a workspace on a paid plan: Self-serve, Biz Org or
   Enterprise<!-- ENTERPRISE_ONLY_START -->, or a Self-host license on your own infrastructure<!-- ENTERPRISE_ONLY_END -->.

## What runs 100% locally, with no account

Everything here works fully offline, today, in open core — nothing on this
list is a trial or a degraded preview of a paid feature:

- **Local rules and gates** — `intutic gates install` compiles your
  `.intutic/sops/` markdown into each harness's rules file, such as
  `.cursor/rules/intutic-governance.mdc`, `.claude/rules/intutic-governance.md`
  or the rules section of `AGENTS.md`, and installs each harness's blocking
  gate; `intutic start` rewrites them as files change.
- **Local policy enforcement** — the Rust proxy intercepts every LLM
  request/response, evaluates it against local WASM rules, blocks prohibited
  tool calls, and injects steering warnings into the stream in real time.
- **Local cost and token ledger** — session traces and daily spend land in
  local JSONL logs (`~/.intutic/logs/`), which `intutic traces list` reads
  with no account. Pre-flight estimates from recorded usage need a connected
  workspace; standalone, `@intutic predict` uses static per-model multipliers.
- **Local spend caps** — a daily budget ceiling (`~/.intutic/config.json`),
  enforced natively inside the proxy on every request.
- **Intelligent routing and the bandit** — the routing engine and its
  cache-honest guard (see [Intelligent Routing](/guide/intelligent-routing))
  run locally; arm state persists to `~/.intutic/bandit-state.json`.
- **DLP scanning and prompt-injection detection** — pattern-based, no LLM
  call, no network egress.

## What a control plane adds

| | Standalone | Connected |
|---|---|---|
| Bandit arm state | `~/.intutic/bandit-state.json` | `bandit:{workspaceId}` in Valkey — shared and durable |
| Who updates routing arms | this proxy, deterministically | the control plane's daily reward job (deterministic, no model call), once it claims the workspace |
| Feature flags | `config.yaml` | control plane, authoritative |
| Auth & budgets | local daily spend cap | workspace virtual keys; [spend budgets](/guide/budgets#setting-up-budget-limits) per workspace, per virtual key and (Biz Org and up) per member, by UTC day and month, each one refusing requests or alerting only; requests-per-minute and tokens-per-minute limits per key |
| Response cache | per-process | shared across every proxy in the workspace |
| Team dashboard | — | web UI: spend, audits, compliance scores |
| Ticket board integration (Jira/Linear) | — | cost attribution to a ticket key |
| Corporate SOP distribution | local files only | centralized, tamper-proof, pushed to every developer |
| Guardrails from policy documents | hand-written SOP files and rules | Notion, Confluence, GitHub, Google Docs and uploads become cited, shadow-first guardrails a person promotes |
| LLM-as-judge (L2/L3 semantic checks) | — | on a paid plan or a trial, not Free: Free stays deterministic |
| MCP server governance | the proxy's local checks: DLP, injection scanning, anomaly detectors, WASM rules, TOFU pinning | plus the [server registry](/guide/mcp-governance#the-registry) with approvals and default-deny, [approval holds](/guide/mcp-governance#approval-holds), allowlists, the calling member on every event, [call budgets](/guide/mcp-governance#call-budgets) and [tool-change risk scoring](/guide/mcp-governance#tool-change-risk), on every plan; the [SSO group policy](/concepts/circuit-breaker#_3-sso-group-clearance) on plans with single sign-on |
| [Decide rules](/guide/decide) | `decide:` lines in local SOPs, asked of your own self-hosted engine and pinned by `intutic decide eval`; enforced by the hook gates, the gate SDKs and the proxy | plus rules served from the control plane with their pins, and its shadow stamps |
| [Decision traffic](/guide/decision-traffic) | the proxy governs decision-model calls: DLP, pinned model versions, abstention and human-review headers, the local decision-traffic log, its own daily cap | plus workspace and virtual-key budgets |
| Qualified `requires_before`, `scope_paths_mode: enforce` | enforced by the hook gates, the gate SDKs and the proxy | the same |
| `plan_approval:` | no plan can be approved, so every call but a read is refused (`PLAN_NOT_APPROVED`) | enforced against the session's approved plan |
| `review_before:` and `closed_lanes:` holds | refused, not held: approval needs a control plane | held until a person approves the call |

Arm state carries over rather than resetting when you connect: a workspace
that learned standalone keeps that learning, and the local loop stands down
within 60 seconds of the control plane taking over. See [Getting
Started](/guide/getting-started#attaching-a-control-plane) for the mechanics.

Nothing that requires a control plane was ever available in open core — so
"what standalone gives up" is exactly the right-hand column above, never
something silently downgraded. Provider credentials are held in memory only
and never written to disk in either mode.

<!-- ENTERPRISE_ONLY_START -->
## What a paid plan adds on top of Connected

A free connected workspace gets the full Connected column above. Each paid
plan adds to it; [Plans & pricing](/guide/plans) has the prices and the full
list. In short:

| | Self-serve | Biz Org | Enterprise | Self-host |
|---|:---:|:---:|:---:|:---:|
| [Policy Guardrails](/guide/policy-guardrails) (extraction and the review page) | ✓ | ✓ | ✓ | ✓ |
| LLM-as-judge: the [response judge](/guide/slash-commands) (`/intutic judge`), the [trajectory monitor's](/guide/trajectory-monitor#what-runs-on-which-plan) review of ambiguous windows, [agent posture](/guide/agents) judging, loop diff verification and semantic skill analysis. Free runs the deterministic checks only; the monitor itself runs on every plan | ✓ | ✓ | ✓ | ✓ |
| [Single sign-on](/guide/security#single-sign-on-sso) (SAML 2.0, OIDC) | | ✓ | ✓ | ✓ |
| [SSO group policy](/concepts/circuit-breaker#_3-sso-group-clearance) for high-risk tools | | ✓ | ✓ | ✓ |
| [Custom Filters](/guide/wasm-rules) (WASM rules) | | ✓ | ✓ | ✓ |
| [SOP Optimizer](/guide/metaclaw) | | ✓ | ✓ | ✓ |
| [Evaluator Sandbox](/guide/evaluator-sandbox) | | ✓ | ✓ | ✓ |
| [Fleet analytics](/guide/budgets#dashboard-widgets): cost by developer, team, branch and commit | | ✓ | ✓ | ✓ |
| [Member spend budgets](/guide/budgets#member-budgets) | | ✓ | ✓ | ✓ |
| [SIEM export](/guide/siem-export) | | ✓ | ✓ | ✓ |
| [SCIM provisioning](/guide/scim) | | | ✓ | ✓ |
| Data residency (Cloud: US; EU on request) | | | ✓ | ✓ |
| [Self-hosted gateway](/external/self-hosted-gateway) | | | ✓ | ✓ |
| Runs in your VPC or an air-gapped network | | | | ✓ |

The 14-day Free trial includes Policy Guardrails, LLM-as-judge, single sign-on, SCIM,
Custom Filters, the SOP Optimizer, fleet analytics, member spend budgets, SIEM export and data
residency; the 14-day Enterprise
trial adds the Evaluator Sandbox and SOP write-back. Plan changes take effect
at the next sync-daemon handshake; no CLI or proxy binary change is needed on
any developer's machine.
<!-- ENTERPRISE_ONLY_END -->

## Upgrading

No CLI or proxy binary changes at any step — the progression is entirely
config and billing state:

1. **Standalone** — `intutic start`, budget enforced against
   `~/.intutic/config.json`.
2. **Connected, Free** — register on the dashboard, then connect to it<!-- ENTERPRISE_ONLY_START -->
   (`intutic connect --workspace-id <wk_id> --api-key <api_key>`)<!-- ENTERPRISE_ONLY_END -->. The sync
   daemon uploads buffered local traces and starts syncing workspace rules
   immediately; no reinstall.
3. **Connected, Paid** — an administrator sets limits and unlocks tier
   features from the dashboard; the next sync-daemon handshake picks them up.

<!-- ENTERPRISE_ONLY_START -->
See the [FAQ](/guide/faqs) (Q17) for the full upgrade narrative, including
how onboarding provisions new members.
<!-- ENTERPRISE_ONLY_END -->

## Related

- [Getting Started](/guide/getting-started) — standalone architecture, what
  Valkey adds, and the standalone/connected mode switch in detail
- [Security](/security) — Standalone-vs-Connected data-flow diagrams,
  encryption, and the Enterprise-tier identity/compliance summary
- [Security & Identity](/guide/security) — the full team-role table, SSO
  setup, and API key management
- [FAQ](/guide/faqs) — <!-- ENTERPRISE_ONLY_START -->the upgrade narrative and <!-- ENTERPRISE_ONLY_END -->the standalone
  works/doesn't-work split this page draws from
