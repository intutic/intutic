/**
 * chaos.ts — agent fault injection for `intutic chaos run`.
 *
 * The chaos runner hands this process a plan through `INTUTIC_CHAOS_PLAN`
 * and an events file through `INTUTIC_CHAOS_EVENTS` (see
 * `@intutic/shared-types`' chaos contract). The faults this proxy injects
 * stand in for the upstream MCP server misbehaving, so they live at the
 * server-response boundary and governance runs around them unchanged:
 *
 * - request side: a fault is considered only for a `tools/call` the
 *   interceptor allowed — a block or a hold is answered exactly as without a
 *   plan, so a fault can never turn a refusal into an allow;
 * - response side: a synthesized or modified result goes through the same
 *   `handleServerLine` path a real one does, so DLP, the injection scanner,
 *   TOFU pinning and the tool-poisoning check all see the faulted response.
 *
 * Without a plan none of this is constructed and the proxy's paths carry no
 * extra work.
 *
 * @module
 */

import * as node_fs from 'node:fs'
import {
  CHAOS_EVENTS_ENV,
  CHAOS_PLAN_ENV,
  FAULT_CATALOG,
  FaultCounter,
  decodeChaosPlan,
  faultMatches,
  faultMessage,
  type ChaosEvent,
  type ChaosPlan,
  type Fault,
} from '@intutic/shared-types'
import { createStderrLogger as createLogger } from './stderrLog.js'

const log = createLogger('mcp-chaos')

type ToolsetChange = Extract<Fault, { id: 'mcp.toolset_change' }>

/** Distributes `Omit` over the event union, so each variant keeps its own fields. */
type EventBody = ChaosEvent extends infer E ? (E extends ChaosEvent ? Omit<E, 'ts' | 'runId' | 'component'> : never) : never

/** What happens to one allowed `tools/call`. */
export type CallFault =
  /** Do not call the server; answer with this result. */
  | { kind: 'respond'; result: Record<string, unknown> }
  /** Call the server, then append this text to its result. */
  | { kind: 'append'; payload: string; call: number }

/**
 * Read the plan from the environment. Null when no plan is set; throws when
 * one is set but invalid, so the caller can refuse to start rather than run
 * with a plan it silently ignores.
 */
export function readChaosPlan(env: NodeJS.ProcessEnv): ChaosPlan | null {
  return decodeChaosPlan(env[CHAOS_PLAN_ENV])
}

export class ChaosInjector {
  private readonly counter = new FaultCounter()
  /** Matching calls seen per fault index — the `call` an event reports. */
  private readonly matched = new Map<number, number>()
  /** Toolset changes that have fired; every later tools/list is rewritten by them. */
  private readonly toolsetChanges: ToolsetChange[] = []

  /** Emits `plan_loaded`. */
  constructor(
    private readonly plan: ChaosPlan,
    private readonly eventsPath: string | undefined = process.env[CHAOS_EVENTS_ENV],
  ) {
    if (!eventsPath) {
      log.warn({ action: 'chaos_events_unset' }, `${CHAOS_EVENTS_ENV} is not set: faults are injected but no events are recorded`)
    }
    const ours = plan.faults.filter((f) => FAULT_CATALOG[f.id].injectedBy.includes('mcp-proxy')).length
    this.emit({ type: 'plan_loaded', faults: ours })
  }

  /** Append one event line. Never throws: a lost event must not break the agent's call. */
  emit(body: EventBody): void {
    if (!this.eventsPath) return
    const event = { ts: new Date().toISOString(), runId: this.plan.runId, component: 'mcp-proxy', ...body }
    try {
      node_fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n')
    } catch (err) {
      log.warn({ action: 'chaos_event_write_error', err: (err as Error).message, type: body.type }, 'Could not record chaos event')
    }
  }

  /** Counts this call against a fault; returns the 1-based matching-call index when it is hit. */
  private hit(index: number, fault: Fault, tool: string): number | null {
    if (!faultMatches(fault, { tool })) return null
    const call = (this.matched.get(index) ?? 0) + 1
    this.matched.set(index, call)
    return this.counter.shouldInject(index, fault) ? call : null
  }

