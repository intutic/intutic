/**
 * dsh.ts — Cordis plugin adapter for DeepSeek's "dsh" harness.
 *
 * Published as the `@intutic/gate/dsh` subpath (see README.md's "Subpath
 * convention for later phases"). `services/sync-daemon/src/harness/dshHooks.ts`
 * merge-writes a row naming this module (`name: '@intutic/gate/dsh'`) into a
 * dsh profile's `cordis.patch.yml`; dsh's own Cordis loader resolves that name
 * with a plain dynamic `import()` and mounts the exported plugin
 * (`{ name, inject, apply }`) the same way it mounts every other bundle row.
 *
 * ## The veto mechanism — CONFIRMED against a real install, not assumed
 *
 * dsh is a developer preview (`@deepseek-ai/dsh`, first published 2026-08-13)
 * built on DeepSeek's own "Cordis" plugin framework (`@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-app-boot`, ...). Both are public
 * on the npm registry, and this module was authored against a real
 * `npm pack`/inspection of them (see the TD entry this phase filed for exactly
 * what was checked and what still had to be assumed) — NOT solely from the
 * phase brief's prior guess, which named a different event (`agent/pre-step`)
 * and a different decision shape (`{kind:'reject',...}`). Both turned out to
 * be close but not exact:
 *
 *   - The real per-tool veto point is `tools/pre-execute` (declared by
 *     `@deepseek-ai/dsh-tools`), not `agent/pre-step` (`@deepseek-ai/dsh-agent`'s
 *     per-turn/step event — a coarser boundary that batches a driver step
 *     rather than one tool call, and the wrong extension point for a
 *     per-tool-call gate).
 *   - It is a genuine Cordis `waterfall`: `(exec: ToolExecution, next: () =>
 *     Promise<PreToolDecision>) => Promise<PreToolDecision>`. Cordis's own
 *     waterfall contract (confirmed by reading `@deepseek-ai/cordis`'s
 *     `events.d.ts`) composes listeners around a `next()` continuation —
 *     "a listener that does not call next() vetoes the rest of the chain,
 *     including the built-in behavior" — so this listener calls `next()` on
 *     ALLOW (to preserve whatever later listener or built-in behaviour — e.g.
 *     dsh's own `ask`/approval flow — would otherwise run) and returns its own
 *     `{kind:'deny',...}` WITHOUT calling `next()` to veto.
 *   - The decision shape is `PreToolDecision = {kind:'allow'} | {kind:'deny',
 *     reason} | {kind:'ask', reason?}` (confirmed from
 *     `@deepseek-ai/dsh-tools`'s shipped `.d.ts`) — `'deny'`, not the phase
 *     brief's guessed `'reject'`.
 *
 * `ctx.tools.guard()` (a separate, monotonic, explicitly SYNCHRONOUS
 * mechanism dsh also exposes) was considered and rejected: `@intutic/gate`'s
 * `Gate.guard()` is async (network-backed SOP-rule fetch and `/hook-gate`
 * POST — see gate.ts's module doc), and a synchronous `ToolGuard` cannot
 * `await` it. `tools/pre-execute` is the only one of dsh's two extension
 * points this package's async contract fits.
 *
 * ## What this module does NOT import
 *
 * Deliberately no dependency on `@deepseek-ai/cordis` or `@deepseek-ai/dsh-tools`
 * at runtime — `CordisLikeContext`/`DshToolExecution`/`DshPreToolDecision`
 * below are narrow structural types capturing only the shape this plugin
 * actually touches, matching Cordis's own duck-typed plugin contract (a
 * plain `{ name?, inject?, apply(ctx, config) }` object — confirmed against
 * both `@deepseek-ai/cordis`'s README quick-start and dsh's own in-product
 * "cordis-plugin-development" skill doc, which returns `{ apply(ctx) {...} }`
 * with no import of anything). Adding a hard dependency on a fast-moving
 * preview product's framework package to `@intutic/gate`'s dsh subpath would
 * make every OTHER subpath's install pull it in too (or need a peerDependency
 * carve-out) for a shape simple enough to describe locally. The real
 * `@deepseek-ai/cordis` package is used only as a devDependency, in this
 * module's own test file, to exercise the real waterfall dispatch mechanics
 * against the genuine `Context` class rather than a hand-rolled stand-in.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { Gate, install } from './gate.js'
import type { GateConfig, ToolInput } from './gate.js'
import { GateClient } from './client.js'
import { IntuticGateRefusal } from './errors.js'

/** The Cordis Plugin id this module registers as. Shown in dsh's own plugin
 *  diagnostics/`--dump-config` output. */
