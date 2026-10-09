# Claude Code

Integrate Intutic governance with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's agentic coding tool.

## How it works

Intutic governs Claude Code in three layers:

- **Rules** — governance SOPs written to `.claude/rules/intutic-governance.md`, which Claude Code loads at launch alongside your `CLAUDE.md`. Your `CLAUDE.md` is not touched.
- **A blocking gate** — a PreToolUse hook registered in `.claude/settings.json` and `~/.claude/settings.json` that runs `.intutic/hooks/claude-code-check.js` before every `Bash`, `Edit`, `Write`, `MultiEdit` and MCP (`mcp__*`) tool call and refuses the call with exit code 2 when it breaks a rule, plus `permissions.deny` entries derived from your SOPs.
- **Proxy routing** — LLM traffic through the Intutic proxy, and your MCP servers wrapped by the MCP governance proxy.

## Setup

### 1. Ensure CLAUDE.md exists

Intutic detects Claude Code from a `CLAUDE.md` in your project root. If you don't have one yet:

```bash
touch CLAUDE.md
```

### 2. Initialize Intutic

```bash
intutic init
```

The CLI detects `CLAUDE.md` and registers Claude Code as a harness:

```
  ✔ claude-code → .claude/rules/intutic-governance.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic writes governance SOPs as markdown to `.claude/rules/intutic-governance.md`, when at least one SOP targets Claude Code:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file

> **Proxy URL:** `http://localhost:4000`

## Code Review Requirements

All code changes must include unit tests with >80% coverage...

---

## Security Policy

Never commit secrets, API keys, or credentials to version control...
```

### Hooks and permissions

`intutic connect` also writes the gate script `.intutic/hooks/claude-code-check.js` and merges two keys into `.claude/settings.json` (project) and `~/.claude/settings.json` (user):

```json
{
  "permissions": {
    "deny": ["Bash(*rm -rf **)", "Bash(*drop database*)"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/project/.intutic/hooks/claude-code-check.js", "timeout": 10 }]
      }
    ]
  }
}
```

There is one PreToolUse entry each for `Bash`, `Edit`, `Write`, `MultiEdit` and `mcp__.*`. Your own PreToolUse hooks and every other setting are kept; only the Intutic entries are replaced on each sync. In the project file `permissions.deny` is the list derived from your SOPs' blocked tools and patterns; in the user file those entries are added to your own. A settings file that is not plain JSON (for example one with comments) is left untouched and reported in the `intutic connect` log.

The gate fails closed: if it cannot read the tool call or crashes, the call is refused. Every decision is appended to `.intutic/events/hook-events.jsonl` and forwarded to the control plane.

The rules file is Intutic's own and is replaced on each sync; keep your own instructions in `CLAUDE.md` or in other files in `.claude/rules/`. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

### Rules and the decisions log

- **Rule sets** go to `.claude/rules/intutic-governance.md`, and, when the workspace turned on the [Governed Decisions Log](/guide/decisions-log), its newest entries to `.claude/rules/intutic-decisions.md`. Neither has `paths:` front matter, so Claude Code loads both at launch with the priority of `.claude/CLAUDE.md`, whether or not your project has a `CLAUDE.md`.
- **`CLAUDE.md` is never created or written.** Under Claude Code's default setting, a project `CLAUDE.md` stops it reading `AGENTS.md`, so creating one would hide your team's `AGENTS.md` from it. Earlier versions overwrote `CLAUDE.md` whole and appended the decisions log to it; the next sync gives you your own copy back, takes the decisions section out of a `CLAUDE.md` you kept, and removes a `CLAUDE.md` an earlier version created that holds nothing else.
- **Nothing is read twice.** Claude Code reads the workspace's `AGENTS.md` too when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` is in its working directory or a directory above it (your own `~/.claude/CLAUDE.md` does not count). Then a rule set aimed at both Claude Code and another `AGENTS.md` reader, such as Codex, reaches Claude Code through `AGENTS.md` and is left out of `.claude/rules/intutic-governance.md`, and the decisions log, which `AGENTS.md` carries for those harnesses, is left out of `.claude/rules/intutic-decisions.md`. A rule set aimed at Claude Code alone always stays in its own file. When a `CLAUDE.md` appears or goes, the next sync moves the content to match.
- **Your choice of instruction files is followed.** Claude Code's **Project instructions** setting decides when it reads `AGENTS.md`: the default `claude-md-or-agents-md`, `claude-md-and-agents-md` to read your `CLAUDE.md` and `AGENTS.md` together, `claude-md`, or `managed-only`. You can opt in to `claude-md-and-agents-md` from `/config` in Claude Code, or under `pluginConfigs` → `cc-plugin-agents-md@builtin` in `~/.claude/settings.json`; Intutic reads the value there and places the content to match. Claude Code ignores the setting in a project's settings files, so it is yours to choose, not the repository's. See [Claude Code's AGENTS.md documentation](https://code.claude.com/docs/en/memory#agentsmd).

To undo what `intutic connect` writes here, run `intutic disconnect --harness claude-code`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `claude-code` |
| Rules file | `.claude/rules/intutic-governance.md` |
| Detection | Checks for `CLAUDE.md` in workspace root |
| Format | Markdown (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |

## Proxy routing

Claude Code uses the `ANTHROPIC_API_KEY` environment variable. To route through the Intutic proxy, set the base URL to the proxy host — Claude Code appends `/v1/messages` itself:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
```

`intutic exec -- claude` sets this for you.

The proxy URL is included in the rules file's header for reference.

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

`intutic connect` wraps the MCP servers Claude Code already has in `~/.claude.json` — the user-scope `mcpServers` and this project's local-scope servers — with the MCP governance proxy, and adds the `intutic` server below. It only edits `~/.claude.json` once Claude Code has created it, and keeps everything else in the file. A project's shared `.mcp.json` is never rewritten: each of its servers you have approved in Claude Code gets a wrapped copy of the same name at local scope instead, which Claude Code uses in its place (see [How a server gets here at all](/guide/mcp-governance#how-a-server-gets-here-at-all)). Every MCP tool call, wrapped or not, also passes through the `mcp__.*` PreToolUse gate.

To configure the same entries by hand, add them to `~/.claude.json`:

### 1. Standalone Governance Server Mode
Exposes Intutic governance tools (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`, `intutic_hold_status`, `intutic_mcp_registry_status`, `intutic_mcp_budget_remaining`) to Claude Code CLI:

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

### 2. Governed Proxy Mode (Wrapping Downstream Tools)
Wraps downstream MCP tools (e.g. Filesystem or Postgres) to intercept and evaluate tool execution frames in-process:

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

Verify your active MCP servers in Claude Code CLI:

```bash
claude mcp list
```

