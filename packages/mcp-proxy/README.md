# @intutic/mcp-governance-proxy

> Three names, one thing: the directory is `packages/mcp-proxy`, the published package is `@intutic/mcp-governance-proxy`, and the docs page is `/integrations/mcp-proxy`.

> Transparent stdio proxy that intercepts MCP `tools/call` JSON-RPC messages and applies workspace SOP policy before forwarding to real MCP servers.

## Overview

The MCP Governance Proxy sits between an AI coding agent and its MCP tool servers. It intercepts every `tools/call` JSON-RPC message on stdin/stdout, evaluates the call against workspace governance policies, and either forwards it, blocks it, or holds it for a person's approval, and redacts secrets out of results on the way back — all without requiring changes to the agent or the tool server.

## Modes

### Proxy Mode

Intercepts stdio between the agent and an existing MCP server process:

```
Agent ↔ intutic-mcp-proxy ↔ Real MCP Server (stdio)
```

The proxy spawns the real MCP server as a child process and relays JSON-RPC messages bidirectionally, applying policy checks on every `tools/call` request.

### Standalone Mode

With no server to wrap (no `--` command, no `--remote-url`), `intutic-mcp-proxy` is itself an MCP server named `intutic`, exposing three read-only tools: `intutic_governance_status`, `intutic_list_sops` and `intutic_list_incidents`. The two list tools take a `limit` (1–50, default 10). The control plane lists incidents only for the OWNER, ADMIN or EM role; any other role gets a message saying so instead.

```
Agent ↔ intutic-mcp-proxy (MCP server) ↔ Intutic control plane
```

It needs `INTUTIC_API_KEY`, the control plane's address (`INTUTIC_CONTROL_PLANE_URL`, or `INTUTIC_HOST` in `~/.intutic/env/runtime.env`; default `http://localhost:3001`) and a workspace id (`--workspace-id` or `INTUTIC_WORKSPACE_ID`).

### Remote Bridge Mode

Fronts a remote (HTTP/SSE-transport) MCP server instead of a spawned child process. The harness still spawns this proxy as a normal stdio child — no new listener, no new port — but the proxy's upstream side talks to the remote server over HTTP or Server-Sent Events using the MCP SDK's client transports directly:

```
Agent ↔ intutic-mcp-proxy ↔ Remote MCP Server (HTTP/SSE)
```

Every governance check proxy mode applies to a stdio server — allowlists, `tools/list` curation, TOFU pinning, DLP redaction, audit events — applies identically here; only the upstream transport differs. See `--remote-url`/`--remote-transport` below.

## Features

### DLP Scanning

16 built-in regex patterns, plus any the workspace adds. A match in a call's arguments blocks the call; a credential in a result is redacted before the agent reads it:

- API keys and tokens: OpenAI, Anthropic, Google, GitHub, Slack, AWS access key IDs
- PEM and EC private keys, long hex strings that look like secrets
- US Social Security numbers
- Destructive commands (`rm -rf /`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`) — arguments only

### Policy Enforcement

- **MCP server registry**: a server an owner or admin blocked is refused; under the workspace's `deny` default, so is any server not yet approved; a tool switched off within a server is hidden and refused
- **Allowlists**: `mcpAllowedServers` / `mcpAllowedTools`, empty meaning unrestricted
- **SSO group policy**: the workspace's `sso_group_policy`, applied to the member the API key belongs to
- **SOP rules** matched on tool name and arguments: `block`, `warn`, or `require_approval` — a hold recorded in the workspace's review queue; the identical call passes once approved
- **Audit events** for every decision, carrying the caller: API key prefix, OS user, harness session and server

## Binaries

| Binary | Description |
|--------|-------------|
| `intutic-mcp-proxy` | Wraps an MCP server (stdio or remote), or with no server to wrap, runs the standalone `intutic` MCP server |
| `intutic-mcp-daemon` | Long-lived local daemon on a Unix socket (`~/.intutic/mcp-proxy.sock`, or `MCP_DAEMON_SOCKET`) that caches policy and batches telemetry for proxies running with `INTUTIC_MCP_PROXY_MODE=daemon`. Not an MCP server. |

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
      "args": ["--server-name", "filesystem", "--", "npx", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### Standalone Mode

```json
{
  "mcpServers": {
    "intutic": {
      "command": "npx",
      "args": ["-y", "-p", "@intutic/mcp-governance-proxy", "intutic-mcp-proxy", "--workspace-id", "wk_your_workspace"],
      "env": { "INTUTIC_API_KEY": "<your API key>" }
    }
  }
}
```

The package has two binaries, so `npx` needs `-p @intutic/mcp-governance-proxy` and the binary name.

### Remote Bridge Mode

```json
{
  "mcpServers": {
    "linear": {
      "command": "intutic-mcp-proxy",
      "args": ["--server-name", "linear", "--remote-url", "https://mcp.linear.app/sse", "--remote-transport", "sse"],
      "env": { "INTUTIC_REMOTE_HEADERS": "{\"Authorization\":\"Bearer <token>\"}" }
    }
  }
}
```

`--remote-transport` accepts `sse` or `http` (default `http`, the SDK's current non-deprecated `StreamableHTTPClientTransport`). `--remote-url` and a positional stdio command (`--` followed by a command) are mutually exclusive — pass one or the other. Auth headers ride via the `INTUTIC_REMOTE_HEADERS` environment variable (a JSON object string), never as a CLI argument — argv is visible to any local process via `ps`.

`--server-name` is the name the registry, the server allowlist and the TOFU pin file (`~/.intutic/mcp-pins/<workspace>__<server>.json`) know the server by; without it the server is `unknown`. `intutic connect` sets it when it wraps a harness's servers. Every environment variable and flag is listed in the [MCP Server Governance guide](https://docs.intutic.ai/guide/mcp-governance#configuration-reference).

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
