---
title: How Intutic Compares
description: Where Intutic enforces, and how it compares with AI-agent governance platforms, AI security gateways and LLM observability tools.
---

# How Intutic Compares

*Last reviewed: 2026-10-10*

Intutic decides each agent tool call before it runs. A native pre-execution gate inside the coding agent allows, blocks or holds the call for approval, and the same policy runs in a request and response proxy that redacts sensitive data, an MCP governance proxy, a default-deny egress firewall and a sandboxed runtime. It covers **43** supported harnesses, seals its execution traces into a signed audit trail you can verify yourself, is open core under MIT, runs fully self-hosted including air-gapped, and publishes its [prices](/guide/plans).

The products on these pages start from other places: governance platforms that inventory agents across an organization, security gateways that guard model inputs and outputs, and observability platforms that trace and evaluate LLM applications. Several now enforce at runtime too. Each detail page says where.

## At a glance

| | Category | Where it enforces | Coding agents | Self-host | Source |
|---|---|---|---|---|---|
| **Intutic** | Agent enforcement point | The tool call (native hook gates in 18 of the 43 harnesses, in-process SDK gates in 17 agent frameworks), model requests and responses, MCP calls, network egress, sandboxed runs | **43** supported harnesses | Yes, including air-gapped | Open core (MIT) |
| [Forge](/compare/forge) | AI-agent governance platform | Its device agent, MCP gateway and LLM gateway, plus connected security tools, including SASE products it can route agent traffic through with nothing installed | Six documented, including Claude Code, Codex and Cursor | Hosted; Resource Gateways run in your environment | Closed |
| [Credo AI](/compare/credo-ai) | AI governance, risk and compliance | Agent Governor (Research Preview for design partners) hooks Claude Code tool calls | Claude Code | Private cloud (Kubernetes or VMs), including air-gapped | Closed |
| [Fiddler AI](/compare/fiddler) | AI observability and guardrails | Model requests and responses at a third-party AI gateway, where it redacts or blocks PII and secrets | Any agent behind a supported gateway; telemetry for Claude Code (plugin in public preview) and GitHub Copilot | Hosted; VPC or on-prem (Enterprise) | Closed |
| [F5 AI Guardrails](/compare/f5-calypso) | AI security (formerly CalypsoAI) | Model inputs and outputs; agent actions and tool use; an MCP gateway in early access | Claude Code, Codex CLI and Gemini CLI, through the model base URL | Cloud, private cloud, on-prem, air-gapped | Closed |
| [Portkey](/compare/portkey) | AI gateway, now Prisma AIRS AI Gateway (Palo Alto Networks), marketed for model, MCP and A2A traffic | Model requests and responses, with inline guardrails; MCP calls routed through its MCP Gateway (deterministic and webhook checks only) | Coding-agent setups for Claude Code, Codex, Cursor and others, through the model base URL and its MCP Gateway | Hybrid (data plane in your VPC) or the open-source gateway; air-gapped no longer offered to new customers | Open-source gateway is MIT (last release 2026-01-12); Enterprise Gateway closed |
| [LangSmith](/compare/langsmith) | LLM tracing and evaluation | Its LLM Gateway (public beta) caps spend, limits rates and redacts on model traffic; Sandboxes contain code sent to them | Gateway guides for Claude Code, Codex and Gemini CLI | Self-hosted or BYOC (Enterprise) | Closed |
| [Arize AX](/compare/arize-ax) | LLM observability and evaluation (Dynatrace) | Guards on input or output that block, re-ask or substitute a default response | Tracing (no enforcement) for Claude Code and others | Yes (Enterprise) | AX closed; Phoenix source-available |
| [W&B Weave](/compare/wandb-weave) | LLM tracing and evaluation (CoreWeave) | Scorers your code applies as guardrails | Tracing (no enforcement) for Claude Code and others | Dedicated cloud on AWS, Google Cloud or Azure; self-managed in preview | SDK is Apache-2.0 |

## What sets Intutic apart

- **It sits at the tool call.** The gate runs inside the agent, before the shell command, file write or MCP call executes, and fails closed if it crashes or receives a malformed payload. A built-in destructive-command tier blocks with no configuration.
- **It covers the agents developers actually run.** Coverage across 43 harnesses, from Claude Code, Cursor, GitHub Copilot, Windsurf and Cline to LangGraph, CrewAI and the OpenAI Agents SDK. See [Integrations](/integrations/).
- **You can verify it.** The proxy, hook gates, MCP proxy, CLI and sync daemon are open source, and the audit trail is a signed Merkle tree you can check in a browser or with `intutic integrity verify`. See [Trace Integrity](/concepts/trace-integrity).
- **It runs where you need it.** Cloud, or the whole product on your own infrastructure from a signed, air-gap-ready bundle.

Intutic is not the only open-source project that enforces on tool calls: Microsoft's Agent Governance Toolkit, agentgateway, Invariant Guardrails, LiteLLM's tool-permission guardrail, and the Docker and Lasso MCP gateways do as well. What Intutic adds is gates inside 36 of its 43 supported harnesses (native hooks in 18, in-process SDK gates in 17, and a bridge gate in one), approval holds, egress and sandbox containment, and a verifiable audit trail in one product.

## Detailed comparisons

| Product | One-line take |
|---|---|
| [Forge](/compare/forge) | Top-down discovery, identity and credential brokering across an organization; Intutic is the enforcement point at the tool call, open core and self-hostable |
| [Credo AI](/compare/credo-ai) | Regulatory GRC system of record with an early Claude Code enforcement preview for design partners; Intutic enforces across 43 harnesses in production |
| [Fiddler AI](/compare/fiddler) | Model monitoring, guardrail models and PII and secrets enforcement at the AI gateway; Intutic decides the tool call, with approval holds, MCP governance, egress and sandbox containment |
| [F5 AI Guardrails](/compare/f5-calypso) | Model-traffic security, red teaming, and AI Remediate to turn findings into guardrails; Intutic governs the coding agent's own tool calls |
| [Portkey](/compare/portkey) | Model gateway with routing, caching, inline guardrails and an MCP gateway; Intutic gates what the agent does with the answer, including local tool calls |
| [LangSmith](/compare/langsmith) | Tracing and evaluation with a new inline gateway and hosted sandboxes for code sent to them; Intutic decides tool calls before they run, where the agent runs |
| [Arize AX](/compare/arize-ax) | Observability and evaluation with output guards; Intutic enforces at the tool call |
| [W&B Weave](/compare/wandb-weave) | Tracing and evaluation for LLM apps; Intutic enforces, contains and audits agent actions |

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
