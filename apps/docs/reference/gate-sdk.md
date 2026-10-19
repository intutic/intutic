# Tool Gate SDK <Badge type="tip" text="Open-Core" />

A pre-execution gate for agent tools, for frameworks that have no Intutic hook file: the gate runs inside your process, before each tool body, and refuses a call by throwing. It ships twice with the same contract:

| Language | Package | Import |
|---|---|---|
| TypeScript | `@intutic/gate` (`npm install @intutic/gate`) | `@intutic/gate`, plus framework adapters under `@intutic/gate/<framework>` |
| Python | `intutic-clawde` (`pip install intutic-clawde`) | `intutic_clawde.gate`, plus framework adapters under `intutic_clawde.gate.adapters` |

The framework integration pages (LangGraph, Mastra, the Vercel AI SDK, Strands and the rest) show the adapter for each framework. This page documents the core every adapter is built on. Every export, with its signature, options and defaults, is in the API reference generated from the source: [`@intutic/gate`](/reference/sdk/gate/) and [`intutic_clawde.gate`](/reference/sdk/python/intutic_clawde/gate/).

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

`gate.guard(toolName, toolInput)` evaluates eight tiers in order and stops at the first refusal:

| Tier | Check | Needs a client | On failure |
|---|---|---|---|
| SSO group policy | The workspace's SSO group policy, decided for the member the policy snapshot was issued to | No | Refuses a high-risk tool when the member's groups are unknown |
| Policy snapshot | The rules in `~/.intutic/hooks/policy-snapshot.rules`, which the sync daemon compiles for the workspace | No | A snapshot that fails its digest or workspace check is not trusted: its rules are dropped, the SSO group policy still refuses (now for a member whose groups are unknown), and every MCP call is refused (next row) |
| Rule records | The snapshot's `@rule` records: a qualified `requires_before: action:run_tests[ok] -> X`, a `scope_paths:` under `scope_paths_mode: enforce`, and `plan_approval:` (see [Rule records](#rule-records)) | No; `plan_approval:` reads the session's plan from the control plane | Fails closed whatever `failClosed` says: an unreadable plan, no session id, or no test result the gate recorded leaves the rule unmet |
| MCP servers | On an `mcp__<server>__<tool>` call, the workspace's [MCP server registry](/guide/mcp-governance) and `mcpAllowedServers` list, from the same snapshot, with the codes, rule ids and reasons the hook gates and the MCP proxy use | No | A snapshot that fails its digest or workspace check admits no MCP server: every MCP call is refused with `POLICY_SNAPSHOT_UNVERIFIED` |
| SOP rules | Rules authored in the SOP register, including their `WHERE` argument clauses, fetched once per process | Yes, with an API key | Fails open; the image check below covers the same case |
| Image integrity | On a deploy command, every container image it names (inline or in a referenced manifest) must be pinned to a digest approved in `.intutic/image-allowlist.json` | No | Fails closed, including when the allowlist is missing or unreadable |
| Decide rules | Only on a call every tier above allowed: the snapshot's decide rules on the tool, asked of the self-hosted decide engine (`~/.intutic/decide/engine.json`, `INTUTIC_DECIDE_*`) within `INTUTIC_DECIDE_BUDGET_MS` (default 7,300 ms) | No | An enforcing rule whose engine cannot answer refuses with `GOVERNANCE_UNAVAILABLE`; a shadow rule's finding is reported as `tool_would_block` and the call goes on |
| Hook gate | `POST /api/v1/hook-gate` on the control plane: DLP patterns over the arguments, plus the SOP register's block rules, [policy guardrails'](/guide/policy-guardrails) hook rules, the SSO group policy, the MCP server registry and `mcpAllowedServers`, image provenance and promoted findings | Yes, with an API key | Set by the client's `failClosed` (default: block), for an unreachable control plane and for a `GOVERNANCE_UNAVAILABLE` answer alike; a request it cannot read, or a key without `gateway:use`, always blocks |

