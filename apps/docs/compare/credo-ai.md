# Intutic vs Credo AI

Credo AI is an AI governance, risk, and compliance (GRC) platform. Since July 2026 it also ships **Agent Governor**, a runtime enforcement feature — so this is no longer a pure governance-vs-enforcement comparison. The honest distinction is now maturity and breadth, not capability category.

## Different Layers, Overlapping at the Edge

Credo AI's core is still the **governance system of record** — policy creation, risk assessment, audit documentation, and regulatory compliance workflows. Agent Governor extends that into the execution path: it hooks an agent harness at session start, before/after each tool call, and session end, and resolves each action to Allow / Block / Escalate / Advise, compiled from policy-as-code.

As of this writing it is a **Research Preview**, **Claude Code only**, with publicly reported scale in the low thousands of governed sessions and double-digit blocked actions — not the general-purpose, multi-harness enforcement Intutic runs today. Intutic's proxy sits in front of 39 coding-agent harnesses, enforces synchronously in-process (no round trip to a policy service), and has been the primary product surface rather than an extension of a governance platform.

Both products now say "policy-as-code," so the distinction has to be sharper than the vocabulary: where the policy lives, and what executes it. In Credo AI, policy-as-code is authored in a governance platform and compiled down into a per-harness hook. In Intutic, the policies are literally files in your repository — `.intutic/sops/*.md` and harness guideline files, reviewed in git like any other code change (see [GitOps for SOPs](/guide/gitops-sops)) — and the thing executing them is the enforcement path itself: the proxy evaluates them synchronously, in-process, on every tool call, with no round trip to a policy service. **Credo AI is adding an enforcement wing to a GRC platform. Intutic is policy-as-code where the code already runs: in the enforcement path.**

## Comparison

| Capability | Intutic | Credo AI (incl. Agent Governor) |
|-----------|---------|----------|
| **Primary function** | Runtime enforcement (circuit breaker) | Governance, risk & compliance (GRC), with a newer runtime-enforcement feature |
| **Where it sits** | In the tool-call path between agent and infrastructure | Above the execution layer for GRC; Agent Governor adds an in-path hook per harness |
| **Enforcement** | Synchronous — BYPASS / ENHANCE / HIJACK / KILL, in-process, all 39 harnesses | Agent Governor: Allow / Block / Escalate / Advise, Claude Code only, Research Preview |
| **Enforcement maturity** | Production, primary product surface | New (July 2026), reported at low-thousands-of-sessions scale |
| **Scope** | AI coding agents (39 harness integrations) | All AI systems for GRC; Agent Governor is single-harness today |
| **DLP & threat detection** | Secrets redaction, SQL injection, prompt injection | Risk scoring and bias detection (GRC side) |
| **Compliance output** | Enforcement audit logs (who, what, when, blocked/allowed) | Compliance reports, model cards, risk registers |
| **Integration model** | Local proxy + sync daemon | Cloud platform + API |
| **Custom rules** | Policies are files in git (`.intutic/sops/*.md`) plus a WASM sandbox for domain-specific enforcement logic | Policy templates and assessment frameworks; Agent Governor compiles policy-as-code |

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
- You need to cover **39 AI coding harnesses** with a single policy stack

## When You Need Credo AI

- You need organization-wide AI governance and risk management
- You're building compliance documentation for regulators (EU AI Act, NIST, ISO 42001)
- You need model risk scoring and bias assessment
- You want a GRC system of record for all AI systems, not just coding agents
- You're already invested in Credo AI's GRC platform and want to try enforcement without adding a second vendor — Agent Governor is worth evaluating for Claude Code specifically, with the caveat that it's a Research Preview today

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
