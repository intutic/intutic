# @intutic/cli

> AI governance control plane for developer workspaces.

Intutic intercepts agent-to-LLM traffic, enforces SOPs, detects anomalies, and tracks costs — all without changing how your team codes.

## Quick Start

```bash
# Install globally
npm install -g @intutic/cli

# Or run directly
npx @intutic/cli init
```

**5 minutes to your first governance verdict:**

```bash
intutic start              # Run the proxy standalone — no account needed
intutic traces list        # See governance verdicts
```

**With a control plane:**

```bash
intutic login              # Authenticate with control plane
intutic init               # Detect harnesses, record them for sync
intutic connect            # Start sync daemon — writes harness rules and gates
intutic traces list        # See governance verdicts
```

## Commands

| Command | Description |
|---------|-------------|
| `intutic init` | Initialize workspace — detect harnesses, record them in `~/.intutic/config.json` |
| `intutic start` | Start the proxy standalone — no account or control plane needed (`--port`, `--upstream-url`) |
| `intutic login` | Authenticate with control plane (`--api-key`, `--control-plane-url`, `--dev`) |
| `intutic logout` | Clear stored credentials |
| `intutic status` | Show workspace status — auth, harnesses, sync state |
| `intutic whoami` | Show current authenticated identity |
| `intutic connect` | Start sync daemon — bidirectional config sync (`--interval`) |
| `intutic traces list` | List execution traces (`--limit`, `--since`, `--action`, `--verdict`, `--model`, `--json`) |
| `intutic traces inspect <id>` | Show full detail of a single trace |

## Supported Harnesses

Intutic auto-detects and configures AI coding harnesses, among them:

| Harness | Detection | Config Method |
|---------|-----------|---------------|
| **Claude Code** | `CLAUDE.md` in the workspace | `.claude/rules/intutic-governance.md` (never `CLAUDE.md`) + PreToolUse gate in `.claude/settings.json` |
| **Cursor** | `.cursor/` or `.cursorrules` in the workspace, or `~/.cursor/` | `.cursor/rules/intutic-governance.mdc` + gate in `.cursor/hooks.json` |
| **Aider** | `.aider.conf.yml` in the workspace | `.intutic/aider-sops.md`, loaded by `read:` in `.aider.conf.yml` |
| **Antigravity** | `~/.gemini/antigravity*/`, `.agents/hooks.json`, `.gemini/` in the workspace, or `antigravity` / `gemini` on PATH | `GEMINI.md` section + `PreToolUse` gate in `~/.gemini/config/hooks.json` (Gemini CLI: `BeforeTool` gate in `~/.gemini/settings.json`) |
| **Codex** | `codex` on PATH, or `CODEX_HOME` set | `AGENTS.md` section + gate in `.codex/hooks.json`; proxy routing in `~/.codex/config.toml` |
| **n8n** | Running n8n instance (`N8N_URL`, default `http://localhost:5678`) | Workflow JSON file + external hook gate `~/.intutic/hooks/n8n-governance-hook.js` |
| **OpenClaw** | `~/.openclaw/` or `.openclaw/openclaw.json` | `AGENTS.md` section in its agent workspace + `~/.intutic/hooks/openclaw/intutic-governance.cjs` (plugin gate, listed in `~/.openclaw/openclaw.json`) |
| **Hermes** | `~/.hermes/` or `.hermes/config.yaml` | `AGENTS.md` section + `hooks.pre_tool_call` gate in `~/.hermes/config.yaml` |
| **OpenCode** | `.opencode/`, `opencode.json`, `~/.config/opencode/` or `opencode` on PATH | `AGENTS.md` + `.opencode/plugins/intutic-governance.js` (plugin gate) |

## Trace Inspection

View governance verdicts directly from the terminal:

```bash
# List recent traces (last 24h)
intutic traces list

# Filter by enforcement action
intutic traces list --action KILL

# Filter by model and time window
intutic traces list --model claude-4 --since 7d

# JSON output for scripting
intutic traces list --json | jq '.traces[] | select(.enforcementAction == "HIJACK")'

# Inspect a specific trace
intutic traces inspect tr_abc123
```

## Configuration

Credentials are stored at `~/.intutic/credentials.json` (mode `0600`).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `INTUTIC_CONTROL_PLANE_URL` | Control plane URL for this shell (overrides the one `intutic login --control-plane-url` saved) |
| `INTUTIC_DEV` | `1` targets the local control plane (`http://localhost:3001`), like `--dev` |
| `INTUTIC_PROXY_URL` | Local proxy URL; its port is the proxy port (default `4000`) |

For non-interactive auth, use `intutic login --api-key vk_...`.

### Development Mode

Use `--dev` flag to point at local control plane (`http://localhost:3001`):

```bash
intutic login --dev
intutic connect --dev
intutic traces list --dev
```

## Documentation

Full documentation: [docs.intutic.ai](https://docs.intutic.ai)

- [Getting Started](https://docs.intutic.ai/guide/getting-started)
- [Integration Guides](https://docs.intutic.ai/integrations/)
- [CLI Reference](https://docs.intutic.ai/reference/cli)
- [API Reference](https://docs.intutic.ai/reference/api)

## License

MIT — see [LICENSE](../../LICENSE) for details.
