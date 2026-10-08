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

`gate.guard(toolName, toolInput)` evaluates four tiers in order and stops at the first refusal:

| Tier | Check | Needs a client | On failure |
|---|---|---|---|
| Policy snapshot | The rules in `~/.intutic/hooks/policy-snapshot.rules`, which the sync daemon compiles for the workspace | No | Fails closed |
| SOP rules | Rules authored in the SOP register, including their `WHERE` argument clauses, fetched once per process | Yes | Fails open; the image check below covers the same case |
| Image integrity | On a deploy command, every container image it names (inline or in a referenced manifest) must be pinned to a digest approved in `.intutic/image-allowlist.json` | No | Fails closed, including when the allowlist is missing or unreadable |
| Hook gate | `POST /api/v1/hook-gate` on the control plane: DLP patterns over the arguments, plus workspace policy | Yes | Set by the client's `failClosed` (default: block) |

Read-only tools (`read_file`, `list_files`, `read`, `cat`, `view`, exported as `READ_ONLY_TOOLS`) get the snapshot check only. Every decision is reported to `POST /api/v1/hook-events` (`tool_blocked`, `tool_flagged`, `tool_would_block`, `tool_allowed`, plus one snapshot-health event per process). Setting `INTUTIC_GUARD_DISABLE=1` skips the snapshot rules and reports `guards_disabled`.

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

A refused call throws `IntuticGateRefusal`. Its message starts with `[Intutic Governance] BLOCKED:`; `reason`, `code` and `incidentId` (`incident_id`) carry the structured verdict. `code` names the tier: `SNAPSHOT`, `SOP_RULE`, `SOP_RULE_APPROVAL` (an SOP rule that requires approval, which an unattended run cannot get), `HOOK_GATE`, or an image code (`E_UNPINNED_LATEST`, `E_UNPINNED_TAG`, `E_UNKNOWN_REGISTRY`, `E_UNKNOWN_IMAGE`, `E_DIGEST_MISMATCH`, `E_MANIFEST_UNPARSEABLE`).

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
