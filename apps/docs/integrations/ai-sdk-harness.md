# AI SDK Harness

Integrate Intutic governance with Vercel's [`@ai-sdk/harness`](https://ai-sdk.dev/) — the `HarnessAgent` runtime that runs full coding-agent harnesses (Claude Code via `@ai-sdk/harness-claude-code`, Grok Build via `@ai-sdk/harness-grok-build`, ...) inside Vercel Sandbox microVMs.

This harness is unlike every other framework in this catalog in one structural way: **the agent's tools execute server-side, in a sandbox — not on the machine where Intutic runs.** That changes what governance can honestly reach, so read the scope section below before assuming laptop-grade coverage.

## What Intutic can and cannot govern here

| Surface | Coverage | Mechanism |
|---|---|---|
| Custom host-executed tools | ✅ Per-call gate | The tool-approval flow: `intuticStaticApprovals()` + `intuticApprovalResponder()` (below) |
| Built-in sandbox tools (`read`/`write`/`edit`/`bash`/`glob`/`grep`, ...) | ⚠️ Mode-level only | `permissionMode` — **defaults to `'allow-all'`**; there is NO per-call approval surface for built-ins at any mode |
| Sandbox network egress | ⚠️ Coarse host-level | The sandbox's own `networkPolicy` (allow/deny hosts and CIDRs) — **not** Intutic DLP; sandbox traffic never crosses the local Intutic proxy |
| The wrapped runtime's own native Intutic gate | ❌ Absent in the sandbox | Hook files the sync-daemon writes on your machine do not exist inside a microVM — see the double-gating note below |

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • ai-sdk-harness → .env.intutic
```

Detection triggers on any of: `@ai-sdk/harness` itself, any `@ai-sdk/harness-*` runtime adapter, or any `@ai-sdk/sandbox-*` provider in `package.json`.

### 2. Gate custom tools via the approval flow

The `HarnessAgentSettings.toolApproval` option is a **static** per-tool record — its own doc comment says "without callback support" — so a per-call gate function cannot be plugged in directly the way [`@intutic/gate/vercel`'s `intuticToolApproval()`](/integrations/vercel-ai-sdk) does for `generateText`. Instead, the gate rides the framework's approval **flow**: every custom tool is marked `'user-approval'` (each call pauses), and each pause is answered with a real per-call `Gate.guard()` verdict:

```bash
npm install @intutic/gate
```

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { Gate, install } from '@intutic/gate'
import {
  intuticApprovalResponder,
  intuticStaticApprovals,
  recommendedHarnessSettings,
} from '@intutic/gate/harness'

install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))

const agent = new HarnessAgent({
  harness,                                      // e.g. claudeCode(...)
  sandbox,
  tools,
  ...recommendedHarnessSettings(),              // permissionMode: 'allow-edits' — see step 3
  toolApproval: intuticStaticApprovals(tools),  // every custom tool -> 'user-approval'
})

const respond = intuticApprovalResponder()

// Run a turn. When it pauses awaiting approval, collect the pending
// tool-approval requests (the turn's `tool-approval-request` parts, or the
// suspended session's pending-approval rows) and answer them:
const toolApprovalContinuations = await respond(pendingApprovals)
const result = await agent.continueGenerate({ session, toolApprovalContinuations })
```

On allow, each continuation approves the call. On deny, it carries `approved: false` with the `[Intutic Governance] BLOCKED: ...` reason — the runtime submits an `execution-denied` result to the model and the tool never runs. A gate crash fails **closed** (deny with the crash named), never open.

Some runtime adapters also implement the optional `session.submitToolApproval` method (confirmed: `@ai-sdk/harness-claude-code@1.0.78` does, `@ai-sdk/harness-grok-build@1.0.12` does not). `intuticSubmitApprovals(session, pendingApprovals)` uses it when present and falls back to returning continuations when not — same verdicts either way.

### 3. Rein in the built-in sandbox tools

