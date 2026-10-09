# Integrations Overview

Intutic supports 43 AI agent harnesses out of the box. The CLI auto-detects which harnesses are present in your workspace and syncs governance rules to each one.

## Supported Harnesses

| Harness | Rule sets go to | Detection | Status |
|---------|-------------|-----------|--------|
| [Claude Code](/integrations/claude-code) | `.claude/rules/intutic-governance.md` | File presence | ✅ Stable |
| [Cursor](/integrations/cursor) | `.cursor/rules/intutic-governance.mdc` | File presence | ✅ Stable |
| [Windsurf](/integrations/windsurf) | `.windsurf/rules/intutic-governance.md` | File presence | ✅ Stable |
| [Aider](/integrations/aider) | `.intutic/aider-sops.md`, listed under `read:` in `.aider.conf.yml` | File presence | ✅ Stable |
| [Antigravity and Gemini CLI](/integrations/antigravity) | `GEMINI.md` (a marked section) | `.gemini/` or `.agents/hooks.json`, or Antigravity's app-data directories | ✅ Stable |
| [Codex](/integrations/codex) | `AGENTS.md` (section) | `CODEX_HOME` env or `codex` in PATH | ✅ Stable |
| [OpenHands](/integrations/openhands) | `.openhands/microagents/intutic-governance.md` | `.openhands/`, or an OpenHands `config.toml` | ✅ Stable |
| [n8n](/integrations/n8n) | No instructions file | n8n instance detection | ✅ Stable |
| [Cline](/integrations/cline) | `.clinerules/intutic-governance.md` | File presence | ✅ Stable |
| [Roo Code](/integrations/roo-code) | `AGENTS.md` (section) | File presence | ✅ Stable |
| [Continue](/integrations/continue) | `.continue/rules/intutic-governance.md` | File presence | ✅ Stable |
| [Claude Desktop](/integrations/claude-desktop) | No instructions file | File presence | ✅ Stable |
| [Goose](/integrations/goose) | `.goosehints` (section) | File presence | ✅ Stable |
| [Open WebUI](/integrations/open-webui) | No instructions file | File presence | ✅ Stable |
| [OpenClaw](/integrations/openclaw) | `AGENTS.md` (section) in OpenClaw's agent workspace | File presence | ✅ Stable |
| [Hermes](/integrations/hermes) | `AGENTS.md` (section) | File presence | ✅ Stable |
| [Pi](/integrations/pi) | `AGENTS.md` (section) | File presence | ✅ Stable |
| [GitHub Copilot](/integrations/github-copilot) | `.github/copilot-instructions.md` (section) | File presence | ✅ Stable |
| [LangGraph](/integrations/langgraph) | No instructions file (SDK framework) | `langgraph`/`langchain` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [Grok Build](/integrations/grok) | `AGENTS.md` (section) | `.grok/` or `AGENTS.md` in project, `~/.grok/`, or `grok` in `PATH` | ✅ Stable |
| Muse Code | `AGENTS.md` (section) | `.muse/` or `AGENTS.md` in project, `~/.config/muse/`, or `muse` in `PATH` | ✅ Stable |
| [OpenCode](/integrations/opencode) | `AGENTS.md` (section) | `.opencode/` or `opencode.json` in project, `$OPENCODE_CONFIG_DIR`/`~/.config/opencode/`, or `opencode` in `PATH` | ✅ Stable — the gate is a plugin OpenCode loads into its own process; `opencode.json` MCP servers are proxy-wrapped |
| [LangChain](/integrations/langchain) | No instructions file (SDK framework) | `langchain`/`langchain-core` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [CrewAI](/integrations/crewai) | No instructions file (SDK framework) | `crewai` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [Google ADK](/integrations/google-adk) | No instructions file (SDK framework) | `google-adk` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [OpenAI Agents SDK](/integrations/openai-agents) | No instructions file (SDK framework) | `openai-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| AutoGen | No instructions file (SDK framework) | `autogen-agentchat`/`autogen-core`/`autogen-ext` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — `InterventionHandler.on_send` is invisible to `AssistantAgent`'s own tool calls, only runtime-routed messages (see docs) |
| AG2 | No instructions file (SDK framework) | `ag2` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| Pydantic AI | No instructions file (SDK framework) | `pydantic-ai`/`pydantic-ai-slim` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| smolagents | No instructions file (SDK framework) | `smolagents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — gates the generated code string pre-execution (`CodeAgent`'s "tool call" IS code execution) |
| [Strands Agents](/integrations/strands) | No instructions file (SDK framework) | `strands-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — default (Bedrock) LLM egress is NOT proxy-routable; tool gate unaffected (see docs) |
| [Microsoft Agent Framework](/integrations/microsoft-agent-framework) | No instructions file (SDK framework) | `agent-framework`/`agent-framework-core` (or `agent_framework`) in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — Azure OpenAI/Foundry clients are not routed by `.env.intutic`; tool gate unaffected (see docs) |
| [Mastra](/integrations/mastra) | No instructions file (SDK framework) | `@mastra/core` in `package.json` | ✅ Stable — per-call `hooks` passed to `.generate()`/`.stream()` override agent-level hooks (see docs) |
| [Vercel AI SDK](/integrations/vercel-ai-sdk) | No instructions file (SDK framework) | `ai` (major ≥ 6) plus any `@ai-sdk/*` package in `package.json` | ✅ Stable — LLM-egress routing is in-code only, see the integration page |
| [eve](/integrations/eve) | No instructions file (SDK framework) | `eve` in `package.json` AND an `agent/` directory (compound) | 🟡 Preview — pre-1.0 product; default AI Gateway egress not proxy-governable, see the integration page |
| [AI SDK Harness](/integrations/ai-sdk-harness) | No instructions file (SDK framework) | `@ai-sdk/harness`, any `@ai-sdk/harness-*`, or any `@ai-sdk/sandbox-*` in `package.json` | ✅ Stable — tools execute server-side in Vercel Sandbox microVMs; built-ins are `permissionMode`-governed only (defaults to allow-all), see the integration page |
| [AI SDK Workflow](/integrations/ai-sdk-workflow) | No instructions file (SDK framework) | `@ai-sdk/workflow` in `package.json` (unscoped `workflow` alone is not a trigger) | ✅ Stable — denials are FatalError-compatible so the durable runtime aborts instead of retrying them, see the integration page |
| [AWS Bedrock AgentCore](/integrations/agentcore) | No instructions file | `bedrock-agentcore`/`bedrock-agentcore-starter-toolkit` in a Python manifest, `bedrock-agentcore`/`@aws/agentcore` in `package.json`, or `.bedrock_agentcore.yaml`/`agentcore/agentcore.json`/`agentcore/aws-targets.json` | ✅ Stable — Runtime module only; hosts your own framework-SDK code, so the real tool gate is whichever already-supported framework adapter your code uses, see the integration page |
| [dsh](/integrations/dsh) | `AGENTS.md` (section) | `$DSH_HOME`/`~/.dsh/`, `@deepseek-ai/dsh` in PATH/package.json | 🟡 Preview — developer preview, breaking changes possible |
| [Xirp](/integrations/xirp) | No instructions file | `~/.xirp`/`$XIRP_HOME`, `Xirp.app`, tmux-parented Claude Code/Codex/Gemini CLI processes | ✅ Stable — macOS only, no gate of its own |
| [Agentic Orchestrator](/integrations/agentic-orchestrator) | No instructions file | `agentico` in PATH, `~/.agentic-orchestrator/config.yaml` | ✅ Stable — all three backends (Claude Code, Codex, OpenCode) delegate to their own gates |

## How integration works

1. **`intutic init`** scans your workspace for all supported harness config files
2. For each detected harness, governance rules (SOPs) are written into the harness-native config format
3. **`intutic connect`** keeps these files in sync as SOPs change on the control plane
   (`intutic connect` needs an account. Without one, `intutic start` runs the proxy and every harness config written in step 2 still applies.)
4. Each harness adapter uses **atomic writes** (write to temp file, then rename) to prevent corruption

## Config format per harness

Rule sets reach a harness in one of three shapes. [Where rule sets go](/guide/how-it-works#where-rule-sets-go) names the file for every harness and the product documentation behind it.

### A file of Intutic's own (Claude Code, Cursor, Windsurf, Cline, Continue, OpenHands, Aider)

The file sits in a directory the product reads every file of, so rules of your own go in other files beside it. Cursor's and Continue's files open with `alwaysApply: true` front matter and Windsurf's with `trigger: always_on`, so the product applies them to every request. Aider reads `.intutic/aider-sops.md` because connect lists it under `read:` in `.aider.conf.yml` by absolute path; Aider has no instructions field of its own.

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file

> **Proxy URL:** `http://localhost:4000`

## Code Review Requirements

All code changes must include test coverage...

---

## Budget Limits

Junior tier limited to $5/day...
```

### A marked section of your own file (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.goosehints`)

These files are often yours. The rule sets go between two markers, after your own text, and nothing outside them is changed. Codex, Muse Code, Grok Build, OpenCode, Pi, Hermes, Roo Code and dsh share one section of the workspace `AGENTS.md`, holding every rule set aimed at any of them; OpenClaw's section is in the `AGENTS.md` of its own agent workspace. Antigravity and Gemini CLI use `GEMINI.md`, GitHub Copilot `.github/copilot-instructions.md`, and Goose `.goosehints`.

```markdown
# Your own instructions stay as they are

<!-- INTUTIC:RULES:START -->
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT this section — managed by intutic sync daemon; edit outside the INTUTIC:RULES markers

> **Proxy URL:** `http://localhost:4000`

## Code Review Requirements

All code changes must include test coverage...
<!-- INTUTIC:RULES:END -->
```

### No instructions file (n8n, Claude Desktop, Open WebUI, Xirp, Agentic Orchestrator, AgentCore, SDK frameworks)

The product reads no file of standing instructions, so the rule-set text cannot reach the model. Where the harness has a gate, the gate still enforces the rules compiled from your rule sets. For the SDK frameworks, connect writes `.env.intutic` with the proxy URLs:

```bash
# Source this file: source .env.intutic
export ANTHROPIC_BASE_URL="http://localhost:4000"
export OPENAI_BASE_URL="http://localhost:4000/v1"
export INTUTIC_PROXY_URL="http://localhost:4000"
INTUTIC_SOP_COUNT=5
```

## Adding support for new harnesses

The harness adapter interface is defined in `tools/cli/src/harness/types.ts`. Each adapter implements:

- `detect(workspaceRoot)` — returns `true` if the harness is present
- `writeConfig(workspaceRoot, sops, proxyUrl)` — writes governance config
- `readCurrentHash(workspaceRoot)` — returns SHA-256 hash of current config (for change detection)
