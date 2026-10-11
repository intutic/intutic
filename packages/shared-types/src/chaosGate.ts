/**
 * Fault injection in the hook gates: the part of a chaos run (`chaos.ts`) a
 * gate carries.
 *
 * A gate is a new process per tool call, so nothing here keeps state in
 * memory: the plan comes from {@link CHAOS_PLAN_ENV}-style text each call,
 * and every count lives in files beside the events file.
 *
 * - `<events>.gate-plan-loaded` — created once, with an exclusive create; the
 *   gate that creates it reports `plan_loaded`, so separate gate processes do
 *   not repeat it.
 * - `<events>.gate-counters/<fault index>.seen.<n>` and `.hit.<n>` — one
 *   empty file per matching call a fault saw and per call it hit. A call
 *   claims the next number with an exclusive create (`open` with `wx`,
 *   `O_CREAT | O_EXCL`), which the file system grants to exactly one process,
 *   so two gates deciding at once can never both take the same number; the
 *   claimed number is the call's 1-based index. A count is the number of
 *   files, read once to start the search, so a claim costs one directory
 *   read and usually one create. That is `FaultCounter`'s `after_calls` and
 *   `times` across processes.
 *
 * Only a call governance allowed counts: a fault never applies to a call the
 * gate refused, held or asked about, so such a call is not one of the
 * fault's matching calls either. Every fault whose `match` covers an allowed
 * call counts it as seen; the first one in plan order that is due injects,
 * and the faults after it do not spend a hit on the same call. A `tool.error`
 * on an `mcp__<server>__<tool>` call is the MCP proxy's to inject, so a gate
 * leaves it alone; `permission.deny_or_delay` is the gate's on any tool.
 *
 * The functions are self-contained on purpose — no imports, no module state —
 * because the JavaScript hook gates emit them as source
 * ({@link CHAOS_GATE_JS_SOURCE}) and run them outside this package. The bash
 * gates run the Python transliteration, `intutic_clawde/gate/chaos.py`, which
 * the sync daemon emits verbatim. Both run `fixtures/chaos-gate-vectors.json`.
 * File access goes through the `fs` argument (Node's `fs` in a gate).
 *
 * @module
 */

/** One fault a gate injects, with its defaults applied. */
export interface ChaosGateFault {
  /** The fault's position in the plan: its counters are keyed on it. */
  index: number
  id: 'tool.error' | 'permission.deny_or_delay'
  match: { tool?: string; host?: string; model?: string } | null
  afterCalls: number
  times: number | null
  /** `tool.error` only. */
  message: string
  /** `permission.deny_or_delay` only. */
  mode: 'deny' | 'delay' | 'hold_then_deny'
  delayS: number
}

/** The fields of a plan a gate uses. */
export interface ChaosGatePlan {
  runId: string
  canary: string
  /** The faults a gate injects; the plan's others are another component's. */
  faults: ChaosGateFault[]
}

/** One call, as the gate decided it before any fault. */
export interface ChaosGateCall {
  tool: string
  decision: 'allow' | 'deny' | 'ask' | 'hold'
  ruleId?: string | null
  destructive: boolean
  policyHit: boolean
}

/** A fault to apply to an allowed call. */
export interface ChaosGateFaultOutcome {
  faultId: string
  /** `deny` refuses now; `delay` waits and allows; `hold_then_deny` waits and refuses. */
  kind: 'deny' | 'delay' | 'hold_then_deny'
  /** The refusal text, carrying the plan's canary; empty for `delay`. */
  reason: string
  delayS: number
}

/** The file operations the functions use: Node's `fs` provides them. */
export interface ChaosGateFs {
  appendFileSync(path: string, data: string): void
  mkdirSync(path: string): unknown
  readdirSync(path: string): string[]
  openSync(path: string, flags: string): number
  closeSync(fd: number): void
}

/**
 * Decodes and checks a plan: base64url JSON, version 1, with valid values in
 * every field a gate reads. Returns the plan, or why it is not one.
 */
