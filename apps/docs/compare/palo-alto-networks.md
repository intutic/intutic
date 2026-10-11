---
title: Intutic vs Palo Alto Networks (Prisma AIRS and Cortex AES)
description: Palo Alto Networks secures coding agents with Agentic Endpoint Security (from Koi) and Prisma AIRS, inside a wider AI and endpoint security portfolio; Intutic is the enforcement point inside 43 coding-agent harnesses, open core and self-hostable.
---

# Intutic vs Palo Alto Networks (Prisma AIRS and Cortex AES)

*Last reviewed: 2026-10-10*

Intutic is the enforcement point inside the coding agent: a pre-execution gate decides each tool call in 36 of the 43 supported harnesses, with a policy proxy, an MCP governance proxy, a default-deny egress firewall, sandboxed execution and a signed audit trail behind it. It is open core, runs fully self-hosted including air-gapped, and publishes its prices. Palo Alto Networks reaches coding agents from two sides. On the endpoint, it [completed its acquisition of Koi](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-koi-to-secure-the-agentic-endpoint) on 2026-04-14 and sells it as Agentic Endpoint Security (AES): standalone, as a Cortex XDR module and as part of Prisma AIRS. AES manages hooks in the coding agent that block or ask on its actions, with Prisma AIRS supplying detectors. On the network, Prisma AIRS covers agent runtime security, red teaming, artifact scanning and posture, and Prisma AIRS AI Gateway (formerly Portkey) carries model, MCP and agent-to-agent traffic; see [Intutic vs Portkey](/compare/portkey) for the gateway comparison. This page covers the endpoint side.

## Comparison

| | Intutic | Palo Alto Networks |
|---|---|---|
| **Where enforcement happens** | At the tool call: native pre-execution hook gates in 18 of the 43 harnesses and in-process SDK gates in 17 agent frameworks; plus a request and response proxy, an MCP governance proxy, a host egress firewall (`intutic enforce`) and sandboxed execution (`intutic exec --sandbox`) | Hooks deployed and managed by AES, with custom rules over shell commands, file access, MCP tools, skills and network requests; a blocked call shows a message in the agent's chat. Claude Enterprise inference hooks call Prisma AIRS for a synchronous allow or deny (since 2026-08-05). Model and MCP traffic through Prisma AIRS AI Gateway; MCP threat detection at the network firewall |
| **Coding agents covered** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Cline, Roo Code, OpenCode and Goose, plus agent frameworks such as LangGraph, CrewAI and the OpenAI Agents SDK through an in-process gate | AES rules in [Cursor, Claude Code and Antigravity](https://www.paloaltonetworks.com/blog/security-operations/a-quarter-of-innovation-with-koi-agentic-endpoint-security/); the [Prisma AIRS integration](https://www.paloaltonetworks.com/blog/ai-security/securing-the-ai-coding-frontier-prisma-airs-agentic-endpoint-security/) names Claude Code, Cursor, Codex, GitHub Copilot and Antigravity, with no general-availability label. [Hook examples on GitHub](https://github.com/PaloAltoNetworks/prisma-airs-integrations) for Claude Code, Codex, Cursor (partial), Cline, Devin, Gemini CLI and Grok Build, with best-effort support. The Cortex XDR module runs on Windows and macOS, not Linux |
| **Policy actions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, and shadow mode that measures how often a rule would act | Block or ask, through custom rules; removal of Claude Code plugins and npm packages, with a registry proxy that blocks reinstalling them |
| **When the policy layer fails** | Hook gates fail closed on a crash or a malformed payload, and the proxy blocks by default when its policy service is unreachable. A built-in destructive-command tier blocks with no configuration | Not documented |
| **MCP governance** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | AES rules on MCP tools in the agent; scanning of MCP servers as artifacts; MCP threat detection on the network through the Prisma AIRS VM-Series firewall, managed in Strata Cloud Manager or Panorama; MCP routing through Prisma AIRS AI Gateway (see [Portkey](/compare/portkey)) |
| **Red teaming** | — | Part of Prisma AIRS since version 3.0 (2026-03-23), with scanning of agent code, MCP servers and skills |
| **Discovery and inventory** | [AI inventory](/guide/ai-inventory) of developer machines that run `intutic connect`: the harnesses, MCP servers and skill bundles on each, and which run ungoverned | AES inventories agents, extensions, packages, skills and binaries on the endpoint and detects personal accounts; Prisma AIRS adds posture management and agent identity |
| **Deployment** | Cloud, or fully self-hosted: signed images and an air-gap bundle, Helm charts, an offline license | AES runs on the endpoint; Strata Cloud Manager is hosted. No self-hosted or air-gapped control plane is documented |
| **Source** | Open core (MIT): the proxy, hook gates, MCP proxy, CLI and sync daemon | Closed; hook examples published on GitHub |
| **Pricing** | [Published](/guide/plans); the open core is free | No list prices. Bring-your-own-license on Software NGFW credits; the runtime API is metered in tokens |

## Where Palo Alto Networks is stronger

- **Endpoint hygiene beyond the tool call.** AES inventories agents, extensions, packages, skills and binaries, detects personal accounts, removes Claude Code plugins and npm packages, and blocks their reinstallation through a registry proxy. Intutic's [AI inventory](/guide/ai-inventory) lists harnesses, MCP servers and skill bundles, and governs what the agent does rather than what is installed.
- **Red teaming and artifact scanning.** Prisma AIRS red-teams AI applications and scans agent code, MCP servers and skills. Intutic does not red-team, so its rules come from your policies and from what its detectors see in real traffic.
- **One portfolio across endpoint, network and gateway.** Endpoint rules, network firewalls, an AI gateway and agent identity come from one vendor, which suits teams already on Cortex or Prisma.
- **Claude Enterprise inference hooks.** Prisma AIRS gives a synchronous allow or deny on Claude Enterprise inference.

## When to choose Intutic

- Your developers use coding agents beyond those AES names, such as Windsurf, Cline, Roo Code or Goose, or agent frameworks such as LangGraph, and you want each tool call decided before it runs.
- Your developers use Linux, which the Cortex XDR module of AES does not support.
- You want risky calls held for approval rather than only allowed or blocked.
- You need to run the whole product on your own infrastructure, including air-gapped.
- You want to read the code that blocks a call, verify the audit trail yourself, and see published prices.

## When to choose Palo Alto Networks

- You already run Cortex XDR or Prisma AIRS and want coding-agent controls in the same console.
- You want endpoint inventory and removal of risky plugins and packages alongside tool-call rules.
- You need red teaming and artifact scanning from the same vendor.

## Use them together

AES can keep inventory and package hygiene on Windows and macOS endpoints while Intutic gates the coding agents' tool calls inside each harness, on Linux and in the CI job as well, and contains their network access. For model traffic, see [Use them together](/compare/portkey#use-them-together) on the Portkey page.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
