---
title: Integrations
description: Connect Intutic to 43 AI coding agents — IDE extensions, CLI tools, agent frameworks, orchestrators, and platforms. Auto-detected, zero config.
---

# Integrations <Badge type="tip" text="Open-Core" />

Intutic supports **43 AI agent harnesses** out of the box. Run `intutic init` in your project and the CLI detects which agents are present and records them; `intutic connect` then writes each one's governance config and keeps it in sync.

```bash
intutic init
#   ✔ cursor → .cursor/rules/intutic-governance.mdc
#   ✔ claude-code → .claude/rules/intutic-governance.md
#   ✔ antigravity → GEMINI.md
#   ○ windsurf (not detected)
#   …
```

Every harness connects through the same governance pipeline — proxy interception, SOP evaluation, and real-time enforcement — regardless of the underlying agent.

---

## IDE Extensions

Code editors with built-in AI that read project-level config files.

| Harness | Description | Rule sets go to |
|---|---|---|
| [**Cursor**](/integrations/cursor) | AI-powered code editor by Anysphere | `.cursor/rules/intutic-governance.mdc` |
| [**Windsurf**](/integrations/windsurf) | AI-native code editor by Codeium | `.windsurf/rules/intutic-governance.md` |
| [**Cline**](/integrations/cline) | VS Code extension for autonomous agentic coding | `.clinerules/intutic-governance.md` |
| [**Roo Code**](/integrations/roo-code) | AI-powered VS Code extension (formerly Roo Clinic) | `AGENTS.md` (section) |
| [**Continue**](/integrations/continue) | Open-source autopilot for VS Code and JetBrains | `.continue/rules/intutic-governance.md` |

## CLI Tools

Terminal-based agents that accept proxy environment variables or config files.

| Harness | Description | Rule sets go to |
|---|---|---|
| [**Claude Code**](/integrations/claude-code) | Anthropic's agentic coding tool | `.claude/rules/intutic-governance.md` |
| [**Aider**](/integrations/aider) | AI pair programming CLI | `.intutic/aider-sops.md`, listed under `read:` in `.aider.conf.yml` |
| [**Codex**](/integrations/codex) | OpenAI's autonomous coding agent | `AGENTS.md` (section) |
| [**Antigravity and Gemini CLI**](/integrations/antigravity) | Google Antigravity (app, IDE, CLI) and Gemini CLI | `GEMINI.md` (section) |
| [**Grok Build**](/integrations/grok) | xAI's terminal coding agent | `AGENTS.md` (section) |
| [**OpenCode**](/integrations/opencode) | Open-source terminal coding agent (`opencode-ai` 1.x, `@opencode/cli` 2.x); gated by a plugin loaded into its own process | `AGENTS.md` (section) |
| [**Muse Code**](/integrations/muse-code) | Meta's beta terminal coding agent (model Muse Spark) | `AGENTS.md` (section) |
| [**dsh**](/integrations/dsh) <Badge type="warning" text="Preview" /> | DeepSeek's plugin-first ("Cordis") coding agent (developer preview) | `AGENTS.md` (section) |

## Agent Frameworks

Autonomous coding agents that run multi-step tasks with tool use.