export const PLUGIN_NAME = 'intutic-governance'

/**
 * The slice of dsh's real `tools/pre-execute` payload (`ToolExecution`, from
 * `@deepseek-ai/dsh-tools`) this plugin reads. `arguments` is documented as
 * "losslessly JSON-serializable parsed arguments (tools validate their own
 * schema)" — an `unknown`, not necessarily an object, hence
 * {@link renderDshToolInput} below.
 */
export interface DshToolExecution {
  readonly name: string
  readonly arguments: unknown
}

/** The confirmed real `PreToolDecision` union from `@deepseek-ai/dsh-tools`. */
export type DshPreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

/**
 * Structural stand-in for the Cordis `Context` this plugin needs — see the
 * module doc for why the real `@deepseek-ai/cordis` package is not imported.
 */
export interface CordisLikeContext {
  on(
    event: 'tools/pre-execute',
    listener: (exec: DshToolExecution, next: () => Promise<DshPreToolDecision>) => Promise<DshPreToolDecision>,
  ): () => boolean
}

/** `cordis.patch.yml` row config for this plugin. Extends the core
 *  {@link GateConfig} with the one dsh-specific knob: an explicit session id,
 *  since dsh has no single "the session" this plugin can read off `exec` (a
 *  `ToolExecution` carries an `agent?`, not a raw session/conversation id) —
 *  see {@link resolveSessionId}. */
export interface DshGateConfig extends GateConfig {
  /** Overrides the generated-per-process session id. Mirrors
   *  `INTUTIC_SESSION_ID` for callers that already have one to hand. */
  sessionId?: string
}

/** Cordis Plugins declare their hard dependencies here; the loader defers
 *  activation until every named service exists and reactivates on restart.
 *  `tools` is `@deepseek-ai/dsh-tools`'s `ToolRegistry` service — the thing
 *  that actually dispatches `tools/pre-execute`. */
export const inject = ['tools']

/**
 * Render a `tools/pre-execute` call's `arguments` as the `tool_input` object
 * {@link Gate.guard} evaluates.
 *
 * Mirrors `wrapTools.ts`'s `renderToolInput` (not exported from there, so
 * reimplemented rather than reached into a sibling module's internals): a
 * plain object passes through as-is; anything else (a scalar, an array, or
 * — per dsh's own doc — a value that failed to serialize) falls back to
 * `{ args: [...] }` so the gate still has something to evaluate.
 */
function renderDshToolInput(args: unknown): ToolInput {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as ToolInput
  }
  return { args: [args] }
}

/**
 * One session id per dsh PROCESS, not per dsh conversation.
 *
 * `GateClient.fromEnv` throws without a session id (see client.ts — an unset
 * `x-session-id` collapses every run onto one dashboard row at the proxy, so
 * the client refuses to construct with none at all). dsh has no single
 * "current session" this plugin can read at plugin-mount time — sessions are
 * created and disposed while the process runs (`agent/session-start` et al.,
 * per `@deepseek-ai/dsh-goal`'s shipped types) — so rather than leave Tier B
 * (the control-plane `/hook-gate` call) and Tier A3 (SOP-rule fetch)
 * permanently inactive for the whole process when `INTUTIC_SESSION_ID` is
 * unset, this generates one random id at plugin-mount time and reuses it for
 * every session the process handles for its lifetime. Coarser attribution
 * than per-conversation, but strictly better than "those two tiers never run
 * under dsh at all" — and Tier A1 (the local policy snapshot, the
 * load-bearing tier) is unaffected either way; it needs no session id.
 */