Built-in tools **ignore `toolApproval` entirely.** Their only control is `permissionMode`, and the framework's default is `'allow-all'` — the shipped types call it "preserving the existing bypass-permissions behavior." A default-configured HarnessAgent runs `bash` in the sandbox with no approval step Intutic (or anyone) can hook.

`recommendedHarnessSettings()` returns `permissionMode: 'allow-edits'` (or pass `{ permissionMode: 'allow-reads' }` for stricter). Be clear about what this is: a **mode**, not a per-call gate. There is no per-call veto surface for built-ins at any setting; the mode is the entire control.

### 4. Constrain sandbox egress with a network policy

Sandbox traffic never touches the Intutic proxy on your machine — the microVM has its own network path. The egress control that actually exists at this layer is the sandbox's network policy:

```ts
const { networkPolicy } = recommendedHarnessSettings({
  allowedHosts: ['registry.npmjs.org', 'api.anthropic.com'],
})
// => { mode: 'custom', allowedHosts: [...], deniedCIDRs: ['169.254.169.254/32'] }

// Apply it to the sandbox session (the method is OPTIONAL — providers
// without an enforcement primitive omit it; treat undefined as "no egress
// policy is in force", not as silently ok):
await sandboxSession.setNetworkPolicy?.(networkPolicy)
```

With no `allowedHosts` given, the recommendation is `{ mode: 'deny-all' }` — deny by default until you decide what the sandbox legitimately needs to reach. **This is honest but coarse governance:** host-level allow/deny, no DLP, no per-request policy, no Intutic dashboard trail for sandbox egress. It is the egress story this execution model actually offers, not a proxy-grade substitute.

## Double-gating note: wrapped runtimes that are themselves Intutic harnesses

`@ai-sdk/harness-claude-code` and `@ai-sdk/harness-grok-build` wrap **Claude Code** and **Grok Build** — both natively-gated Intutic harnesses on a developer machine (see [the coverage matrix](/reference/harness-security-matrix)). Unlike [Grok Build's own double-gating behaviour](/reference/harness-security-matrix#grok-build) — where a workspace's existing `.claude/settings.json`/`.cursor/hooks.json` gates fire *in addition to* the native one — here the situation is the **inverse**: the sync-daemon's hook files are written to your repo and home directory, and *neither exists inside the sandbox microVM* (worktree propagation reaches git worktrees on your machine, not filesystems inside a Vercel Sandbox). The native gate those harnesses would have on a laptop is simply absent in the sandbox.

Two passthrough channels exist that *could* carry configuration into the wrapped runtime, confirmed in the adapters' shipped types: `harness-claude-code` accepts `env` (merged over the bridge process environment) and `mcpServers` (native format); `harness-grok-build` accepts `mcpServers` only — it has no `env` setting. Whether hook-file installation can actually be effected through those channels (e.g. env-var-pointed settings, an MCP-mediated gate) was **not verified against a live sandbox** — no Vercel Sandbox deployment was available to this integration's research. Until someone does that verification, treat the approval flow + `permissionMode` + network policy above as the *entire* enforcement surface for sandboxed runs, and see TD-417 for the tracked follow-up.

## What gets written

Same `.env.intutic` shape as every SDK-gated framework, with the preamble corrected for this execution model: the proxy base-URL vars govern LLM egress **from your own process only** — they do not and cannot route sandbox traffic.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `ai-sdk-harness` |
| Config file | `.env.intutic` |
| Detection | `@ai-sdk/harness`, any `@ai-sdk/harness-*`, or any `@ai-sdk/sandbox-*` in `package.json` (`dependencies`, `devDependencies`, or `peerDependencies`) |
| Format | Shell environment variables (inert for sandbox traffic — see above) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`@intutic/gate/harness`'s approval responder over the tool-approval flow) — custom host-executed tools only; built-ins are `permissionMode`-governed |
| Egress governance | Sandbox `networkPolicy` (coarse host-level) — sandbox traffic never crosses the Intutic proxy |
