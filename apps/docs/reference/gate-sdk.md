# Tool Gate SDK <Badge type="tip" text="Open-Core" />

A pre-execution gate for agent tools, for frameworks that have no Intutic hook file: the gate runs inside your process, before each tool body, and refuses a call by throwing. It ships twice with the same contract:

| Language | Package | Import |
|---|---|---|
| TypeScript | `@intutic/gate` (`npm install @intutic/gate`) | `@intutic/gate`, plus framework adapters under `@intutic/gate/<framework>` |
| Python | `intutic-clawde` (`pip install intutic-clawde`) | `intutic_clawde.gate`, plus framework adapters under `intutic_clawde.gate.adapters` |

The framework integration pages (LangGraph, Mastra, the Vercel AI SDK, Strands and the rest) show the adapter for each framework. This page documents the core every adapter is built on.

## Quick start

### TypeScript

```ts
import { Gate, GateClient, IntuticGateRefusal, install, wrapTools } from '@intutic/gate'

install(
  new Gate(
    { workspaceId: process.env.INTUTIC_WORKSPACE_ID },
    GateClient.fromEnv({ harness: 'my-agent' }),
  ),
)

const tools = wrapTools({
  shell: async ({ command }: { command: string }) => runShell(command),
})

try {
  await tools.shell({ command: 'kubectl apply -f k8s/deploy.yaml' })
} catch (err) {
  if (err instanceof IntuticGateRefusal) console.error(err.code, err.reason)
  else throw err
}
```

### Python

```python
import os

from intutic_clawde.gate import Gate, GateClient, GateConfig, IntuticGateRefusal, guard, install

install(Gate(GateConfig(workspace_id=os.environ.get("INTUTIC_WORKSPACE_ID", "")),
             GateClient.from_env(harness="my-agent")))

@guard
def shell(command: str) -> str:
    return run_shell(command)

try:
    shell("kubectl apply -f k8s/deploy.yaml")
except IntuticGateRefusal as e:
    print(e.code, e.reason)
```

`Gate.guard()` is `async` in TypeScript and synchronous in Python, so a wrapped TypeScript tool always returns a promise.

## What a call goes through

`gate.guard(toolName, toolInput)` evaluates six tiers in order and stops at the first refusal:

| Tier | Check | Needs a client | On failure |
|---|---|---|---|
| SSO group policy | The workspace's SSO group policy, decided for the member the policy snapshot was issued to | No | Refuses a high-risk tool when the member's groups are unknown |
| Policy snapshot | The rules in `~/.intutic/hooks/policy-snapshot.rules`, which the sync daemon compiles for the workspace | No | A snapshot that fails its digest or workspace check is not trusted: its rules are dropped, the SSO group policy still refuses (now for a member whose groups are unknown), and every MCP call is refused (next row) |
| MCP servers | On an `mcp__<server>__<tool>` call, the workspace's [MCP server registry](/guide/mcp-governance) and `mcpAllowedServers` list, from the same snapshot, with the codes, rule ids and reasons the hook gates and the MCP proxy use | No | A snapshot that fails its digest or workspace check admits no MCP server: every MCP call is refused with `POLICY_SNAPSHOT_UNVERIFIED` |
| SOP rules | Rules authored in the SOP register, including their `WHERE` argument clauses, fetched once per process | Yes | Fails open; the image check below covers the same case |
| Image integrity | On a deploy command, every container image it names (inline or in a referenced manifest) must be pinned to a digest approved in `.intutic/image-allowlist.json` | No | Fails closed, including when the allowlist is missing or unreadable |
| Hook gate | `POST /api/v1/hook-gate` on the control plane: DLP patterns over the arguments, plus workspace policy, the MCP server registry and `mcpAllowedServers` | Yes | Set by the client's `failClosed` (default: block) |

Read-only tools (`read_file`, `list_files`, `read`, `cat`, `view`, exported as `READ_ONLY_TOOLS`) get the snapshot check only. Every decision is reported to `POST /api/v1/hook-events` (`tool_blocked`, `tool_held`, `hold_approved_bypass_used`, `tool_flagged`, `tool_would_block`, `tool_allowed`, plus one snapshot-health event per process). Setting `INTUTIC_GUARD_DISABLE=1` skips the snapshot's destructive-command rules and reports `guards_disabled`.