A snapshot that carries decide rules is in format 2: an `@format` line, an `@decide` record for each rule, and, for a rule stamped to enforce, a fallback line that refuses the rule's tools. The gate reads each record, checking the rule against its hash, and keeps the ones that decode in `snapshot.decideRules` (`decide_rules`) with the format in `snapshot.formatVersion` (`format_version`). It evaluates decide rules itself (`CAN_EVALUATE_DECIDE`), so it skips a fallback line, but only when a record that decoded names it: any other fallback line still refuses, as it does in a gate older than 3.0. `loadSnapshot(workspaceId, path)` (`load_snapshot(...)`) on its own keeps every fallback line; pass `{ evaluatesDecide: true }` (`evaluates_decide=True`) only when you evaluate the rules yourself. A snapshot with rule records is in format 3, and its `@rule` records and their fallback lines follow the same pattern: the gate keeps the records that decode in `snapshot.ruleRecords` (`rule_records`), evaluates them itself (`CAN_EVALUATE_RULE_RECORDS`), and skips a fallback line only when a record that decoded names it; `loadSnapshot` keeps every fallback line unless you pass `{ evaluatesRules: true }` (`evaluates_rules=True`). A snapshot in a newer format is reported once as `snapshot_format_newer`, and what the gate can read is still enforced.

Read-only tools (`read_file`, `list_files`, `read`, `cat`, `view`, exported as `READ_ONLY_TOOLS`) skip the SOP-rule and hook-gate tiers, and their allows are not reported. Every decision is reported to `POST /api/v1/hook-events` (`tool_blocked`, `tool_held`, `hold_approved_bypass_used`, `tool_flagged`, `tool_would_block`, `tool_allowed`, plus one snapshot-health event per process). Setting `INTUTIC_GUARD_DISABLE=1` skips the snapshot's destructive-command rules and reports `guards_disabled`.

