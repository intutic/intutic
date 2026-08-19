# Intutic vs Fiddler AI

Fiddler AI is an enterprise model monitoring and guardrails platform built to detect toxicity, PII leakage, prompt injections, and model hallucinations inside text inputs and outputs. **Intutic is a proxy-level agent control plane that governs actual tool execution and operating system activities in real time.**

## The Core Difference

Fiddler AI focuses on **content guardrails**. It analyzes natural language text values to ensure models do not receive or output prohibited text structures. Intutic focuses on **action guardrails**. It inspects the commands, file mutations and queries an agent is about to perform — wherever that agent runs — and blocks them at the proxy layer if security constraints are breached.

If your agent attempts to execute a shell command that deletes a configuration file, Fiddler will not catch it because the prompt text is structurally benign. Intutic inspects the command payload, compares it with security policies, and terminates the execution.

---

## Comparison

| Capability | Intutic | Fiddler AI |
|-----------|---------|------------|
| **Primary Scope** | Action & Tool-Call Interception | Prompt Content & Model Text Evaluation |
| **Interception Point** | System commands, files, database, and network | LLM prompt inputs and model text outputs |
| **Enforcement Layer** | Synchronous terminal/proxy gateway, in-process | Model API gateway or async content scanner |
| **Sandbox Isolation** | WASM (wasmtime) policy sandbox — 16 MB, 1,000,000 fuel, 5 ms, explicit host-import allowlist | Not available |
| **Agent Integrations** | 39 AI coding harnesses (Claude Code, Cursor, etc.) | Standard chatbot SDK integrations |
| **FinOps & ROI** | Append-only cost ledger with per-model breakdown; daily and monthly caps enforced with KILL | Basic model usage statistics |

---

## When to Choose Intutic

- **You are deploying autonomous agents** that interact with local developer filesystems, command lines, or databases.
- **You need to protect infrastructure** from destructive shell execution (e.g. `rm -rf`, raw database updates).
- **You want policy evaluated in a sandbox you can trust** — rules run as WASM under wasmtime with hard memory, fuel and time limits, and an explicit host-import allowlist.
- **You want to manage engineering seats** and compute limits dynamically.

## When to Choose Fiddler AI

- **You only need to scan text inputs** for PII leakage, toxicity, or safety violations.
- **You want to monitor model drift** and evaluate performance over time on chatbot conversations.
- **Your agents are not running shell commands** or modifying developer source codes.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
