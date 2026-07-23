# Intutic vs LangSmith

LangSmith is a powerful developer platform designed for tracing, debugging, and evaluating LLM application behavior after execution. **Intutic is a real-time, synchronous agentic firewall that prevents policy violations and runaway costs before they are incurred.**

## The Core Difference

LangSmith is built for **post-hoc analysis**. It records trace graphs, logs outputs, and provides tools to run evaluations against offline test datasets. Intutic is built for **live runtime containment**. It intercepts tool calls and LLM completions, applying safety filters, cost limits, and security constraints in the active execution path.

If your agent runs into an infinite loop, LangSmith will record a detailed visualization of the $500 token spike. Intutic's warm-path budget gate pre-check intercepts the loop and kills the session in under 1ms.

---

## Comparison

| Capability | Intutic | LangSmith |
|-----------|---------|-----------|
| **Primary Purpose** | Active security containment & cost enforcement | Passive tracing, debugging, and offline evaluations |
| **Execution Path** | Synchronous interceptor (under 50ms) | Asynchronous logging listener |
| **Cost Control** | Real-time budget gates (kills runaway loops) | Cost estimation after request completes |
| **Tool-Call Security** | Active blocks on shell commands, files, APIs | Post-hoc audit trail of executed tools |
| **Policy Definition** | Standardized SOP schemas and WASM rules | Evaluator prompt tests ran against logs |
| **Deployment Model** | Local-first gateway + Cloud hub sync | Cloud-hosted dashboard (SaaS) |

---

## When to Choose Intutic

- **You run autonomous agents** that interact with files, databases, and APIs where bad commands must be blocked immediately.
- **You need strict cost boundaries** to prevent unexpected token spend spikes.
- **You want to enforce security policies locally** on developer machines without sending all prompt activities to third-party clouds.
- **You want ready-to-use hooks** for standard developer harnesses like Cursor, Claude Code, or VSCode.

## When to Choose LangSmith

- **You are debugging prompt chains** and need a detailed visual trace of nested model calls.
- **You want to run automated regression testing** against curated gold-standard prompt datasets.
- **You do not require real-time containment** or active process blocking.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
