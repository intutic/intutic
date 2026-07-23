# Claude Code

Integrate Intutic governance with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's agentic coding tool.

## How it works

Intutic writes governance rules into your project's `CLAUDE.md` file, which Claude Code reads as its system instructions. This means governance rules are automatically applied to every Claude Code session in your workspace.

## Setup

### 1. Ensure CLAUDE.md exists

Claude Code looks for `CLAUDE.md` in your project root. If you don't have one yet:

```bash
touch CLAUDE.md
```

### 2. Initialize Intutic

```bash
intutic init
```

The CLI detects `CLAUDE.md` and registers Claude Code as a harness:

```
✓ Detected harnesses:
  • claude-code → CLAUDE.md
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

Intutic writes governance SOPs as markdown into `CLAUDE.md`:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `https://proxy.intutic.ai/v1`

## Code Review Requirements

All code changes must include unit tests with >80% coverage...

---

## Security Policy

Never commit secrets, API keys, or credentials to version control...
```

::: warning
Intutic overwrites the entire `CLAUDE.md` file. If you have custom instructions, consider moving them to a separate file or incorporating them as SOPs in the Intutic dashboard.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `claude-code` |
| Config file | `CLAUDE.md` |
| Detection | Checks for `CLAUDE.md` in workspace root |
| Format | Markdown (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |

## Proxy routing

Claude Code uses the `ANTHROPIC_API_KEY` environment variable. To route through the Intutic proxy, set the base URL:

```bash
export ANTHROPIC_BASE_URL=https://proxy.intutic.ai/v1
```

The proxy URL is included in the `CLAUDE.md` header for reference.

## Session Cost Attribution & Auto-Judging

When Claude Code is routed through the proxy, you can manage cost attribution and enforce automated policy evaluation directly inside your CLI chat sessions. 

::: tip Preferred Prefix: @intutic
Since Claude Code's CLI natively intercepts prompts starting with `/` at the shell entry point, we recommend using the **`@intutic`** prefix instead of `/intutic` to avoid client-side parsing conflicts (which would otherwise require a hacky leading space).
:::

1. **Attribution Initialization**:
   Type `@intutic initialize` to fetch open tasks/incidents matching your local git branch context.
2. **Attribution Lock & Auto-Judging**:
   Type `@intutic start <option> --auto-judge` (or `-j`) to bind all session costs to the chosen ticket and activate automatic compliance evaluations for all subsequent prompts.
3. **Interactive Validation**:
   Any output violating corporate SOPs or local personal rules will receive the synthesized `Intutic LLM-as-a-Judge` warning card appended dynamically to the CLI streams.

---

## MCP Server Integration (`~/.claude.json`)

To enable Intutic governance tools and MCP tool call interception in Claude Code CLI, add your MCP server configurations to `~/.claude.json`:

### 1. Standalone Governance Server Mode
Exposes Intutic governance status and SOP tools (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`) to Claude Code CLI:

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

### 2. Governed Proxy Mode (Wrapping Downstream Tools)
Wraps downstream MCP tools (e.g. Filesystem or Postgres) to intercept and evaluate tool execution frames in `<5ms`:

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

Verify your active MCP servers in Claude Code CLI:

```bash
claude mcp list
```

