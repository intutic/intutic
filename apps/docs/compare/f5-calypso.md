---
title: Intutic vs F5 AI Guardrails
description: F5's AI Security Platform (formerly CalypsoAI) guards model traffic, red-teams AI applications and turns findings into guardrails; Intutic is the enforcement point inside 43 coding-agent harnesses.
---

# Intutic vs F5 AI Guardrails (formerly CalypsoAI)

*Last reviewed: 2026-10-10*

Intutic is the enforcement point inside the coding agent: a pre-execution gate decides each tool call in 36 of the 43 supported harnesses, with a policy proxy, an MCP governance proxy, a default-deny egress firewall, sandboxed execution and a signed audit trail behind it. F5 acquired CalypsoAI in September 2025; since June 2026 its products are sold as the F5 AI Security Platform. AI Guardrails scans model inputs and outputs, including custom guardrails described in plain language, and its Secure AI Agents capability enforces on agent actions and tool use. AI Red Team attacks models and applications, AI Remediate turns what the attacks found into guardrails, Workforce AI Security discovers AI use across the network, and an AI Gateway with an MCP gateway is in early access. F5 secures AI traffic across an enterprise; Intutic governs what coding agents and agent frameworks do on developer machines, in CI and in your services.

## Comparison

| | Intutic | F5 AI Guardrails |
|---|---|---|
| **Primary job** | Runtime enforcement and audit for AI agents | AI runtime security for models, applications and agents |
| **Where it enforces** | Pre-execution gates inside the agent (native hook gates in 18 of the 43 harnesses, in-process SDK gates in 17 agent frameworks), plus request and response proxy, MCP governance proxy, egress firewall and sandbox | At the model API: prompts, responses, and the tool calls in OpenAI- and Anthropic-format agent traffic; Workforce AI Security checks tool calls on the network |
| **Coding agents** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf and Cline | Claude Code, Codex CLI and Gemini CLI, by pointing the agent's model base URL at F5; per-session timelines of a Claude Code agent's steps and tool calls |
| **Decisions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, shadow | Allow, block or redact, or flag without acting |
| **Custom policy** | SOPs in git, WASM and Rego rules; policy documents turned into deterministic rules with [Policy Guardrails](/guide/policy-guardrails), proven in shadow mode before a person promotes them | A phrase becomes a versioned guardrail that F5's own model evaluates on each prompt or response; regex and keyword scanners |
| **MCP** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | An MCP gateway with an approved-server registry and per-agent access limits, in the AI Gateway (early access since August 2026) |
| **Red teaming** | — | Automated red teaming with multi-turn attacker agents, scheduled campaigns and new attack prompts every month; AI Remediate turns findings into guardrails, retests them and holds them for approval |
| **Deployment** | Cloud, or fully self-hosted including air-gapped | Public cloud, private cloud, on-prem, air-gapped |
| **Source** | Open core (MIT) | Closed |

## Where F5 is stronger

- **Red teaming that feeds the guardrails.** F5 AI Red Team attacks models and applications with adaptive, multi-turn attacker agents, on a schedule or from CI. AI Remediate turns what got through into guardrails, replays the successful attacks against them and waits for a person to approve. Intutic does not red-team, so its rules come from your policies and from what its detectors see in real traffic.
- **Guardrails from a phrase.** A custom guardrail is a short description that F5's own model applies to every prompt or response. Intutic's [Policy Guardrails](/guide/policy-guardrails) also start from plain-language policy, but compile each clause into a deterministic rule with a citation, and a sentence no rule can express is reported as having no enforceable rule. A semantic check such as "no discussion of unreleased products" is judged by Intutic only after the fact, by a self-hosted model that raises an alert (the [trajectory monitor](/guide/trajectory-monitor) can end the session on Enterprise), never by blocking the request inline.
- **Published benchmarks.** F5 publishes monthly security leaderboards for models and agents (CASI and ARS).
- **Coverage beyond agents.** Guardrails for every LLM application, network discovery of AI use across the workforce, and one vendor for teams already on F5.

## When to choose Intutic

- Your risk is coding agents running commands, editing files and calling MCP tools, and you need each call decided before it runs.
- You need coverage for the specific harnesses and frameworks your developers use.
- You want approval holds, egress control and sandboxing at the agent.
- You want to read the enforcement code and verify the audit trail yourself.

## When to choose F5 AI Guardrails

- You need guardrails and red teaming across customer-facing and internal LLM applications.
- Your main concern is prompt injection, jailbreaks and data leakage in model traffic.
- You want AI security from the vendor that already runs your application delivery.

## Use them together

F5 can guard model traffic across the enterprise while Intutic gates the coding agents' tool calls and contains their network access. Each sees a different part of the same session.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
