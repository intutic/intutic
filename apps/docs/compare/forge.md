---
title: Intutic vs Forge
description: Intutic is the enforcement point at the agent's tool call, open core and self-hostable; Forge is a hosted platform that assembles control points across an organization's security stack.
---

# Intutic vs Forge

*Last reviewed: 2026-10-08*

Intutic and Forge start from different places. Intutic is the enforcement point itself: a gate inside the coding agent that decides each tool call before it runs, in 36 of its 43 supported harnesses, backed by a policy proxy, an MCP governance proxy, a default-deny egress firewall and sandboxed execution. It is open core, runs fully self-hosted including air-gapped, and publishes its prices. Forge (by a37) is a hosted governance platform that works top-down: it discovers AI agents and non-human identities across an organization, brokers their cloud credentials, and enforces policy through its own device agent, MCP gateway and LLM gateway plus the security tools you already run.

## Comparison

| | Intutic | Forge |
|---|---|---|
| **Where enforcement happens** | At the tool call: native pre-execution hook gates in 19 of the 43 harnesses and in-process SDK gates in 17 agent frameworks; plus a request and response proxy, an MCP governance proxy, a host egress firewall (`intutic enforce`) and sandboxed execution (`intutic exec --sandbox`) | Its device agent, MCP gateway and LLM gateway, plus control points in connected tools |
| **Coding agents covered** | **43** supported harnesses, including Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Cline, Roo Code, OpenCode and Goose, plus agent frameworks such as LangGraph, CrewAI and the OpenAI Agents SDK through an in-process gate | Documented integrations for Claude Code, Claude Cowork, Codex, Cursor, OpenClaw and Rovo Dev, with managed configuration for the first four |
| **Policy actions** | Allow, warn, require approval (the call is refused and queued for review; once it is approved with `intutic decision approve`, the identical retry passes if the workspace has opted in), block, redact, re-ask, and shadow mode that measures how often a rule would act | Allow, nudge, flag for review, redact, filter, require approval, block |
| **When the policy layer fails** | Hook gates fail closed on a crash or a malformed payload, and the proxy blocks by default when its policy service is unreachable. A built-in destructive-command tier blocks with no configuration | Rego policies fail closed; built-in conditions that lack data do not match; the Cloudflare transport fails open unless switched to fail closed |
| **MCP governance** | A server registry with approvals, an optional default-deny policy and per-tool switches; approval holds; the API key, OS user and session on every event and hold, with the member resolved from the key and SSO group policy applied; call budgets per server, per member and per tool, counted in Valkey across proxies; pattern DLP, argument-matching policy rules, prompt-injection scanning, seven anomaly detectors, WASM rules, trust-on-first-use pinning that flags or blocks a changed tool set, a rule-based risk score for each tool-set change that can return a server to the approval queue, and tool-description poisoning detection; wired automatically into 11 harnesses; MCP servers that bypass the proxy are listed as ungoverned | MCP Gateway with a default-deny server registry, approvals, per-server, per-user and per-tool budgets, tool-change risk scoring and OAuth 2.1 |
| **Audit integrity** | Merkle tree with per-trace inclusion proofs; Ed25519-signed roots against a published key set; roots hash-chained to each other and mirrored to your own GCS or S3 bucket; append-only database triggers; an hourly probe that re-derives the roots, walks the chain and alerts when either fails; verification in the browser or with `intutic integrity verify` | SHA-256 hash-chain ledger, database-enforced immutability, a scheduled verifier, signed checkpoints and proof packages, with external anchor receipts when configured |
| **SIEM and alerting** | Six destinations (Splunk HEC, Syslog/CEF, Datadog, S3, GCS, an HMAC-signed webhook) with retries and a dead-letter queue, streaming traces, incidents, findings, plan decisions, device events, sign-ins, settings and policy changes, governance alerts and, opt-in, every gate decision; Slack, PagerDuty, email and HMAC-signed webhook notifications, including alerts when a gate stops reporting or the integrity check fails | Splunk HEC, S3 and Falcon LogScale exports, plus a signed notification webhook with Tines and Google SecOps templates |
| **Identity** | SAML and OIDC with group claims; SCIM 2.0 with nested groups, which map to roles and, while SCIM is on, replace sign-in claims as the member's groups; an SSO group policy uses those groups to restrict high-risk tools at the server, MCP, local and SDK gates and in the proxy's response gate; virtual keys with scopes, model allowlists and attenuated child keys; an agent registry with posture scoring and an agent graph | Agent identities, a non-human-identity inventory, and short-lived credentials issued for AWS, Microsoft Entra, Google Cloud and GitHub |
| **Devices** | CA trust and Jamf/Intune MDM profiles (`intutic enterprise install`), stale-device detection | Native device agent for Windows (Intune), macOS (Network Extension, Jamf or other MDM) and Linux (systemd) |
| **Compliance** | Eleven hourly compliance probes against live workspace state, a SOC 2 evidence pack, OWASP LLM and Agentic posture mapping, partial control mapping to the EU AI Act, ISO/IEC 42001 and NIST AI RMF, and an EU AI Act Article 14 human-oversight export, both exports signed when a signing key is configured | Framework mapping to NIST AI RMF, EU AI Act, ISO 42001, SOC 2, HIPAA, OWASP, MITRE ATLAS and others, exported as PDF, CSV or JSON |
| **Deployment** | Cloud, or fully self-hosted: signed images and an air-gap bundle, Helm charts, an offline license | Hosted service; Resource Gateways run in your environment and connect out to Forge. No self-hosted or air-gapped option is documented |
| **Source** | Open core (MIT): the proxy, hook gates, MCP proxy, CLI and sync daemon | Closed |
| **Pricing** | [Published](/guide/plans); the open core is free | Not published |

