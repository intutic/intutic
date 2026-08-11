# Intutic vs W&B Weave

Weights & Biases Weave is a developer tool built to trace LLM application graphs, log datasets, and evaluate prompt alignment metrics. **Intutic is an active governance layer with opt-in egress containment (`intutic enforce`) and runtime isolation (`intutic exec --sandbox`) for autonomous agent fleets** (see [LLD #63](https://github.com/intutic/intutic)).

## The Core Difference

W&B Weave is designed for **model tracing**. It monitors call hierarchies, logging prompt inputs and responses to evaluate alignment and quality metrics. Intutic is designed for **active enforcement**. It sits inline on the agent's traffic and applies execution gates in real time, blocking a request before it reaches the model rather than reporting on it afterwards.

If your agent's next step is a tool call an SOP forbids, W&B Weave will log the API trajectory. Intutic sees that tool call in the request, matches it against the SOP in force, and kills the request before the model ever answers.

---

## Comparison

| Capability | Intutic | W&B Weave |
|-----------|---------|-----------|
| **Core Value** | Active containment & sandbox security | Trajectory tracing & prompt evaluation |
| **Isolation Model** | WASM (wasmtime) policy sandbox — 16 MB, 1,000,000 fuel, 5 ms, explicit host-import allowlist | Not available |
| **Egress Control** | Opt-in default-deny egress (`intutic enforce`) forces all traffic through the governing proxy | N/A |
| **Enforcement Path** | Real-time inline proxy — requests are blocked before they reach the model | Async telemetry listener |
| **Rule Engine** | Dynamic WASM modules & custom security scripts | Prompt evaluation workflows |
| **Target Workload** | Autonomous coding agents (Cursor, Claude Code) | Chat applications, RAG pipelines |

---

## When to Choose Intutic

- **You deploy untrusted autonomous agents** that need to execute code locally but must be walled off from sensitive networks or source code repositories.
- **You require isolated sandbox runs** (`intutic exec --sandbox`) for per-run workspace isolation whose only egress is the governing proxy.
- **You need active, real-time protection** against unauthorized files, commands, and network connections.
- **You want ready-to-use integrations** for 18+ agent harnesses.

## When to Choose W&B Weave

- **You are optimizing RAG pipelines** and need to visualize nested LLM call graphs and dataset traces.
- **You are fine-tuning models** and need to log training datasets and prompt evaluations.
- **You do not require runtime isolation** (`intutic exec --sandbox`) or opt-in firewall containment (`intutic enforce`).

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
