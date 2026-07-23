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
intutic login              # Authenticate with control plane
intutic init               # Detect harnesses, configure proxy
intutic connect            # Start sync daemon (background)
intutic traces list        # See governance verdicts
```

## Commands

| Command | Description |
|---------|-------------|
| `intutic init` | Initialize workspace — detect harnesses, configure sync |
| `intutic login` | Authenticate with control plane (`--api-key`, `--dev`) |
| `intutic logout` | Clear stored credentials |
| `intutic status` | Show workspace status — auth, harnesses, sync state |
| `intutic whoami` | Show current authenticated identity |
| `intutic connect` | Start sync daemon — bidirectional config sync (`--interval`) |
| `intutic traces list` | List execution traces (`--limit`, `--since`, `--action`, `--model`, `--json`) |
| `intutic traces inspect <id>` | Show full detail of a single trace |

## Supported Harnesses

Intutic auto-detects and configures these AI coding harnesses:

| Harness | Detection | Config Method |
|---------|-----------|---------------|
| **Claude Code** | `~/.claude/` directory | `CLAUDE.md` + `settings.json` |
| **Cursor** | `~/.cursor/` directory | `.cursorrules` file |
| **Aider** | `~/.aider/` directory | `.aider.conf.yml` |
| **Antigravity** | `~/.gemini/` directory | Environment variables |
| **Codex** | `~/.codex/` directory | `codex.json` config |
| **n8n** | Running n8n instance | Workflow JSON file |
| **OpenClaw** | `~/.openclaw/` directory | `config.yaml` |
| **Hermes** | `~/.hermes/` directory | `config.toml` |

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
| `INTUTIC_API_URL` | Control plane URL (default: `https://api.intutic.ai`) |
| `INTUTIC_API_KEY` | API key for non-interactive auth (`vk_*` prefix) |

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
