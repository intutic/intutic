/**
 * `@ai-sdk/workflow` adapter: `intuticNeedsApproval()`, `withIntuticApproval()`,
 * `wrapWorkflowTools()`, and the FatalError-compatible `IntuticWorkflowRefusal`.
 *
 * `@intutic/gate/workflow` — the same idea `vercel.ts` implements for the base
 * `ai` package (wrap the framework's own veto point around this package's
 * `Gate.guard()`), reshaped for Vercel's DURABLE workflow-agent runtime, where
 * two facts change the adapter's whole design:
 *
 * ## 1. The veto surface is per-tool `needsApproval`, not an agent option
 *
 * Confirmed against a real install (`@ai-sdk/workflow@1.0.69`):
 * `WorkflowAgent`/`WorkflowAgentOptions` carry ZERO approval fields — the
 * string `toolApproval` does not appear anywhere in the package's shipped
 * `.d.ts`. The veto surface is `needsApproval` (boolean | function) on the
 * TOOL definition, exactly as the framework's own workflow-agent docs
 * describe under "Tool Approval". The compiled agent loop confirms the
 * semantics (dist/index.js): `needsApproval == null` → no approval; a
 * boolean is used directly; a function is awaited as
 * `needsApproval(input, { toolCallId, messages, context })`. A call needing
 * approval pauses DURABLY — the run suspends and a human can approve hours
 * later — so this framework, uniquely in this package, has a real
 * human-in-the-loop lane for the gate to route into.
 *
 * (`ai@7.0.68` marks tool-level `needsApproval` `@deprecated` in favour of
 * generateText-level `toolApproval` — but `@ai-sdk/workflow`'s OWN agent loop
 * reads the tool-level field and exposes no other veto surface, so it is the
 * correct — indeed the only — integration point here. Noted in the TD entry
 * this phase filed, so a future @ai-sdk/workflow release moving to the
 * generateText-shaped surface gets caught rather than silently ungated.)
 *
 * ## 2. Denials must not be retried — refusals here are FatalError-compatible
 *
 * A durable workflow retries failed steps. Confirmed against real installs
 * (`workflow@4.8.3` re-exporting `@workflow/errors@4.2.1` via
 * `@workflow/core`): the runtime's retry/abort decision consults
 * `FatalError.is(err)` (`@workflow/core`'s `runtime/step-handler.js` — a
 * fatal error "bubbl[es] up to parent workflow"; anything else is retried
 * toward `maxAttempts`), and `FatalError.is()` DUCK-TYPES: it checks
 * `err.name === 'FatalError'` on any Error-shaped object, precisely because
 * workflows execute in a separate `vm` realm where `instanceof` fails across
 * the boundary. A plain `IntuticGateRefusal` thrown from `needsApproval` or a
 * tool body would therefore be RETRIED — a governance denial replayed on a
 * timer until max attempts, burning the run to reach the same refusal. So
 * this adapter's refusals are {@link IntuticWorkflowRefusal}: still an
 * `IntuticGateRefusal` (`instanceof` works in-realm, `.reason`/`.code`/
 * `.incidentId` intact, message still `[Intutic Governance] BLOCKED: ...`)
 * but with `name = 'FatalError'` so the real runtime's duck-check aborts
 * instead of retry-looping. `__tests__/workflow.test.ts` pins this against
 * the REAL `FatalError.is` from the `workflow` package, not a re-derivation.
 *
 * Deliberately asymmetric: a NON-refusal crash inside `Gate.guard()` (a
 * transient network failure in a remote tier, an unexpected bug) is re-thrown
 * UNTOUCHED — retryable, which is the durable runtime's correct response to a
 * transient failure. Only a real governance verdict (and the fail-closed
 * "no gate configured" case, which is deterministic and would fail every
 * retry identically) is made fatal.
 *
 * @module
 */

import { active as activeGate, type Gate, type ToolInput } from './gate.js'
import { IntuticGateRefusal } from './errors.js'
import { wrapTools, type AnyFn, type ExecutableTool } from './wrapTools.js'

/**
 * A refused call inside a durable workflow.
 *
 * `name` is `'FatalError'` — NOT `'IntuticGateRefusal'` — on purpose: the
 * workflow runtime's `FatalError.is()` duck-types on that exact string (see
 * module doc), and it is the only cross-VM-realm-safe way to tell the runtime
 * "abort, do not retry". Everything else about the refusal contract is
 * preserved: `instanceof IntuticGateRefusal` still holds (same realm),
 * `.message` still carries the `[Intutic Governance] BLOCKED:` prefix, and
 * `.reason`/`.code`/`.incidentId` carry the structured verdict. `fatal: true`
 * mirrors the property the real `FatalError` class sets, for code that
 * checks the flag rather than the name.
 */
