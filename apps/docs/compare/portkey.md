---
title: Intutic vs Portkey
description: Portkey, now Prisma AIRS AI Gateway from Palo Alto Networks, is a model gateway with routing, caching, inline guardrails and an MCP gateway; Intutic gates the agent's tool calls across 43 harnesses.
---

# Intutic vs Portkey

*Last reviewed: 2026-10-09*

Intutic decides agent tool calls before they run, across 43 supported harnesses: native hook gates in 18 of them and in-process SDK gates in 17 allow or block the call, hook gates, SDK gates and the MCP governance proxy can hold it for human approval, and the other eight are governed through the proxies, a bridge or the harness they orchestrate. Around the gates, a policy proxy redacts sensitive data in model traffic, an MCP governance proxy governs MCP tools, an egress firewall and sandboxed execution stop the agent routing around governance, and execution traces are sealed into a signed audit trail you can verify. Portkey is an AI gateway between applications and model providers, with routing, fallbacks, caching, budgets and guardrails that can reject a request inline, plus a hosted MCP gateway that can stop MCP tool calls routed through it. Palo Alto Networks completed its acquisition of Portkey on 2026-05-29; the product is now sold as Prisma AIRS AI Gateway, generally available since 2026-07-16. Portkey governs the model call and the MCP calls it carries; Intutic governs every action the agent takes with the answer, including the shell commands and file writes that never leave the developer's machine.

## Comparison

| | Intutic | Portkey |
|---|---|---|
| **Primary job** | Runtime enforcement and audit for AI agents | Gateway for model traffic |
| **Where it enforces** | Pre-execution gates inside the agent (native hook gates in 18 of the 43 harnesses, in-process SDK gates in 17 agent frameworks), plus request and response proxy, MCP governance proxy, egress firewall and sandbox | Model requests and responses: a failing guardrail set to deny rejects the request (HTTP 446), and output guardrails on a streamed response only report after the stream ends. MCP tool calls routed through its MCP Gateway can be blocked before they run (since 2026-09-01). Local tool execution, such as a shell command or file write, never passes through it |
| **Coding agents** | **43** supported harnesses: native hook gates in 18, in-process SDK gates in 17, and the proxies, a bridge or the orchestrated harness for the other eight | A Coding Agents governance offering with setup guides for Claude Code, Codex, Cursor, Cline, Roo Code, Goose, opencode, GitHub Copilot and others, plus an `npx portkey` setup CLI. Each agent points its model base URL, and optionally its MCP servers, at the gateway; nothing hooks the agent's local tool execution |
| **Decisions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, shadow | Deny (HTTP 446, or a 200 with `soft_deny_200` for clients such as Claude Code that treat 4xx as fatal), flag and allow (HTTP 246), log only, or trigger a retry or fallback on the result. No human approval workflow documented |
| **MCP** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | Hosted MCP Gateway (generally available January 2026) for remote HTTP servers: sign-in through your identity provider or OAuth, OAuth 2.1 and credential injection to upstream servers, per-tool enable and disable, per-tool rate limits, full call logs, and MCP guardrails (deterministic checks and webhooks) since 2026-09-01. Local stdio servers must first be exposed over HTTP |
| **Model providers** | Eight served directly: Anthropic, OpenAI, Mistral, OpenRouter, DeepSeek, [AWS Bedrock](/integrations/aws-bedrock), [Google Vertex AI](/integrations/google-vertex-ai) and [Azure OpenAI](/integrations/azure-openai); any other OpenAI- or Anthropic-compatible endpoint through one upstream URL | About 50 providers in its integration list, Bedrock, Vertex AI and Azure OpenAI among them |
| **Routing** | Thompson-sampling model routing per workspace that learns from cost, latency and upstream failures. Its quality signal catches broken, cut-off or empty answers only, not worse ones | Load balancing and conditional routing |
| **Retries and fallbacks** | Retries on by default (429, 5xx, 529 and dropped connections, honouring `retry-after`, within a time budget), then ordered fallback targets per model, including the same Claude model on Anthropic's API, Bedrock or Vertex AI; never once a stream has started | Retries of up to 5 attempts and fallback targets, set per config; fallbacks can trigger on any non-2xx status |
| **Caching** | Exact and semantic cache, both off until a workspace turns them on; the semantic cache also needs an embedding service and TurboVec | Simple cache on every plan; semantic cache on select Enterprise plans per its docs, though its pricing page lists it under Production |
| **Budgets** | Daily spend caps enforced before a request leaves; a loop run that exceeds its budget is stopped | Budget and rate limits on paid plans |
| **Audit trail** | Signed Merkle roots with inclusion proofs, verifiable in the browser or CLI | Request and response logs, kept 3 days on Developer and 30 days on Production; admin audit logs on Enterprise. No cryptographic sealing documented |
| **Stored provider keys** | Envelope encryption (AES-256-GCM, a data key per value) under a key derived from your deployment's `ENCRYPTION_KEY`, rotatable; every change to a provider key or virtual key is recorded and streamed to SIEM. A cloud KMS key is not supported yet | Envelope encryption under your own AWS KMS key on Enterprise |
| **Deployment** | Cloud, or fully self-hosted including air-gapped | Hosted, or hybrid with the data plane in your VPC and the control plane hosted by Portkey (or in Palo Alto Networks Strata Cloud Manager). Fully air-gapped deployment is no longer offered to new customers. The open-source gateway still self-hosts |
| **Pricing** | [Published plans](/guide/plans); the open core is free | Developer free (10k logs a month); Production $49 a month plus $9 per extra 100k logs; Enterprise by quote through Palo Alto Networks |
| **Source** | Open core (MIT) | The open-source gateway is MIT, last released as v1.15.2 on 2026-01-12 with no merges since 2026-05-25; the Enterprise Gateway (v2.28.0 on 2026-10-08) is closed |

