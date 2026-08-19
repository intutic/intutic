# Integrations Overview

Intutic supports 34 AI agent harnesses out of the box. The CLI auto-detects which harnesses are present in your workspace and syncs governance rules to each one.

## Supported Harnesses

| Harness | Config File | Detection | Status |
|---------|-------------|-----------|--------|
| [Claude Code](/integrations/claude-code) | `CLAUDE.md` | File presence | ✅ Stable |
| [Cursor](/integrations/cursor) | `.cursorrules` | File presence | ✅ Stable |
| [Windsurf](/integrations/windsurf) | `.windsurfrules` | File presence | ✅ Stable |
| [Aider](/integrations/aider) | `.aider.conf.yml` | File presence | ✅ Stable |
| [Antigravity](/integrations/antigravity) | `.gemini/settings.json` | `.gemini/` directory | ✅ Stable |
| [Codex](/integrations/codex) | `.env.intutic` | `CODEX_HOME` env or `codex` in PATH | ✅ Stable |
| [OpenHands](/integrations/openhands) | `config.toml` | File presence | ✅ Stable |
| [n8n](/integrations/n8n) | `.intutic/n8n/governance-workflow.json` | n8n instance detection | ✅ Stable |
| [Cline](/integrations/cline) | `.cline/hooks/hooks.json` | File presence | ✅ Stable |
| [Roo Code](/integrations/roo-code) | `.roorules` | File presence | ✅ Stable |
| [Continue](/integrations/continue) | `.continue/config.json` | File presence | ✅ Stable |
| [Claude Desktop](/integrations/claude-desktop) | `claude_desktop_config.json` | File presence | ✅ Stable |
| [Goose](/integrations/goose) | `.agents/plugins/intutic-governance/hooks/hooks.json` | File presence | ✅ Stable |
| [Open WebUI](/integrations/open-webui) | `.open-webui/intutic-governance-filter.py` | File presence | ✅ Stable |
| [OpenClaw](/integrations/openclaw) | `.openclaw/openclaw.json` | File presence | ✅ Stable |
| [Hermes](/integrations/hermes) | `.hermes/config.yaml` | File presence | ✅ Stable |
| [Pi](/integrations/pi) | `.pi/hooks.json` | File presence | ✅ Stable |
| [GitHub Copilot](/integrations/github-copilot) | `.github/copilot-instructions.md` | File presence | ✅ Stable |
| [LangGraph](/integrations/langgraph) | `.env.intutic` | `langgraph`/`langchain` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [Grok Build](/integrations/grok) | `AGENTS.md` | `.grok/` or `AGENTS.md` in project, `~/.grok/`, or `grok` in `PATH` | ✅ Stable |
| Muse Code | `AGENTS.md` | `.muse/` or `AGENTS.md` in project, `~/.config/muse/`, or `muse` in `PATH` | ✅ Stable |
| [LangChain](/integrations/langchain) | `.env.intutic` | `langchain`/`langchain-core` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [CrewAI](/integrations/crewai) | `.env.intutic` | `crewai` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [Google ADK](/integrations/google-adk) | `.env.intutic` | `google-adk` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| [OpenAI Agents SDK](/integrations/openai-agents) | `.env.intutic` | `openai-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| AutoGen | `.env.intutic` | `autogen-agentchat`/`autogen-core`/`autogen-ext` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — `InterventionHandler.on_send` is invisible to `AssistantAgent`'s own tool calls, only runtime-routed messages (see docs) |
| AG2 | `.env.intutic` | `ag2` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| Pydantic AI | `.env.intutic` | `pydantic-ai`/`pydantic-ai-slim` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable |
| smolagents | `.env.intutic` | `smolagents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` | ✅ Stable — gates the generated code string pre-execution (`CodeAgent`'s "tool call" IS code execution) |
| [Mastra](/integrations/mastra) | `.env.intutic` | `@mastra/core` in `package.json` | ✅ Stable — per-call `hooks` passed to `.generate()`/`.stream()` override agent-level hooks (see docs) |
| [Vercel AI SDK](/integrations/vercel-ai-sdk) | `.env.intutic` | `ai` (major ≥ 6) plus any `@ai-sdk/*` package in `package.json` | ✅ Stable — LLM-egress routing is in-code only, see the integration page |
| [dsh](/integrations/dsh) | `cordis.patch.yml` (Cordis plugin) | `$DSH_HOME`/`~/.dsh/`, `@deepseek-ai/dsh` in PATH/package.json | 🟡 Preview — developer preview, breaking changes possible |
| [Xirp](/integrations/xirp) | none (delegates) | `~/.xirp`/`$XIRP_HOME`, `Xirp.app`, tmux-parented Claude Code/Codex/Gemini CLI processes | ✅ Stable — macOS only, no gate of its own |
| [Agentic Orchestrator](/integrations/agentic-orchestrator) | none (delegates) | `agentico` in PATH, `~/.agentic-orchestrator/config.yaml` | ✅ Stable — OpenCode backend has no gate to delegate to (see docs) |

## How integration works

1. **`intutic init`** scans your workspace for all supported harness config files
2. For each detected harness, governance rules (SOPs) are written into the harness-native config format
3. **`intutic connect`** keeps these files in sync as SOPs change on the control plane
   (`intutic connect` needs an account. Without one, `intutic start` runs the proxy and every harness config written in step 2 still applies.)
4. Each harness adapter uses **atomic writes** (write to temp file, then rename) to prevent corruption

## Config format per harness

Harnesses fall into three categories:

### Markdown-based (Cursor, Claude Code, Windsurf, GitHub Copilot, Grok Build)

SOP content is written as markdown with a header. Grok Build's file is
`AGENTS.md` rather than a harness-specific filename, but the content and
formatter are identical to every other row in this category:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `http://localhost:4000/v1`

## SOP: Code Review Requirements

All code changes must include test coverage...

---

## SOP: Budget Limits

Junior tier limited to $5/day...
```

### YAML-based (Aider)

SOP content goes into the `extra-instructions` field:

```yaml
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

# Proxy URL: http://localhost:4000/v1

extra-instructions: |
  ## SOP: Code Review Requirements

  All code changes must include test coverage...
```

### JSON-based (Antigravity)

SOP content is merged into the `customInstructions` field of the existing settings:

```json
{
  "customInstructions": "# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT...",
  "existingField": "preserved"
}
```

### Env-based (Codex)

Proxy URLs are set as environment variables:

```bash
# Source this file: source .env.intutic
ANTHROPIC_BASE_URL=http://localhost:4000/v1
OPENAI_BASE_URL=http://localhost:4000/v1
INTUTIC_PROXY_URL=http://localhost:4000/v1
INTUTIC_SOP_COUNT=5
```

### TOML-based (OpenHands)

SOP content goes into an `[intutic]` section:

```toml
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon

[intutic]
proxy_url = "http://localhost:4000/v1"
instructions = """
## SOP: Code Review Requirements

All code changes must include test coverage...
"""
```

## Adding support for new harnesses

The harness adapter interface is defined in `tools/cli/src/harness/types.ts`. Each adapter implements:

- `detect(workspaceRoot)` — returns `true` if the harness is present
- `writeConfig(workspaceRoot, sops, proxyUrl)` — writes governance config
- `readCurrentHash(workspaceRoot)` — returns SHA-256 hash of current config (for change detection)