| Harness | Description | Rule sets go to |
|---|---|---|
| [**LangGraph**](/integrations/langgraph) | LangChain's graph-based agent framework | No instructions file (SDK framework; the SDK gate applies) |
| [**LangChain**](/integrations/langchain) | LangChain v1.x agents (`AgentMiddleware`) | No instructions file (SDK framework; the SDK gate applies) |
| [**CrewAI**](/integrations/crewai) | Multi-agent orchestration framework | No instructions file (SDK framework; the SDK gate applies) |
| [**Google ADK**](/integrations/google-adk) | Google's Agent Development Kit | No instructions file (SDK framework; the SDK gate applies) |
| [**OpenAI Agents SDK**](/integrations/openai-agents) | OpenAI's Python agents SDK | No instructions file (SDK framework; the SDK gate applies) |
| [**AutoGen**](/integrations/autogen) | Microsoft's multi-agent conversation framework | No instructions file (SDK framework; the SDK gate applies) |
| [**AG2**](/integrations/ag2) | CrewAI-style fork/continuation of pre-Microsoft AutoGen | No instructions file (SDK framework; the SDK gate applies) |
| [**Pydantic AI**](/integrations/pydantic-ai) | Pydantic's typed agent framework | No instructions file (SDK framework; the SDK gate applies) |
| [**smolagents**](/integrations/smolagents) | Hugging Face's code-executing agent framework | No instructions file (SDK framework; the SDK gate applies) |
| [**Strands Agents**](/integrations/strands) | AWS's open-source agent framework (Bedrock AgentCore default) | No instructions file (SDK framework; the SDK gate applies) |
| [**Microsoft Agent Framework**](/integrations/microsoft-agent-framework) | Microsoft's AutoGen + Semantic Kernel successor (`agent-framework`) | No instructions file (SDK framework; the SDK gate applies) |
| [**Mastra**](/integrations/mastra) | TypeScript agent framework | No instructions file (SDK framework; the SDK gate applies) |
| [**Vercel AI SDK**](/integrations/vercel-ai-sdk) | Vercel's `ai` package (v6+) | No instructions file (SDK framework; the SDK gate applies) |
| [**eve**](/integrations/eve) <Badge type="warning" text="Preview" /> | Vercel's filesystem-first durable backend agent framework | No instructions file (SDK framework; the SDK gate applies) |
| [**AI SDK Harness**](/integrations/ai-sdk-harness) | Vercel's `@ai-sdk/harness` — coding-agent harnesses in Vercel Sandbox microVMs | No instructions file (SDK framework; the SDK gate applies) |
| [**AI SDK Workflow**](/integrations/ai-sdk-workflow) | Vercel's `@ai-sdk/workflow` — durable workflow agents on the Workflow DevKit | No instructions file (SDK framework; the SDK gate applies) |
| [**TrueForge** (embedded)](/integrations/trueforge) | TrueForge agent runtime used as a library in your own process | No instructions file (SDK framework; the SDK gate applies) |
| [**TrueForge** (server)](/integrations/trueforge#server-mode-standalone-hosted) | TrueForge run as its own standalone server | No instructions file (governed by the TrueForge bridge) |
| [**AWS Bedrock AgentCore**](/integrations/agentcore) | AWS's managed hosting environment for the Runtime module — runs your own agent code (any framework) unchanged | No instructions file (your framework's SDK gate applies) |
| [**OpenHands**](/integrations/openhands) | Open-source AI software developer platform | `.openhands/microagents/intutic-governance.md` |
| [**Goose**](/integrations/goose) | Block's terminal agent and desktop framework | `.goosehints` (section) |
| [**Hermes**](/integrations/hermes) | NousResearch's skill-based developer agent | `AGENTS.md` (section) |
| [**Pi**](/integrations/pi) | Pi coding agent (earendil-works/pi) | `AGENTS.md` (section) |
| [**OpenClaw**](/integrations/openclaw) | Developer terminal agent | `AGENTS.md` (section) in OpenClaw's agent workspace |

## Platforms

Web UIs, desktop apps, and collaboration tools that host AI agents.

| Harness | Description | Rule sets go to |
|---|---|---|
| [**n8n**](/integrations/n8n) | Workflow automation platform | No instructions file (the workflow gate applies) |
| [**Open WebUI**](/integrations/open-webui) | Web interface for LLMs | No instructions file (system prompts live in Open WebUI's settings) |
| [**Claude Desktop**](/integrations/claude-desktop) | Anthropic's desktop application | No instructions file (instructions live in the app's projects) |
| [**GitHub Copilot**](/integrations/github-copilot) | GitHub's AI pair programmer | `.github/copilot-instructions.md` (section) |
| [**Xirp**](/integrations/xirp) | Spotify's macOS orchestrator for parallel Claude Code/Codex/Gemini CLI sessions, each in its own tmux session + git worktree | No instructions file (the harnesses it runs read their own) |
| [**Agentic Orchestrator**](/integrations/agentic-orchestrator) | DoorDash's open-source (Apache-2.0) desktop app + CLI (`agentico`) for multi-phase feature workflows across Claude Code/Codex/OpenCode, each in its own git worktree | No instructions file (Claude Code, Codex and OpenCode read their own) |

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

- **Single-Agent Assistants**: Governs individual coding tools (*Claude Code, Cursor, Windsurf, Antigravity*). Tool calls, file writes, and shell execution are intercepted synchronously before execution by each harness's own hook. Aider has no pre-execution hook, so it is governed at the proxy only.
- **Multi-Agent Swarms & Graphs**: Governs multi-agent frameworks (**LangGraph, CrewAI, AutoGen, OpenHands, OpenClaw, Hermes**). Every node's traffic crosses the same proxy under one session ID, so rules see the whole graph's tool history rather than a single node's turn — which is what makes ordering constraints, cycle-breaking and a shared budget ceiling enforceable across nodes. The request context also carries per-node identity — `node_id`, `agent_role`, `graph_id`, `parent_session_id`, `depth` — so rules can target one role or node as well as constrain the graph globally. Identity is client-supplied and unverifiable, so it scopes rules and observability only; authorisation stays bound to the virtual key. See [Graph Guardrails](/guide/graph-guardrails).

