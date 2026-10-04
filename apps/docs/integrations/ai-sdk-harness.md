# AI SDK Harness

Integrate Intutic governance with Vercel's [`@ai-sdk/harness`](https://ai-sdk.dev/) — the `HarnessAgent` runtime that runs full coding-agent harnesses (Claude Code via `@ai-sdk/harness-claude-code`, Grok Build via `@ai-sdk/harness-grok-build`, ...) inside Vercel Sandbox microVMs.

This harness is unlike every other framework in this catalog in one structural way: **the agent's tools execute server-side, in a sandbox — not on the machine where Intutic runs.** That changes what governance can honestly reach, so read the scope section below before assuming laptop-grade coverage.

## What Intutic can and cannot govern here

| Surface | Coverage | Mechanism |
|---|---|---|
| Custom host-executed tools | ✅ Per-call gate | The tool-approval flow: `intuticStaticApprovals()` + `intuticApprovalResponder()` (below) |
| Built-in `bash` | ✅ Removed from the tool set (default), or ✅ per-call gate | `recommendedHarnessSettings()`'s default `inactiveTools: ['bash']`; or `{ filterBash: false }` under `permissionMode: 'allow-edits'`, where every bash call pauses as a built-in approval request the same responder answers — see step 3 below |
| Built-in `write`/`edit` | ⚠️ Per-call only under `'allow-reads'` | `permissionMode: 'allow-reads'` makes them pause for approval like `bash`; under `'allow-edits'` (the recommendation) they run without pausing |
| Built-in read-kind tools (`read`/`glob`/`grep`/web fetch, ...) | ⚠️ Mode-level only | Never pause at any `permissionMode` — the mode is the entire control. **`permissionMode` defaults to `'allow-all'`**, under which no built-in pauses at all |
| Sandbox network egress | ⚠️ Coarse host-level | The sandbox's own `networkPolicy` (allow/deny hosts and CIDRs) — **not** Intutic DLP; sandbox traffic never crosses the local Intutic proxy |
| The wrapped runtime's own native Intutic gate | ⚠️ Tier A1 only, via bootstrap injection | `intuticSandboxBootstrap()` — see step 5 below, and the double-gating note for what this does not close |

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
  ...recommendedHarnessSettings(),              // permissionMode: 'allow-edits', inactiveTools: ['bash'] — see step 3
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

Some runtime adapters also implement the optional `session.submitToolApproval` method on their *adapter* session. `intuticSubmitApprovals(session, pendingApprovals)` uses it when present and otherwise returns continuations. Either way the verdicts are the same. The `HarnessAgentSession` you get from `agent.createSession()` does not expose that method, so through `HarnessAgent` the helper always returns `submitted: false`. Pass its `continuations` to `continueGenerate`/`continueStream`. For built-in approvals, the framework forwards your decision to the adapter itself.

The continuations work with every `@ai-sdk/harness` 1.x. Version 1.0.101 (2026-09-03) changed `toolApprovalContinuations` from `{ approvalResponse, toolCall }` objects to bare `tool-approval-response` parts, and each continuation `intuticApprovalResponder()` returns satisfies both shapes. Older `@intutic/gate` releases produced only the old shape. On 1.0.101 and later those were silently ignored, and the paused turn never resumed. `@intutic/gate` is built and tested against `@ai-sdk/harness` 1.0.138 with `ai` 7.0.127, where `HarnessAgentToolApprovalContinuation` is no longer exported and the framework's own collector returns the bare parts.

**Verified live (locally, 2026-10-03; re-run 2026-10-04 after the AI SDK upgrade).** A real Claude Code bridge in a Docker sandbox, driven by a scripted local model, went through the full pause → respond → resume cycle:
- A custom tool resumed in both directions. When allowed, it ran on the host. When denied, it never ran, and the model received an `execution-denied` result carrying the `BLOCKED` reason.
- Built-in `bash` did the same, as described in step 3.

### 3. Rein in the built-in sandbox tools

Built-in tools **ignore `toolApproval` entirely.** `permissionMode` decides which of them pause for approval, and the framework's default is `'allow-all'` — the shipped types call it "preserving the existing bypass-permissions behavior." A default-configured HarnessAgent runs built-in tools in the sandbox with no approval step Intutic (or anyone) can hook.

`recommendedHarnessSettings()` returns `permissionMode: 'allow-edits'` (or pass `{ permissionMode: 'allow-reads' }` for stricter). Under those modes some built-ins **do** pause per call: the `@ai-sdk/harness-claude-code` bridge adds approval (`ask`) rules for bash-kind tools under `'allow-edits'`, and for bash- and edit-kind tools under `'allow-reads'`, and emits a `tool-approval-request` for each such call. `HarnessAgent` turns it into a pending approval of `kind: 'builtin'` and pauses the turn, so the same `intuticApprovalResponder()` from step 2 answers it with a per-call `Gate.guard()` verdict, and `continueGenerate` delivers the decision to the runtime. What still has no per-call surface: read-kind built-ins (`read`/`glob`/`grep`/web fetch, ...) never pause in any mode, and `write`/`edit` don't pause under `'allow-edits'`.

