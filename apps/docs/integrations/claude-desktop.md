# Claude Desktop

Integrate Intutic governance with [Claude Desktop](https://docs.anthropic.com/en/docs/claude-desktop) — Anthropic's desktop application.

## How it works

Intutic monitors and updates `claude_desktop_config.json` to route LLM requests through the local proxy. It also wraps configure-level Model Context Protocol (MCP) server endpoints using the Intutic MCP proxy to intercept tool calls.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Claude Desktop and registers it as a harness:

```
✓ Detected harnesses:
  • claude-desktop -> ~/Library/Application Support/Claude/claude_desktop_config.json
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic updates the Claude Desktop configuration file `claude_desktop_config.json`:
* **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Example `claude_desktop_config.json`

### 1. Standalone Governance Server Mode
Exposes Intutic governance tools (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`) directly to Claude Desktop:

```json
{
  "mcpServers": {
    "intutic": {
      "command": "npx",
      "args": [
        "-y",
        "@intutic/mcp-governance-proxy"
      ],
      "env": {
        "NODE_ENV": "production",
        "PINO_DEST": "stderr"
      }
    }
  }
}
```

### 2. Governed Proxy Mode (Wrapping Downstream MCP Servers)
Wraps downstream MCP servers (e.g. Filesystem or Postgres) to intercept and evaluate tool calls before execution:

```json
{
  "mcpServers": {
    "intutic_governed_filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@intutic/mcp-governance-proxy",
        "--workspace-id",
        "ws_production",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username"
      ],
      "env": {
        "NODE_ENV": "production",
        "PINO_DEST": "stderr"
      }
    }
  }
}
```