Because every response byte passes through the proxy before the client sees it, the proxy also enforces the tool deny list on the **response** path (the response gate, open-core, default-on): a model-emitted `tool_calls[]` naming a denied tool is withheld before the harness's tool runner ever sees it — harness-agnostic, no client hook required, on both streaming and non-streaming responses (Anthropic, OpenAI chat-completions, and OpenAI Responses wire shapes). It is fail-closed within its scope: inert unless the active role has a non-empty deny list, and within that scope an unparseable non-streaming body is refused rather than forwarded. Two precise limits: on streams the deny list enforces at the tool **name** level only (arguments arrive as JSON fragments across chunks) — the one argument-level rule, the destructive-SQL guard ([`sql_guard:`](/reference/sop-front-matter#destructive-sql)), holds a shell-tool block until its arguments are complete — and it cannot see locally-originated tool calls that never traverse the proxy.

---

## Universal Harness Compatibility & SDKs

- **Any Custom Harness**: Direct any custom agent or LLM client to the local Intutic proxy port (`:4000`):
  ```bash
  export ANTHROPIC_BASE_URL="http://localhost:4000"     # Anthropic SDKs append /v1/messages
  export OPENAI_BASE_URL="http://localhost:4000/v1"      # OpenAI SDKs append /chat/completions
  ```
- **Zero-Code Proxying**: No SDK modification required inside your agent codebase — Intutic operates transparently at the network/proxy layer.
- **WASM Rules SDK**: Write custom policy rules in AssemblyScript and compile them into hot-path proxy filters. The SDK is a template, not an npm package: copy it from `packages/wasm-sdk/` in the open-core repository. See [Custom Filters (WASM Rules Engine)](/external/wasm-rules).

---

## Additional Integrations

| Integration | Description |
|---|---|
| [**Standalone Proxy**](/integrations/standalone) | Route any LLM traffic through your own proxy without a harness adapter — works with any OpenAI-compatible client |
| [**Kitkat Agent Custom Skill**](/integrations/kitkat) | Pre-built governance skill for agents that support custom skill files (`.agents/skills/intutic-governance-kitkat/SKILL.md`) |

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

1. **`intutic init`** scans your workspace, detects the harnesses present and records them in `~/.intutic/config.json`. It writes no harness files.
2. **`intutic connect`** starts the proxy and writes each recorded harness's governance config in its native format — rules, hooks and proxy routing — then keeps them in sync as SOPs change (see [What writes harness files](#what-writes-harness-files)).
3. Every tool call flows through the proxy, and through the harness's own hook where it has one, for real-time policy evaluation.

`intutic connect` needs a control plane. Without one, `intutic start` runs the same proxy but writes no harness files: point each harness at the proxy as its page describes, or launch it with `intutic exec`.

## What writes harness files

Only `intutic connect` writes harness files. On each config sync, for every harness recorded in `~/.intutic/config.json`, it installs the gate and the proxy routing that harness's page lists, whether or not any SOP targets it: the gate enforces the built-in protections, the destructive-command tier, group rules and holds, none of which needs an SOP. The harness's rules file ([Where rule sets go](/guide/how-it-works#where-rule-sets-go) lists each one) is written when **at least one SOP targets that harness**: a synced SOP whose targets include it, or any local SOP under `.intutic/sops/`, which targets every recorded harness.

To govern a harness `intutic init` did not detect, add its id (the harness type, e.g. `"codex"`) to the `harnesses` list in `~/.intutic/config.json` and restart `intutic connect`.

Files the user also edits — `settings.json`, `hooks.json`, `config.toml`, `config.yaml`, `.aider.conf.yml` — are merged: only the Intutic keys or entries are added or replaced, and a file that does not parse is left untouched and reported in the `intutic connect` log. In `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.goosehints`, connect writes only the section between the `INTUTIC:RULES` markers.

Each adapter uses **atomic writes** (write to temp file, then rename) to prevent config corruption during sync.

For the technical details of each config format (markdown, YAML, JSON, TOML, env), see the [Integration Overview](/integrations/overview).
