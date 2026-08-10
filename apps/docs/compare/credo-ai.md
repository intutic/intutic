# Intutic vs Credo AI

Credo AI is an AI governance, risk, and compliance (GRC) platform. It helps organizations create AI policies, track model risk, and generate compliance reports. **Intutic enforces policies in real time at the tool-call level.**

## Different Layers, Different Buyers

Credo AI owns the **governance system of record** — policy creation, risk assessment, audit documentation, and regulatory compliance workflows. Intutic sits in the **execution path** and enforces those policies on every tool call an AI agent makes.

**We enforce. They govern.**

## Comparison

| Capability | Intutic | Credo AI |
|-----------|---------|----------|
| **Primary function** | Runtime enforcement (circuit breaker) | Governance, risk & compliance (GRC) |
| **Where it sits** | In the tool-call path between agent and infrastructure | Above the execution layer — policy and audit |
| **Enforcement** | Synchronous — BYPASS / ENHANCE / HIJACK / KILL, in-process | Policy definition and assessment — no runtime blocking |
| **Scope** | AI coding agents (19 harness integrations) | All AI systems (models, pipelines, applications) |
| **DLP & threat detection** | Secrets redaction, SQL injection, prompt injection | Risk scoring and bias detection |
| **Compliance output** | Enforcement audit logs (who, what, when, blocked/allowed) | Compliance reports, model cards, risk registers |
| **Integration model** | Local proxy + sync daemon | Cloud platform + API |
| **Custom rules** | WASM sandbox for domain-specific enforcement | Policy templates and assessment frameworks |

## Better Together — What Actually Interoperates Today

Intutic and Credo AI sit at different layers, and two of the three steps below are real:

1. **Define policies in Credo AI** — create governance frameworks, risk thresholds, and compliance requirements
2. **Enforce policies with Intutic** — translate governance rules into SOPs that block, modify, or allow agent actions in real time
3. **Export traces via OpenTelemetry** — Intutic emits standard OTLP traces (both the Rust proxy and the Node control-plane run a real trace exporter today, no metrics or logs). Any OTel-compatible collector can ingest that stream.

What does **not** exist: a Credo-specific connector, a Credo-shaped evidence schema, or an export route that translates Intutic's enforcement decisions into Credo AI's compliance evidence format. There is no code anywhere in this codebase that produces Credo-shaped output. If you want Intutic's enforcement audit logs represented as Credo AI evidence, you would need to build that translation layer yourself against Credo's ingestion API — it is not on our roadmap with a date, it is simply not built.

This gives your compliance team the governance system of record they need, and your engineering team the runtime enforcement layer they need — evidence pipelines between the two are on you today, not us.

## When You Need Intutic

- Your AI agents write files, run commands, and mutate databases
- You need **runtime enforcement** — blocking bad actions before they execute
- You want tool-call-level audit trails with enforcement decisions
- You need to cover **19 AI coding harnesses** with a single policy stack

## When You Need Credo AI

- You need organization-wide AI governance and risk management
- You're building compliance documentation for regulators (EU AI Act, NIST, ISO 42001)
- You need model risk scoring and bias assessment
- You want a GRC system of record for all AI systems, not just coding agents

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
