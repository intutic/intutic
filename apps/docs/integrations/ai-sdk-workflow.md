# AI SDK Workflow

Integrate Intutic governance with Vercel's [`@ai-sdk/workflow`](https://ai-sdk.dev/) — the `WorkflowAgent` class for durable AI agents built on the Workflow DevKit (`workflow`).

Two facts about this runtime shape the whole integration; both were confirmed against real installs (`@ai-sdk/workflow@1.0.69`, `workflow@4.8.3`), not inferred from docs:

1. **The veto surface is per-tool `needsApproval` — the agent has no approval option.** `WorkflowAgent`/`WorkflowAgentOptions` carry zero approval fields; the agent loop evaluates each tool's own `needsApproval` (boolean or async function) before executing it, and a call that needs approval pauses **durably** — the run suspends, and a human can approve hours later.
2. **The durable runtime retries thrown errors.** A denial that throws a plain error is not a stop — it is a *retry schedule*. The runtime's retry/abort decision duck-types on `error.name === 'FatalError'` (`FatalError.is()`), so this adapter's refusals carry that name. Without it, a governance denial would be replayed toward max attempts, failing identically every time.

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

```ts
import { WorkflowAgent } from '@ai-sdk/workflow'
import { Gate, install } from '@intutic/gate'
import { withIntuticApproval } from '@intutic/gate/workflow'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const agent = new WorkflowAgent({
  model,
  tools: withIntuticApproval({
    deployService: { description: '...', inputSchema, execute: deployStep },
    queryStatus:  { description: '...', inputSchema, execute: queryStep },
  }),
})
```

`withIntuticApproval()` attaches an async `needsApproval` to every tool (the record key is the tool name the gate sees — the same identity the framework dispatches on). Per call:

- **BLOCK** → throws `IntuticWorkflowRefusal` — the run aborts with the `[Intutic Governance] BLOCKED: ...` message. It does not retry (see below), and it does not get handed to a human approver as though the gate had no verdict.
- **ALLOW** → resolves `false` by default (the gate evaluated the call; no human pause), or `true` with `{ onAllow: 'human' }` — the gate allows AND the framework's own durable human-approval pause still happens. This is the one framework in the catalog where "route allowed-but-sensitive calls to a human who can answer hours later" is natively expressible, so the option exists.
- A tool that already declared its own `needsApproval` keeps it: the gate composes with it (gate first; a prior "always ask a human" still asks).

For a single tool, `intuticNeedsApproval('toolName')` builds just the function — the tool name is a parameter because the framework's `needsApproval` signature does not carry it.

### Denials must abort, not retry — why refusals here are `FatalError`-shaped

Durable workflows retry failed steps by design. The runtime decides retry-vs-abort with `FatalError.is(err)`, which checks `err.name === 'FatalError'` — a duck-type, because workflow code executes in a separate `vm` realm where `instanceof` fails across the boundary. A plain `IntuticGateRefusal` thrown from `needsApproval` or a tool body would therefore be **retried**: the same governance denial, re-evaluated on a timer, burning the step's attempt budget to arrive at the same refusal.

`IntuticWorkflowRefusal` is an `IntuticGateRefusal` subclass with `name = 'FatalError'` (and `fatal: true`): the message prefix, `.reason`, `.code`, and `.incidentId` are all intact, and the real runtime's duck-check aborts the run on it. This is pinned by test against the actual `FatalError.is` exported by the `workflow` package, not a re-implementation.

The asymmetry is deliberate: a **non-refusal** crash inside the gate (a transient network failure in a remote tier) is re-thrown untouched — retryable, which is exactly what a durable runtime should do with a transient failure. Only real verdicts (and the deterministic "no gate configured" error, which would fail identically on every retry) are fatal.

### Execute-level wrapping (defense in depth)

`wrapWorkflowTools(tools)` is the [`wrapTools`](/integrations/langgraph) equivalent for workflow tool definitions: it gates each tool's `execute` directly, with the thrown refusal converted to the fatal shape (a workflow tool's `execute` is a durable step — the same retry trap applies). Prefer `withIntuticApproval()` as the primary integration — it refuses *before* the durable step starts and keeps the human-approval lane available; running both double-guards harmlessly but emits duplicate gate telemetry.

## What gets written

Same `.env.intutic` shape as every other SDK-gated framework — proxy URLs plus a pointer at `@intutic/gate/workflow`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). Two additions specific to this runtime:

- **No live durable run was exercised.** This integration was verified against the shipped types and the real `FatalError.is`/`collect` machinery, but exercising an end-to-end suspend/approve/resume cycle needs a Workflow DevKit deployment (workflow-server or Vercel), which was not available — see `docs/TECH_DEBT.md` TD-418.
- **The integration point is watched for drift.** `ai@7.0.68` marks tool-level `needsApproval` as deprecated in favour of `generateText`-level `toolApproval` — but `@ai-sdk/workflow`'s own agent loop reads the tool-level field and exposes no other veto surface, so it is the correct (and only) integration point today. If a future `@ai-sdk/workflow` release moves to the `toolApproval`-shaped surface, this adapter must move with it — see TD-419.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `ai-sdk-workflow` |
| Config file | `.env.intutic` |
| Detection | `@ai-sdk/workflow` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`); the unscoped `workflow` package alone is not a trigger |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/workflow`'s `intuticNeedsApproval()`/`withIntuticApproval()` on each tool's `needsApproval`) — no sync-daemon hook file |
| Denial semantics | `IntuticWorkflowRefusal` (`name: 'FatalError'`) — aborts the durable run instead of retry-looping |
