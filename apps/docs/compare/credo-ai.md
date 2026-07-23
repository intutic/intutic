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
| **Enforcement** | Synchronous — BYPASS / ENHANCE / HIJACK / KILL in <50ms | Policy definition and assessment — no runtime blocking |
| **Scope** | AI coding agents (18 harness integrations) | All AI systems (models, pipelines, applications) |
| **DLP & threat detection** | Secrets redaction, SQL injection, prompt injection | Risk scoring and bias detection |
| **Compliance output** | Enforcement audit logs (who, what, when, blocked/allowed) | Compliance reports, model cards, risk registers |
| **Integration model** | Local proxy + sync daemon | Cloud platform + API |
| **Custom rules** | WASM sandbox for domain-specific enforcement | Policy templates and assessment frameworks |

## Better Together

Intutic and Credo AI are **complementary**. Use them together for full-stack AI governance:

1. **Define policies in Credo AI** — create governance frameworks, risk thresholds, and compliance requirements
2. **Enforce policies with Intutic** — translate governance rules into SOPs that block, modify, or allow agent actions in real time
3. **Export enforcement evidence to Credo AI** — send Intutic's audit logs and enforcement decisions back to Credo's compliance system as evidence of policy adherence

This gives your compliance team the governance system of record they need, and your engineering team the runtime enforcement layer they need.

## When You Need Intutic

- Your AI agents write files, run commands, and mutate databases
- You need **runtime enforcement** — blocking bad actions before they execute
- You want tool-call-level audit trails with enforcement decisions
- You need to cover **18 AI coding harnesses** with a single policy stack

## When You Need Credo AI

- You need organization-wide AI governance and risk management
- You're building compliance documentation for regulators (EU AI Act, NIST, ISO 42001)
- You need model risk scoring and bias assessment
- You want a GRC system of record for all AI systems, not just coding agents

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
