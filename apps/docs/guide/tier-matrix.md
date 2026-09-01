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
[FAQ](/guide/faqs) has the upgrade narrative. This page is the one place that
states the whole boundary at once — everything below is drawn from those
pages, not new content, so treat this as the index and follow the links for
the full detail on any row.

There are three tiers, not two:

1. **Standalone (Open-Core)** — no account, no control plane, runs entirely
   on your machine.
2. **Connected, Free** — `intutic connect` to a workspace with no paid plan.
3. **Connected, Paid** (Pro / Team / Enterprise) — a workspace with a plan
   attached.

## What runs 100% locally, with no account

Everything here works fully offline, today, in open core — nothing on this
list is a trial or a degraded preview of a paid feature:

- **Local rule sync** — the sync daemon compiles your `.intutic/sops/`
  markdown into `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, and every
  other harness's own config format as files change.
- **Local policy enforcement** — the Rust proxy intercepts every LLM
  request/response, evaluates it against local WASM rules, blocks prohibited
  tool calls, and injects steering warnings into the stream in real time.
- **Local cost and token ledger** — session traces and daily spend land in
  local JSONL logs (`~/.intutic/logs/`); `intutic predict-cost` reads that
  same history for pre-flight estimates.
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
| Who updates routing arms | this proxy, deterministically | the control plane's judge, if it claims the workspace |
| Feature flags | `config.yaml` | control plane, authoritative |
| Auth & budgets | local daily spend cap | workspace virtual keys and per-member budgets |
| Response cache | per-process | shared across every proxy in the workspace |
| Team dashboard | — | web UI: spend, audits, compliance scores |
| Ticket board integration (Jira/Linear) | — | cost attribution to a ticket key |
| Corporate SOP distribution | local files only | centralized, tamper-proof, pushed to every developer |
| LLM-as-judge (L2/L3 semantic checks) | — | requires server compute |

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

A free connected workspace gets the full Connected column above. A paid plan
(Pro / Team / Enterprise) adds workspace-wide governance controls that need
more than one developer to make sense of:

- **RBAC roles** — Owner, Admin, EM, Developer, Viewer, each scoped to a
  different slice of the dashboard (Review Queue, Compliance Scope, WASM
  filters, SOP Optimizer, Incidents, Emergency Overrides). See
  [Security & Identity](/guide/security#rbac-roles) for the full
  role/capability table.
- **SSO** — SAML 2.0 or OIDC, so team members authenticate through Okta,
  Entra ID, Google, or Ping Identity rather than individual passwords.
- **Semantic response caching** and **workspace-wide SOP Registry** —
  unlocked dynamically at the next sync-daemon handshake once an
  administrator raises the tier from the dashboard; no CLI or proxy binary
  change is needed on any developer's machine.
<!-- ENTERPRISE_ONLY_END -->

## Upgrading

No CLI or proxy binary changes at any step — the progression is entirely
config and billing state:

1. **Standalone** — `intutic start`, budget enforced against
   `~/.intutic/config.json`.
2. **Connected, Free** — register on the dashboard, then
   `intutic connect --workspace-id <wk_id> --api-key <api_key>`. The sync
   daemon uploads buffered local traces and starts syncing workspace rules
   immediately; no reinstall.
3. **Connected, Paid** — an administrator sets limits and unlocks tier
   features from the dashboard; the next sync-daemon handshake picks them up.

See the [FAQ](/guide/faqs) (Q17) for the full upgrade narrative, including
how onboarding provisions new members.

## Related

- [Getting Started](/guide/getting-started) — standalone architecture, what
  Valkey adds, and the standalone/connected mode switch in detail
- [Security](/security) — Standalone-vs-Connected data-flow diagrams,
  encryption, and the Enterprise-tier identity/compliance summary
- [Security & Identity](/guide/security) — the full team-role table, SSO
  setup, and API key management
- [FAQ](/guide/faqs) — the upgrade narrative and the standalone
  works/doesn't-work split this page draws from
