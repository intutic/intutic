# Model Context Protocol (MCP) Governance Proxy <Badge type="tip" text="Open-Core" />

The `@intutic/mcp-governance-proxy` package (`intutic-mcp-proxy`) is a transparent, high-performance stdio proxy for Model Context Protocol (MCP) servers. It intercepts, evaluates, and logs JSON-RPC 2.0 tool execution frames in `<5ms` before forwarding them to downstream MCP servers.

---

## 🚀 Overview

Modern AI coding agents (Claude Code, Cursor, Windsurf, Claude Desktop) interact with workspace tools, databases, and cloud infrastructure through **MCP Servers** (e.g., GitHub MCP, Postgres MCP, GKE MCP, Filesystem MCP).

`@intutic/mcp-governance-proxy` acts as a transparent wrapper between the AI agent and any real MCP server:

```
  AI Coding Agent (Claude Code / Cursor)
               │
               │ (stdio JSON-RPC 2.0 tool frames)
               ▼
   [ @intutic/mcp-governance-proxy ]  ◄── Evaluates SOP policies & PCAS
               │                          action primitives in <5ms
      ┌────────┴────────┐
      ▼                 ▼
  [ BYPASS ]        [ KILL ]
  Forward to      Intercept & return
  real MCP        JSON-RPC error (-32603)
  Server          pre-flight
```

---

---

## ⚡ Execution Modes (Standalone vs Governed Proxy)

The `@intutic/mcp-governance-proxy` package supports two complementary execution modes:

| Mode | Command Syntax | Purpose & Exposed Capabilities |
| :--- | :--- | :--- |
| **Standalone Governance Server** | `npx @intutic/mcp-governance-proxy` | Exposes governance status tools directly to the agent (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`). |
| **Governed Proxy Wrapper** | `npx @intutic/mcp-governance-proxy --workspace-id <ws_id> -- <real-mcp-command>` | Intercepts, evaluates, and logs tool calls for downstream MCP tools (e.g. Filesystem, Postgres) before forwarding. |

---

## 🛠️ Configuration Example (Claude Desktop & Claude Code)

You can configure both modes together in `claude_desktop_config.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "intutic": {
      "command": "npx",
      "args": [
        "-y",
        "@intutic/mcp-governance-proxy"
      ]
    },
    "intutic_governed_filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@intutic/mcp-governance-proxy",
        "--workspace-id", "ws_production",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"
      ]
    }
  }
}
```

---

## ⚡ Interception Primitives (PCAS)

When an agent invokes a tool (e.g., `tools/call`), the proxy inspects the JSON-RPC payload pre-flight and applies one of four Policy Enforcement & Circuit Breaking (PCAS) primitives:

| Action | Behavior | Description |
| :--- | :--- | :--- |
| **`BYPASS`** | Allow | Forwards the JSON-RPC frame untouched to downstream server. |
| **`ENHANCE`** | Augment | Appends workspace guardrail parameters or contextual warnings. |
| **`HIJACK`** | Rewrite | Modifies arguments (e.g. converting `DROP TABLE` to `SELECT`). |
| **`KILL`** | Block | Blocks tool execution immediately, returning a standard JSON-RPC `-32603` error response to the agent. |

---

## 🔒 Stdio Isolation Protocol

In the Model Context Protocol specification:
* **`stdout`** is strictly reserved for JSON-RPC 2.0 messages.
* **`stderr`** is used for logging and diagnostic outputs.

The Intutic MCP proxy guarantees strict `stdio` isolation — all governance logging, audit events, and trace metrics are routed to `stderr` and the local `Valkey` cache, preventing JSON-RPC parsing errors in host agent environments.

---

## ❓ Troubleshooting & Common Errors

### 1. Error: "Server disconnected" in Claude Desktop or Cursor

* **Symptom**: Claude Desktop or Cursor displays a red `Server disconnected` status badge when opening the application.
* **Root Cause**: The MCP proxy was configured without a downstream target command (missing `--` followed by the real MCP server), or the file path to `index.js` was invalid. The proxy printed a usage error to `stderr` and exited with status code `1`.
* **Remedy**:
  1. **Automatic Fix (Recommended)**: Run `intutic connect` in your terminal. The Intutic Sync Daemon automatically detects your installed MCP servers and prepends the proxy wrapper cleanly.
  2. **Manual Fix**: Ensure your `claude_desktop_config.json` passes a valid target MCP server command after `--`:
     ```json
     {
       "mcpServers": {
         "filesystem": {
           "command": "node",
           "args": [
             "/path/to/packages/mcp-proxy/dist/index.js",
             "--workspace-id", "ws_production",
             "--",
             "npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/yourname"
           ]
         }
       }
     }
     ```
