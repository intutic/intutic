/**
 * Generic tool-wrapping helper.
 *
 * The JS/TS analogue of `guard`/`guard_tools` in
 * `packages/intutic-clawde/intutic_clawde/gate/framework.py`, reshaped for
 * how JS agent frameworks actually define a "tool": either
 *
 *   * a plain async function `(input) => result`, or
 *   * an object carrying an `execute(input) => result` method alongside
 *     framework metadata (`{ description, parameters, execute }` — the
 *     Vercel AI SDK / Mastra shape; LangChain.js `DynamicStructuredTool`
 *     and `tool()`-created tools carry the same `execute`/`func` contract
 *     closely enough that this shape covers them too).
 *
 * This is the helper any JS framework WITHOUT a dedicated `@intutic/gate/*`
 * adapter (notably LangChain.js, until a sibling phase ships one) uses to get
 * gated: wrap each tool with {@link wrapTool} (or a whole collection with
 * {@link wrapTools}) before handing it to the framework's agent/executor.
 *
 * On deny, the wrapped tool's `execute`/call THROWS `IntuticGateRefusal`
 * (see `errors.ts`) before the real implementation ever runs — this
 * package's throw-based refusal contract, not a return-value one. On allow,
 * the real implementation runs and its return value passes through
 * untouched.
 *
 * Requires a `Gate` — either passed explicitly via `{ gate }`, or installed
 * process-wide with `install(new Gate(...))` from `gate.ts`. Calling a
 * wrapped tool with neither throws, refusing to run the tool unguarded
 * rather than silently skipping enforcement.
 */

import { active as activeGate, type Gate } from './gate.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...args: any[]) => any

export interface ExecutableTool {
  execute: AnyFn
  name?: string
  [key: string]: unknown
}

export interface WrapToolOptions {
  /** Tool name reported to the gate. Defaults to the function's own `.name`
   *  (or the tool object's `.name`), then falls back to `"tool"`. */
  name?: string
  /** Overrides the process-wide installed gate for this tool only. */
  gate?: Gate
}

const GUARDED = Symbol.for('intutic.gate.guarded')

function isGuarded(fn: AnyFn): boolean {
  return (fn as unknown as Record<symbol, unknown>)[GUARDED] === true
}

/**
 * Render a call's arguments as the `tool_input` object the gate evaluates.
 *
 * Every JS agent-framework tool signature this package targets calls
 * `execute` with the arguments object as the first positional parameter
 * (`execute(input)`, `execute(input, context)`, `_call(input)`, `func(input)`
 * ...), so the first argument — when it is a plain object — IS the tool
 * input. A call shaped some other way (positional scalars, no arguments)
 * falls back to `{ args: [...] }` so the gate still sees something to
 * evaluate rather than throwing on a signature it does not recognise.
 */
function renderToolInput(args: unknown[]): Record<string, unknown> {
  const [first] = args
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return first as Record<string, unknown>
  }
  return { args }
}

function wrapFn(fn: AnyFn, toolName: string, gate: Gate | undefined): AnyFn {
  if (isGuarded(fn)) return fn

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]) => {
    const g = gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to wrapTool()/wrapTools(). Refusing to run the tool unguarded.',
      )
    }
    await g.guard(toolName, renderToolInput(args))
    return fn(...args)
  }

  Object.defineProperty(wrapped, GUARDED, { value: true, enumerable: false })
  Object.defineProperty(wrapped, 'name', { value: toolName, configurable: true })
  return wrapped
}

/**
 * Wrap a single tool — a plain async function, or a `{ execute, ... }`
 * object — so `Gate.guard()` runs before the real implementation.
 *
 * The object form returns a NEW object (a shallow copy with `execute`
 * replaced); it does not mutate the one passed in, since the frameworks this
 * targets tend to hand out tool definitions that are re-used or frozen.
 * Already-wrapped functions/objects pass through unchanged, so wrapping the
 * same tool twice does not double-gate it.
 */
export function wrapTool<T extends AnyFn>(fn: T, opts?: WrapToolOptions): T
export function wrapTool<T extends ExecutableTool>(tool: T, opts?: WrapToolOptions): T
export function wrapTool(toolOrFn: AnyFn | ExecutableTool, opts: WrapToolOptions = {}): unknown {
  if (typeof toolOrFn === 'function') {
    const name = opts.name ?? (toolOrFn.name || 'tool')
    return wrapFn(toolOrFn, name, opts.gate)
  }
  if (toolOrFn !== null && typeof toolOrFn === 'object' && typeof toolOrFn.execute === 'function') {
    const name = opts.name ?? toolOrFn.name ?? 'tool'
    return { ...toolOrFn, execute: wrapFn(toolOrFn.execute, name, opts.gate) }
  }
  throw new TypeError(
    'wrapTool: expected an async function or a tool object with an execute() method, got ' +
      `${typeof toolOrFn}`,
  )
}

/**
 * Wrap a collection of tools in one call.
 *
 * Accepts either an array (tool name comes from each tool's own `.name`/
 * function name) or a record keyed by tool name (the Vercel AI SDK / Mastra
 * `tools: { myTool: {...} }` shape) — in the record form the KEY is always
 * the name reported to the gate, since that is the identity the framework
 * itself uses to invoke the tool.
 */
export function wrapTools<T extends AnyFn | ExecutableTool>(tools: readonly T[], gate?: Gate): T[]
export function wrapTools<T extends AnyFn | ExecutableTool>(
  tools: Record<string, T>,
  gate?: Gate,
): Record<string, T>
export function wrapTools<T extends AnyFn | ExecutableTool>(
  tools: readonly T[] | Record<string, T>,
  gate?: Gate,
): T[] | Record<string, T> {
  if (Array.isArray(tools)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tools.map((t) => wrapTool(t as any, { gate })) as T[]
  }
  const out: Record<string, T> = {}
  for (const [key, t] of Object.entries(tools)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[key] = wrapTool(t as any, { name: key, gate })
  }
  return out
}
