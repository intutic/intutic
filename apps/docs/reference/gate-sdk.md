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

`gate.guard(toolName, toolInput)` evaluates five tiers in order and stops at the first refusal:

| Tier | Check | Needs a client | On failure |
|---|---|---|---|
| SSO group policy | The workspace's SSO group policy, decided for the member the policy snapshot was issued to | No | Refuses a high-risk tool when the member's groups are unknown |
| Policy snapshot | The rules in `~/.intutic/hooks/policy-snapshot.rules`, which the sync daemon compiles for the workspace | No | Fails closed |
| SOP rules | Rules authored in the SOP register, including their `WHERE` argument clauses, fetched once per process | Yes | Fails open; the image check below covers the same case |
| Image integrity | On a deploy command, every container image it names (inline or in a referenced manifest) must be pinned to a digest approved in `.intutic/image-allowlist.json` | No | Fails closed, including when the allowlist is missing or unreadable |
| Hook gate | `POST /api/v1/hook-gate` on the control plane: DLP patterns over the arguments, plus workspace policy | Yes | Set by the client's `failClosed` (default: block) |

Read-only tools (`read_file`, `list_files`, `read`, `cat`, `view`, exported as `READ_ONLY_TOOLS`) get the snapshot check only. Every decision is reported to `POST /api/v1/hook-events` (`tool_blocked`, `tool_held`, `hold_approved_bypass_used`, `tool_flagged`, `tool_would_block`, `tool_allowed`, plus one snapshot-health event per process). Setting `INTUTIC_GUARD_DISABLE=1` skips the snapshot's destructive-command rules and reports `guards_disabled`.

### Holds

A hold rule asks a person before the call runs: a `REQUIRE_APPROVAL:` SOP, which reaches the gate both in the policy snapshot and in the SOP register, or a `review_before:` entry in a local SOP or the workspace settings, which reaches it in the snapshot. The gate handles it the way the harness hook gates and the [MCP proxy](/guide/mcp-governance#approval-holds) do, through the same decisions API:

1. It looks for an approval of this exact call in `GET /api/v1/decisions/approved-bypasses`. "Exact" means the same rule, the same tool and the same arguments, compared as a SHA-256 of the arguments with their keys sorted. If it finds one that has not expired, the call goes on to the next tier and the gate reports `hold_approved_bypass_used`.
2. Otherwise it records a hold with `POST /api/v1/decisions`, reports `tool_held`, and throws `IntuticGateHold`, a subclass of `IntuticGateRefusal` with `code` `HELD` and the hold's id in `holdId` (`hold_id`). Its message starts with `[Intutic Governance] HELD:` and tells the agent who can approve the hold and when a retry passes. The hold appears in **Findings › Review Queue**, and the workspace gets the `decision.pending` notification, Slack card included.
3. An owner, admin or engineering manager approves or rejects it with `intutic decision approve <holdId>` (or `reject`), the review API, or the Slack card. A developer cannot approve their own hold.
4. With the workspace's `reviewHoldBypassEnabled` setting on, approval lets the identical call through for `reviewHoldBypassTtlMinutes` (10 by default). With it off, the default, approval records the decision only and a retry is held again.

A hold needs the control plane, to look for an approval and to record the request. Without a client, or when the control plane cannot be reached, the call stays held whatever `failClosed` says, and `holdId` is unset because there is nothing to approve yet.

### Without a client

`new Gate(config)` with no `GateClient` (`Gate(GateConfig())` in Python) runs the two local tiers, policy snapshot and image integrity, and nothing else: there is no SOP-rule fetch, no hook-gate call, and no events are sent. Use this for local, offline enforcement against the snapshot the daemon already wrote.

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

A refused call throws `IntuticGateRefusal`. Its message starts with `[Intutic Governance] BLOCKED:`; `reason`, `code` and `incidentId` (`incident_id`) carry the structured verdict. A hold throws the subclass `IntuticGateHold` instead, which adds `holdId` (`hold_id`) and starts its message with `[Intutic Governance] HELD:` (see [Holds](#holds)). `code` is one of these, exported as `GATE_REFUSAL_CODES` and, in TypeScript, typed as `GateRefusalCode`:

| Code | Meaning |
|---|---|
| `SSO_GROUP` | The workspace's SSO group policy does not clear this tool for the member, or the member's groups are unknown |
| `SNAPSHOT` | A block rule in the policy snapshot matched |
| `HELD` | A hold rule matched: the call is held for a person's approval, and `holdId` names the hold |
| `SOP_RULE` | A block rule in the SOP register matched |
| `HOOK_GATE` | The control plane's hook gate refused the call, or could not be reached while `failClosed` is on |
| `E_UNPINNED_LATEST` | A deploy uses an image tagged `latest` |
| `E_UNPINNED_TAG` | A deploy uses an image by tag where the allowlist requires a digest |
| `E_UNKNOWN_REGISTRY` | A deploy uses an image from a registry the allowlist does not name |
| `E_UNKNOWN_IMAGE` | A deploy uses an image the allowlist does not name |
| `E_DIGEST_MISMATCH` | A deploy uses an image digest the allowlist does not approve |
| `E_MANIFEST_UNPARSEABLE` | The image allowlist, or a manifest the deploy names, is missing or unreadable |
| `WORKFLOW_SANDBOX` | TypeScript only: the Workflow DevKit adapter was called inside the workflow sandbox, where the gate cannot run; run it in a step |
| `NO_GATE` | TypeScript only: the Workflow DevKit adapter has no gate to call, because none was passed and none was installed |

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

## Related

- [clawde SDK](/reference/clawde-sdk) — the client for the proxy's chat route and the control plane
- [Harness Security Matrix](/reference/harness-security-matrix) — where each harness is gated