export function chaosGateDecode(raw: string): { plan: ChaosGatePlan; error: null } | { plan: null; error: string } {
  const ids = [
    'llm.rate_limit', 'llm.upstream_5xx', 'llm.context_trim', 'llm.model_degrade', 'tool.error', 'tool.stale_data',
    'mcp.toolset_change', 'permission.deny_or_delay', 'inject.tool_result', 'egress.dns_fail', 'egress.credential_401',
  ]
  const invalid = (why: string) => ({ plan: null, error: 'INTUTIC_CHAOS_PLAN is not a valid plan: ' + why })
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const isInt = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  let json: unknown
  try {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) throw new Error('alphabet')
    const b64 = raw.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { plan: null, error: 'INTUTIC_CHAOS_PLAN is not base64url-encoded JSON' }
  }
  if (!isObject(json)) return invalid('not a JSON object')
  if (json.v !== 1) return invalid('version ' + JSON.stringify(json.v) + ', and a gate reads only version 1')
  if (typeof json.runId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(json.runId)) return invalid('runId')
  if (typeof json.canary !== 'string' || !/^E-INTUTIC-[0-9A-F]{4,16}$/.test(json.canary)) return invalid('canary')
  if (!Array.isArray(json.faults) || json.faults.length > 50) return invalid('faults')
  const faults: ChaosGateFault[] = []
  for (let i = 0; i < json.faults.length; i++) {
    const f: unknown = json.faults[i]
    const at = 'faults[' + i + ']'
    if (!isObject(f) || typeof f.id !== 'string' || ids.indexOf(f.id) === -1) return invalid(at + '.id')
    if (f.id !== 'tool.error' && f.id !== 'permission.deny_or_delay') continue
    let match: ChaosGateFault['match'] = null
    if (f.match !== undefined) {
      if (!isObject(f.match)) return invalid(at + '.match')
      for (const k of Object.keys(f.match)) {
        const v = f.match[k]
        if ((k !== 'tool' && k !== 'host' && k !== 'model') || typeof v !== 'string' || v.length === 0) {
          return invalid(at + '.match.' + k)
        }
      }
      match = f.match as ChaosGateFault['match']
    }
    if (f.after_calls !== undefined && !isInt(f.after_calls, 0, 10000)) return invalid(at + '.after_calls')
    if (f.times !== undefined && !isInt(f.times, 1, 10000)) return invalid(at + '.times')
    const fault: ChaosGateFault = {
      index: i,
      id: f.id,
      match: match,
      afterCalls: f.after_calls === undefined ? 0 : (f.after_calls as number),
      times: f.times === undefined ? null : (f.times as number),
      message: 'tool failed',
      mode: 'deny',
      delayS: 0,
    }
    if (f.id === 'tool.error' && f.message !== undefined) {
      if (typeof f.message !== 'string' || f.message.length < 1 || f.message.length > 2000) return invalid(at + '.message')
      fault.message = f.message
    }
    if (f.id === 'permission.deny_or_delay') {
      if (f.mode !== undefined) {
        if (f.mode !== 'deny' && f.mode !== 'delay' && f.mode !== 'hold_then_deny') return invalid(at + '.mode')
        fault.mode = f.mode
      }
      if (f.delay_s !== undefined) {
        if (!isInt(f.delay_s, 0, 600)) return invalid(at + '.delay_s')
        fault.delayS = f.delay_s as number
      }
    }
    faults.push(fault)
  }
  return { plan: { runId: json.runId, canary: json.canary, faults: faults }, error: null }
}

/**
 * Whether a fault's `match` covers a gate call. A gate call has a tool and
 * nothing else, so a fault that names a host or a model never matches one.
 * `tool` matches exactly, or by suffix when it starts with `*`.
 */
export function chaosGateMatches(match: ChaosGateFault['match'], tool: string): boolean {
  if (!match) return true
  if (match.host !== undefined || match.model !== undefined) return false
  const p = match.tool
  if (p === undefined) return true
  return p.charAt(0) === '*' ? tool.endsWith(p.slice(1)) : tool === p
}

/** One events-file line: `ts`, `runId`, `component`, `type`, then the fields that are set. */
export function chaosGateEvent(plan: ChaosGatePlan, type: string, fields: Record<string, unknown>, now: string): string {
  const event: Record<string, unknown> = { ts: now, runId: plan.runId, component: 'gate', type: type }
  for (const k of Object.keys(fields)) if (fields[k] !== undefined && fields[k] !== null) event[k] = fields[k]
  return JSON.stringify(event) + '\n'
}

/** Appends whole lines in one write. An I/O error is reported, never thrown: it must not decide the call. */
export function chaosGateAppend(fs: ChaosGateFs, eventsPath: string, lines: string): void {
  try {
    fs.appendFileSync(eventsPath, lines)
  } catch (e) {
    try {
      console.error('[Intutic Governance] chaos: could not append to ' + eventsPath + ': ' + String((e && (e as Error).message) || e))
    } catch {
      /* stderr gone too */
    }
  }
}

