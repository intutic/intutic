# AI SDK Workflow

Integrate Intutic governance with Vercel's [`@ai-sdk/workflow`](https://ai-sdk.dev/) — the `WorkflowAgent` class for durable AI agents built on the Workflow DevKit (`workflow`).

Three facts about this runtime shape the whole integration. All three were confirmed against real installs (`@ai-sdk/workflow@1.0.69`, `workflow@4.8.3`) and observed in live runs on the Workflow DevKit's local world (`@workflow/world-local`), not inferred from docs:

1. **The veto surface is per-tool `needsApproval` — the agent has no approval option.** `WorkflowAgent`/`WorkflowAgentOptions` carry zero approval fields; the agent loop evaluates each tool's own `needsApproval` (boolean or async function) before executing it. A call that needs approval ends the run with a `tool-approval-request` on the run's stream and no tool result. The run does not stay suspended. To approve it, hours later or after a restart, you start a **new** run whose messages carry a `tool-approval-response`. The agent then re-evaluates `needsApproval` for the approved call before executing it.
2. **`needsApproval` runs in the workflow sandbox, not in Node.js.** The agent loop runs inside the `"use workflow"` function, so `needsApproval` executes in the workflow VM, which has no Node.js modules. The gate reads its policy snapshot from disk and cannot run there. It runs in a `"use step"` function you declare, and `withIntuticApproval(tools, { step })` makes each tool's `needsApproval` call that step, as shown below.
3. **Steps retry thrown errors.** A plain error thrown from a step is retried: 3 retries, so 4 attempts in all, before the step fails. The runtime decides retry-vs-abort with `FatalError.is()`, which checks `error.name === 'FatalError'`, so this adapter's refusals carry that name and run exactly once. A plain error thrown directly in workflow code is not retried; it fails the run immediately.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • ai-sdk-workflow → .env.intutic
```

Detection requires `@ai-sdk/workflow` in `package.json`. The unscoped `workflow` package alone is deliberately **not** a trigger: the bare name is too generic to treat as evidence, and the durable runtime without `@ai-sdk/workflow` has no `WorkflowAgent` for this gate to apply to.

### 2. Route LLM traffic through the proxy

`WorkflowAgent` takes an AI SDK model. The same limitation as the [Vercel AI SDK integration](/integrations/vercel-ai-sdk#known-plain-limitation-no-environment-variable-llm-routing) applies: provider construction is in-code, so use `withIntuticProxy()` from `@intutic/gate/vercel` at every provider construction site. (When workflows are deployed to run on Vercel's infrastructure rather than your machine, a proxy on your machine is not on the path at all — egress governance then depends on where the workflow actually executes.)

### 3. Gate local tool execution (SDK)

```bash
npm install @intutic/gate
```

Declare one `"use step"` function that evaluates the gate. Its body is `intuticApprovalStep()`:

```ts
// workflows/intutic-gate.ts
import { Gate } from '@intutic/gate'
import { intuticApprovalStep } from '@intutic/gate/workflow'

export async function intuticGate(toolName: string, input: unknown): Promise<boolean> {
  'use step'
  return intuticApprovalStep(toolName, input, {
    gate: new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }),
  })
}
```

Then pass it as `{ step }` when you attach the gate to the agent's tools:

```ts
// workflows/deploy-agent.ts
import { WorkflowAgent } from '@ai-sdk/workflow'
import { withIntuticApproval } from '@intutic/gate/workflow'
import type { ModelMessage } from 'ai'
import { getWritable } from 'workflow'
import { intuticGate } from './intutic-gate'