function resolveSessionId(config: DshGateConfig): string {
  return config.sessionId || process.env.INTUTIC_SESSION_ID || randomUUID()
}

/**
 * Build the `tools/pre-execute` listener for a given {@link Gate}.
 *
 * Factored out of {@link apply} so a test can exercise the exact listener
 * `apply()` registers — event extraction, the refusal-to-decision mapping,
 * the fail-closed default, and the waterfall `next()`-calling on allow —
 * against a controllable fake `Gate`, without needing a real dsh install or
 * network access to construct a `GateClient`.
 *
 * Never throws: every path returns a {@link DshPreToolDecision}. A crash
 * inside `gate.guard()` that is not an {@link IntuticGateRefusal} — a bug in
 * this gate, or an unexpected throw from a tier it calls into — is treated
 * as "cannot evaluate" and denied rather than allowed to escape the
 * waterfall or fall through to an allow; see gate.ts's own module doc for why
 * every tier in this package takes that direction on failure.
 */
export function createPreExecuteListener(
  gate: Gate,
): (exec: DshToolExecution, next: () => Promise<DshPreToolDecision>) => Promise<DshPreToolDecision> {
  return async (exec, next) => {
    try {
      await gate.guard(exec.name, renderDshToolInput(exec.arguments))
    } catch (err) {
      if (err instanceof IntuticGateRefusal) {
        return { kind: 'deny', reason: err.message }
      }
      const detail = err instanceof Error ? err.message : String(err)
      return {
        kind: 'deny',
        reason: `[Intutic Governance] BLOCKED: gate crashed (${detail}) — failing closed rather than allowing an unevaluated call.`,
      }
    }
    // Allow: call next() rather than returning {kind:'allow'} directly, so a
    // later listener in the waterfall (including dsh's own built-in
    // ask/approval behaviour) still runs — see the module doc's note on
    // Cordis's waterfall semantics.
    return next()
  }
}

/**
 * Mount the Intutic governance gate on a dsh profile.
 *
 * Builds one {@link Gate} for the lifetime of this plugin instance (not per
 * call — Tier A1/A2/A3 all cache within a `Gate`, see gate.ts) and installs it
 * as the process-wide default too (`install()`), so a hand-authored
 * `wrapTool`/`wrapTools` call elsewhere in the same dsh process picks up the
 * identical instance rather than constructing a second one with independent
 * caches.
 *
 * Never throws out of `apply()` itself: a `GateClient.fromEnv` failure (e.g.
 * credentials genuinely unreadable) degrades to a client-less `Gate` — Tier B
 * and Tier A3 inactive, Tier A1/A2 (local, load-bearing) unaffected — rather
 * than taking down the whole dsh profile boot over a governance layer that is
 * additive by design.
 */
export function apply(ctx: CordisLikeContext, config: DshGateConfig = {}): void {
  let client: GateClient | null
  try {
    client = GateClient.fromEnv({ harness: 'dsh', sessionId: resolveSessionId(config) })
  } catch {
    client = null
  }

  const gate = new Gate(config, client)
  install(gate)

  ctx.on('tools/pre-execute', createPreExecuteListener(gate))
}

/** Default export — the whole Plugin object, for `name: '@intutic/gate/dsh'`
 *  cordis.patch.yml rows that resolve this module and pass it directly to
 *  `ctx.plugin()` (dsh's loader unwraps a default export the same way it
 *  unwraps a named one — see `dsh-app-boot`'s `unwrapExports`). Named exports
 *  (`apply`, `inject`, `PLUGIN_NAME`) are also available for a caller that
 *  imports this subpath directly rather than through the loader. */
export default { name: PLUGIN_NAME, inject, apply }
