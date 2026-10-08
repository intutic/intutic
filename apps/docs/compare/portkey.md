---
title: Intutic vs Portkey
description: Portkey is a model gateway with routing, caching and inline guardrails, now part of Palo Alto Networks; Intutic gates the agent's tool calls across 43 harnesses.
---

# Intutic vs Portkey

*Last reviewed: 2026-10-08*

Intutic decides each agent tool call before it runs, across 43 harnesses: native hook gates and in-process SDK gates allow or block the call, and hook gates can hold it for human approval. Around the gates, a policy proxy redacts sensitive data in model traffic, an MCP governance proxy governs MCP tools, an egress firewall and sandboxed execution stop the agent routing around governance, and a signed audit trail records every decision. Portkey is an AI gateway between applications and model providers, with routing, fallbacks, caching, budgets and guardrails that can reject a request inline. Palo Alto Networks completed its acquisition of Portkey on 2026-05-29 and makes it the AI gateway of Prisma AIRS. Portkey governs the model call; Intutic governs the action the agent takes with the answer.

## Comparison

| | Intutic | Portkey |
|---|---|---|
| **Primary job** | Runtime enforcement and audit for AI agents | Gateway for model traffic |
| **Where it enforces** | Native pre-execution hook gates in 19 of the 43 harnesses, plus request and response proxy, MCP governance proxy, egress firewall and sandbox | Model requests and responses; a failing guardrail set to deny rejects the request (HTTP 446) |
| **Coding agents** | **43** supported harnesses with native gates or in-process SDK gates | Any client that can point its base URL at the gateway |
| **Decisions** | Allow, warn, require approval (held until approved in Slack or the CLI), block, redact, re-ask, shadow | Allow or deny on guardrail results |
| **MCP** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | MCP Gateway |
| **Routing** | Thompson-sampling routing that learns cost and quality per workspace | Fallbacks, load balancing and conditional routing |
| **Caching** | Exact and semantic cache | Simple cache on every plan; semantic cache on select Enterprise plans |
| **Budgets** | Daily spend caps enforced before a request leaves | Budget and rate limits on paid plans |
| **Audit trail** | Signed Merkle roots with inclusion proofs, verifiable in the browser or CLI | Request and response logs |
| **Deployment** | Cloud, or fully self-hosted including air-gapped | Hosted, or self-host the open-source gateway (Docker, Kubernetes, major clouds) |
| **Source** | Open core (MIT) | Gateway is MIT |

## Where Portkey is stronger

- **Provider breadth and routing controls.** A mature gateway with fallbacks, load balancing and conditional routing across many providers.
- **Gateway-level guardrails for any application.** Inline checks on every model call, whether or not the caller is an agent.
- **Platform backing.** As part of Prisma AIRS, it sits inside Palo Alto Networks' AI security portfolio.

## When to choose Intutic

- Your agents run commands, edit files and call MCP tools, and you need each call decided before it runs.
- You want risky calls held for approval rather than only allowed or rejected.
- You need egress control and sandboxing so an agent cannot route around governance.
- You want an audit trail you can verify independently.

## When to choose Portkey

- You need one gateway for model traffic across many applications and providers.
- Routing, fallbacks, caching and per-key budgets are the main requirements.
- You are standardising on Palo Alto Networks' Prisma AIRS.

## Use them together

Portkey can keep routing, caching and guarding model calls for your applications while Intutic's hook gates decide the agents' tool calls inside each harness. The gates do not depend on which gateway carries the model traffic.

## Intutic's measured false-positive rate

Enforcement that fires on benign work gets switched off, so the number that matters
is how often it does.

**2 of 1,000 benign trajectories (0.2%)** trip a detector, plus **0 of 339** benign
prompts carrying injection trigger words.

The corpora are external and were not chosen by us: [BFCL v3
multi-turn](https://gorilla.cs.berkeley.edu/leaderboard.html) (Apache-2.0) and
[NotInject](https://huggingface.co/datasets/leolee99/NotInject) (MIT), vendored with
checksums rather than fetched at test time. The assertion pins the two firing
trajectories **by name**, not by count — a count still passes when one seed stops
firing and another starts. It runs unpiped, so the gate cannot go green on a
swallowed failure, and it runs on every push through the versioned `pre-push` hook
rather than only in CI. Source: `packages/proxy/tests/anomaly_corpus_test.rs`.

Three limits apply to this figure:

- **It is a lower bound.** BFCL is API-orchestration traffic filtered to successful
  completion — short (median 6 calls) and clean. Every sequence detector's exposure
  grows with trajectory length, and agentic coding runs are far longer.
- **It covers 8 of 27 detectors.** Seven against the two corpora above, plus one
  measured against 10,753 real tool and parameter descriptions. The other eighteen
  read fields no public corpus supplies — graph depth, workflow budget, DLP findings —
  or fire only on an operator declaration and so have no false-positive rate to
  measure at all. The split is generated from the registry at test time into
  `packages/proxy/tests/corpus/BASELINE.txt`, and a gate fails this page if the two
  disagree.
- **It says nothing about recall.** Nothing in the corpus records a missed catch, so
  recall is unmeasurable from this data in principle, not merely unmeasured.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
