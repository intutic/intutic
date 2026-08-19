# @intutic/gate

Pre-execution tool gate for JS/TS agent frameworks without a shipped Intutic
harness. Port of the Python SDK's gate subpackage
(`packages/intutic-clawde/intutic_clawde/gate/`) — see that package for the
canonical description of the enforcement contract this one mirrors.

This package is the **core** library plus framework-specific adapters built
on top of it: `@intutic/gate/dsh` (a Cordis plugin for DeepSeek's "dsh"
harness), `@intutic/gate/mastra` (`intuticHooks()` on Mastra's
`beforeToolCall`), `@intutic/gate/vercel` (`intuticToolApproval()` on the
`ai` package's `toolApproval`), `@intutic/gate/openai` (the OpenAI Agents SDK
for TypeScript — see below), `@intutic/gate/eve` (`intuticApproval()` on
eve's per-tool/per-connection `approval` policy surface — Vercel's
filesystem-first durable-agent framework, a pre-1.0 **Preview** product),
`@intutic/gate/harness` (Vercel's `@ai-sdk/harness` sandboxed coding-agent
runtime), `@intutic/gate/workflow` (Vercel's `@ai-sdk/workflow` durable
workflow agents), and `@intutic/gate/managed-agents` (Anthropic's Managed
Agents — a session-confirmation responder, not a hook, since Anthropic hosts
the tool-call loop; see below). LangChain.js has no dedicated adapter planned
and instead uses the generic `wrapTool`/`wrapTools` helper directly.

## Quick start

```ts
import { Gate, GateClient, install, wrapTools } from '@intutic/gate'

const gate = new Gate(
  { workspaceId: process.env.INTUTIC_WORKSPACE_ID },
  GateClient.fromEnv({ harness: 'my-framework' }),
)
install(gate) // process-wide default; wrapTool()/wrapTools() pick it up

const guardedTools = wrapTools(myTools) // array or {name: tool} record
```

On a refused call, the wrapped tool throws `IntuticGateRefusal` (message
prefixed `[Intutic Governance] BLOCKED:`) BEFORE the real implementation
runs — this package's throw-based refusal contract, the same one
`services/sync-daemon/src/harness/gateBody.ts`'s emitted gates and
`packages/mcp-proxy/src/policy.ts` use elsewhere in this repo's gate
vocabulary.

## Public API surface

| Export | From | What it is |
|---|---|---|
| `Gate`, `GateConfig` | `gate.ts` | The four-tier evaluator. `new Gate(cfg, client?)`, `await gate.guard(toolName, toolInput)`. |
| `install(gate)`, `active()` | `gate.ts` | Process-wide default gate, so wrapped tools don't need the instance threaded through every call site. |
| `IntuticGateRefusal`, `GateError`, `GateConnectionError` | `errors.ts` | Thrown on refusal. `.reason`, `.code`, `.incidentId` carry the structured verdict; `.message` carries the `[Intutic Governance] BLOCKED: ...` text. |
| `GateClient` | `client.ts` | Control-plane client (`hookGate`, `emit`, `GateClient.fromEnv(...)`). |
| `wrapTool(fn \| tool, opts?)`, `wrapTools(list \| record, gate?)` | `wrapTools.ts` | Generic wrapping for a plain async function or an `{ execute, ... }`-shaped tool object. **This is the integration point for any JS framework without a dedicated adapter — LangChain.js included.** |
| `intuticHeaders(opts?)` | `headers.ts` | Headers for a proxy-pointed HTTP/OpenAI-compatible client (`x-session-id`, `x-workspace-id`, `x-intutic-harness`). |
| `loadSnapshot`, `evaluate`, `Snapshot`, `guardDisabledFromEnv` | `snapshot.ts` | Tier A1: reads `~/.intutic/hooks/policy-snapshot.rules`. |
| `parseRules`, `firstMatch`, `fetchRules`, `SopRule` | `soprules.ts` | Tier A3: SOP-authored `WHERE`-clause rules. |
| `checkCommand`, `checkImages`, `checkWrittenManifest`, `ImageVerdict` | `imagecheck.ts` | Tier A2: container-image provenance on deploy commands. |
| `classify`, `isDeploy`, `isTest`, `touchesInfra` | `actions.ts` | Command classifier shared by A2's deploy trigger. |

