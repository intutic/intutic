---
title: Intutic vs Arize AX
description: Arize AX observes and evaluates LLM applications and can guard model output; Intutic decides agent tool calls before they run across 43 harnesses.
---

# Intutic vs Arize AX

*Last reviewed: 2026-10-10*

Intutic decides agent tool calls before they run, across 43 supported harnesses: native hook gates in 18 of them and in-process SDK gates in 17 allow or block the call, hook gates, SDK gates and the MCP governance proxy can hold it for human approval, and the other eight are governed through the proxies, a bridge or the harness they orchestrate. Around the gates, a policy proxy redacts sensitive data in model traffic, an MCP governance proxy governs MCP tools, an egress firewall and sandboxed execution stop the agent routing around governance, and execution traces are sealed into a signed audit trail you can verify. Arize AX is an observability and evaluation platform for LLM applications and agents, built on OpenTelemetry and OpenInference tracing, with LLM-as-judge evaluations, human review, and guards that check user input (for example, for jailbreaks) or model output at runtime and can block, re-ask or return a default response. Its tracing plugins for coding agents, among them Claude Code, Codex and Cursor, record sessions as traces; they fail open and do not block a call. Dynatrace completed its acquisition of Arize on 2026-10-01. Arize measures and improves how well the application works; Intutic controls what the agent is allowed to do.

## Comparison

| | Intutic | Arize AX |
|---|---|---|
| **Primary job** | Runtime enforcement and audit for AI agents | Observability and evaluation for LLM applications |
| **Where it enforces** | Pre-execution gates inside the agent (native hook gates in 18 of the 43 harnesses, in-process SDK gates in 17 agent frameworks), plus request and response proxy, MCP governance proxy, egress firewall and sandbox | Guards on user input or model output in your application code |
| **Coding agents** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf and Cline | Tracing plugins for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode and others; the Claude Code plugin records 16 hook events as OpenInference spans. Tracing only: the plugins fail open and do not block a call |
| **Decisions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, shadow | Block, re-ask, or substitute a default response |
| **Evaluation** | Shadow mode measures how often a rule would act before it enforces; judge verdicts in the uncertain band go to a human review queue | LLM-as-judge and online evaluations, human annotation and labeling queues |
| **Tracing** | Enforcement decisions per tool call; OpenTelemetry traces and metrics of Intutic's own components | Full application traces with spans, evaluations and annotations |
| **Deployment** | Cloud, or fully self-hosted including air-gapped | Cloud; self-hosted on Kubernetes for Enterprise |
| **Source** | Open core (MIT) | AX is closed; Phoenix is source-available under the Elastic License 2.0 |

## Where Arize is stronger

- **Evaluation depth.** LLM-as-judge, online evaluations and human labeling for measuring application quality over time.
- **Application-wide tracing.** Spans across retrieval, chains and agents in any LLM application, not only coding agents.
- **Coding-agent tracing.** Session traces from many coding agents, and its Alyx assistant can find failing tool calls in Cursor and Codex sessions.
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

Arize can trace and evaluate your application while Intutic gates the agent's tool calls. In a coding agent, Arize's tracing plugin records the session and Intutic's gate decides each tool call. Intutic's enforcement records reach other systems through [SIEM export](/guide/siem-export) and signed webhooks; they are not emitted as OpenInference spans, so Arize does not show Intutic's decisions inside its traces.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
