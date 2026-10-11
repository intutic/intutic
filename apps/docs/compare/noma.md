---
title: Intutic vs Noma Security
description: Noma Security governs coding agents through open-source hook plugins backed by its closed platform, and announced endpoint coverage in September 2026; Intutic is the enforcement point inside 43 coding-agent harnesses, with gates that fail closed.
---

# Intutic vs Noma Security

*Last reviewed: 2026-10-10*

Intutic is the enforcement point inside the coding agent: a pre-execution gate decides each tool call in 36 of the 43 supported harnesses, with a policy proxy, an MCP governance proxy, a default-deny egress firewall, sandboxed execution and a signed audit trail behind it. It is open core, runs fully self-hosted including air-gapped, and publishes its prices. Noma Security ([noma.security](https://noma.security)) is an AI security platform whose coding-agent controls ship as hook plugins for Claude Code, Codex, Cursor and GitHub Copilot. The plugins are open source under Apache-2.0 and call Noma's closed backend with an API key. On 2026-09-28 Noma [announced](https://www.prnewswire.com/news-releases/noma-extends-agent-security-and-governance-to-the-employee-endpoint-302890925.html) endpoint coverage for more agents, discovered through EDR and MDM tools; the announcement carries no general-availability label. The sharpest difference is what happens when the policy layer cannot answer: Noma's plugins let the call proceed, Intutic's gates block it.

## Comparison

| | Intutic | Noma Security |
|---|---|---|
| **Where enforcement happens** | At the tool call: native pre-execution hook gates in 18 of the 43 harnesses and in-process SDK gates in 17 agent frameworks; plus a request and response proxy, an MCP governance proxy, a host egress firewall (`intutic enforce`) and sandboxed execution (`intutic exec --sandbox`) | Hook plugins in the agent. In Claude Code they run when a prompt is submitted, before and after each tool call, and when the session stops, covering shell commands, MCP calls and file reads; in Cursor a generic pre-tool hook covers prompts, shell, MCP and file reads and edits. The announcement adds gateways, SDKs, EDR and MDM as routes; the vendor says Claude Code and Cowork cloud sessions are covered through organization-level hooks |
| **Coding agents covered** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Cline, Roo Code, OpenCode and Goose, plus agent frameworks such as LangGraph, CrewAI and the OpenAI Agents SDK through an in-process gate | [Plugins](https://github.com/Noma-Security/noma-marketplace) for Claude Code, Codex, Cursor and GitHub Copilot; its Cursor marketplace listing is in progress. The announcement also names Claude Cowork, Windsurf, Kiro, Antigravity and OpenClaw, with no plugin or documentation for the last four |
| **Policy actions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, and shadow mode that measures how often a rule would act | Block, mask or ask. An ask verdict uses Claude Code's own permission prompt, so it works in interactive sessions only; in Cursor an ask verdict does not block. Policy per user, group, tool or organization, tied to identity-provider groups (announced) |
| **When the policy layer fails** | Hook gates fail closed on a crash or a malformed payload, and the proxy blocks by default when its policy service is unreachable. A built-in destructive-command tier blocks with no configuration | The plugins fail open: with no API key, no network or malformed input, the call proceeds |
| **MCP governance** | MCP governance proxy with a server registry, approvals and optional default-deny, approval holds, per-call identity, DLP, policy rules, anomaly detectors, trust-on-first-use pinning and tool-description poisoning detection | Discovery of MCP servers, policy per server, tool or group, flagging or blocking unapproved servers, and detection of poisoning in tool responses. No MCP gateway of its own is documented |
| **Red teaming** | — | Listed as a module on its website; no product documentation found |
| **Discovery and inventory** | [AI inventory](/guide/ai-inventory) of developer machines that run `intutic connect`: the harnesses, MCP servers and skill bundles on each, and which run ungoverned | Agents, MCP servers and skills discovered through EDR and MDM tools (CrowdStrike is named), kept in a governed registry as approved, under review or blocked (announced) |
| **Deployment** | Cloud, or fully self-hosted: signed images and an air-gap bundle, Helm charts, an offline license | The vendor says on-premises and hosted; no air-gapped deployment is documented |
| **Source** | Open core (MIT): the proxy, hook gates, MCP proxy, CLI and sync daemon | Plugins Apache-2.0; the backend they call is closed and needs an API key |
| **Pricing** | [Published](/guide/plans); the open core is free | Not published |

## Where Noma Security is stronger

- **Discovery through the security stack.** The announced endpoint coverage finds agents, MCP servers and skills through EDR and MDM tools such as CrowdStrike, and keeps them in a registry with approved, under-review and blocked states. Intutic's [AI inventory](/guide/ai-inventory) covers developer machines that run `intutic connect`.
- **Cloud agent sessions.** The vendor says organization-level hooks reach Claude Code and Cowork sessions that run in the cloud.
- **A wider AI security platform.** The vendor lists posture management, agent access control and detection and response modules alongside the coding-agent plugins.

## When to choose Intutic

- You need a tool call blocked when the policy layer is unreachable or the input is malformed, not allowed through.
- You want risky calls held in a review queue and released with `intutic decision approve`, rather than decided at the agent's own permission prompt.
- Your developers use coding agents beyond the four Noma ships plugins for, such as Windsurf, Cline or Goose, or agent frameworks such as LangGraph.
- You want an egress firewall and a sandbox so an agent cannot route around governance, and an audit trail you can verify yourself.
- You need to run the whole product on your own infrastructure, including air-gapped.

## When to choose Noma Security

- You want agent discovery driven by the EDR and MDM tools you already run.
- Your coding agents are Claude Code, Codex, Cursor and GitHub Copilot, and fail-open behaviour is acceptable for them.
- You want the coding-agent plugins from a vendor that also lists posture, access-control and detection modules.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