### A note for sibling adapter phases

`Gate.guard()` is **async** (`Promise<void>`), unlike the Python SDK's
synchronous `Gate.guard()` — the network-backed tiers (SOP-rule fetch,
`POST /hook-gate`) use `fetch` here rather than Python's blocking
`urllib.request`. Every adapter built on this package must `await` it.

### What Tier A1 does and does not cover

Like the Python SDK it ports, this package's snapshot reader (Tier A1) reads
**only** `~/.intutic/hooks/policy-snapshot.rules`. It does **not** separately
compile in the "static floor" patterns
(`services/sync-daemon/src/harness/protectedPaths.ts`'s
`staticFloorPatterns()` — the bypass/secret-content/skill-surface pattern
tables) the way the shipped shell/JS gate emitters do (`INTUTIC_FLOOR`,
concatenated ahead of the snapshot's own rules in `gateBody.ts`'s
`intuticGate()`). Only what actually flows through the `.rules` file —
SOP-authored rules, the destructive-command tier, and the tier-promoted
skill-surface rules — is enforced by Tier A1 here. This gap already exists in
`intutic_clawde`; it is preserved, not introduced, by this port. See
`src/__tests__/fidelity.test.ts` for exactly which parts of the shipped
contract Tier A1 DOES reproduce, verified against the real pattern tables.

## `@intutic/gate/openai` — OpenAI Agents SDK (TypeScript)

The adapter for `@openai/agents` (the TypeScript twin of the Python SDK's
`intutic_clawde.gate.adapters.openai_agents`). The SDK's documented per-tool
veto point is a **tool input guardrail** (`@openai/agents-core` >= 0.3.8):
the runner executes guardrails before the tool body, and a
`rejectContent` result skips the tool and hands the message to the model.

```ts
import { Agent, run } from '@openai/agents'
import { installOpenAiGate, wrapAgent } from '@intutic/gate/openai'

installOpenAiGate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID })

const agent = wrapAgent(new Agent({ name: 'ops', tools, mcpServers }))
const result = await run(agent, prompt)
```

* `intuticToolGuardrail()` — the raw guardrail, attachable via
  `tool({ inputGuardrails: [...] })`. Refusal → `rejectContent` with the
  `[Intutic Governance] BLOCKED: ...` message; unexpected gate crash →
  `rejectContent` too (fail closed).
* `wrapTools(tools)` / `wrapAgent(agent)` — inject the guardrail into every
  `FunctionTool`, **including `mcpServers`-derived tools** (`wrapAgent`
  patches `getAllTools`, the only place those ever appear — mapping over
  `agent.tools` misses them); rewrite `hostedMcpTool` entries to
  `require_approval: 'always'` plus an Intutic `on_approval`; install a
  composed gate-driven `onApproval` on local `shellTool`/`applyPatchTool`;
  and gate `computerTool` through its `needsApproval` predicate (refusal →
  pending interruption your code must reject — the SDK has no auto-reject
  hook for computer actions).
* `installOpenAiGate()` — builds + `install()`s a `Gate` and, by default,
  sets `OPENAI_AGENTS_DISABLE_TRACING=1`: the SDK's tracing exporter posts
  tool inputs/outputs to a **hardcoded** `api.openai.com/v1/traces/ingest`
  that ignores `OPENAI_BASE_URL` (a DLP leak around the proxy). Pass
  `{ tracingExport: 'keep' }` only once the exporter endpoint is re-pointed.
