# Model Context Protocol (MCP) Governance Proxy <Badge type="tip" text="Open-Core" />

The `@intutic/mcp-governance-proxy` package (`intutic-mcp-proxy`) is a transparent stdio proxy for Model Context Protocol (MCP) servers. It intercepts, evaluates, and logs JSON-RPC 2.0 tool execution frames in-process before forwarding them to downstream MCP servers.

This page is the package/CLI/config reference. For the concepts behind each
control — what DLP redaction, tools/list curation, TOFU pinning, and
injection scanning each actually do and don't cover — see [MCP Server
Governance](/guide/mcp-governance).

---

## Overview

Modern AI coding agents (Claude Code, Cursor, Windsurf, Claude Desktop) interact with workspace tools, databases, and cloud infrastructure through **MCP Servers** (e.g., GitHub MCP, Postgres MCP, GKE MCP, Filesystem MCP).

`@intutic/mcp-governance-proxy` acts as a transparent wrapper between the AI agent and any real MCP server:

```
  AI Coding Agent (Claude Code / Cursor)
               │
               │ (stdio JSON-RPC 2.0 tool frames)
               ▼
   [ @intutic/mcp-governance-proxy ]  ◄── allowlist → DLP → SOP rules →
               │                          injection scan → real decision
      ┌────────┴────────┐
      ▼                 ▼
  [ allow ]         [ block ]
  Forward to      Return a JSON-RPC
  real MCP        error (-32603)
  Server          pre-flight
```

