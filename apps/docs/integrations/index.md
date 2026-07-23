---
title: Integrations
description: Connect Intutic to 18 AI coding agents — IDE extensions, CLI tools, agent frameworks, and platforms. Auto-detected, zero config.
---

# Integrations <Badge type="tip" text="Open-Core" />

Intutic supports **18 AI agent harnesses** out of the box. Run `intutic init` in your project and the CLI auto-detects which agents are present, then syncs governance rules to each one.

```bash
intutic init
# ✔ Detected harnesses:
#   ✔ cursor       → .cursorrules
#   ✔ claude-code  → CLAUDE.md
#   ✔ antigravity  → .gemini/settings.json
```

Every harness connects through the same governance pipeline — proxy interception, SOP evaluation, and real-time enforcement — regardless of the underlying agent.

---

## IDE Extensions

Code editors with built-in AI that read project-level config files.

| Harness | Description | Config File |
|---|---|---|
| [**Cursor**](/integrations/cursor) | AI-powered code editor by Anysphere | `.cursorrules` |
| [**Windsurf**](/integrations/windsurf) | AI-native code editor by Codeium | `.windsurfrules` |
| [**Cline**](/integrations/cline) | VS Code extension for autonomous agentic coding | `.cline/hooks/hooks.json` |
| [**Roo Code**](/integrations/roo-code) | AI-powered VS Code extension (formerly Roo Clinic) | `.roorules` |
| [**Continue**](/integrations/continue) | Open-source autopilot for VS Code and JetBrains | `.continue/config.json` |

## CLI Tools

Terminal-based agents that accept proxy environment variables or config files.

| Harness | Description | Config File |
|---|---|---|
| [**Claude Code**](/integrations/claude-code) | Anthropic's agentic coding tool | `CLAUDE.md` |
| [**Aider**](/integrations/aider) | AI pair programming CLI | `.aider.conf.yml` |
| [**Codex**](/integrations/codex) | OpenAI's autonomous coding agent | `.env.intutic` |
| [**Antigravity**](/integrations/antigravity) | Google's Gemini AI coding agent | `.gemini/settings.json` |

## Agent Frameworks

Autonomous coding agents that run multi-step tasks with tool use.

| Harness | Description | Config File |
|---|---|---|
| [**OpenHands**](/integrations/openhands) | Open-source AI software developer platform | `config.toml` |
| [**Goose**](/integrations/goose) | Block's terminal agent and desktop framework | `.agents/plugins/` |
| [**Hermes**](/integrations/hermes) | NousResearch's skill-based developer agent | `.hermes/config.yaml` |
| [**Pi**](/integrations/pi) | Inflection AI's developer command-line assistant | `.pi/hooks.json` |
| [**OpenClaw**](/integrations/openclaw) | Developer terminal agent | `.openclaw/openclaw.json` |

## Platforms

Web UIs, desktop apps, and collaboration tools that host AI agents.

| Harness | Description | Config File |
|---|---|---|
| [**n8n**](/integrations/n8n) | Workflow automation platform | API-based |
| [**Open WebUI**](/integrations/open-webui) | Web interface for LLMs | `.open-webui/` filter |
| [**Claude Desktop**](/integrations/claude-desktop) | Anthropic's desktop application | `claude_desktop_config.json` |
| [**GitHub Copilot**](/integrations/github-copilot) | GitHub's AI pair programmer | `.github/copilot-instructions.md` |

---

---

## Single-Agent & Multi-Agent Support

Intutic provides zero-trust governance regardless of your agent architecture:

- **Single-Agent Assistants**: Governs individual coding tools (*Claude Code, Cursor, Windsurf, Aider, Antigravity*). Tool calls, file writes, and shell execution are intercepted synchronously before execution.
- **Multi-Agent Swarms & Graphs**: Governs multi-agent frameworks (**LangGraph, CrewAI, AutoGen, OpenHands, OpenClaw, Hermes**). Intutic tracks inter-agent delegation sub-loops, assigns unified session trace IDs, evaluates role-specific SOPs per agent node, and breaks off recursive multi-agent failure loops.

---

## Universal Harness Compatibility & SDKs

- **Any Custom Harness**: Direct any custom agent or LLM client to the local Intutic proxy port (`:4000`):
  ```bash
  export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
  export OPENAI_BASE_URL="http://localhost:4000/v1"
  ```
- **Zero-Code Proxying**: No SDK modification required inside your agent codebase — Intutic operates transparently at the network/proxy layer.
- **WASM Policy Rules SDK (`@intutic/wasm-sdk`)**: Compile custom policy rules in AssemblyScript, TypeScript, C, or Rust into hot-path proxy filters. See [Custom Filters (WASM Rules Engine)](/external/wasm-rules).

---

## Additional Integrations

| Integration | Description |
|---|---|
| [**Standalone Cloud Proxy**](/integrations/standalone) | Route any LLM traffic through `proxy.intutic.ai` without a harness adapter — works with any OpenAI-compatible client |
| [**Kitkat Agent Custom Skill**](/integrations/kitkat) | Pre-built governance skill for agents that support custom skill files (`.intutic/SKILL.md`) |

---

## How it works

All 18 harnesses share the same integration flow:

```
┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│  intutic     │────▶│  Detect     │────▶│  Write       │
│  init        │     │  harnesses  │     │  config      │
└──────────────┘     └─────────────┘     └──────┬───────┘
                                                │
┌──────────────┐     ┌─────────────┐     ┌──────▼───────┐
│  Enforce     │◀────│  Evaluate   │◀────│  intutic     │
│  verdict     │     │  SOPs       │     │  connect     │
└──────────────┘     └─────────────┘     └──────────────┘
```

1. **`intutic init`** scans your workspace and detects all harness config files
2. Governance rules (SOPs) are written into each harness's native config format
3. **`intutic connect`** starts the proxy and keeps configs in sync as SOPs change
4. Every tool call flows through the proxy for real-time policy evaluation

Each adapter uses **atomic writes** (write to temp file, then rename) to prevent config corruption during sync.

For the technical details of each config format (markdown, YAML, JSON, TOML, env), see the [Integration Overview](/integrations/overview).
