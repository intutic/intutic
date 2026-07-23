---
layout: home

hero:
  name: Intutic
  text: The circuit breaker for AI agents
  tagline: Intutic sits in the tool-call path between your AI agents and production. Every file write, API call, and shell command passes through a <5ms evaluation chain — blocking bad actions and steering agentic loops in real time.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/intutic

features:
  - icon: 🔴
    title: Circuit Breaker
    details: Four enforcement actions — BYPASS, ENHANCE, HIJACK, KILL — evaluated per tool call in under 50ms. SOPs define the rules; the circuit breaker intercepts, rewrites, or blocks actions before they reach your infrastructure.
  - icon: 🔍
    title: DLP & Threat Detection
    details: Detect secrets in prompts, data exfiltration, prompt injection, tool abuse, token waste, SQL injection, and unauthorized operations. Threats are flagged and blocked before they leave the proxy.
  - icon: 💰
    title: FinOps Ledger
    details: Track every token, every model, every dollar. Per-model cost breakdowns, local session token metering, and customizable spending caps.
  - icon: 🔌
    title: 18 Harness Integrations
    details: Works with Claude Code, Cursor, Windsurf, Aider, Antigravity, Codex, OpenHands, n8n, Cline, Roo Code, Continue, Claude Desktop, Goose, Open WebUI, OpenClaw, Hermes, Pi, and GitHub Copilot. Auto-detects your tooling and syncs governance rules to every agent.
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #3b82f6 30%, #10b981);
  --vp-home-hero-image-background-image: linear-gradient(-45deg, #3b82f6 50%, #10b981 50%);
  --vp-home-hero-image-filter: blur(44px);
}
</style>

## Quick Install

```bash
# Install global CLI and native Rust proxy binary
npm install -g @intutic/cli @intutic/proxy

# Initialize workspace and start local proxy gateway
intutic init
intutic connect
```

Your workspace is now governed. Every AI agent request flows through the Intutic proxy, where SOPs are enforced and traces are recorded.

## What Gets Blocked

Intutic's circuit breaker evaluates every tool call against your policy stack. Here's what gets caught:

| Threat | How It's Blocked |
|--------|-----------------|
| 🗂️ **File system destruction** | `rm -rf`, mass deletes, and recursive overwrites are intercepted by path-pattern SOPs |
| 🔐 **Secrets in prompts** | API keys, tokens, and credentials are redacted before they reach the model |
| 🏭 **Production writes** | Database mutations against prod connections are blocked or routed to review queue |
| 🔀 **Unauthorized git ops** | Force pushes, branch deletions, and pushes to protected branches are killed |
| 💸 **Budget overruns** | Token spend exceeding session ceilings triggers automatic session suspension |
| 🌐 **Unapproved API calls** | Outbound HTTP to non-allowlisted domains is blocked at the proxy layer |
| 🧩 **MCP tool violations** | Calls to unapproved MCP servers or tools are intercepted before execution |
| 💉 **SQL injection** | Destructive SQL patterns (DROP, TRUNCATE, DELETE without WHERE) are caught and blocked |

Every blocked action generates an audit log entry with full context — who, what, when, and why it was stopped.

### 🐱 Agentic Custom Skill (Kitkat)

If you are using an agentic coding assistant (such as Claude Code, Cursor, Google Antigravity, or OpenAI Codex), you can download our pre-configured **Kitkat Governance Skill** to load rules directly into your workspace:

- <a href="/downloads/SKILL.md" download="SKILL.md" class="download-button" style="display: inline-block; padding: 4px 10px; background: var(--vp-c-brand); color: white; border-radius: 4px; text-decoration: none; font-weight: 500; font-size: 0.8rem; margin-top: var(--space-2); margin-bottom: var(--space-2);">Download SKILL.md</a> (Save into `.agents/skills/intutic-governance-kitkat/` inside your project root).
- See the [Kitkat Agent Custom Skill Guide](/integrations/kitkat) for detailed setup.