A third outcome, `redact`, applies only to the RESPONSE direction (a tool
result or `resources/read` body) — the call already ran by the time this
proxy sees the result, so there is nothing left to block; the proxy instead
strips sensitive content out of what the agent will read. See [Decisions and
directions](#decisions-and-directions) below.

---

## Execution Modes (Standalone vs Governed Proxy)

The `@intutic/mcp-governance-proxy` package supports three execution modes:

| Mode | Command Syntax | Purpose & Exposed Capabilities |
| :--- | :--- | :--- |
| **Standalone Governance Server** | `npx @intutic/mcp-governance-proxy` | Exposes governance status tools directly to the agent (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`). |
| **Governed Proxy Wrapper (stdio)** | `npx @intutic/mcp-governance-proxy --workspace-id <wk_id> -- <real-mcp-command>` | Intercepts, evaluates, and logs tool calls for a downstream MCP server spawned as a stdio child process, before forwarding. |
| **Governed Proxy Wrapper (remote bridge)** | `npx @intutic/mcp-governance-proxy --workspace-id <wk_id> --remote-url <url> [--remote-transport sse\|http]` | Same governance pipeline as the stdio wrapper, applied to a remote MCP server reached over HTTP or Server-Sent Events instead of a spawned child process — see [Remote (HTTP/SSE) MCP servers](/guide/mcp-governance#remote-http-sse-mcp-servers-the-stdio-http-bridge) for the full mechanism. |

---

## Configuration Example (Claude Desktop & Claude Code)

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
        "--workspace-id", "wk_production",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"
      ]
    }
  }
}
```

In practice you rarely hand-write this: `intutic connect` and the sync
daemon's continuous sync loop rewrite each MCP server entry in a harness
config to route through this proxy automatically — see [How a server gets
here at all](/guide/mcp-governance#how-a-server-gets-here-at-all).

---

## Decisions and directions

The interceptor (`ToolCallInterceptor.decide`, `src/interceptor.ts`) evaluates
every `tools/call` REQUEST and returns one of the `Decision` type's three
variants:

| Decision | Direction | Meaning |
| :--- | :--- | :--- |
| `allow` | request | Forward the JSON-RPC frame to the real server. |
| `block` | request | Refuse the call pre-flight; return a JSON-RPC `-32603` error to the agent. Nothing runs. |
| `redact` | response | Declared by the `Decision` type but produced structurally, not as a `decide()` return value — see below. |

`decide()` runs this pipeline, in order, over every `tools/call` request:

1. **Server allowlist** (`mcpAllowedServers`) — refuses the whole server if it's not on an explicit, non-empty allowlist.
2. **Tool allowlist** (`mcpAllowedTools`) — refuses the individual tool the same way.
3. **DLP scan** — blocks a request whose arguments contain a credential-shaped value or a destructive command pattern (`rm -rf /`, `DROP TABLE`, etc.).
4. **SOP policy rules** — workspace-defined `block` / `warn` / `require_approval` rules matched against tool name and serialized arguments. `require_approval` is treated as `block` in this headless proxy (there is no interactive approval UI in the loop).
5. **Prompt-injection scan** (request direction) — see [Prompt-injection scanning](#prompt-injection-scanning) below.

An empty allowlist means unrestricted at every allowlist step above — never
"permit nothing." A control-plane outage triggers **fail-open** behavior by
default (`mcpProxyFailBehavior`): DLP/SOP/TOFU checks that error out allow the
call through rather than blocking every request while policy is unreachable.

**The RESPONSE direction is a separate code path** (`processServerLine`,
`src/proxy.ts`), because by the time a result comes back the call has already
executed — refusing to deliver the result protects nothing about whether the
call happened, only what the agent gets to read afterward. That path applies,
in order:

1. **DLP redaction** — strips credential-shaped values out of the result text. If a match spans JSON syntax and the redacted text no longer parses, the whole result is withheld and replaced with an error explaining why (the call ran; only the delivery was refused).
2. **Prompt-injection scan** (response direction) — runs on the already-redacted text, so a secret can never reach this path unredacted. See below.
3. **`tools/list` curation** — allowlist filtering and operator description overrides, then a report-only injection scan over the resulting (post-curation) descriptions.
4. **Server-level TOFU pinning** — compares a `tools/list` response's fingerprint against what was first pinned for this `{workspace, server}` pair; see [MCP Server Governance](/guide/mcp-governance#server-level-tofu-pinning) for the full mechanism.

---

## Prompt-injection scanning

Ported from the Rust LLM-traffic proxy's `injection.rs` — five regex patterns
that catch well-known injection phrasings (instruction override, system-prompt
extraction, role reassignment, guardrail-bypass language, forged instruction
boundaries like `[INST]`/`<|im_start|>`). This is pattern matching, not a
classifier: it catches the obvious cases and nothing more subtle, and it is
deliberately narrow to keep false positives low — people legitimately tell an
agent to "ignore my last message."

The scanner (`src/injection.ts`) runs at three points:

- **Response direction**: a `tools/call` result or `resources/read` body, after DLP redaction completes. This is the multi-agent-graph attack shape — content the agent fetched (a web page, a file, another tool's output) can carry text that looks exactly like instructions from the orchestrator.
- **`tools/list` descriptions**, post-curation. **Report-only in v1** — a matched description never hides or blocks a listing; curation (`mcpAllowedTools`, operator overrides) and TOFU pinning already govern what the agent sees in a tool listing.
- **Request direction**: the `arguments` of an incoming `tools/call`, as a step inside `interceptor.decide`.

**Configuration** — `mcpInjectionAction: 'warn' | 'block'`, default **`warn`**.
This mirrors the Rust proxy's own posture: its `PromptInjectionDetector` never
disposes an injection finding as an unconditional kill on its own — only
`reask` (once findings reach a 2-technique threshold, or the source is
untrusted content) or `steer` below that. A default of unconditional blocking
in this proxy would be stricter than the capability it was ported from.

In **`block`** mode:
- A request-side match returns a `block` decision citing pattern names only (never the matched text — matched text is attacker-controlled and this proxy never quotes it into logs or events).
- A response-side match replaces the delivered result with a withheld-error frame. The wording is deliberate: it says the tool call already executed and its output was not delivered — it does **not** say the call was blocked, because it wasn't.

Every match — in either mode, on any of the three surfaces — emits an
`injection_detected` event carrying the pattern names and the source
(`tool_result` / `tool_description` / `tool_input`). Severity on that event
escalates to `high` when findings reach the 2-technique threshold, or when the
source is untrusted content (`tool_result` / `tool_description`) — mirroring
the Rust detector's own escalation rule. A `block`-mode block additionally
emits the existing `tool_blocked` event, so any consumer already keyed on
`tool_blocked` sees this new block reason too.

`mcpInjectionAction` rides the same policy-snapshot channel as every other
curation field in this package (`PolicyClient.absorbCuration`) — set it via
workspace settings on the control plane, or via the `INTUTIC_MCP_INJECTION_ACTION`
environment variable for standalone/open-core use without a control plane.

---

## Stdio Isolation Protocol

In the Model Context Protocol specification:
* **`stdout`** is strictly reserved for JSON-RPC 2.0 messages.
* **`stderr`** is used for logging and diagnostic outputs.

The Intutic MCP proxy guarantees strict `stdio` isolation — all governance logging, audit events, and trace metrics are routed to `stderr` (via this package's own `stderrLog.ts`, never `@intutic/logger`, which defaults to stdout) and the local `Valkey` cache, preventing JSON-RPC parsing errors in host agent environments.

---

## Troubleshooting & Common Errors

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
             "--workspace-id", "wk_production",
             "--",
             "npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/yourname"
           ]
         }
       }
     }
     ```
