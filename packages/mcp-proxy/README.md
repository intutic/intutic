# @intutic/mcp-governance-proxy

> Transparent stdio proxy that intercepts MCP `tools/call` JSON-RPC messages and applies workspace SOP policy before forwarding to real MCP servers.

## Overview

The MCP Governance Proxy sits between an AI coding agent and its MCP tool servers. It intercepts every `tools/call` JSON-RPC message on stdin/stdout, evaluates the call against workspace governance policies, and either forwards, blocks, redacts, or flags for approval — all without requiring changes to the agent or the tool server.

## Modes

### Proxy Mode

Intercepts stdio between the agent and an existing MCP server process:

```
Agent ↔ intutic-mcp-proxy ↔ Real MCP Server (stdio)
```

The proxy spawns the real MCP server as a child process and relays JSON-RPC messages bidirectionally, applying policy checks on every `tools/call` request.

### Standalone Mode

Runs as its own MCP server that exposes governance-aware tool wrappers:

```
Agent ↔ intutic-mcp-daemon (MCP server)
```

## Features

### DLP Scanning

14 regex patterns detect and block sensitive data in tool arguments and responses:

- API keys and tokens (AWS, GCP, GitHub, Stripe, etc.)
- Secrets and passwords
- Private keys and certificates
- SQL injection patterns
- PII indicators

### Policy Enforcement

- **SOP rule matching**: Maps tool names and argument patterns to workspace SOP rules
- **Enforcement actions**: `allow`, `block`, `redact`, `require_approval`
- **Audit logging**: Every intercepted call is logged with policy evaluation results

## Binaries

| Binary | Description |
|--------|-------------|
| `intutic-mcp-proxy` | Stdio proxy — wraps an existing MCP server |
| `intutic-mcp-daemon` | Standalone MCP server with governance built in |

## Installation

```bash
npm install @intutic/mcp-governance-proxy
```

## Usage

### Proxy Mode

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "intutic-mcp-proxy",
      "args": ["--", "npx", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### Standalone Mode

```bash
intutic-mcp-daemon --port 3100
```

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
