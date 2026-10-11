---
title: Intutic vs Zenity
description: Zenity is a security platform for AI agents across the enterprise, with native hooks and an MCP gateway for coding agents; Intutic is the enforcement point inside 43 coding-agent harnesses, open core and self-hostable.
---

# Intutic vs Zenity

*Last reviewed: 2026-10-10*

Intutic is the enforcement point inside the coding agent: a pre-execution gate decides each tool call in 36 of the 43 supported harnesses, with a policy proxy, an MCP governance proxy, a default-deny egress firewall, sandboxed execution and a signed audit trail behind it. It is open core, runs fully self-hosted including air-gapped, and publishes its prices. Zenity ([zenity.io](https://zenity.io)) secures AI agents across an organization: assistants such as Microsoft Copilot, ChatGPT Enterprise and Gemini, agents built on Foundry, Bedrock and Vertex, and, for coding and personal agents, native agent hooks and an MCP gateway that block or modify a tool call before it runs. Zenity covers the breadth of enterprise AI from one platform; Intutic goes deep on coding agents and agent frameworks, where they run.

## Comparison

| | Intutic | Zenity |
|---|---|---|
| **Where enforcement happens** | At the tool call: native pre-execution hook gates in 18 of the 43 harnesses and in-process SDK gates in 17 agent frameworks; plus a request and response proxy, an MCP governance proxy, a host egress firewall (`intutic enforce`) and sandboxed execution (`intutic exec --sandbox`) | Native agent hooks (pre-tool blocking in Claude Code, Cursor and Codex) and its MCP gateway, which block or modify a tool call before it runs. Telemetry comes from OpenTelemetry and the hooks; Claude Enterprise connects through Anthropic's Compliance API. The vendor says no endpoint sensor is needed |
| **Coding agents covered** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Cline, Roo Code, OpenCode and Goose, plus agent frameworks such as LangGraph, CrewAI and the OpenAI Agents SDK through an in-process gate | Claude Code, Claude Cowork, Codex, GitHub Copilot and Cursor are named on its [coding-agents page](https://zenity.io/use-cases/agent-type/coding-personal-agents); hooks for GitHub Copilot and Codex became generally available in August 2026 |
| **Policy actions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, and shadow mode that measures how often a rule would act | Block a tool call, redact output, or show guidance in the agent's chat; MCP allowlists set at build time. Rules run in Detect or Prevent mode, and each taint is marked as blocking or flag-only |
| **When the policy layer fails** | Hook gates fail closed on a crash or a malformed payload, and the proxy blocks by default when its policy service is unreachable. A built-in destructive-command tier blocks with no configuration | Not documented |
| **MCP governance** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | An [MCP gateway](https://zenity.io/platform/mcp-security) behind one URL that allows, modifies or blocks each tool, per agent, user or team |
| **Red teaming** | — | No red-teaming product documented. Risky skills, files and code can be detonated in a sandbox |
| **Discovery and inventory** | [AI inventory](/guide/ai-inventory) of developer machines that run `intutic connect`: the harnesses, MCP servers and skill bundles on each, and which run ungoverned | Assistants and agent platforms across the organization; inventory and monitoring through its GitHub Copilot and Codex hooks |
| **Audit and SIEM** | Merkle tree with per-trace inclusion proofs and Ed25519-signed roots, verifiable in the browser or with `intutic integrity verify`; six SIEM destinations, including Splunk HEC, Syslog/CEF and Datadog | Immutable audit; streaming to Splunk and Microsoft Sentinel |
| **Deployment** | Cloud, or fully self-hosted: signed images and an air-gap bundle, Helm charts, an offline license | No self-hosted or air-gapped option is documented |
| **Source** | Open core (MIT): the proxy, hook gates, MCP proxy, CLI and sync daemon | The platform's source is not published; Zenity released an [open-source security framework for OpenClaw](https://zenity.io/blog/open-source-security-openclaw) in March 2026, with no licence stated |
| **Pricing** | [Published](/guide/plans); the open core is free | Not published |

## Where Zenity is stronger

- **Breadth beyond coding agents.** One platform covers enterprise assistants (Microsoft Copilot, ChatGPT Enterprise, Gemini) and agents built on Foundry, Bedrock and Vertex alongside coding agents. Intutic governs coding agents and agent frameworks.
- **Nothing on the endpoint.** The vendor says its coding-agent coverage needs no endpoint sensor. Every Intutic enforcement point runs on the machine, in the CI job or beside the service.
- **Policy drafted and tested for you.** An AI assistant in Zenity drafts a rule and tests it against recent activity; rules can also be managed as code through a CLI. Intutic's [Policy Guardrails](/guide/policy-guardrails) start from the policy documents you already have, cite the passage behind each rule, and prove it in shadow mode before a person promotes it.
- **Detonation of suspect artefacts.** Zenity runs risky skills, files and code in a sandbox to see what they do. Intutic's sandbox (`intutic exec --sandbox`) contains the agent's own execution.
- **Per-team MCP tool policy behind one URL.** Its MCP gateway can modify a tool call as well as allow or block it, per agent, user or team.

## When to choose Intutic

- Your agents are coding agents and agent frameworks, such as Windsurf, Cline, Roo Code, Goose or LangGraph alongside Claude Code and Cursor, and you want each tool call decided before it runs.
- You want risky calls held for approval rather than only allowed or blocked.
- You need to run the whole product on your own infrastructure, including air-gapped.
- You want to read the code that blocks a call, and to verify the audit trail yourself.
- You want an egress firewall and a sandbox so an agent cannot route around governance.

## When to choose Zenity

- You need to secure enterprise assistants and agent platforms, such as Microsoft Copilot and ChatGPT Enterprise, from the same console as your coding agents.
- You want coding-agent coverage without installing a sensor on developer machines.
- You do not need to run the platform on your own infrastructure.

## Use them together

Zenity can cover the enterprise assistants and agent platforms while Intutic gates the coding agents' tool calls inside each harness and contains their network access. Each governs a different part of the organization's AI use.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