A call to a server the workspace has not approved under `mcpDefaultPolicy: deny` is refused with `SERVER_NOT_APPROVED`, and its `tool_blocked` event puts the server in the approval queue on the MCP Servers page, as a hook gate's refusal does. A server not on `mcpAllowedServers` is refused with `SERVER_NOT_ALLOWED`; in an observe-only (`SILENT_LOG`) workspace the call goes ahead and is reported as `tool_would_block`. On a snapshot that fails its digest (broken or missing) or workspace check, every MCP call is refused with `POLICY_SNAPSHOT_UNVERIFIED`, observe-only workspaces included, because an edited or deleted registry or allowlist record cannot be told from the workspace's own; the sync daemon restores the last verified snapshot ([A snapshot that fails verification](/guide/mcp-governance#a-snapshot-that-fails-verification)).

The events carry `gateSource: "sdk"` and the client's `harness`, which is how the control plane watches an SDK gate for silence with no daemon to report it: once a gate's events have arrived on three different days within a week, [Gate health](/guide/settings) lists it, and **Gate Stopped Reporting** fires if it then sends nothing for 48 hours. A script run once or twice is never listed. Give each long-running agent its own `harness` name to watch it on its own.

### Holds

A hold rule asks a person before the call runs: a `REQUIRE_APPROVAL:` SOP, which reaches the gate both in the policy snapshot and in the SOP register, or a `review_before:` entry in a local SOP or the workspace settings, which reaches it in the snapshot. The gate handles it the way the harness hook gates and the [MCP proxy](/guide/mcp-governance#approval-holds) do, through the same decisions API:

1. It looks for an approval of this exact call in `GET /api/v1/decisions/approved-bypasses`. "Exact" means the same rule, the same tool and the same arguments, compared as a SHA-256 of the arguments with their keys sorted. If it finds one that has not expired, the call goes on to the next tier and the gate reports `hold_approved_bypass_used`.
2. Otherwise it records a hold with `POST /api/v1/decisions`, reports `tool_held`, and throws `IntuticGateHold`, a subclass of `IntuticGateRefusal` with `code` `HELD` and the hold's id in `holdId` (`hold_id`). Its message starts with `[Intutic Governance] HELD:` and tells the agent who can approve the hold and when a retry passes. The hold appears in **Findings › Review Queue**, and the workspace gets the `decision.pending` notification, Slack card included.
3. An owner, admin or engineering manager approves or rejects it with `intutic decision approve <holdId>` (or `reject`), the review API, or the Slack card. A developer cannot approve their own hold.
4. With the workspace's `reviewHoldBypassEnabled` setting on, approval lets the identical call through for `reviewHoldBypassTtlMinutes` (10 by default). With it off, the default, approval records the decision only and a retry is held again.

A `review_before:` entry can name a tool (`Write`) or an action (`action:deploy`, `action:publish`, `action:release`, `action:db_write`). For an action, the gate classifies the call's `command` with the same phrases as the hook gates and the proxy, whatever separates their words: `git push` with a tab or a line continuation between the words, `kubectl --context prod apply` and `DROP/**/TABLE users` are held like their plain spellings.

A hold needs the control plane, to look for an approval and to record the request. Without a client, or when the control plane cannot be reached, the call stays held whatever `failClosed` says, and `holdId` is unset because there is nothing to approve yet.

### Without a client

`new Gate(config)` with no `GateClient` (`Gate(GateConfig())` in Python) runs the local tiers, the ones the table above marks as needing no client, and nothing else: there is no SOP-rule fetch, no hook-gate call, and no events are sent. Use this for local, offline enforcement against the snapshot the daemon already wrote.

### Fail-closed defaults

- A `GateClient` that cannot reach the hook gate, or gets a non-2xx answer, reports a block. Pass `failClosed: false` (`fail_closed=False`) to treat that tier as advisory.
- A deploy command with no readable image allowlist is refused rather than approved against an empty policy.
- A wrapped tool called with no gate installed and none passed throws (`RuntimeError` in Python) instead of running unguarded.
- `GateClient.fromEnv()` (`from_env()`) throws when no session id is set, because the proxy would record every run under the session `unknown`.

## Configuration

### `Gate`

| TypeScript | Python (`GateConfig`) | Default | Meaning |
|---|---|---|---|
| `repoRoot` | `repo_root` | `.` | Where relative manifest and allowlist paths resolve from |
| `workspaceId` | `workspace_id` | `''` | Compared with the workspace the policy snapshot was compiled for, and scopes the SOP-rule fetch |
| `allowlistPath` | `allowlist_path` | `.intutic/image-allowlist.json` | The image allowlist, relative to `repoRoot` unless absolute |
| `enforce` | `enforce` | `true` | `false` turns `guard()` into a no-op |
| `useHookGate` | `use_hook_gate` | `true` | Call the hook gate (needs a client) |
| `useSopRules` | `use_sop_rules` | `true` | Fetch and apply SOP rules (needs a client) |

The image allowlist is JSON: `require_digest` (default `true`), `registries_allowed` (repository prefixes; empty allows any registry) and `images`, keyed by repository, each with its `approved_digests`.

### `GateClient`

| TypeScript | Python | Default |
|---|---|---|
| `baseUrl` | `base_url` | `INTUTIC_CONTROL_PLANE_URL`, then Intutic's hosted control plane |
| `apiKey` | `api_key` | `''` |
| `workspaceId` | `workspace_id` | `''` |
| `sessionId` | `session_id` | `''` |
| `harness` | `harness` | `generic` in TypeScript, `langgraph` in Python; sent as `harnessType` to attribute incidents |
| `failClosed` | `fail_closed` | `true` |
| `timeoutMs` | `timeout` | 2 seconds |

`GateClient.fromEnv({ sessionId?, harness?, failClosed? })` (`GateClient.from_env(session_id=None, harness=..., fail_closed=True)`) reads `INTUTIC_CONTROL_PLANE_URL`, `INTUTIC_API_KEY`, `INTUTIC_WORKSPACE_ID` and `INTUTIC_SESSION_ID`, and falls back to the key and workspace that `intutic login` stored in `~/.intutic/credentials.json`.

## Refusals

A refused call throws `IntuticGateRefusal`. Its message starts with `[Intutic Governance] BLOCKED:`; `reason`, `code` and `incidentId` (`incident_id`) carry the structured verdict. A hold throws the subclass `IntuticGateHold` instead, which adds `holdId` (`hold_id`) and starts its message with `[Intutic Governance] HELD:` (see [Holds](#holds)). `code` is one of these, exported as `GATE_REFUSAL_CODES` and, in TypeScript, typed as `GateRefusalCode`. A refusal from the hook gate is `HOOK_GATE`, or the registry's own code when the hook gate's MCP server registry refused:

| Code | Meaning |
|---|---|
| `SSO_GROUP` | The workspace's SSO group policy does not clear this tool for the member, or the member's groups are unknown |
| `SNAPSHOT` | A block rule in the policy snapshot matched |
| `HELD` | A hold rule matched: the call is held for a person's approval, and `holdId` names the hold |
| `SERVER_BLOCKED` | The MCP server is blocked in the MCP server registry |
| `SERVER_HELD` | The MCP server changed its tools in a way scored high risk and waits for an owner or admin to approve it again |
| `SERVER_NOT_APPROVED` | The workspace refuses MCP servers it has not approved (`mcpDefaultPolicy: deny`), and this one is not approved |
| `TOOL_DISABLED` | The tool is switched off on this MCP server in the registry |
| `SERVER_NOT_ALLOWED` | The MCP server is not on the workspace's `mcpAllowedServers` list |
| `POLICY_SNAPSHOT_UNVERIFIED` | The policy snapshot on this machine failed its integrity check, so it admits no MCP server; the sync daemon restores the last verified snapshot |
| `SOP_RULE` | A block rule in the SOP register matched |
| `HOOK_GATE` | The control plane's hook gate refused the call, or could not be reached while `failClosed` is on |
| `COMMAND_TOO_LARGE` | The command is over 256 KiB, or the tool arguments over 1 MiB, the most a gate evaluates; split the work into smaller calls |
| `E_UNPINNED_LATEST` | A deploy uses an image tagged `latest` |
| `E_UNPINNED_TAG` | A deploy uses an image by tag where the allowlist requires a digest |
| `E_UNKNOWN_REGISTRY` | A deploy uses an image from a registry the allowlist does not name |
| `E_UNKNOWN_IMAGE` | A deploy uses an image the allowlist does not name |
| `E_DIGEST_MISMATCH` | A deploy uses an image digest the allowlist does not approve |
| `E_MANIFEST_UNPARSEABLE` | The image allowlist, or a manifest the deploy names, is missing or unreadable |
| `WORKFLOW_SANDBOX` | TypeScript only: the Workflow DevKit adapter was called inside the workflow sandbox, where the gate cannot run; run it in a step |
| `NO_GATE` | TypeScript only: the Workflow DevKit adapter has no gate to call, because none was passed and none was installed |

`COMMAND_TOO_LARGE` is checked before every tier: a `command` over 256 KiB, or arguments whose compact JSON is over 1 MiB (UTF-8 bytes; `COMMAND_SIZE_LIMIT` and `ARGUMENTS_SIZE_LIMIT`, exported by both packages), is refused without being evaluated. The limits sit far above real agent traffic and bound how long any rule can take; see [Hook timeouts](/reference/harness-security-matrix#hook-timeouts).

## Wrapping tools

| TypeScript | Python | Use |
|---|---|---|
| `install(gate)`, `active()` | `install(gate)`, `active()` | Set and read the process-wide gate that wrapped tools use |
| `wrapTool(fnOrTool, { name?, gate? })` | `@guard`, `@guard(name=..., gate=...)` | Gate one function, or (TypeScript) one `{ execute, ... }` tool object, which is copied rather than mutated |
| `wrapTools(arrayOrRecord, gate?)` | `guard_tools(tools, gate=None)` | Gate a collection. A TypeScript record uses its keys as tool names; Python duck-types LangChain/LangGraph (`.func`, `._run`) and smolagents (`.forward`) tool objects and wraps them in place |

The tool input the gate sees is the call's first argument when it is an object (TypeScript), or the call's arguments bound to their parameter names (Python), so `shell("rm -rf /")` and `shell(command="rm -rf /")` are evaluated identically. Wrapping an already-wrapped tool is a no-op.

## Other exports

- `intuticHeaders({ sessionId?, workspaceId?, harness? })` (`intutic_headers(session_id=None, workspace_id=None, harness="langgraph")`) returns `x-intutic-harness`, `x-session-id` and `x-workspace-id` headers for a model client pointed at the Intutic proxy. The session and workspace fall back to `INTUTIC_SESSION_ID` and `INTUTIC_WORKSPACE_ID`.
- `checkCommand(command, repoRoot, policy)` (TypeScript) runs the image-integrity check on its own and returns `{ ok, code, detail, images }`; `checkImages` and `checkWrittenManifest` check parsed image references and manifest text.
- `classify`, `isDeploy`, `isTest`, `touchesInfra` (`classify`, `is_deploy`, `is_test`, `touches_infra`) are the command classifier the image check uses to decide what counts as a deploy.
- `loadSnapshot` / `load_snapshot`, `parseRules` / `parse_rules` and `firstMatch` / `first_match` expose the snapshot and SOP-rule tiers for testing your own rules.
- `canonicalJson`, `holdKey` and `holdMessage` (`canonical_json`, `hold_key`, `hold_message`) are the hold helpers the gate uses: JSON with keys sorted at every level, the tool name and argument hash an approved hold is matched on, and the message a held call carries (see [Holds](#holds)).
- `GATE_DEADLINE_MS` (TypeScript only, 9000) is how long the hook script `intuticSandboxBootstrap()` writes may evaluate, from process start, before it refuses with `GATE_DEADLINE`: one second under that hook entry's 10-second timeout (`HOOK_TIMEOUT_SECONDS`), so a slow rule is refused rather than left to the harness, which would run the call. See [Hook timeouts](/reference/harness-security-matrix#hook-timeouts).

## Related

- [clawde SDK](/reference/clawde-sdk) — the client for the proxy's chat route and the control plane
- [Harness Security Matrix](/reference/harness-security-matrix) — where each harness is gated