The tools a mode does **not** auto-allow are different on adapters that support built-in approvals. On Claude Code, that is `bash` under `allow-edits`, plus edits under `allow-reads`. Those calls pause with a `tool-approval-request`, just like custom tools, and `intuticApprovalResponder()` answers each one with a real `Gate.guard()` verdict. Built-in approvals were verified live, locally, on 2026-10-03:
- An allowed `bash` call ran inside the sandbox.
- A denied one never ran, and the model saw `[Intutic Governance] BLOCKED: …` as the tool error.

Not every adapter supports built-in approvals. `@ai-sdk/harness-codex` disables them, and `HarnessAgent`'s constructor rejects any `permissionMode` other than `'allow-all'` for it. That rejection is loud, not a silent bypass.

**`bash` specifically is stronger than that.** `recommendedHarnessSettings()` now also returns `inactiveTools: ['bash']` by default, which is spread onto `HarnessAgentSettings.inactiveTools` — confirmed against real shipped `dist/index.js` (not just `.d.ts`) to genuinely exclude `bash` from the tool set for both `@ai-sdk/harness-claude-code` (native `builtinToolFiltering` support) and `@ai-sdk/harness-grok-build` (via the framework's own fallback, which auto-denies every call to a filtered builtin before execution). Either way, `bash` is never callable — a stronger mitigation than an approval step, since the tool is removed rather than merely gated. If an adapter supports neither mechanism, `HarnessAgent`'s constructor throws rather than silently ignoring the setting, so this is never a silent no-op. Filtering is a coarse, all-or-nothing exclusion decided once at session-construction time. A workspace that genuinely needs `bash` gets the per-call alternative instead: pass `{ filterBash: false }` and keep `'allow-edits'` (or `'allow-reads'`). `bash` then stays available, and every call to it pauses for a gate verdict as described above (do not combine it with `'allow-all'`, under which nothing pauses).

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

A method that is present is not proof of enforcement. For example, the community Docker provider (`ai-sdk-sandbox-docker`) implements `setNetworkPolicy` as a no-op, and you must fix its network at container creation (`--network`) instead. Live enforcement has only been designed against Vercel Sandbox's primitive and has not yet been verified there.

With no `allowedHosts` given, the recommendation is `{ mode: 'deny-all' }` — deny by default until you decide what the sandbox legitimately needs to reach. **This is honest but coarse governance:** host-level allow/deny, no DLP, no per-request policy, no Intutic dashboard trail for sandbox egress. It is the egress story this execution model actually offers, not a proxy-grade substitute.

### 5. Inject a Tier A1 policy floor into the sandbox filesystem (`intuticSandboxBootstrap()`)

None of the surfaces above put anything resembling the laptop's native Intutic gate inside the sandbox itself. `HarnessAgentSettings.sandboxConfig.onBootstrap` is a real, typed, consumer-facing hook (`@ai-sdk/harness/agent`'s `HarnessAgentSandboxConfig`, confirmed against shipped `.d.ts`) that fires once per `bootstrapHash` identity, during sandbox template creation, before a snapshot-capable provider publishes its snapshot — exactly the right lifecycle for writing static governance files that then persist for every session built from that snapshot. Since `@ai-sdk/harness` 1.0.138 (not 1.0.75) the framework also records an `~/.ai-sdk-harness/.on-bootstrap/<sha256>.ok` marker after a successful run and re-runs `onBootstrap` on any session it acquires without that marker, so a sandbox that never went through template creation gets the files too. `intuticSandboxBootstrap()` uses this channel to write, directly into the sandbox filesystem:

- the compiled policy-snapshot `.rules` text you pass in, verbatim;
- a self-contained (zero-`require`) Node hook script that is a hand-port of this package's own Tier A1 evaluator (`snapshot.ts`'s `normalise`/`evaluate`) — same field order, same pattern-matching contract, fail-closed on any parse/read error; and
- a `.claude/settings.json` registering that script as a `PreToolUse` hook for `Bash`/`Edit`/`Write`/`MultiEdit`/`mcp__.*`, matching the laptop writer's own matcher set; and
- the same registration merged into the sandbox user's `$HOME/.claude/settings.json`. This one is what makes the hook fire. Unless you set `sandboxConfig.workDir`, `HarnessAgent` runs each session's Claude Code in its own `<workDir>/claude-code-<sessionId>` directory, and Claude Code does not read project settings from a parent directory. An existing user settings file is appended to, never overwritten, and a re-run replaces this bootstrap's own earlier entries rather than duplicating them. If `$HOME` cannot be resolved, or that file is unparseable, the bootstrap fails rather than leaving the sandbox ungated.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { intuticSandboxBootstrap, recommendedHarnessSettings } from '@intutic/gate/harness'