Every answer the hook gate gives names its decision with a `decisionId` (`decision_id` on the client's response). The `tool_blocked` or `tool_allowed` event that reports that call carries it as `gateDecisionId`, so the control plane exports the decision to SIEM once (the hook gate's own record) and files its incident once: from this event for a rule refusal, and by the hook gate itself for its DLP check, whose `incidentId` names that incident. A `GOVERNANCE_UNAVAILABLE` answer keeps the id only when `failClosed` refuses the call too; failing open, the call runs and its report carries none. An SDK older than 2.5.1 sends no `gateDecisionId`, and each hook-gate decision it reports reaches a SIEM destination twice (see [SIEM export](/guide/siem-export#one-record-per-gate-decision)).

A call to a server the workspace has not approved under `mcpDefaultPolicy: deny` is refused with `SERVER_NOT_APPROVED`, and its `tool_blocked` event puts the server in the approval queue on the MCP Servers page, as a hook gate's refusal does. A server not on `mcpAllowedServers` is refused with `SERVER_NOT_ALLOWED`; in an observe-only (`SILENT_LOG`) workspace the call goes ahead and is reported as `tool_would_block`. On a snapshot that fails its digest (broken or missing) or workspace check, every MCP call is refused with `POLICY_SNAPSHOT_UNVERIFIED`, observe-only workspaces included, because an edited or deleted registry or allowlist record cannot be told from the workspace's own; the sync daemon restores the last verified snapshot ([A snapshot that fails verification](/guide/mcp-governance#a-snapshot-that-fails-verification)).

The events carry `gateSource: "sdk"` and the client's `harness`, which is how the control plane watches an SDK gate for silence with no daemon to report it: once a gate's events have arrived on three different days within a week, [Gate health](/guide/settings) lists it, and **Gate Stopped Reporting** fires if it then sends nothing for 48 hours. A script run once or twice is never listed. Give each long-running agent its own `harness` name to watch it on its own.

### Rule records

The sync daemon, the CLI and the control plane compile three SOP front-matter rules into `@rule` records for the gates. Only SOPs with no `roles:` compile, because a gate has no agent role. A SOP in `mode: shadow` compiles shadow records: what they would refuse is reported as `tool_would_block`, and the call goes on.

- **A qualified prerequisite.** `requires_before: action:run_tests[ok] -> action:deploy` refuses a deploy with `PREREQUISITE_UNMET` unless the latest test run in the session passed. The gate learns how a test run went from `gate.recordOutcome(toolName, toolInput, { exitCode?, isError?, output? })` (`record_outcome(tool_name, tool_input, exit_code=None, is_error=None, output=None)`), which `wrapTool` and `@guard` call after every call they run: a throw is a failure; a returned exit code (`exitCode`, `exit_code` or `returncode`) or text is read for the outcome. Without an exit code, the runner summaries in the last 64 KiB of the output decide (pytest, jest, vitest, go test, cargo test, mocha, rspec); output nothing can be read from leaves the rule unmet, and so does a run that reports no tests. A file change after a passing run (a write, edit, delete or move tool, or a shell command such as `sed -i`, `git checkout` or `git pull`) makes it stale, so the next deploy needs a new passing run. With `~>` the run must be the call right before. Outcomes are kept in memory per `sessionId` for a day; a client with no session id keeps none, so the rule is never met.
- **An enforced scope.** `scope_paths:` with `scope_paths_mode: enforce` refuses a call that writes, edits, deletes or moves a file outside the scope with `OUT_OF_SCOPE`. The path is made relative to the workspace root, the nearest directory at or above the working directory holding `.git`; a path outside the root is out of scope. A shell command is never read as a path.
- **Plan approval.** `plan_approval: required` refuses every call with `PLAN_NOT_APPROVED` until the session's plan is APPROVED or EXECUTING, read from `GET /api/v1/plans/session/:sessionId` and kept for 30 seconds (`PLAN_CACHE_MS` in TypeScript; in Python, `PLAN_CACHE_S` in `intutic_clawde.gate.gate`, not exported from `intutic_clawde.gate`). `plan_approval: strict` also refuses a tool that is not a step of the approved plan, with `OFF_PLAN`. Read, search and listing tools (`Read`, `Grep`, `Glob`, `LS`, `TodoWrite` and their kin) are never refused, because an agent has to read code to write a plan. A plan that cannot be read, a client with no API key, and a client with no session id all leave the rule unmet. Something must capture the session's plan for this to pass: upgrade every gate before turning it on.

A refusal from this tier carries `scope` beside `code` and `reason` (see [Refusals](#refusals)). A gate older than this tier refuses through the record's fallback line instead: the gated call for a prerequisite, every file-changing tool for a scope, every call for plan approval.

### Holds

A hold rule asks a person before the call runs: a `REQUIRE_APPROVAL:` SOP, which reaches the gate both in the policy snapshot and in the SOP register, or a `review_before:` entry in a local SOP or the workspace settings, which reaches it in the snapshot. The gate handles it the way the harness hook gates and the [MCP proxy](/guide/mcp-governance#approval-holds) do, through the same decisions API:

1. It looks for an approval of this exact call in `GET /api/v1/decisions/approved-bypasses`. "Exact" means the same rule, the same tool and the same arguments, compared as a SHA-256 of the arguments with their keys sorted. If it finds one that has not expired, the call goes on to the next tier and the gate reports `hold_approved_bypass_used`.
2. Otherwise it records a hold with `POST /api/v1/decisions`, reports `tool_held`, and throws `IntuticGateHold`, a subclass of `IntuticGateRefusal` with `code` `HELD` and the hold's id in `holdId` (`hold_id`). Its message starts with `[Intutic Governance] HELD:` and tells the agent who can approve the hold and when a retry passes. The hold appears in **Findings › Review Queue**, and the workspace gets the `decision.pending` notification, Slack card included.
3. An owner, admin or engineering manager approves or rejects it with the review API or the Slack card<!-- ENTERPRISE_ONLY_START -->, or with `intutic decision approve <holdId>` (or `reject`)<!-- ENTERPRISE_ONLY_END -->. A developer cannot approve their own hold.
4. With the workspace's `reviewHoldBypassEnabled` setting on, approval lets the identical call through for `reviewHoldBypassTtlMinutes` (10 by default). With it off, the default, approval records the decision only and a retry is held again.

A `review_before:` entry can name a tool (`Write`) or an action (`action:deploy`, `action:publish`, `action:release`, `action:db_write`). For an action, the gate classifies the call's `command` with the same phrases as the hook gates and the proxy, whatever separates their words: `git push` with a tab or a line continuation between the words, `kubectl --context prod apply` and `DROP/**/TABLE users` are held like their plain spellings.

A hold needs the control plane, to look for an approval and to record the request. Without a client, with a client that has no API key, or when the control plane cannot be reached, the call stays held whatever `failClosed` says, and `holdId` is unset because there is nothing to approve yet.

### Without a client

`new Gate(config)` with no `GateClient` (`Gate(GateConfig())` in Python) runs the local tiers, the ones the table above marks as needing no client, and nothing else: there is no SOP-rule fetch, no hook-gate call, and no events are sent. Use this for local, offline enforcement against the snapshot the daemon already wrote.

### Without credentials

A `GateClient` with no API key, which is what `GateClient.fromEnv()` (`from_env()`) builds when neither `INTUTIC_API_KEY` nor `~/.intutic/credentials.json` supplies one, is local-only: `client.localOnly` (`client.local_only`) is `true`. It sends nothing, because the control plane would refuse every request. The gate behaves as it does without a client, with one difference you can read: `client.hookGate()` (`hook_gate()`) answers allow with `reached` false, `code` `LOCAL_ONLY`, and a reason saying the control-plane tiers did not run. The SSO group, policy snapshot, MCP server and image tiers still decide every call.

A client that has a key needs a control plane address: `baseUrl` (`base_url`), else `INTUTIC_CONTROL_PLANE_URL`, else (for `fromEnv()`) the `controlPlaneUrl` a login stored in `~/.intutic/credentials.json`. This release has no default control plane, so a client with a key and no address throws on construction (`ValueError` in Python) rather than skip the hook gate without a word.

A client that has a key the control plane refuses (HTTP 401) is not local-only. That is an authentication fault, and it is decided by `failClosed` like any other hook gate answer that carries no verdict: blocked by default.

### Chaos runs

Under [`intutic chaos run`](/guide/chaos-engineering), which sets `INTUTIC_CHAOS_PLAN` and `INTUTIC_CHAOS_EVENTS` in the agent's environment, `guard()` takes part in the experiment exactly as the harness hook gates do, with the same plan decoding, the same counter files and the same events:

- Every call is reported to the run's events file (`plan_loaded` once per run, then `gate_decision` with the tier's verdict, the deciding rule, whether a destructive-command rule fires on the call and whether a rule hit; `tool_call` for a call that goes ahead or is held).
- A call every tier allowed can then be refused by the fault that is due. `tool.error` and `permission.deny_or_delay` in `deny` mode throw `IntuticGateRefusal` with `code` `CHAOS_FAULT` and the fault's message, which carries the run's canary. `delay` and `hold_then_deny` throw `IntuticGateHold` (`HELD`, no `holdId`) until the identical retry, the same tool and arguments compared as a hold compares them, comes after `delay_s`; that retry is let through or refused with `CHAOS_FAULT`. See [How a permission delay works](/guide/chaos-engineering#how-a-permission-delay-works).
- A fault never applies to a call a tier refused or held, and it never turns one into an allow.
- A plan that is set but unreadable, or set without an events file, refuses every call with `CHAOS_FAULT`.

Without the plan nothing changes, and `enforce: false` (`enforce=False`) skips the experiment along with every tier.

### Fail-closed defaults

- A `GateClient` that gets no verdict from the hook gate reports a block: the control plane cannot be reached, answers non-2xx or without a verdict, or answers `GOVERNANCE_UNAVAILABLE` because a check it runs (the SOP register, the hook-rule guardrails, the SSO group policy, the MCP server registry, image provenance, promoted findings) could not complete. `failClosed` (`fail_closed`) is `true` by default in both SDKs; pass `failClosed: false` (`fail_closed=False`) to treat that tier as advisory during an outage, and the call goes ahead. A workspace in shadow mode gets an allow from the hook gate itself, marked `degraded`.
- A request the hook gate cannot read (HTTP 400, `INVALID_REQUEST`) is a block whatever `failClosed` says: the request is wrong, not the control plane down. The response's `code` is `INVALID_REQUEST`, and the refusal's is `HOOK_GATE`.
- A key without the scope the hook gate needs (HTTP 403, `INSUFFICIENT_SCOPE`) is a block whatever `failClosed` says: the key is misconfigured, not the control plane down. The response's `code` and the refusal's are both `INSUFFICIENT_SCOPE`, and the reason names the missing scope (`gateway:use`).
- A deploy command with no readable image allowlist is refused rather than approved against an empty policy.
- A wrapped tool called with no gate installed and none passed throws (`RuntimeError` in Python) instead of running unguarded.
- `GateClient.fromEnv()` (`from_env()`) throws when no session id is set, because the proxy would record every run under the session `unknown`.
- A client with no API key skips the control-plane tiers rather than failing closed on them, since there is nothing to authenticate with (see [Without credentials](#without-credentials)). A key the control plane refuses still blocks.

## Configuration

`Gate` takes a config and an optional client. The options, with their defaults, are in the reference: [`GateConfig`](/reference/sdk/gate/core/#gateconfig) and [`GateClientOptions`](/reference/sdk/gate/core/#gateclientoptions) in TypeScript, [`GateConfig` and `GateClient`](/reference/sdk/python/intutic_clawde/gate/) in Python, which spells each option in snake_case (`repoRoot` is `repo_root`, `failClosed` is `fail_closed`) and takes the client's timeout in seconds (`timeout`) rather than milliseconds (`timeoutMs`). The Python client's `harness` defaults to `langgraph` rather than `generic`.

The image allowlist is JSON: `require_digest` (default `true`), `registries_allowed` (repository prefixes; empty allows any registry) and `images`, keyed by repository, each with its `approved_digests`.

`GateClient.fromEnv({ sessionId?, harness?, failClosed? })` (`GateClient.from_env(session_id=None, harness=..., fail_closed=True)`) reads `INTUTIC_CONTROL_PLANE_URL`, `INTUTIC_API_KEY`, `INTUTIC_WORKSPACE_ID` and `INTUTIC_SESSION_ID`, and falls back to the key, workspace and `controlPlaneUrl` a control-plane login stored in `~/.intutic/credentials.json`. With no key in either place, the client is local-only (see [Without credentials](#without-credentials)).

## Refusals

A refused call throws `IntuticGateRefusal`. Its message starts with `[Intutic Governance] BLOCKED:`; `reason`, `code` and `incidentId` (`incident_id`) carry the structured verdict. A hold throws the subclass `IntuticGateHold` instead, which adds `holdId` (`hold_id`) and starts its message with `[Intutic Governance] HELD:` (see [Holds](#holds)). A decide rule that could not decide throws the subclass `IntuticGateEscalation` (code `DECIDE_ESCALATED`), which adds `ruleId` (`rule_id`): a caller that can ask its user asks with `reason` and runs the call only on a yes, and one that cannot treats it as the refusal it also is. The dsh plugin turns it into dsh's own ask. A refusal also carries `scope` and `evidence` when it says where it applies, so a retry can stay out of it: `scope` holds any of `paths`, `tools`, `step`, `detector` and `rule`, and `evidence` is a list of `{kind, detail}`, each list at most 8 items and each string at most 256 characters. Both are unset in an OPAQUE workspace, whose reason is the generic sentence too. `code` is one of these, exported as `GATE_REFUSAL_CODES` and, in TypeScript, typed as `GateRefusalCode`. A refusal from the hook gate is `HOOK_GATE`, or the registry's own code when the hook gate's MCP server registry refused, or `INSUFFICIENT_SCOPE` when it refused the API key:

| Code | Meaning |
|---|---|
| `SSO_GROUP` | The workspace's SSO group policy does not clear this tool for the member, or the member's groups are unknown |
| `SNAPSHOT` | A block rule in the policy snapshot matched |
| `HELD` | A hold rule matched: the call is held for a person's approval, and `holdId` names the hold |
| `PREREQUISITE_UNMET` | A qualified `requires_before` (`action:run_tests[ok] -> …`) gates the call and is not met: no test run in the session, the last one failed, its result could not be read, files changed after it, or there is no session id ([Rule records](#rule-records)) |
| `OUT_OF_SCOPE` | The call writes, edits, deletes or moves a file outside `scope_paths` under `scope_paths_mode: enforce`, or outside the workspace |
| `OFF_PLAN` | `plan_approval: strict` is set and the tool is not a step of the session's approved plan |
| `PLAN_NOT_APPROVED` | `plan_approval:` is set and the session has no APPROVED or EXECUTING plan, the approved plans could not be read, or there is no session id |
| `SERVER_BLOCKED` | The MCP server is blocked in the MCP server registry |
| `SERVER_HELD` | The MCP server changed its tools in a way scored high risk and waits for an owner or admin to approve it again |
| `SERVER_NOT_APPROVED` | The workspace refuses MCP servers it has not approved (`mcpDefaultPolicy: deny`), and this one is not approved |
| `TOOL_DISABLED` | The tool is switched off on this MCP server in the registry |
| `SERVER_NOT_ALLOWED` | The MCP server is not on the workspace's `mcpAllowedServers` list |
| `POLICY_SNAPSHOT_UNVERIFIED` | The policy snapshot on this machine failed its integrity check, so it admits no MCP server; the sync daemon restores the last verified snapshot |
| `SOP_RULE` | A block rule in the SOP register matched |
| `HOOK_GATE` | The control plane's hook gate refused the call or could not read it (`INVALID_REQUEST`), or, while `failClosed` is on, could not be reached or could not complete a check (`GOVERNANCE_UNAVAILABLE`) |
| `INSUFFICIENT_SCOPE` | The API key lacks the scope the control plane's hook gate needs (`gateway:use`), so the hook gate refused the call whatever `failClosed` says; give the key `gateway:use`, or `*` (see [API key scopes](/reference/api#api-key-scopes)) |
| `COMMAND_TOO_LARGE` | The command is over 256 KiB, or the tool arguments over 1 MiB, the most a gate evaluates; split the work into smaller calls |
| `CHAOS_FAULT` | A chaos experiment (`intutic chaos run`) injected this failure into a call governance allowed, and the reason carries the run's `E-INTUTIC-` canary; or the experiment set a plan the gate cannot read. Not a governance decision ([Chaos runs](#chaos-runs)) |
| `E_UNPINNED_LATEST` | A deploy uses an image tagged `latest` |
| `E_UNPINNED_TAG` | A deploy uses an image by tag where the allowlist requires a digest |
| `E_UNKNOWN_REGISTRY` | A deploy uses an image from a registry the allowlist does not name |
| `E_UNKNOWN_IMAGE` | A deploy uses an image the allowlist does not name |
| `E_DIGEST_MISMATCH` | A deploy uses an image digest the allowlist does not approve |
| `E_MANIFEST_UNPARSEABLE` | The image allowlist, or a manifest the deploy names, is missing or unreadable |
| `DECIDE_REFUSED` | The rule asked its questions of the self-hosted decide engine and the answers made its `when` true |
| `DECIDE_ESCALATED` | The answers to a decide rule's questions fell between its bands or disagreed across option orders, and the harness cannot ask a person, so the call is refused until a person decides |
| `GOVERNANCE_UNAVAILABLE` | An enforcing decide rule could not be evaluated: its engine is not configured, is not self-hosted, did not answer in time, gave no usable probabilities or failed its known-answer canary, or more than four enforcing decide rules name the tool |
| `WORKFLOW_SANDBOX` | TypeScript only: the Workflow DevKit adapter was called inside the workflow sandbox, where the gate cannot run; run it in a step |
| `NO_GATE` | TypeScript only: the Workflow DevKit adapter has no gate to call, because none was passed and none was installed |

`COMMAND_TOO_LARGE` is checked before every tier: a `command` over 256 KiB, or arguments whose compact JSON is over 1 MiB (UTF-8 bytes; `COMMAND_SIZE_LIMIT` and `ARGUMENTS_SIZE_LIMIT`, exported by both packages), is refused without being evaluated. The limits sit far above real agent traffic and bound how long any rule can take; see [Hook timeouts](/reference/harness-security-matrix#hook-timeouts).

## Wrapping tools

`install(gate)` sets the process-wide gate that wrapped tools use, and `active()` reads it. In TypeScript, `wrapTool` gates one function or one `{ execute, ... }` tool object (copied rather than mutated), and `wrapTools` a collection, using a record's keys as tool names. In Python, `@guard` gates one function, and `guard_tools` a collection, duck-typing LangChain/LangGraph (`.func`, `._run`) and smolagents (`.forward`) tool objects and wrapping them in place.

After the tool runs, the wrapper reports how it went with `recordOutcome` (`record_outcome`), for [rule records](#rule-records): a throw is a failure, and a returned string, or an object's exit code (`exitCode`, `exit_code`, `returncode`) and output (`output`, `stdout`, `stderr`), is read for the outcome. What the tool returns is passed through unchanged.

The tool input the gate sees is the call's first argument when it is an object (TypeScript), or the call's arguments bound to their parameter names (Python), so `shell("rm -rf /")` and `shell(command="rm -rf /")` are evaluated identically. Wrapping an already-wrapped tool is a no-op.

## Other exports

The packages also export the pieces the gate is built from, for testing your own rules and for headers on a model client pointed at the Intutic proxy (`intuticHeaders`, `intutic_headers`): the command classifier, the image-integrity check, the snapshot and SOP-rule readers and the hold helpers. In Python, `intutic_clawde.gate` exports only the image check's `ImageVerdict`; its functions (`check_command`, `check_images`, `check_written_manifest`) are in `intutic_clawde.gate.imagecheck`. The snapshot's `evaluate()` returns the deciding match with `advisories`: every shadow or warn rule that matched before it, in rule order, for the caller to record as the rendered gates do. Each is listed, with its signature, in the [API reference](/reference/sdk/). `GATE_DEADLINE_MS` (TypeScript only, 9000) is how long the hook script `intuticSandboxBootstrap()` writes may evaluate, from process start, before it refuses with `GATE_DEADLINE`: one second under that hook entry's 10-second timeout (`HOOK_TIMEOUT_SECONDS`), so a slow rule is refused rather than left to the harness, which would run the call. See [Hook timeouts](/reference/harness-security-matrix#hook-timeouts).

### `decide()`

`decide(state, questions, opts)` (in Python, `intutic_clawde.decide(state, questions, when=...)`) asks the self-hosted decide engine a few narrow questions about any text, outside a gate, and returns each answer's probability and reading, with the outcome a rule would reach when `when` is given. It reads the same engine as Tier D, and its host guard refuses a hosted decision API before anything is sent; an engine that cannot answer throws `DecideEngineError`. See [In your own agent: `decide()`](/guide/decide#in-your-own-agent-decide).

## Related

- [clawde SDK](/reference/clawde-sdk) — the client for the proxy's chat route and the control plane
- [SDK API reference](/reference/sdk/) — every export of both SDKs, generated from their source
- [Harness Security Matrix](/reference/harness-security-matrix) — where each harness is gated
