---
title: MCP Server Governance
description: The MCP server registry, per-workspace allowlist, and server-level TOFU pinning that guard against a rogue or rug-pulled MCP server — and what these controls honestly do not cover yet.
---

# MCP Server Governance <Badge type="tip" text="Open-Core" />

An MCP server is code a harness spawns and trusts on the agent's behalf —
every tool it declares becomes something the model can call, and every tool
*description* becomes text the model reads as instructions. This page covers
three controls built on top of the MCP proxy-wrapping mechanism described in
[Graph Guardrails](/guide/graph-guardrails): a **registry** of servers seen
per workspace, a **per-workspace allowlist** that can refuse an unapproved
server outright, and **server-level TOFU pinning** that detects a server's
tool definitions changing after a user has already trusted it.

## How a server gets here at all

`intutic connect` and the sync daemon's continuous sync loop rewrite each
stdio MCP server entry in a harness config (`~/.claude/mcp.json`, Claude
Desktop, Cursor, Cline, Windsurf, Continue, Goose, OpenHands — nine config
paths across eight harnesses) so that the `@intutic/mcp-governance-proxy`
binary fronts it: the harness spawns the proxy, the proxy spawns the real
server, and every `tools/call` and `tools/list` passes through governance in
between.

**This is not instant.** A server a developer adds to their harness config is
unwrapped and unmediated by this proxy until the *next* sync cycle picks it
up — the sync loop runs continuously (not one-shot), but there is a real
window, on the order of the loop's own interval, where a freshly-added server
talks to the harness directly. During that window none of the controls on
this page apply to it.

## The registry: what the control plane knows about a server

Every proxy-wrapped server reports its identity — server name, harness,
transport — to the control plane on each daemon heartbeat
(`POST /api/v1/mcp-daemon/report`), which upserts it into the `mcp_servers`
table: the first sighting of a `{workspace, server}` pair creates a
`candidate` row; every later sighting refreshes when it was last seen,
without touching its status. Promoting a server from `candidate` to
`approved` or `blocked` is a lifecycle this table supports, but this phase
does not ship the dashboard/route to *do* the promoting — that is a tracked
follow-up (see TECH_DEBT.md), not a built feature.

## The allowlist: `mcpAllowedServers`

A workspace can set `mcpAllowedServers` (an array of server names) in its
settings. **Absent or empty means unrestricted** — the same convention every
allowlist in this product uses (`mcpAllowedTools`, `allowedModels`,
`egressAllow`): a workspace that never configured this must not suddenly
start refusing every MCP server because a default changed.

When the list is non-empty, the proxy refuses to service any tool call routed
through a server whose name is not on it, and names the setting in the
refusal so an operator knows exactly what to widen rather than guessing:

```
MCP server "some-third-party-server" is not in this workspace's MCP server
allowlist (2 server(s) permitted). An operator can widen the allowlist in
workspace settings (mcpAllowedServers).
```

This is enforced by the same proxy process that already enforces
`mcpAllowedTools` (per-tool scoping) and DLP/SOP policy — one interception
point, not a second one that could disagree with the first.

## Server-level TOFU pinning

Ported from `packages/proxy/src/tool_pin.rs`'s per-request tool-array
pinning, extended to one fingerprint per `{workspace, server}` pair (each
governance proxy process fronts exactly one real server). On the first
`tools/list` response a workspace sees from a server, the proxy computes a
SHA-256 fingerprint over the canonical JSON of every tool's `name`,
`description`, and `inputSchema` — sorted so a server reordering its own
list never reads as a change — and stores it under
`~/.intutic/mcp-pins/<workspace>__<server>.json`. Every later `tools/list`
response is compared against that stored fingerprint.

On a mismatch, the proxy emits an `mcp_server_definition_changed` event and
honors the workspace's `mcpProxyFailBehavior` setting exactly the way every
other governance check in this proxy does: fail-open logs the mismatch and
forwards the response as normal; fail-closed refuses the `tools/list` call
outright, naming the server and the setting an operator would need to
change.

### TOFU is change-detection, not content-detection

This is the single most important thing to understand about this control,
stated as plainly as `tool_pin.rs`'s own doc comment states it for the Rust
proxy: **a server that is malicious from the very first `tools/list`
response has its payload adopted as the trusted baseline.** TOFU pins
whatever arrives first. It cannot tell a benign tool definition from a
malicious one — it can only tell you that *something changed* after you
already trusted it. A server engineered to be poisoned from day one passes
this control cleanly, every time.

## Remote (HTTP/SSE) MCP servers: the stdio→HTTP bridge

Every control above this section — proxy-wrapping, the allowlist, TOFU
pinning — was originally a stdio-process mechanism: it worked by fronting
the real server's *spawned process*. A `url`-keyed remote MCP server entry
has no process to front, which is why remote servers were entirely
uncovered by this page (TD-354 in TECH_DEBT.md recorded that as an accepted
interim gap, not a decision to leave permanently).

