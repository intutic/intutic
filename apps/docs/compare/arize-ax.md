# Intutic vs Arize AX

Arize AX is an AI observability platform for monitoring, evaluating, and debugging LLM applications. It provides tracing, evaluation metrics, and performance dashboards. **Intutic enforces policies on agent tool calls in real time.**

## Different Layers, Same Stack

Arize AX **observes** what your AI systems do — traces, evaluations, latency, quality scores. Intutic **controls** what your AI agents are allowed to do — blocking destructive actions, redacting secrets, enforcing budgets.

**Intutic enforces. Arize observes.**

## Comparison

| Capability | Intutic | Arize AX |
|-----------|---------|----------|
| **Primary function** | Runtime enforcement (circuit breaker) | Observability and evaluation |
| **Where it sits** | In the tool-call path — synchronous enforcement | After execution — async tracing and analysis |
| **Enforcement** | BYPASS / ENHANCE / HIJACK / KILL in <50ms | No enforcement — observation only |
| **Tracing** | Tool-call-level audit logs with enforcement decisions | Full LLM trace with spans, evaluations, and annotations |
| **Scope** | AI coding agents (18 harness integrations) | Any LLM application (RAG, agents, chatbots) |
| **DLP & threat detection** | Secrets redaction, SQL injection, prompt injection — blocked at proxy | Hallucination detection, toxicity scoring — flagged post-hoc |
| **Evaluation** | Policy pass/fail per tool call | LLM-as-judge, human annotation, custom evaluators |
| **Data export** | OTel-compatible trace export | Native OTel ingestion |

## Better Together

Intutic and Arize AX work at **different layers** of the AI stack. Use them together:

1. **Enforce with Intutic** — block bad actions, redact secrets, enforce budgets on every tool call
2. **Export traces to Arize** — Intutic emits OTel-compatible traces that Arize can ingest for deep observability
3. **Analyze with Arize** — use Arize's evaluation and debugging tools to understand agent behavior patterns, quality trends, and failure modes

Intutic tells you what was **blocked and why**. Arize tells you what **happened and how well it worked**.

## When You Need Intutic

- Your AI agents interact with infrastructure — files, databases, APIs, git
- You need to **prevent** destructive actions, not just observe them
- You want policy enforcement that runs **locally** in under 50ms
- You need coverage across **18 AI coding harnesses**

## When You Need Arize AX

- You need deep LLM observability with tracing and evaluation
- You're debugging RAG quality, hallucination rates, or response latency
- You want LLM-as-judge evaluation pipelines
- You need observability across all LLM application types, not just coding agents

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
