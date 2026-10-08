# Claude Desktop

Integrate Intutic governance with [Claude Desktop](https://docs.anthropic.com/en/docs/claude-desktop) — Anthropic's desktop application.

## How it works

Claude Desktop has no hook system and no setting that changes where it sends LLM requests — its model traffic goes to Anthropic directly. Intutic governs it through the MCP servers it runs: `intutic connect` wraps each MCP server in `claude_desktop_config.json` with the Intutic MCP governance proxy, so every MCP tool call is evaluated before it reaches the server, and adds the `intutic` governance server. It also watches the file and reports any change made outside Intutic (for example an MCP server added by another tool).

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Claude Desktop and registers it as a harness:

```
  ✔ claude-desktop → ~/Library/Application Support/Claude/claude_desktop_config.json
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic merges MCP server entries into the Claude Desktop configuration file `claude_desktop_config.json` (every other key is kept; a file that does not parse is left untouched):
* **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

To undo what `intutic connect` writes here, run `intutic disconnect --harness claude-desktop`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

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
        "-p",
        "@intutic/mcp-governance-proxy",
        "intutic-mcp-proxy"
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
        "-p",
        "@intutic/mcp-governance-proxy",
        "intutic-mcp-proxy",
        "--workspace-id",
        "wk_production",
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
