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
| **Standalone Governance Server** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy` | Exposes governance tools directly to the agent: `intutic_governance_status`, `intutic_list_sops`, `intutic_list_incidents`, and the three below. |
| **Governed Proxy Wrapper (stdio)** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy --workspace-id <wk_id> -- <real-mcp-command>` | Intercepts, evaluates, and logs tool calls for a downstream MCP server spawned as a stdio child process, before forwarding. |
| **Governed Proxy Wrapper (remote bridge)** | `npx -y -p @intutic/mcp-governance-proxy intutic-mcp-proxy --workspace-id <wk_id> --remote-url <url> [--remote-transport sse\|http]` | Same governance pipeline as the stdio wrapper, applied to a remote MCP server reached over HTTP or Server-Sent Events instead of a spawned child process — see [Remote (HTTP/SSE) MCP servers](/guide/mcp-governance#remote-http-sse-mcp-servers-the-stdio-http-bridge) for the full mechanism. |

The standalone server's tools that answer a refusal:

| Tool | Answers |
| :--- | :--- |
| `intutic_hold_status` (`holdId`) | Whether a hold has been approved or rejected, and whether retrying the identical call now passes: `wait`, `passes` (with the time the approval's bypass expires), `held_again` (approved, but the workspace's `reviewHoldBypassEnabled` is off or the bypass has expired) or `do_not_retry` |
| `intutic_mcp_registry_status` (`server`, optional) | For each server in the registry: its status, whether calls to it are allowed or refused and with which [code](#refusal-codes), and its switched-off tools |
| `intutic_mcp_budget_remaining` | Each MCP call budget that counts the caller's calls: limit, calls used and left this period, and when it resets. Counts are read from the Valkey the proxies count in (`INTUTIC_VALKEY_URL`); without one, `used` is `null` |

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
| `block` | request | Refuse the call pre-flight; return a JSON-RPC `-32603` error to the agent, with a [refusal code](#refusal-codes) in `error.data.code`. Nothing runs. |
| `hold` | request | A `require_approval` rule matched: refuse the call for now, record a hold for review, and return a `-32603` error whose message names the hold id (also in `error.data.holdId`, with `error.data.code` `HELD`). See [Approval holds](/guide/mcp-governance#approval-holds). |
| `redact` | response | Declared by the `Decision` type but produced structurally, not as a `decide()` return value — see below. |

`decide()` runs this pipeline, in order, over every `tools/call` request:

1. **MCP server registry** — refuses a blocked server, a server held for re-approval after a high-risk tool change, every server not approved when the workspace's default policy is `deny`, and a tool switched off within its server. See [The registry](/guide/mcp-governance#the-registry).
2. **Server allowlist** (`mcpAllowedServers`) — refuses the whole server if it's not on an explicit, non-empty allowlist.
3. **Tool allowlist** (`mcpAllowedTools`) — refuses the individual tool the same way.
4. **SSO group policy** — the workspace's `sso_group_policy`, applied to the member the proxy's API key belongs to. See [Who made the call](/guide/mcp-governance#caller-identity).
5. **DLP scan** — blocks a request whose arguments contain a credential-shaped value or a destructive command pattern (`rm -rf /`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`). Command patterns are matched against each argument string as the tool receives it, object keys included, and the SQL keywords may be separated by any whitespace, a block or `--` comment, or an escaped `\n` / `\t`: `DROP/**/TABLE` and `DROP` and `TABLE` on separate lines are blocked. The scan reads text, not SQL, so a quoted mention such as `SELECT 'drop table'` is blocked too — a quoted string is also how a shell command carries the real statement.
6. **SOP policy rules** — workspace-defined `block` / `warn` / `require_approval` rules matched against tool name and serialized arguments. `require_approval` holds the call for a person's approval (`hold` above).
7. **Prompt-injection scan** (request direction) — see [Prompt-injection scanning](#prompt-injection-scanning) below.
8. **Anomaly detectors** and **WASM rules** — see the session-scope note below.
9. **Call budgets** (`mcpBudgets`) — counts the call in Valkey against every budget that covers it, and refuses it when one is used up. Last, so a call another step refuses spends nothing. See [Call budgets](/guide/mcp-governance#call-budgets).

The DLP scan also runs the enabled [PII detectors](/guide/policies#pii-detectors):
card numbers, IBANs and SSNs by default. Arguments are never rewritten, so a
match blocks the call even when its detector is set to `redact`.

### Refusal codes

Every refusal is a JSON-RPC `-32603` error whose message is written for the agent, and whose `error.data` names it for a client that reads it programmatically: `code`, one of the codes below; `ruleId`, the rule, setting or detector that decided; and, for some codes, more fields. A hold adds `status: "pending_approval"` and `holdId`, which is empty when the hold could not be recorded, so there is nothing to approve yet. `BUDGET_EXCEEDED` adds the budget's `budgetId`, `scope`, `period`, `limit`, `used` and `resetAt`, and `BUDGET_UNAVAILABLE` the `budgetIds` it could not check.

```json
{"code": -32603, "message": "[Intutic Governance] Tool call blocked: Tool \"query\" is disabled on MCP server \"db\" …",
 "data": {"code": "TOOL_DISABLED", "ruleId": "mcp_registry.db.query"}}
```

| Code | `ruleId` | Meaning |
|---|---|---|
| `REGISTRY_UNAVAILABLE` | `mcpProxyFailBehavior` | The MCP server registry has not loaded since the proxy started, and the proxy fails closed |
| `SERVER_BLOCKED` | `mcp_registry.<server>` | The server is blocked in the MCP server registry |
| `SERVER_HELD` | `mcp_registry.<server>` | The server changed its tools in a way scored high risk and waits for an owner or admin to approve it again |
| `SERVER_NOT_APPROVED` | `mcpDefaultPolicy` | The workspace refuses servers it has not approved (`mcpDefaultPolicy: deny`), and this one is not approved |
| `TOOL_DISABLED` | `mcp_registry.<server>.<tool>` | The tool is switched off on this server in the registry |
| `SERVER_NOT_ALLOWED` | `mcpAllowedServers` | The server is not on the workspace's `mcpAllowedServers` list |
| `TOOL_NOT_ALLOWED` | `mcpAllowedTools` | The tool is not on the workspace's `mcpAllowedTools` list |
| `SSO_GROUP` | `sso_group.high_risk.<tool>` or `sso_group.require_obo.<tool>` | The workspace's SSO group policy does not clear this tool for the member, or the member's groups are unknown |
| `DLP` | `dlp.<pattern>` | The arguments contain a credential, a destructive command or a PII value the DLP scan blocks |
| `SOP_RULE` | The SOP rule id | A `block` SOP rule matched |
| `HELD` | The SOP rule id | A `require_approval` SOP rule matched: the call is held for a person's approval, and `holdId` names the hold |
| `INJECTION` | `injection.tool_input` | The arguments matched a prompt-injection pattern, and the workspace blocks injection |
| `ANOMALY` | The detector id | An anomaly detector stopped the call |
| `WASM_RULE` | `wasm:<rule id>` | A custom WASM rule blocked the call |
| `REASK` | The detector id, or `wasm:<rule id>` | An anomaly detector or WASM rule refused this attempt; revise the approach |
| `REASK_EXHAUSTED` | The detector id, or `wasm:<rule id>` | The same detector or rule refused three attempts, so it now blocks outright |
| `BUDGET_EXCEEDED` | The budget id | An MCP call budget covering this call is used up until `resetAt` |
| `BUDGET_UNAVAILABLE` | `mcpProxyFailBehavior` | A call budget covers this call but could not be checked, and the proxy fails closed |
| `GOVERNANCE_UNAVAILABLE` | `mcpProxyFailBehavior` | A governance check could not complete, and the proxy fails closed |
| `TOFU_UNAVAILABLE` | `mcpProxyFailBehavior` | The server's pinned tool definitions could not be read or written, and the proxy fails closed |
| `TOOL_DEFINITIONS_CHANGED` | `tofu.<server>` | The server's tool definitions changed since they were first pinned, and the proxy fails closed |
| `RESULT_WITHHELD_DLP` | `dlp.<pattern>` | The tool ran, but its result held sensitive data that could not be redacted safely, so it was not delivered |
| `RESULT_WITHHELD_INJECTION` | `injection.tool_result` | The tool ran, but its result matched a prompt-injection pattern, so it was not delivered |

The two `RESULT_WITHHELD_*` codes answer a call that already ran; every other code means the call did not run.

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

1. **DLP redaction** — strips credential-shaped values and enabled PII detector matches (as `[REDACTED_PII]`) out of the result text. If a match spans JSON syntax and the redacted text no longer parses, the whole result is withheld and replaced with an error explaining why (the call ran; only the delivery was refused).
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
`tool_blocked` sees this new block reason too. The control plane files every
`injection_detected`, `anomaly_detected` and `tool_redacted` event as a
detector finding under an `mcp:` detector id — see [MCP Server
Governance](/guide/mcp-governance#prompt-injection-scanning).

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