export async function deployAgent(messages: ModelMessage[]) {
  'use workflow'
  const agent = new WorkflowAgent({
    model,
    tools: withIntuticApproval(
      {
        deployService: { description: '...', inputSchema, execute: deployStep },
        queryStatus: { description: '...', inputSchema, execute: queryStep },
      },
      { step: intuticGate },
    ),
  })
  const result = await agent.stream({ messages, writable: getWritable() })
  return result.messages
}
```

The step has to be your own function: the `"use step"` directive only takes effect in a module the workflow bundler transforms, and step arguments are serialized, so the step builds its `Gate` itself rather than receiving one. With `{ step }`, the `needsApproval` that `withIntuticApproval()` attaches only calls the step and reads its answer, so nothing that needs Node.js runs in the workflow sandbox. `@intutic/gate/workflow` itself imports nothing that needs Node.js, so importing it into workflow code is safe.

Use the `@intutic/gate` root package only inside `"use step"` function bodies in any module a workflow imports. The workflow bundler also bundles those modules, with step bodies replaced. If the gate is used at module level, for example a `Gate` constructed or `install()` called at the top of a workflow file, it stays in the workflow bundle and fails with `ReferenceError: require is not defined`. With `workflow/nitro` that failure covered every workflow in the app, because they all share one workflow bundle.

For a single tool, `intuticNeedsApproval('deployService', { step: intuticGate })` builds just its `needsApproval` function. The tool name is a parameter because the framework's `needsApproval` signature does not carry it; `withIntuticApproval()` uses each record key. Without `{ step }`, both helpers evaluate the gate in-process. That still works wherever Node.js is available, such as a plain `ai` tool loop or inside a step. On a `WorkflowAgent` it fails the run with `[Intutic Governance] BLOCKED: intuticNeedsApproval() ran inside the workflow sandbox...`, which names this fix. Other workflows are unaffected.

Per call:

- **BLOCK**: the step throws `IntuticWorkflowRefusal` once, with no retry. `needsApproval` rethrows it, and the run fails. `run.returnValue` rejects with a `WorkflowRunFailedError` whose message contains the `[Intutic Governance] BLOCKED: ...` text. A blocked call is never handed to a human approver as though the gate had no verdict.
- **ALLOW**: resolves `false` by default, so the call runs without a human pause. With `withIntuticApproval(tools, { step: intuticGate, onAllow: 'human' })` it resolves `true`: the gate allows the call and the framework's human-approval pause still happens. The run ends with a `tool-approval-request`. The approval arrives as a `tool-approval-response` in the messages of a later run, which can start hours later or after a server restart. That later run calls `needsApproval` again before executing, so the gate is re-evaluated against the policy in force at approval time. If that policy now blocks the call, the agent turns the refusal into an error tool-result. The call never runs, and the run completes.
- A tool that already declares its own `needsApproval` keeps it. The gate runs first, and a prior "always ask a human" still asks.

### Denials must abort, not retry — why refusals here are `FatalError`-shaped

Steps are retried by design. In a local run, a plain error thrown from a step ran 4 times (3 retries, about a second apart) before the step failed. The runtime decides retry-vs-abort with `FatalError.is(err)`, which checks `err.name === 'FatalError'`. It checks the name, not `instanceof`, because workflow code runs in a separate `vm` realm where `instanceof` fails across the boundary. A plain `IntuticGateRefusal` thrown from the gate step would therefore be retried, re-evaluating the same denial 3 more times.

`IntuticWorkflowRefusal` is an `IntuticGateRefusal` subclass with `name = 'FatalError'` and `fatal: true`. Thrown from the gate step, it runs exactly once. Inside the workflow it arrives as a `FatalError` with the message intact, and `FatalError.is()` returns `true`. Only the name and message cross the step boundary: `.reason`, `.code` and `.incidentId` are lost, and `instanceof Error` is `false` in the workflow realm. Match on the `[Intutic Governance] BLOCKED:` message prefix, which is what `IntuticWorkflowRefusal.is()` checks.

The asymmetry is deliberate. A **non-refusal** crash inside the gate, such as a transient network failure in a remote tier, is re-thrown untouched. It is retried, which is what a durable runtime should do with a transient failure. Only real verdicts are fatal, plus the deterministic "no gate configured" error, which would fail the same way on every retry.

### Execute-level wrapping (defense in depth)

`wrapWorkflowTools(tools)` is the [`wrapTools`](/integrations/langgraph) equivalent for workflow tool definitions: it gates each tool's `execute` directly and converts a refusal to the fatal shape. Call it inside the tool's step. A refusal there runs once and the tool body never executes. The run does not fail, though: `WorkflowAgent` turns a failed tool step into an error tool-result and continues, and the model sees `{"fatal":true,"name":"FatalError"}` without the BLOCKED reason. Prefer the `needsApproval` gate as the primary integration. It refuses before the tool step starts and keeps the human-approval lane available. Running both guards each call twice and emits duplicate gate telemetry, but does no other harm.

## What gets written

Same `.env.intutic` shape as every other SDK-gated framework — proxy URLs plus a pointer at `@intutic/gate/workflow`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). Two additions specific to this runtime:

- **Verified live on the local world only.** Everything above was observed on the Workflow DevKit's local world (`nitro dev` with `workflow/nitro`, state in `.workflow-data`) with a scripted model and no account or keys. That covers the approval pause, a SIGKILL and restart followed by an approved resume, refusal versus plain-error retry counts, and the refusal's shape across the step boundary. Not exercised: a hosted world (Vercel Workflow or another production world) with its own queue and retry delivery, a real model provider, and an approval that arrives after hours of wall-clock time rather than after a restart. See `docs/TECH_DEBT.md` TD-418.
- **The integration point is watched for drift.** `ai@7.0.68` marks tool-level `needsApproval` as deprecated in favour of `generateText`-level `toolApproval` — but `@ai-sdk/workflow`'s own agent loop reads the tool-level field and exposes no other veto surface, so it is the correct (and only) integration point today. If a future `@ai-sdk/workflow` release moves to the `toolApproval`-shaped surface, this adapter must move with it — see TD-419.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `ai-sdk-workflow` |
| Config file | `.env.intutic` |
| Detection | `@ai-sdk/workflow` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`); the unscoped `workflow` package alone is not a trigger |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side: `@intutic/gate/workflow`'s `withIntuticApproval(tools, { step })` / `intuticNeedsApproval(toolName, { step })` on each tool's `needsApproval`, with the gate evaluated by `intuticApprovalStep()` in a `"use step"` function you declare. No sync-daemon hook file |
| Denial semantics | `IntuticWorkflowRefusal` (`name: 'FatalError'`) — aborts the durable run instead of retry-looping |
