---
title: Intutic vs Arize AX
description: Arize AX observes and evaluates LLM applications and can guard model output; Intutic decides agent tool calls before they run across 43 harnesses.
---

# Intutic vs Arize AX

*Last reviewed: 2026-10-08*

Intutic decides each agent tool call before it runs, across 43 harnesses: native hook gates and in-process SDK gates allow or block the call, and hook gates can hold it for human approval. Around the gates, a policy proxy redacts sensitive data in model traffic, an MCP governance proxy governs MCP tools, an egress firewall and sandboxed execution stop the agent routing around governance, and a signed audit trail records every decision. Arize AX is an observability and evaluation platform for LLM applications and agents, built on OpenTelemetry and OpenInference tracing, with LLM-as-judge evaluations, human review, and guards that can block, re-ask or substitute a model's output at runtime. Dynatrace completed its acquisition of Arize on 2026-10-01. Arize measures and improves how well the application works; Intutic controls what the agent is allowed to do.

## Comparison

| | Intutic | Arize AX |
|---|---|---|
| **Primary job** | Runtime enforcement and audit for AI agents | Observability and evaluation for LLM applications |
| **Where it enforces** | Native pre-execution hooks in 21 harnesses, plus request and response proxy, MCP governance proxy, egress firewall and sandbox | Guards on model output in your application code |
| **Coding agents** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf and Cline | Not a focus; it traces any application instrumented with OpenInference or OpenTelemetry |
| **Decisions** | Allow, warn, require approval (held until approved in Slack or the CLI), block, redact, re-ask, shadow | Block, re-ask, or substitute a default response |
| **Evaluation** | Shadow mode measures how often a rule would act before it enforces; judge findings go to a human review queue | LLM-as-judge and online evaluations, human annotation and labeling queues |
| **Tracing** | Enforcement decisions per tool call; OpenTelemetry traces and metrics of Intutic's own components | Full application traces with spans, evaluations and annotations |
| **Deployment** | Cloud, or fully self-hosted including air-gapped | Cloud; self-hosted on Kubernetes for Enterprise |
| **Source** | Open core (MIT) | AX is closed; Phoenix is source-available under the Elastic License 2.0 |

## Where Arize is stronger

- **Evaluation depth.** LLM-as-judge, online evaluations and human labeling for measuring application quality over time.
- **Application-wide tracing.** Spans across retrieval, chains and agents in any LLM application, not only coding agents.
- **Observability platform.** As part of Dynatrace, it connects AI observability with application performance monitoring.

## When to choose Intutic

- Your agents run commands, edit files and call MCP tools, and you need each call decided before it runs.
- You want risky calls held for human approval.
- You need egress control and sandboxing so an agent cannot route around governance.
- You want an audit trail you can verify independently.

## When to choose Arize AX

- You are measuring and improving the quality of RAG pipelines, chatbots or agents.
- You want evaluation pipelines and human review of model output.
- You already run Dynatrace and want AI observability in the same platform.

## Use them together

Arize can trace and evaluate your application while Intutic gates the agent's tool calls. Intutic's enforcement records reach other systems through [SIEM export](/guide/siem-export) and signed webhooks; they are not emitted as OpenInference spans, so Arize does not show Intutic's decisions inside its traces.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
