---
title: Integrations
description: Connect Intutic to 39 AI coding agents — IDE extensions, CLI tools, agent frameworks, orchestrators, and platforms. Auto-detected, zero config.
---

# Integrations <Badge type="tip" text="Open-Core" />

Intutic supports **39 AI agent harnesses** out of the box. Run `intutic init` in your project and the CLI auto-detects which agents are present, then syncs governance rules to each one.

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
| [**Grok Build**](/integrations/grok) | xAI's terminal coding agent | `AGENTS.md` |
| **Muse Code** | Meta's beta terminal coding agent (model Muse Spark) | `AGENTS.md` |
| [**dsh**](/integrations/dsh) <Badge type="warning" text="Preview" /> | DeepSeek's plugin-first ("Cordis") coding agent (developer preview) | `cordis.patch.yml` (Cordis plugin, not a rules file) |

## Agent Frameworks

Autonomous coding agents that run multi-step tasks with tool use.

| Harness | Description | Config File |
|---|---|---|
| [**LangGraph**](/integrations/langgraph) | LangChain's graph-based agent framework | `.env.intutic` + SDK gate |
| [**LangChain**](/integrations/langchain) | LangChain v1.x agents (`AgentMiddleware`) | `.env.intutic` + SDK gate |
| [**CrewAI**](/integrations/crewai) | Multi-agent orchestration framework | `.env.intutic` + SDK gate |
| [**Google ADK**](/integrations/google-adk) | Google's Agent Development Kit | `.env.intutic` + SDK gate |
| [**OpenAI Agents SDK**](/integrations/openai-agents) | OpenAI's Python agents SDK | `.env.intutic` + SDK gate |
| **AutoGen** | Microsoft's multi-agent conversation framework | `.env.intutic` + SDK gate |
| **AG2** | CrewAI-style fork/continuation of pre-Microsoft AutoGen | `.env.intutic` + SDK gate |
| **Pydantic AI** | Pydantic's typed agent framework | `.env.intutic` + SDK gate |
| **smolagents** | Hugging Face's code-executing agent framework | `.env.intutic` + SDK gate |
| [**Strands Agents**](/integrations/strands) | AWS's open-source agent framework (Bedrock AgentCore default) | `.env.intutic` + SDK gate |
| [**Mastra**](/integrations/mastra) | TypeScript agent framework | `.env.intutic` + SDK gate |
| [**Vercel AI SDK**](/integrations/vercel-ai-sdk) | Vercel's `ai` package (v6+) | `.env.intutic` + SDK gate |
| [**eve**](/integrations/eve) <Badge type="warning" text="Preview" /> | Vercel's filesystem-first durable backend agent framework | `.env.intutic` + SDK gate (per-tool/connection `approval`) |
| [**AI SDK Harness**](/integrations/ai-sdk-harness) | Vercel's `@ai-sdk/harness` — coding-agent harnesses in Vercel Sandbox microVMs | `.env.intutic` + SDK gate (approval flow; see sandbox caveats) |
| [**AI SDK Workflow**](/integrations/ai-sdk-workflow) | Vercel's `@ai-sdk/workflow` — durable workflow agents on the Workflow DevKit | `.env.intutic` + SDK gate (`needsApproval`) |
| [**AWS Bedrock AgentCore**](/integrations/agentcore) | AWS's managed hosting environment for the Runtime module — runs your own agent code (any framework) unchanged | none — delegates to whichever already-supported framework adapter your code uses |
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
| [**Xirp**](/integrations/xirp) | Spotify's macOS orchestrator for parallel Claude Code/Codex/Gemini CLI sessions, each in its own tmux session + git worktree | none — delegates to the wrapped harness |
| [**Agentic Orchestrator**](/integrations/agentic-orchestrator) | DoorDash's open-source (Apache-2.0) desktop app + CLI (`agentico`) for multi-phase feature workflows across Claude Code/Codex/OpenCode, each in its own git worktree | none — delegates to the wrapped backend (OpenCode has no gate — see notes) |

---

## Server-Side Platform Integrations

Backend platforms that call Intutic directly over HTTP as part of their own contract, rather than being detected and configured by `intutic init`/`intutic connect`. No `HarnessType` enum entry, no CLI harness registration — deployment is a config step against the platform's own settings.

| Platform | Description | Integration point |
|---|---|---|
| [**QM**](/integrations/qm) | YC-backed, OSS multiplayer agent harness (wraps `pi`/`claude`/`codex`/`opencode`) | `securityScreen` HTTP contract (`qm.config.jsonc`) |
| [**Anthropic Managed Agents**](/integrations/anthropic-managed-agents) | Anthropic-hosted "session" that executes tool calls server-side rather than in your own process | Session-confirmation responder (`IntuticSessionConfirmer`) answering `user.tool_confirmation` events |
| [**AWS Bedrock AgentCore Gateway**](/integrations/agentcore) | Deployed AWS resource that forwards MCP `tools/call` requests to a target — distinct from the Runtime module above | `tools/agentcore-interceptor` Lambda calling `POST /api/v1/integrations/agentcore/gateway-check` |

---

## Single-Agent & Multi-Agent Support

Intutic provides zero-trust governance regardless of your agent architecture:

- **Single-Agent Assistants**: Governs individual coding tools (*Claude Code, Cursor, Windsurf, Aider, Antigravity*). Tool calls, file writes, and shell execution are intercepted synchronously before execution.
- **Multi-Agent Swarms & Graphs**: Governs multi-agent frameworks (**LangGraph, CrewAI, AutoGen, OpenHands, OpenClaw, Hermes**). Every node's traffic crosses the same proxy under one session ID, so rules see the whole graph's tool history rather than a single node's turn — which is what makes ordering constraints, cycle-breaking and a shared budget ceiling enforceable across nodes. The request context also carries per-node identity — `node_id`, `agent_role`, `graph_id`, `parent_session_id`, `depth` — so rules can target one role or node as well as constrain the graph globally. Identity is client-supplied and unverifiable, so it scopes rules and observability only; authorisation stays bound to the virtual key. See [Graph Guardrails](/guide/graph-guardrails).

Because every response byte passes through the proxy before the client sees it, the proxy also enforces the tool deny list on the **response** path (the response gate, open-core, default-on): a model-emitted `tool_calls[]` naming a denied tool is withheld before the harness's tool runner ever sees it — harness-agnostic, no client hook required, on both streaming and non-streaming responses (Anthropic, OpenAI chat-completions, and OpenAI Responses wire shapes). It is fail-closed within its scope: inert unless the active role has a non-empty deny list, and within that scope an unparseable non-streaming body is refused rather than forwarded. Two precise limits: on streams it enforces at the tool **name** level only (arguments arrive as JSON fragments across chunks, so argument-level rules are non-streaming-only), and it cannot see locally-originated tool calls that never traverse the proxy.

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
| [**Standalone Proxy**](/integrations/standalone) | Route any LLM traffic through your own proxy without a harness adapter — works with any OpenAI-compatible client |
| [**Kitkat Agent Custom Skill**](/integrations/kitkat) | Pre-built governance skill for agents that support custom skill files (`.intutic/SKILL.md`) |

---

## How it works

All harnesses share the same integration flow:

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
   (`intutic connect` needs a control plane. Without one, `intutic start` runs the proxy and every harness config written in step 2 still applies.)
4. Every tool call flows through the proxy for real-time policy evaluation

Each adapter uses **atomic writes** (write to temp file, then rename) to prevent config corruption during sync.

For the technical details of each config format (markdown, YAML, JSON, TOML, env), see the [Integration Overview](/integrations/overview).