export class IntuticWorkflowRefusal extends IntuticGateRefusal {
  public readonly fatal = true as const
  constructor(reason: string, code: string, incidentId?: string) {
    super(reason, code, incidentId)
    this.name = 'FatalError'
  }

  /** Rewrap a core refusal so the durable runtime treats it as fatal. */
  static from(refusal: IntuticGateRefusal): IntuticWorkflowRefusal {
    return new IntuticWorkflowRefusal(refusal.reason, refusal.code, refusal.incidentId)
  }

  /**
   * Cross-realm-safe detection (the same trick `FatalError.is` itself uses):
   * `instanceof` fails across the workflow `vm` boundary, so this checks the
   * duck-typed name plus this package's own message prefix.
   */
  static is(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'FatalError' &&
      typeof (value as { message?: unknown }).message === 'string' &&
      ((value as { message: string }).message.startsWith('[Intutic Governance] BLOCKED:'))
    )
  }
}

/** Structural copy of the options object `@ai-sdk/workflow`'s agent loop
 *  passes to a tool's `needsApproval` function (confirmed from the compiled
 *  loop: `needsApproval(tc.input, { toolCallId, messages, context })`). Only
 *  the fields this adapter could ever read are named; the index signature
 *  keeps the function assignable to the real (wider) option type. */
export interface WorkflowNeedsApprovalOptions {
  toolCallId: string
  [key: string]: unknown
}

/** The `needsApproval` function shape this adapter produces — assignable to
 *  `ai`'s tool-level `needsApproval` (the surface `@ai-sdk/workflow`'s agent
 *  loop actually consults). */
export type WorkflowNeedsApproval = (
  input: unknown,
  options: WorkflowNeedsApprovalOptions,
) => Promise<boolean>

export interface IntuticNeedsApprovalOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
  /**
   * What an ALLOWED call maps to. `needsApproval` answers "does a human need
   * to approve this?", which is a different question from "may this run?" —
   * so an allow has two honest encodings and this option picks one:
   *
   *  - `'auto'` (default): resolve `false` — the gate evaluated the call and
   *    allowed it; no human pause. Denials never reach this mapping at all
   *    (they THROW — see below), so `false` here never launders a block.
   *  - `'human'`: resolve `true` — the gate allowed it AND a human still
   *    approves, using the framework's own durable pause (approvable hours
   *    later). Belt-and-braces for high-stakes tools.
   *
   * A BLOCKED call takes neither value: it throws
   * {@link IntuticWorkflowRefusal}. Returning `true` for a denial would hand
   * the decision to a human approver as though the gate had no verdict, and
   * returning `false` would RUN the tool — the one thing a block must never
   * do.
   */
  onAllow?: 'auto' | 'human'
}

function requireGate(gate: Gate | undefined, helper: string): Gate {
  const g = gate ?? activeGate()
  if (g === null) {
    // FatalError-compatible on purpose: "no gate configured" is
    // deterministic — a durable retry would fail identically every attempt,
    // so burning the step's retry budget on it helps nobody. Fail closed,
    // once, loudly.
    throw new IntuticWorkflowRefusal(
      `No gate configured: call install(new Gate(...)) from @intutic/gate, or pass { gate } to ${helper}. ` +
        'Refusing to run the tool unguarded.',
      'NO_GATE',
    )
  }
  return g
}

function renderWorkflowToolInput(input: unknown): ToolInput {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as ToolInput
  }
  return { args: [input] }
}

/**
 * Build an async `needsApproval` function for ONE workflow tool:
 *
 * ```ts
 * import { WorkflowAgent } from '@ai-sdk/workflow'
 * import { Gate, install } from '@intutic/gate'
 * import { intuticNeedsApproval } from '@intutic/gate/workflow'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * const agent = new WorkflowAgent({
 *   model,
 *   tools: {
 *     deployService: {
 *       description: '...',
 *       inputSchema,
 *       execute: deployStep,
 *       needsApproval: intuticNeedsApproval('deployService'),
 *     },
 *   },
 * })
 * ```
 *
 * The tool name is a parameter because the framework's `needsApproval`
 * signature does not carry it — `(input, { toolCallId, messages, context })`
 * has no `toolName` field (confirmed against the shipped types). Use
 * {@link withIntuticApproval} to attach this to a whole tools record without
 * hand-repeating each name.
 *
 * Verdict mapping: BLOCK → throws {@link IntuticWorkflowRefusal} (fatal —
 * aborts instead of retry-looping; see module doc); ALLOW → `false` or `true`
 * per `onAllow`. A non-refusal crash in the gate is re-thrown untouched
 * (retryable — correct for transients).
 */