## Where Portkey is stronger

- **Provider breadth and routing controls.** A mature gateway with load balancing, conditional routing and nested fallback strategies across many providers. Intutic's fallbacks only go to a target that accepts the request in its original wire format.
- **Gateway-level guardrails for any application.** Inline checks on every model call, whether or not the caller is an agent.
- **Ecosystem.** About 25 partner guardrails (among them Prisma AIRS, Lakera, Pangea, Pillar, Lasso and Bedrock) plus a webhook guardrail, and prompt management with versioning and a playground. Intutic has neither, and its rules do not call third-party decision services.
- **Central MCP authentication.** Its MCP Gateway signs agents in through your identity provider and injects OAuth or API credentials into upstream servers. Intutic's MCP proxy passes static headers to remote servers and brokers no OAuth.
- **Customer-managed KMS keys.** Stored provider keys can be encrypted under a key you hold in AWS KMS.
- **Compliance attestations.** Portkey states SOC 2, ISO 27001, GDPR and HIPAA compliance and ships FIPS 140-3 images for its Enterprise Gateway. Intutic claims no attestation for its own service.
- **Entry price.** A free Developer tier and a $49-a-month Production tier. Intutic's open core is free, but its connected plans start far higher.
- **Platform backing.** As Prisma AIRS AI Gateway, it sits inside Palo Alto Networks' AI security portfolio.

## When to choose Intutic

- Your agents run commands, edit files and call MCP tools, and you need each call decided before it runs.
- You want risky calls held for approval rather than only allowed or rejected.
- You need egress control and sandboxing so an agent cannot route around governance.
- You want an audit trail you can verify independently.

## When to choose Portkey

- You need one gateway for model traffic across many applications and providers.
- Load balancing, conditional routing, caching and per-key budgets are the main requirements.
- You are standardising on Palo Alto Networks' Prisma AIRS.

## Use them together

Portkey can keep routing, caching and guarding model calls for your applications while Intutic's hook gates decide the agents' tool calls inside each harness. The gates do not depend on which gateway carries the model traffic. To also run Intutic's DLP and budgets on the model traffic, put the Intutic proxy between Portkey and the provider: see [Intutic behind an existing gateway](/integrations/standalone#option-d-intutic-behind-an-existing-gateway-portkey-kong-litellm).

## Sources

Portkey and Palo Alto Networks, as of 2026-10-09:

- [Palo Alto Networks completes acquisition of Portkey](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents) and [Prisma AIRS AI Gateway general availability](https://www.paloaltonetworks.com/blog/2026/07/announcing-general-availability-of-prisma-airs-ai-gateway/)
- [Guardrails](https://docs.portkey.ai/docs/product/guardrails), [Guardrail capabilities](https://docs.portkey.ai/docs/product/guardrails/capabilities) and [Enterprise Gateway changelog](https://docs.portkey.ai/docs/changelog/enterprise)
- [MCP Gateway](https://docs.portkey.ai/docs/product/mcp-gateway), [MCP registry](https://docs.portkey.ai/docs/product/mcp-gateway/mcp-registry), [Tool provisioning](https://docs.portkey.ai/docs/product/mcp-gateway/tool-provisioning) and [MCP guardrails](https://docs.portkey.ai/docs/product/mcp-gateway/guardrails)
- [Coding Agents](https://docs.portkey.ai/docs/product/coding-agent) and [Claude Code integration](https://docs.portkey.ai/docs/integrations/libraries/claude-code)
- [Caching](https://docs.portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic), [Audit logs](https://docs.portkey.ai/docs/product/enterprise-offering/audit-logs), [Security](https://docs.portkey.ai/docs/product/enterprise-offering/security-portkey) and [Pricing](https://portkey.ai/pricing)
- [Hybrid deployment](https://docs.portkey.ai/docs/self-hosting/hybrid-deployments/architecture) and [Air-gapped deployment](https://docs.portkey.ai/docs/self-hosting/airgapped/model-pricing)
- [Open-source gateway releases](https://github.com/Portkey-AI/gateway/releases)

Intutic: [Intelligent routing](/guide/intelligent-routing), [MCP governance](/guide/mcp-governance), [Budgets](/guide/budgets), [Trace integrity](/concepts/trace-integrity) and [Self-hosting](/guide/self-host).

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
  measured against 10,753 real tool and parameter descriptions. The other nineteen
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
