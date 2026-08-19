/**
 * Mastra adapter: `intuticHooks()`.
 *
 * `@intutic/gate/mastra` — a framework-specific specialization of the same
 * idea `wrapTools.ts` implements generically (see that file's module doc):
 * wrap the framework's own veto point around this package's `Gate.guard()`,
 * throwing/vetoing before the real tool body ever runs.
 *
 * Mastra (`@mastra/core`) exposes a documented pre-execution veto point: an
 * `Agent`'s `hooks.beforeToolCall`. It runs for every tool in the agent's
 * assembled tool dictionary — natively defined tools AND MCP-sourced tools
 * registered through `@mastra/mcp`, since both are merged into the same
 * `CoreTool` record before hook-wrapping happens (`wrapToolsWithHooks`
 * operates generically over `Object.entries(tools)`, with no source-specific
 * branch). Returning `{ proceed: false, output }` from `beforeToolCall` skips
 * the tool's real `execute` entirely and hands `output` back to the model IN
 * PLACE OF the tool's result.
 *
 * ## Confirmed against a real install
 *
 * `@mastra/core@1.59.0` was installed in a scratch directory and its shipped
 * `.d.ts`/compiled source read directly (not inferred from docs alone):
 *
 * `dist/tools/types.d.ts`:
 * ```ts
 * export interface ToolHookContext<TInput, TContext, TMetadata> {
 *   toolName: string
 *   input: TInput
 *   context: TContext
 *   metadata?: TMetadata
 * }
 * export interface ToolBeforeHookResult<TOutput> {
 *   proceed: false
 *   output: TOutput
 * }
 * export interface ToolHooks<TInput, TOutput, TContext, TMetadata> {
 *   beforeToolCall?: (context: ToolHookContext<TInput, TContext, TMetadata>) =>
 *     void | ToolBeforeHookResult<TOutput> | Promise<void | ToolBeforeHookResult<TOutput>>
 *   afterToolCall?: (context: ToolAfterHookContext<...>) => void | Promise<void>
 * }
 * ```
 * `void`/`undefined` means "proceed" (allow); only an explicit
 * `{ proceed: false, output }` vetoes — this adapter's `beforeToolCall`
 * therefore returns `undefined` on allow, matching the framework's own
 * "no opinion" contract rather than a synthetic allow value.
 *
 * `dist/agent-CKAVuxKN.js`'s `wrapToolWithHooks` (the actual wrapping the
 * `.d.ts` above only declares the shape of) confirms the consumption side:
 * ```js
 * const beforeResult = await hooks.beforeToolCall?.(hookContext)
 * if (beforeResult?.proceed === false) return beforeResult.output
 * ```
 * `output` is returned AS the tool's own `execute` return value at this
 * layer, with no schema check performed by the hook wrapper itself — but a
 * tool with a strict Zod `outputSchema` may still validate/reject that value
 * further downstream, and `beforeToolCall` is never told what that schema
 * is (the hook context carries no `outputSchema`/tool-definition reference).
 * This adapter therefore cannot GUARANTEE a schema-conformant denial payload
 * for an arbitrary tool; see {@link IntuticHooksOptions.denialOutput} to
 * shape it per your own tools when the generic default will not validate.
 *
 * ## TAMPER NOTE — per-call hooks OVERRIDE agent-level hooks, they do not merge
 *
 * Also confirmed against the same install — `dist/agent.d.ts`'s
 * `getConfiguredToolHooks()` doc comment:
 *
 * > Run-level hooks override these via {@link resolveToolHooks}, so callers
 * > that need to preserve the configured hooks must read and compose them
 * > explicitly.
 *
 * Concretely: `new Agent({ hooks: intuticHooks() })` installs this gate at
 * the agent level, but ANY caller of `.generate()`/`.stream()` who passes
 * their own `hooks` option — even `{}`, or a `hooks` object with no
 * `beforeToolCall` — REPLACES the agent-level hooks wholesale for that call.
 * This gate silently does not run: no error, no warning, just an unguarded
 * tool call. This is Mastra's own documented behaviour, not a defect this
 * package can work around from outside the framework — there is no hook
 * inheritance or merge to opt into. See `gateRegistry.ts`'s `mastra` row for
 * the same note surfaced to the registry, and
 * `apps/docs/integrations/mastra.md` for the operator-facing version.
 *
 * If your application passes call-level `hooks` anywhere, compose this
 * gate's `beforeToolCall` into that call's hooks yourself:
 *
 * ```ts
 * const intutic = intuticHooks()
 * await agent.generate(prompt, {
 *   hooks: {
 *     beforeToolCall: async (ctx) => {
 *       const denied = await intutic.beforeToolCall(ctx)
 *       if (denied) return denied
 *       return myOwnBeforeToolCall(ctx)
 *     },
 *   },
 * })
 * ```
 */

