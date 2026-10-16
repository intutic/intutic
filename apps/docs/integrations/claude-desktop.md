# Claude Desktop

Integrate Intutic governance with [Claude Desktop](https://docs.anthropic.com/en/docs/claude-desktop) — Anthropic's desktop application.

## How it works

Claude Desktop has no hook system and no setting that changes where it sends LLM requests — its model traffic goes to Anthropic directly. Intutic governs it through the MCP servers it runs: with each MCP server in `claude_desktop_config.json` wrapped by the Intutic MCP governance proxy, every MCP tool call is evaluated before it reaches the server.<!-- ENTERPRISE_ONLY_START --> `intutic connect` wraps them, adds the `intutic` governance server, watches the file and reports any change made outside Intutic (for example an MCP server added by another tool).<!-- ENTERPRISE_ONLY_END -->

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Claude Desktop and registers it as a harness:

```
  ✔ claude-desktop → /Users/you/Library/Application Support/Claude/claude_desktop_config.json
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. In the open core, wrap the servers yourself: add entries like the ones under [Example `claude_desktop_config.json`](#example-config) to the file.

### 2. Start the proxy

```bash
intutic start
```

<!-- ENTERPRISE_ONLY_START -->
> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It writes the same files, starts the same proxy and adds bidirectional config sync.
<!-- ENTERPRISE_ONLY_END -->

The configuration file, `claude_desktop_config.json`, is at:
* **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

Claude Desktop has **no instructions file**: its instructions live in the app's projects, so the text of your rule sets does not reach the model. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

<!-- ENTERPRISE_ONLY_START -->
## What gets written

`intutic connect` merges MCP server entries into the Claude Desktop configuration file (every other key is kept; a file that does not parse is left untouched).

To undo what `intutic connect` writes here, run `intutic disconnect --harness claude-desktop`: each file goes back to what it held before Intutic first wrote it, or is deleted if Intutic created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
<!-- ENTERPRISE_ONLY_END -->

## Example `claude_desktop_config.json` {#example-config}

### 1. Standalone Governance Server Mode
Exposes Intutic governance tools (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`, `intutic_hold_status`, `intutic_mcp_registry_status`, `intutic_mcp_budget_remaining`) directly to Claude Desktop:

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