export function intuticNeedsApproval(
  toolName: string,
  opts: IntuticNeedsApprovalOptions = {},
): WorkflowNeedsApproval {
  const onAllow = opts.onAllow ?? 'auto'
  return async (input, _options) => {
    const g = requireGate(opts.gate, 'intuticNeedsApproval()')
    try {
      await g.guard(toolName, renderWorkflowToolInput(input))
    } catch (exc) {
      if (exc instanceof IntuticGateRefusal && !(exc instanceof IntuticWorkflowRefusal)) {
        throw IntuticWorkflowRefusal.from(exc)
      }
      throw exc
    }
    return onAllow === 'human'
  }
}

/** The slice of a workflow tool definition this adapter reads/replaces.
 *  Structurally compatible with `ai`'s `Tool` (whose `needsApproval` is
 *  `boolean | ToolNeedsApprovalFunction<...>`). */
export interface WorkflowToolLike {
  needsApproval?: boolean | ((input: never, options: never) => unknown)
  [key: string]: unknown
}

/**
 * Attach the Intutic gate to every tool in a record, composing with any
 * `needsApproval` the tool already declares:
 *
 * ```ts
 * const agent = new WorkflowAgent({ model, tools: withIntuticApproval(tools) })
 * ```
 *
 * For each tool (the record KEY is the tool name reported to the gate — the
 * same identity the framework itself dispatches on):
 *
 *   1. `Gate.guard()` runs first. BLOCK throws {@link IntuticWorkflowRefusal}.
 *   2. On allow, the tool's OWN prior `needsApproval` still applies: a
 *      boolean is returned as-is; a function is awaited with the original
 *      arguments; a tool with none falls back to `onAllow` ('auto' → false).
 *
 * So a tool that already said "always ask a human" (`needsApproval: true`)
 * keeps asking a human — this gate only ADDS the ability to refuse outright,
 * it never removes an approval pause the caller had configured.
 *
 * Returns a NEW record of NEW tool objects (shallow copies); the input record
 * and its tools are not mutated.
 */
export function withIntuticApproval<T extends Record<string, WorkflowToolLike>>(
  tools: T,
  opts: IntuticNeedsApprovalOptions = {},
): T {
  const out: Record<string, WorkflowToolLike> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const prior = tool.needsApproval
    const gateApproval = intuticNeedsApproval(name, opts)
    const composed: WorkflowNeedsApproval = async (input, options) => {
      const gateSaysHuman = await gateApproval(input, options)
      if (typeof prior === 'boolean') return prior || gateSaysHuman
      if (typeof prior === 'function') {
        const priorResult = await (prior as (i: unknown, o: unknown) => unknown)(input, options)
        return Boolean(priorResult) || gateSaysHuman
      }
      return gateSaysHuman
    }
    out[name] = { ...tool, needsApproval: composed }
  }
  return out as T
}

/**
 * `wrapTools` for durable workflow tool definitions — the same generic
 * execute-wrapping `wrapTools.ts` provides (gate first, then the real body),
 * with ONE workflow-specific change: a refusal thrown out of the wrapped
 * `execute` is rewrapped as {@link IntuticWorkflowRefusal}, because a
 * workflow tool's `execute` is a durable STEP and a step that throws a
 * non-fatal error is retried (see module doc). Everything else — including
 * "no gate configured" handling and the record-key-is-tool-name convention —
 * is `wrapTools`'s own behaviour, reused rather than reimplemented.
 *
 * Prefer {@link withIntuticApproval} as the primary integration: it uses the
 * framework's own pre-execution veto surface, refuses BEFORE the durable
 * step ever starts, and keeps the human-approval lane available. This
 * execute-level wrapper is defense in depth (or the option for callers whose
 * tools are shared with non-workflow code paths); running both double-guards
 * the call, which is harmless but emits duplicate gate telemetry.
 */
export function wrapWorkflowTools<T extends AnyFn | ExecutableTool>(
  tools: Record<string, T>,
  gate?: Gate,
): Record<string, T> {
  const wrapped = wrapTools(tools, gate)
  const out: Record<string, T> = {}
  for (const [name, tool] of Object.entries(wrapped)) {
    if (typeof tool === 'function') {
      out[name] = fatalize(tool) as T
    } else {
      out[name] = { ...(tool as ExecutableTool), execute: fatalize((tool as ExecutableTool).execute) } as T
    }
  }
  return out
}

function fatalize(fn: AnyFn): AnyFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (exc) {
      if (exc instanceof IntuticGateRefusal && !(exc instanceof IntuticWorkflowRefusal)) {
        throw IntuticWorkflowRefusal.from(exc)
      }
      throw exc
    }
  }
}