* Truly hosted tools (`webSearchTool`, `fileSearchTool`,
  `codeInterpreterTool`, image generation, hosted-environment `shellTool`)
  execute server-side at OpenAI — **no client-side hook exists**; they pass
  through unwrapped, stated plainly rather than pretended otherwise.

LLM egress: the underlying `openai` client honours `OPENAI_BASE_URL`, so a
sourced `.env.intutic` routes chat traffic through the Intutic proxy with
zero code. See `apps/docs/integrations/openai-agents.md` for the full
operator-facing version (guardrail-vs-approval ordering, realtime coverage,
minimum versions).

## `@intutic/gate/harness` — Vercel `@ai-sdk/harness` (sandboxed coding agents)

`HarnessAgent` runs coding-agent runtimes (Claude Code, Grok Build, ...)
**server-side, in Vercel Sandbox microVMs** — a materially different execution
model from every other adapter in this package, and its veto surface differs
to match. Confirmed against `@ai-sdk/harness@1.0.75` (a devDependency,
type-checked and exercised in `src/__tests__/harness.test.ts`):

- The `toolApproval` setting is a **static** `Readonly<Record<string,
  ToolApprovalStatus>>` — "without callback support" (the shipped doc's own
  words). Per-call gating therefore routes through the tool-approval **flow**:
  `intuticStaticApprovals(tools)` marks every custom tool `'user-approval'`
  (pausing each call), and `intuticApprovalResponder()` answers each pause
  with a real `Gate.guard()` verdict, producing the
  `toolApprovalContinuations` array for `continueGenerate`/`continueStream`.
  `intuticSubmitApprovals(session, ...)` uses the optional
  `session.submitToolApproval` instead when the adapter implements it
  (harness-claude-code does; harness-grok-build does not).
- **Built-in sandbox tools (read/write/edit/bash/...) never consult
  `toolApproval`.** They are governed only by `permissionMode`, which
  **defaults to `'allow-all'`**. `recommendedHarnessSettings()` returns the
  posture this integration recommends instead (`'allow-edits'`, plus a
  sandbox `networkPolicy` — deny-all, or a host allow-list) — because the
  laptop Intutic proxy never sees sandbox egress, host-level network policy
  is the only egress control available there, and it is coarse (no DLP).

## `@intutic/gate/workflow` — Vercel `@ai-sdk/workflow` (durable workflow agents)

`WorkflowAgent` has **zero approval fields** (confirmed against
`@ai-sdk/workflow@1.0.69`); its veto surface is per-tool `needsApproval`,
which pauses a call **durably** (a human can approve hours later).
`intuticNeedsApproval(toolName)` builds that function from `Gate.guard()`;
`withIntuticApproval(tools)` attaches it to a whole record, composing with any
`needsApproval` a tool already declares.

The durable runtime **retries** thrown errors — and its retry/abort decision
duck-types on `error.name === 'FatalError'` (`FatalError.is()`, confirmed
against `workflow@4.8.3`'s real machinery, because workflows run in a separate
`vm` realm where `instanceof` fails). A plain `IntuticGateRefusal` thrown from
`needsApproval` would be retried toward max attempts — a governance denial
replayed on a timer. This adapter therefore throws `IntuticWorkflowRefusal`:
still an `IntuticGateRefusal` (message, `.reason`/`.code`/`.incidentId`
intact) but with `name = 'FatalError'`, so a denial **aborts** instead of
retry-looping. On allow it resolves `false` (no human pause) or `true` (with
`{ onAllow: 'human' }` — gate allows AND a human still approves).
`wrapWorkflowTools()` is the execute-level variant: `wrapTools` semantics with
the throw contract converted to the fatal shape.

## `@intutic/gate/managed-agents` — Anthropic Managed Agents (session responder)