import { active as activeGate, type Gate } from './gate.js'
import { IntuticGateRefusal } from './errors.js'

/** Structural copy of `@mastra/core`'s `ToolHookContext` — this package does
 *  not depend on `@mastra/core` at runtime, so the shape is declared here
 *  rather than imported. Confirmed field-for-field against
 *  `@mastra/core@1.59.0`'s `dist/tools/types.d.ts` (see module doc). */
export interface MastraToolHookContext {
  /** The name exposed to the model for this tool call. */
  toolName: string
  /** Input passed to the tool — this is what `Gate.guard()` evaluates. */
  input: unknown
  /** Execution context passed to the tool. Not read by this adapter. */
  context?: unknown
  /** Optional adapter-specific metadata (e.g. `agentId`/`agentName`). */
  metadata?: Record<string, unknown>
}

/** Structural copy of `@mastra/core`'s `ToolBeforeHookResult`. */
export interface MastraToolBeforeHookResult {
  proceed: false
  output: unknown
}

/** Structural copy of `@mastra/core`'s `ToolHooks['beforeToolCall']` — the
 *  slice of the real type this adapter implements. Assignable directly to
 *  `Agent`'s `hooks` constructor option. */
export type MastraBeforeToolCall = (
  context: MastraToolHookContext,
) => Promise<void | MastraToolBeforeHookResult>

export interface IntuticHooksOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
  /**
   * Shapes the `output` handed back to the model on a refusal. The default
   * produces `{ error: true, message, code, incidentId? }` — reasonable for
   * an unstructured/text-ish tool output, but NOT guaranteed to satisfy an
   * arbitrary tool's own Zod `outputSchema` (this hook is never told what
   * that schema is — see the module doc's "Confirmed against a real
   * install" section). Supply this when your tools declare strict output
   * schemas the default shape would fail.
   */
  denialOutput?: (ctx: { toolName: string; refusal: IntuticGateRefusal }) => unknown
}

function defaultDenialOutput(ctx: { toolName: string; refusal: IntuticGateRefusal }): unknown {
  return {
    error: true,
    message: ctx.refusal.message,
    code: ctx.refusal.code,
    incidentId: ctx.refusal.incidentId,
  }
}

/**
 * Builds a `{ beforeToolCall }` object shaped for direct use in `@mastra/core`'s
 * `Agent` constructor's `hooks` option:
 *
 * ```ts
 * import { Agent } from '@mastra/core/agent'
 * import { Gate, install } from '@intutic/gate'
 * import { intuticHooks } from '@intutic/gate/mastra'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * const agent = new Agent({
 *   id: 'my-agent',
 *   name: 'My Agent',
 *   model: 'openai/gpt-5-mini',
 *   tools: { deleteTool },
 *   hooks: intuticHooks(),
 * })
 * ```
 *
 * On refusal, returns `{ proceed: false, output }` — the real tool body
 * never runs. On allow, returns `undefined`, Mastra's own "no opinion"
 * value, so the real `execute` runs untouched.
 *
 * Requires a `Gate` — either passed via `{ gate }` here, or installed
 * process-wide with `install(new Gate(...))`. A call with neither throws
 * (via the underlying `beforeToolCall`), refusing to run tools unguarded
 * rather than silently skipping enforcement — same posture as `wrapTool`.
 *
 * See the module doc's TAMPER NOTE: this only governs calls that do not
 * override `hooks` at the `.generate()`/`.stream()` call site.
 */
export function intuticHooks(opts: IntuticHooksOptions = {}): { beforeToolCall: MastraBeforeToolCall } {
  const denialOutput = opts.denialOutput ?? defaultDenialOutput

  const beforeToolCall: MastraBeforeToolCall = async (ctx) => {
    const g = opts.gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to intuticHooks(). Refusing to run the tool unguarded.',
      )
    }
    try {
      await g.guard(ctx.toolName, (ctx.input ?? {}) as Record<string, unknown>)
      return undefined
    } catch (exc) {
      if (exc instanceof IntuticGateRefusal) {
        return { proceed: false, output: denialOutput({ toolName: ctx.toolName, refusal: exc }) }
      }
      throw exc
    }
  }

  return { beforeToolCall }
}