const agent = new HarnessAgent({
  harness,
  sandbox,
  ...recommendedHarnessSettings(),
  sandboxConfig: intuticSandboxBootstrap({
    policySnapshotRules: fs.readFileSync(snapshotPath(), 'utf-8'),
    workspaceId: process.env.INTUTIC_WORKSPACE_ID,
  }),
})
```

**Be precise about the tier this provides.** It is **Tier A1 only** — the destructive-command policy-snapshot floor, plus whatever SOP-authored rules were already compiled into the `.rules` text you supply. It deliberately does NOT reproduce the SOP tier (A3, control-plane-fetched), review-hold parking, or control-plane event draining — all three need a live control-plane connection a bootstrap function cannot have at construction time, and this page's own recommended `networkPolicy` denies sandbox egress by default anyway. That makes this a real but strict *subset* of a laptop gate, not an equivalent. It is also **Claude Code-only today**: `.claude/settings.json`'s hook shape is Claude Code's own contract; Grok Build's laptop equivalent uses a completely different mechanism (a `.grok/hooks/*.json` registry entry with a stdout-decision contract instead of an exit code) and has not been adapted for this channel.

## Double-gating note: wrapped runtimes that are themselves Intutic harnesses

`@ai-sdk/harness-claude-code` and `@ai-sdk/harness-grok-build` wrap **Claude Code** and **Grok Build** — both natively-gated Intutic harnesses on a developer machine (see [the coverage matrix](/reference/harness-security-matrix)). Unlike [Grok Build's own double-gating behaviour](/reference/harness-security-matrix#grok-build) — where a workspace's existing `.claude/settings.json`/`.cursor/hooks.json` gates fire *in addition to* the native one — here the situation was, until `intuticSandboxBootstrap()`, the **inverse**: the sync-daemon's hook files are written to your repo and home directory, and *neither exists inside the sandbox microVM* (worktree propagation reaches git worktrees on your machine, not filesystems inside a Vercel Sandbox). Step 5 above closes part of that gap for Claude Code, at Tier A1 only — everything below states precisely what is and is not confirmed about it.

**What has been live-verified, and what has not (TD-417).** The core bootstrap-channel mechanics were confirmed against a real Vercel Sandbox on 2026-08-20: a throwaway sandbox was created, `intuticSandboxBootstrap()`'s `onBootstrap` was called against its real `writeFiles()`, all three generated files were confirmed present *inside* the running sandbox via `ls`/`cat`, and the generated hook script — invoked directly with a synthetic PreToolUse-shaped payload on stdin — was confirmed to exit `2` and block on a matching rule, and exit `0` and allow on a non-matching one. That proves the channel is not a no-op and the hook genuinely enforces when invoked. **Open after that 2026-08-20 pass:** whether the `@ai-sdk/harness` bridge itself wires this hook into a real model-driven PreToolUse dispatch (as opposed to a manually-piped stdin payload) needs a live Anthropic API key this environment did not have; whether the written files survive an actual snapshot/resume cycle needs a deliberate stop→resume test on a `persistent: true` sandbox, which the verification pass specifically skipped to avoid leaving billable snapshot storage behind; and the Grok Build path needs a live xAI key and has not been attempted at all, mechanically or via bridge.

**Verified locally since then (2026-10-03, using a local Docker rig with no account or credential).** A real Claude Code bridge in a Docker sandbox ran against a scripted local model. The model's `Bash` call for a blocked canary command reached the bootstrap hook through the bridge's **own PreToolUse dispatch**. The hook's exit `2` stopped the call, the model received `is_error: true` with the `[Intutic Guardrail] BLOCKED` message, and the command never ran. The same block held again after a container stop/start plus `resumeSession`, and every bootstrap file was still present. A re-run on 2026-10-04 with the upgraded `@intutic/gate` gave the same results (`uat/evidence/live-verify/harness-docker-run-1.0.138.md`).

That run also found that, as originally shipped, the hook never fired in a default session: the settings file sat in the parent directory, which Claude Code does not read. The `$HOME/.claude/settings.json` registration above is the fix.

**Still Vercel-only or external:**
- whether bootstrap files survive a true snapshot publish/restore;
- live `setNetworkPolicy` enforcement;
- the Grok Build path (needs an xAI key; its hook format has not been adapted).

Until those three close, treat the approval flow + `permissionMode` + `inactiveTools` + network policy + this Tier A1 bootstrap as the entire *confirmed* enforcement surface for sandboxed runs — see TD-417 for the exact remaining steps.

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
| Tool gate | SDK-side (`@intutic/gate/harness`'s approval responder over the tool-approval flow) — custom host-executed tools, plus built-ins that `permissionMode` makes pause (`bash` under `'allow-edits'`; also `write`/`edit` under `'allow-reads'`); `bash` is excluded from the tool set by default (`inactiveTools`); read-kind built-ins are `permissionMode`-governed only |
| Egress governance | Sandbox `networkPolicy` (coarse host-level) — sandbox traffic never crosses the Intutic proxy |
| Sandbox filesystem gate | `intuticSandboxBootstrap()` — Tier A1 (policy-snapshot) only, injected via `sandboxConfig.onBootstrap`; Claude Code only today |
