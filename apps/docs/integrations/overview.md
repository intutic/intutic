# Integrations Overview

Intutic supports 18 AI agent harnesses out of the box. The CLI auto-detects which harnesses are present in your workspace and syncs governance rules to each one.

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

## How integration works

1. **`intutic init`** scans your workspace for all 18 harness config files
2. For each detected harness, governance rules (SOPs) are written into the harness-native config format
3. **`intutic connect`** keeps these files in sync as SOPs change on the control plane
4. Each harness adapter uses **atomic writes** (write to temp file, then rename) to prevent corruption

## Config format per harness

Harnesses fall into three categories:

### Markdown-based (Cursor, Claude Code, Windsurf)

SOP content is written as markdown with a header:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `https://proxy.intutic.ai/v1`

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

# Proxy URL: https://proxy.intutic.ai/v1

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
ANTHROPIC_BASE_URL=https://proxy.intutic.ai/v1
OPENAI_BASE_URL=https://proxy.intutic.ai/v1
INTUTIC_PROXY_URL=https://proxy.intutic.ai/v1
INTUTIC_SOP_COUNT=5
```

### TOML-based (OpenHands)

SOP content goes into an `[intutic]` section:

```toml
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon

[intutic]
proxy_url = "https://proxy.intutic.ai/v1"
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