That gap is closed by a bridge, not a redesign: the harness still spawns
`@intutic/mcp-governance-proxy` as an ordinary stdio child process — no new
listener, no new port, no daemon-lifecycle change — but the proxy's
*upstream* side now talks to the remote server over HTTP or Server-Sent
Events instead of a spawned child's stdin/stdout, using the MCP SDK's client
transports directly (never wrapped in the SDK's `Client` class, which would
filter the protocol rather than let governance see every message). The sync
daemon wraps a discovered `url`-keyed entry into this bridge mode the same
way it wraps a stdio entry — `wrapWithProxy` (`harness/mcpAutoWrite.ts`)
rewrites it to invoke the proxy with `--remote-url`/`--remote-transport`
instead of `--`, and `discoverMcpServers` now reports these entries honestly
too: `wrapped: true`, with their true `transport` (`http`/`sse`) preserved
rather than misreported as stdio. Auth headers (a bearer token, an API key)
ride via the `INTUTIC_REMOTE_HEADERS` environment variable on the wrapped
entry, never as a CLI argument — argv is visible to any local process via
`ps`, and a header carrying a credential must not leak that way.

Once bridged, a remote server gets the *exact same* governance pipeline a
stdio server already had: the per-tool and per-server allowlists, tools/list
curation, server-level TOFU pinning, DLP redaction on results, and per-call
audit events. Nothing about that pipeline changed to accommodate a second
upstream transport — `handleHarnessLine` and `handleServerLine`
(`packages/mcp-proxy/src/proxy.ts`) are the identical functions both stdio
proxy mode and the remote bridge call.

### What the bridge adds beyond egress control

Wrapped-remote traffic remains fully subject to host-level
[egress control](/guide/policies#network-egress-control)
(`egressAllow`/`egressMode`) — the bridge does not bypass it, and does not
attempt to. Egress control is a *lower* layer than this page's controls: it
governs *where* any process on the host, wrapped or not, is allowed to
connect at the network level. The bridge does not replace that layer; it
adds a higher one on top, specific to the MCP protocol itself:

| | Egress control alone | + the stdio→HTTP bridge |
|---|---|---|
| Can permit/deny a *destination* | ✅ (allow list, by host/domain/CIDR) | — |
| Can permit/deny an individual *tool* | ✗ (has no notion of MCP tools) | ✅ per-tool and per-server allowlists |
| Curates what tools the agent even sees | ✗ | ✅ `tools/list` curation |
| Detects a server's tool definitions changing after first trust | ✗ | ✅ server-level TOFU pinning |
| Redacts a credential out of a tool *result* | ✗ | ✅ DLP scanning on the response direction |
| Per-call audit trail (which tool, which server, allowed/blocked/redacted) | ✗ (connection-level logging only) | ✅ the same `tool_allowed`/`tool_blocked`/`tool_redacted` events stdio mode emits |

A remote MCP server allowed through egress control but never proxy-wrapped
still gets none of the right-hand column — egress alone cannot see MCP
protocol frames, only TCP/TLS connections. Governance over a remote server's
traffic requires BOTH layers doing their own job, not one substituting for
the other.

## What this phase deliberately does not cover

- **No cross-workspace or cross-tenant correlation.** A TOFU mismatch, or a
  server report, is stored per workspace. If the same popular MCP server
  rug-pulls a hundred different Intutic workspaces on the same day, nothing
  in this phase notices the pattern across them — each workspace's own proxy
  independently detects its own mismatch, with no aggregation joining those
  events together. See TECH_DEBT.md for why this is deliberately deferred,
  not merely unbuilt.
- **No public or global MCP server reputation database, and no VirusTotal
  (or similar third-party scanning) integration.** This product does not
  maintain, consume, or plan to consume a shared "is this MCP server known
  bad" list. Every judgment this page's controls make is local to a
  workspace's own observed history with a server — first contact, then
  change-detection from there. A reputation service is a different kind of
  claim (this server *is* dangerous, independent of your own history with
  it) that nothing here makes or relies on.
- **No automated promotion out of `candidate` status.** The registry table
  supports `approved`/`blocked`, and the ingest route never sets either — but
  nothing in this phase builds the dashboard or API route an operator would
  use to actually make that call.

## Related

| Page | What it covers |
|---|---|
| [Governance Controls Checklist](/guide/governance-controls) | The house style for stating partial coverage honestly, applied across every control this product ships |
| [Graph Guardrails](/guide/graph-guardrails) | The deterministic detector taxonomy MCP tool-poisoning detection follows, and how the proxy-wrapping mechanism this page builds on works |
| [Skill Scanning](/guide/skill-scanning) | The nearest sibling control: prose an agent treats as authoritative, published by a party the user never reviewed — applied to skill files instead of MCP tool declarations |
| [Network Egress Control](/guide/policies#network-egress-control) | The host-level layer the stdio→HTTP bridge sits above, not instead of — `egressAllow`/`egressMode` |