Anthropic hosts the tool-call loop for a Managed Agents session — your process
never executes a call directly, so there is no hook to attach. Instead your
backend answers session events. `evaluated_permission: "ask"` on an
`agent.tool_use`/`agent.mcp_tool_use` event (e.g. a tool configured
`always_ask`) **pauses the session** until a `user.tool_confirmation` event
arrives — a real, documented pre-execution veto ("Denied tools do not run.").
`IntuticSessionConfirmer` answers those pauses with a `Gate.guard()` verdict,
via polling, a webhook (`session.requires_action`), or a live stream. A tool
configured `always_allow` never pauses and is therefore never seen by
Intutic at all — see TD-425.

`agent.custom_tool_use` (your own tools) has no pause concept — it is gated
at the point YOUR code executes it instead, via
`wrapManagedAgentsCustomTool`/`wrapManagedAgentsCustomTools` (the
`BetaRunnableTool.run()` shape, not `.execute` — the generic `wrapTools()`
does not apply here). See `apps/docs/integrations/anthropic-managed-agents.md`
for the full operator-facing version, including the self-hosted
`EnvironmentWorker` coverage story and the Python-side custom-tool decorator
ordering gotcha (TD-427).

## Subpath convention

Eight adapters exist today, one source file each: `@intutic/gate/dsh`
(`src/dsh.ts` — a Cordis plugin; see its module doc for the veto contract and
`services/sync-daemon/src/harness/dshHooks.ts` for profile registration),
`@intutic/gate/mastra` (`src/mastra.ts`), `@intutic/gate/vercel`
(`src/vercel.ts`), `@intutic/gate/openai` (`src/openai.ts` — see above),
`@intutic/gate/eve` (`src/eve.ts` — approval policies for eve's
per-tool/per-connection `approval` surface, plus the observe-only
`intuticAuditHooks()`; verified against a pinned `eve@0.39.1` install — a
pre-1.0 Preview product, see its module doc and TD-410), `@intutic/gate/harness`
(`src/harness.ts` — see above), `@intutic/gate/workflow` (`src/workflow.ts`
— see above), and `@intutic/gate/managed-agents` (`src/managedAgents.ts` — see
above). Later adapter phases follow the SAME convention (also
`services/sync-daemon`'s existing subpath convention — see that package's
`package.json`):

1. One source file per adapter: `src/vercel.ts`, `src/mastra.ts`,
   `src/dsh.ts`, `src/harness.ts`, `src/workflow.ts`, `src/managedAgents.ts`.
2. An `exports` entry per adapter in `package.json`:
   ```json
   "./vercel": { "import": "./dist/vercel.js", "types": "./dist/vercel.d.ts" }
   ```
3. A matching `typesVersions` entry so editors resolve types from source
   pre-build:
   ```json
   "typesVersions": { "*": { "vercel": ["src/vercel.ts"] } }
   ```
4. Each adapter file imports from `./gate.js`, `./errors.js`, etc. (this
   package's core, already built) rather than re-implementing any tier —
   the whole point of splitting core from adapters is that the four-tier
   evaluation logic lives in exactly one place.

No stub files are checked in for future adapters; the `exports` map above
documents the shape they should take rather than pre-committing to file
names a later phase might want to change.

## Fidelity suite

`src/__tests__/fidelity.test.ts` builds a synthetic `.rules` snapshot from a
point-in-time copy of the REAL pattern tables in
`services/sync-daemon/src/harness/protectedPaths.ts`
(`src/__tests__/fixtures/protectedPathsFixtures.ts` — see that file's header
for why it is a copy rather than a live cross-package import, and how to
re-sync it) and asserts `evaluate()` reproduces the same block/warn/shadow
verdict as each pattern's own `matches`/`notMatches` fixtures, for every
pattern whose `subject` a `.rules` file can actually carry (`command`,
`target`, `tool`, `any` — `content`-subject patterns, i.e.
`SECRET_CONTENT_PATTERNS`, are out of scope: they never reach the snapshot
channel in the first place, matching the Python SDK's own limitation).