/**
 * Claims the next numbered file `<dir>/<prefix><n>` with an exclusive create
 * and returns n, or 0 when every number up to `limit` is taken. -1 on an I/O
 * error, after saying so.
 */
export function chaosGateClaim(fs: ChaosGateFs, dir: string, prefix: string, limit: number | null): number {
  try {
    // Beside the events file, never creating its directory: the runner did.
    try {
      fs.mkdirSync(dir)
    } catch (e) {
      if (!e || (e as { code?: string }).code !== 'EEXIST') throw e
    }
    const names = fs.readdirSync(dir)
    let n = 0
    for (let i = 0; i < names.length; i++) if (names[i]!.indexOf(prefix) === 0) n++
    for (n = n + 1; limit === null || n <= limit; n++) {
      try {
        fs.closeSync(fs.openSync(dir + '/' + prefix + n, 'wx'))
        return n
      } catch (e) {
        if (!e || (e as { code?: string }).code !== 'EEXIST') throw e
      }
    }
    return 0
  } catch (e) {
    try {
      console.error('[Intutic Governance] chaos: could not count calls in ' + dir + ': ' + String((e && (e as Error).message) || e))
    } catch {
      /* stderr gone too */
    }
    return -1
  }
}

/**
 * Reports one call: `plan_loaded` the first time any gate reports to this
 * events file, then `gate_decision`; for an allowed call, the fault that is
 * due (`fault_injected`), and `tool_call` when the call still goes ahead.
 * Returns the fault the gate must apply, or null. `now` is the ISO-8601 time.
 */
export function chaosGateCall(
  fs: ChaosGateFs,
  plan: ChaosGatePlan,
  eventsPath: string,
  call: ChaosGateCall,
  now: string,
): ChaosGateFaultOutcome | null {
  let lines = ''
  let first = true
  try {
    fs.closeSync(fs.openSync(eventsPath + '.gate-plan-loaded', 'wx'))
  } catch (e) {
    // Already reported. Any other error: report again rather than not at all.
    if (e && (e as { code?: string }).code === 'EEXIST') first = false
  }
  if (first) lines += chaosGateEvent(plan, 'plan_loaded', { faults: plan.faults.length }, now)
  lines += chaosGateEvent(
    plan,
    'gate_decision',
    {
      tool: call.tool,
      decision: call.decision,
      ruleId: call.ruleId || null,
      destructive: !!call.destructive,
      policyHit: !!call.policyHit,
    },
    now,
  )
  let fault: ChaosGateFaultOutcome | null = null
  if (call.decision === 'allow') {
    const dir = eventsPath + '.gate-counters'
    for (let i = 0; i < plan.faults.length; i++) {
      const f = plan.faults[i]!
      if (!chaosGateMatches(f.match, call.tool)) continue
      // An MCP tool's error is the MCP proxy's to inject; a gate injects the built-in side.
      if (f.id === 'tool.error' && call.tool.indexOf('mcp__') === 0) continue
      const seen = chaosGateClaim(fs, dir, f.index + '.seen.', null)
      if (fault || seen < 1 || seen <= f.afterCalls) continue
      if (f.times !== null && chaosGateClaim(fs, dir, f.index + '.hit.', f.times) < 1) continue
      const tag = ' [' + plan.canary + ']'
      fault =
        f.id === 'tool.error'
          ? { faultId: f.id, kind: 'deny', reason: f.message + tag, delayS: 0 }
          : f.mode === 'delay'
            ? { faultId: f.id, kind: 'delay', reason: '', delayS: f.delayS }
            : f.mode === 'hold_then_deny'
              ? { faultId: f.id, kind: 'hold_then_deny', reason: 'Permission held for approval, then denied by approver' + tag, delayS: f.delayS }
              : { faultId: f.id, kind: 'deny', reason: 'Permission denied by approver' + tag, delayS: 0 }
      lines += chaosGateEvent(plan, 'fault_injected', { faultId: f.id, call: seen, target: call.tool }, now)
    }
    if (!fault || fault.kind === 'delay') lines += chaosGateEvent(plan, 'tool_call', { tool: call.tool, ok: true }, now)
  }
  chaosGateAppend(fs, eventsPath, lines)
  return fault
}

/** Every function above as JavaScript source, for a hook gate to emit. */
export const CHAOS_GATE_JS_SOURCE = [
  chaosGateDecode,
  chaosGateMatches,
  chaosGateEvent,
  chaosGateAppend,
  chaosGateClaim,
  chaosGateCall,
]
  .map((f) => f.toString())
  .join('\n')
