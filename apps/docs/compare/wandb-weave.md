# Intutic vs W&B Weave

Weights & Biases Weave is a developer tool built to trace LLM application graphs, log datasets, and evaluate prompt alignment metrics. **Intutic is an active security containment and execution isolation platform for autonomous agent fleets.**

## The Core Difference

W&B Weave is designed for **model tracing**. It monitors call hierarchies, logging prompt inputs and responses to evaluate alignment and quality metrics. Intutic is designed for **active enforcement**. It sits inline on the agent's traffic and applies execution gates in real time, blocking a request before it reaches the model rather than reporting on it afterwards.

If your agent attempts to establish an unauthorized SSH connection to your internal servers, W&B Weave will log the API trajectory. Intutic intercepts the socket connection at the container boundaries and terminates the run.

---

## Comparison

| Capability | Intutic | W&B Weave |
|-----------|---------|-----------|
| **Core Value** | Active containment & sandbox security | Trajectory tracing & prompt evaluation |
| **Isolation Model** | WASM (wasmtime) policy sandbox — 16 MB, 1,000,000 fuel, 5 ms; SOP hook scripts in a frozen V8 context (node:vm, 100 ms) | Not available |
| **Egress Control** | All agent LLM traffic forced through the governing proxy | N/A |
| **Enforcement Path** | Real-time inline proxy — requests are blocked before they reach the model | Async telemetry listener |
| **Rule Engine** | Dynamic WASM modules & custom security scripts | Prompt evaluation workflows |
| **Target Workload** | Autonomous coding agents (Cursor, Claude Code) | Chat applications, RAG pipelines |

---

## When to Choose Intutic

- **You deploy untrusted autonomous agents** that need to execute code locally but must be walled off from sensitive networks or source code repositories.
- **You require isolated sandbox runs** to guarantee workspace isolation and SOC 2 security compliance.
- **You need active, real-time protection** against unauthorized files, commands, and network connections.
- **You want ready-to-use integrations** for 18+ agent harnesses.

## When to Choose W&B Weave

- **You are optimizing RAG pipelines** and need to visualize nested LLM call graphs and dataset traces.
- **You are fine-tuning models** and need to log training datasets and prompt evaluations.
- **You do not require system isolation** or active firewall containment.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