  /**
   * Called once per `tools/call` governance allowed, before it is forwarded.
   *
   * Toolset changes count every such call; one that fires stays in effect for
   * the rest of the run and calls `notify` once. Result faults are tried in
   * plan order and the first that fires decides the call; faults after it do
   * not count the call. `append` is reported when the payload is actually
   * appended (see {@link faultServerLine}), the others here.
   */
  onAllowedCall(tool: string, notify: () => void): CallFault | null {
    let outcome: CallFault | null = null
    for (const [index, fault] of this.plan.faults.entries()) {
      if (fault.id === 'mcp.toolset_change') {
        if (this.toolsetChanges.includes(fault)) continue
        const call = this.hit(index, fault, tool)
        if (call === null) continue
        this.toolsetChanges.push(fault)
        this.emit({ type: 'fault_injected', faultId: fault.id, call, target: tool })
        notify()
        continue
      }
      if (outcome) continue
      if (fault.id !== 'tool.error' && fault.id !== 'tool.stale_data' && fault.id !== 'inject.tool_result') continue
      const call = this.hit(index, fault, tool)
      if (call === null) continue
      if (fault.id === 'inject.tool_result') {
        outcome = { kind: 'append', payload: fault.payload, call }
        continue
      }
      this.emit({ type: 'fault_injected', faultId: fault.id, call, target: tool })
      outcome =
        fault.id === 'tool.error'
          ? { kind: 'respond', result: { content: [{ type: 'text', text: faultMessage(this.plan, fault.message) }], isError: true } }
          : { kind: 'respond', result: { content: [{ type: 'text', text: fault.result }] } }
    }
    return outcome
  }

  /**
   * Apply the response-side faults to one upstream line before governance
   * inspects it: append an `inject.tool_result` payload to the call it was
   * chosen for, and rewrite a `tools/list` once a toolset change has fired.
   * Returns the (possibly rewritten) line and, for a `tools/call` response,
   * the tool it answers. `pending` is read, not consumed.
   */
  faultServerLine(
    raw: string,
    pending: ReadonlyMap<string | number, { method: string; toolName?: string; inject?: { payload: string; call: number } }>,
  ): { line: string; toolCall?: string } {
    let msg: { id?: string | number | null; result?: Record<string, unknown> }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return { line: raw }
    }
    if (msg.id === undefined || msg.id === null) return { line: raw }
    const req = pending.get(msg.id)
    if (!req) return { line: raw }

    if (req.method === 'tools/call') {
      const tool = req.toolName ?? '<unknown>'
      const content = msg.result?.['content']
      if (!req.inject || !Array.isArray(content)) return { line: raw, toolCall: tool }
      content.push({ type: 'text', text: req.inject.payload })
      this.emit({ type: 'fault_injected', faultId: 'inject.tool_result', call: req.inject.call, target: tool })
      return { line: JSON.stringify(msg), toolCall: tool }
    }

    if (req.method === 'tools/list' && this.toolsetChanges.length > 0) {
      const tools = msg.result?.['tools']
      if (!msg.result || !Array.isArray(tools)) return { line: raw }
      let kept = tools as Array<Record<string, unknown>>
      for (const change of this.toolsetChanges) {
        kept = kept.filter((t) => !change.remove.includes(t['name'] as string))
        for (const t of kept) {
          const description = change.redefine[t['name'] as string]
          if (description !== undefined) t['description'] = description
        }
      }
      msg.result['tools'] = kept
      return { line: JSON.stringify(msg) }
    }

    return { line: raw }
  }

  /** Report a `tools/call` outcome; `frame` is what the agent receives. */
  recordToolCall(tool: string, frame: string): void {
    let ok = false
    try {
      const msg = JSON.parse(frame) as { error?: unknown; result?: { isError?: unknown } }
      ok = msg.error === undefined && msg.result !== undefined && msg.result.isError !== true
    } catch {
      // Not JSON: the agent got nothing usable.
    }
    this.emit({ type: 'tool_call', tool, ok })
  }
}