On audit integrity, Intutic covers what Forge's ledger does (a hash chain, database-enforced immutability, scheduled verification and signed checkpoints) and adds two things Forge does not document: a Merkle inclusion proof for every trace, and verification you run yourself, in a browser or with the CLI, against a published key set. See [Trace Integrity](/concepts/trace-integrity).

## Where Forge is stronger

- **Organization-wide discovery.** Forge inventories AI agents and non-human identities across the whole organization, beyond the coding-agent surface.
- **Credential brokering.** It issues short-lived cloud credentials to agents and right-sizes their permissions. Intutic governs what an agent does with access it already has.
- **MCP OAuth brokering.** Forge's MCP gateway brokers OAuth 2.1 for remote MCP servers. Intutic's MCP proxy passes a remote server's credentials through rather than obtaining, refreshing or scoping them. Both have server registries, budgets and tool-change risk scores; Intutic's budgets count calls in a Valkey the proxies share, so proxies on separate Valkeys count separately. New Intutic workspaces start with the registry allowing unapproved servers.
- **Regulatory framework mapping.** Intutic maps its own evidence to SOC 2 and OWASP, and to the EU AI Act, ISO/IEC 42001 and the NIST AI RMF where an enforcement layer can evidence a control, mostly as partial coverage. Forge also maps to HIPAA, MITRE ATLAS and more, and exports the mapping as PDF or CSV.
- **Policy as infrastructure code.** Rego policies with backtests against historical evidence, and a Terraform provider.
- **Protocol policies.** Connection and command decisions for HTTP, Postgres, MySQL and Redis. Intutic's `sql_guard` covers destructive SQL issued through an agent's tools.

## When to choose Intutic

- Your agents are coding agents and agent frameworks, such as Windsurf, Cline, Roo Code, Goose or LangGraph alongside Claude Code and Cursor, and you want each tool call decided before it runs.
- You need to run the whole product on your own infrastructure, including air-gapped.
- You want to read the code that blocks a call, and to verify the audit trail yourself.
- You want an approval hold, a sandbox and an egress firewall that work with or without the rest of your security stack.

## When to choose Forge

- You need to discover and inventory every AI agent and non-human identity across the organization.
- You want agents to receive short-lived cloud credentials rather than standing keys.
- Your compliance program needs mappings beyond the AI frameworks, such as HIPAA or MITRE ATLAS.
- You manage policy as Rego and Terraform, and a hosted service suits your data posture.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
