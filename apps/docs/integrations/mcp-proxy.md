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
   [ @intutic/mcp-governance-proxy ]  ◄── registry → allowlists → SSO groups →
               │                          DLP → SOP rules → injection scan →
               │                          anomaly detectors → WASM rules
      ┌────────┼─────────────────┐
      ▼        ▼                 ▼
  [ allow ] [ block ]        [ hold ]
  Forward   JSON-RPC error   JSON-RPC error naming the hold;
  to the    (-32603),        the identical retry runs once
  server    nothing runs     a person approves it
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
| **Standalone Governance Server** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy` | Exposes governance status tools directly to the agent (`intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`). |
| **Governed Proxy Wrapper (stdio)** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy --workspace-id <wk_id> -- <real-mcp-command>` | Intercepts, evaluates, and logs tool calls for a downstream MCP server spawned as a stdio child process, before forwarding. |
| **Governed Proxy Wrapper (remote bridge)** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy --workspace-id <wk_id> --remote-url <url> [--remote-transport sse\|http]` | Same governance pipeline as the stdio wrapper, applied to a remote MCP server reached over HTTP or Server-Sent Events instead of a spawned child process — see [Remote (HTTP/SSE) MCP servers](/guide/mcp-governance#remote-http-sse-mcp-servers-the-stdio-http-bridge) for the full mechanism. |

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
        "-p",
        "@intutic/mcp-governance-proxy",
        "intutic-mcp-proxy"
      ]
    },
    "intutic_governed_filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@intutic/mcp-governance-proxy",
        "intutic-mcp-proxy",
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
every `tools/call` REQUEST and returns one of the `Decision` type's
variants:

| Decision | Direction | Meaning |
| :--- | :--- | :--- |
| `allow` | request | Forward the JSON-RPC frame to the real server. |
| `block` | request | Refuse the call pre-flight; return a JSON-RPC `-32603` error to the agent. Nothing runs. |
| `hold` | request | A `require_approval` rule matched: refuse the call for now, record a hold for review, and return a `-32603` error whose message names the hold id (also in `error.data.holdId`). See [Approval holds](/guide/mcp-governance#approval-holds). |
| `redact` | response | Declared by the `Decision` type but produced structurally, not as a `decide()` return value — see below. |

`decide()` runs this pipeline, in order, over every `tools/call` request:

1. **MCP server registry** — refuses a blocked server, every server not approved when the workspace's default policy is `deny`, and a tool switched off within its server. See [The registry](/guide/mcp-governance#the-registry).
2. **Server allowlist** (`mcpAllowedServers`) — refuses the whole server if it's not on an explicit, non-empty allowlist.
3. **Tool allowlist** (`mcpAllowedTools`) — refuses the individual tool the same way.
4. **SSO group policy** — the workspace's `sso_group_policy`, applied to the member the proxy's API key belongs to. See [Who made the call](/guide/mcp-governance#caller-identity).
5. **DLP scan** — blocks a request whose arguments contain a credential-shaped value or a destructive command pattern (`rm -rf /`, `DROP TABLE`, etc.).
6. **SOP policy rules** — workspace-defined `block` / `warn` / `require_approval` rules matched against tool name and serialized arguments. `require_approval` holds the call for a person's approval (`hold` above).
7. **Prompt-injection scan** (request direction) — see [Prompt-injection scanning](#prompt-injection-scanning) below.
8. **Anomaly detectors** and **WASM rules** — see the session-scope note below.

### Anomaly-detection session scope

The sequence detectors (`consecutive_repeat`, `ping_pong_cycle`, `landmark_cycle`,
`tool_diversity_collapse`) and the reask ladder read a rolling window of the
session's tool calls. `intutic connect` wraps **each** MCP server with its own
proxy process, so a harness session with three servers runs three proxies — and
until Wave 5.3 each kept its own window, so a loop that alternated between two
servers was invisible and a reask budget reset per server.

The window is now shared through the local Valkey `intutic connect` runs: the
daemon writes `INTUTIC_VALKEY_URL` into `~/.intutic/env/runtime.env` when its
Valkey is up, and every proxy of one harness session — identified by the
harness process that spawned them (`<workspace>:mcp:<parent pid>:<start token>`;
`INTUTIC_MCP_SESSION_SCOPE` overrides it) — reads and appends the same
60-entry sequence, the same 60-second call window and the same reask counters
(one hour, set when a counter is created). One Valkey round trip per
`tools/call`, and none when the window is not shared.

It is never a hard dependency: with no URL configured, with Valkey down, or
when a read takes longer than 200 ms, the proxy uses its own in-process window
— exactly the behaviour before Wave 5.3. Standalone `intutic start` writes no
runtime env, so sharing there needs `VALKEY_URL` in the harness's environment.
Tool names are shared bare (the `tool_sequence` WASM rules see), so two servers
that both expose a tool called `search` count as one; `session_id` in the WASM
context stays per process.

An empty allowlist means unrestricted at every allowlist step above — never
"permit nothing." A check that cannot complete fails **open** by default:
DLP/SOP/TOFU checks that error out, and a registry the proxy has never been
able to load, let the call through rather than blocking every request while
policy is unreachable. The workspace's `mcpProxyFailBehavior` chooses, and
`INTUTIC_MCP_FAIL_OPEN=false` sets it locally until the proxy has loaded the
workspace's choice — see [When the registry has not
loaded](/guide/mcp-governance#when-the-registry-has-not-loaded).

**The RESPONSE direction is a separate code path** (`processServerLine`,
`src/proxy.ts`), because by the time a result comes back the call has already
executed — refusing to deliver the result protects nothing about whether the
call happened, only what the agent gets to read afterward. That path applies,
in order:

1. **DLP redaction** — strips credential-shaped values out of the result text. If a match spans JSON syntax and the redacted text no longer parses, the whole result is withheld and replaced with an error explaining why (the call ran; only the delivery was refused).
2. **Prompt-injection scan** (response direction) — runs on the already-redacted text, so a secret can never reach this path unredacted. See below.
3. **`tools/list` curation** — allowlist filtering, removal of tools the registry switched off, and operator description overrides, then a report-only injection scan over the resulting (post-curation) descriptions.
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

**Workspace patterns** — `mcpInjectionPatterns: string[]` in workspace settings
adds your own regex sources on top of the five built in. The control plane
serves them with the rest of the MCP curation (`GET /api/v1/policy/resolve`
and `GET /api/v1/sop/rules`); the proxy compiles them itself, drops one that
does not compile and counts the drop, and reports a match as `workspace:<n>`
so a finding says which layer caught it. The built-in floor applies whether
or not the control plane is reachable. Patterns are matched case-insensitively
and capped at 512 characters each.
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
* **Root Cause**: The entry's command could not start the proxy — usually a path to `dist/index.js` that does not exist on this machine, or `npx @intutic/mcp-governance-proxy` without `-p` (the package has two binaries, `intutic-mcp-proxy` and `intutic-mcp-daemon`, so `npx` cannot pick one and exits). An entry with no command after `--` and no `--remote-url` is not an error: it runs the standalone governance server.
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
