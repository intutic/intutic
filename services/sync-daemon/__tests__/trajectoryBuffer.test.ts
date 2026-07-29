// First coverage TrajectoryBuffer.toSummary has ever had — added with TD-207,
// whose fix changed exactly what this math consumes.
//
// Background: the proxy's trace:live events carried `toolName: <task type>`,
// so every summary metric built on "tools" was actually built on a
// near-constant task-type string. Events now carry `tools` — the per-turn
// delta of REAL tool calls — and the summary flattens those, falling back to
// the legacy field only when no event has the array (an old proxy).
import { describe, it, expect } from 'vitest'
import { TrajectoryBuffer, type TraceEvent } from '../src/trajectoryMonitor.js'

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    sessionId: 'ses_t',
    workspaceId: 'ws_t',
    toolName: 'coding', // the legacy lie: a task type in a tool field
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 50,
    status: 'success',
    // Near-now: push() trims events older than the sliding window against the
    // real clock, so a fixed historical timestamp would be dropped on entry.
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('TrajectoryBuffer.toSummary', () => {
  it('counts real tool calls from the tools arrays, not LLM requests', () => {
    const buf = new TrajectoryBuffer('ses_t', 'ws_t')
    // Two requests: one carrying three tool calls, one carrying none.
    buf.push(event({ tools: ['Read', 'Edit', 'Bash'] }))
    buf.push(event({ tools: [] }))

    const s = buf.toSummary([], 0)
    expect(s.toolCallCount).toBe(3)
    expect(s.uniqueTools).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('detects consecutive identical calls across event boundaries', () => {
    // The run [Bash, Bash] spans two requests. Flattening is what makes the
    // scan see it; the per-event view could not.
    const buf = new TrajectoryBuffer('ses_t', 'ws_t')
    buf.push(event({ tools: ['Read', 'Bash'] }))
    buf.push(event({ tools: ['Bash', 'Bash'] }))

    const s = buf.toSummary([], 0)
    expect(s.maxConsecutiveIdenticalCalls).toBe(3)
  })

  it('falls back to the legacy field only when NO event carries a tools array', () => {
    // An old proxy: no event has `tools`. The pre-TD-207 behaviour is the
    // best available, and must not silently change under an old fleet.
    const buf = new TrajectoryBuffer('ses_t', 'ws_t')
    buf.push(event({ toolName: 'coding' }))
    buf.push(event({ toolName: 'coding' }))

    const s = buf.toSummary([], 0)
    expect(s.toolCallCount).toBe(2)
    expect(s.uniqueTools).toEqual(['coding'])
  })

  it('does not mix vocabularies when only some events carry tools arrays', () => {
    // Mixed fleet mid-upgrade: one new-proxy event with real names, one old
    // event with a task type. Mixing "Bash" and "coding" in one list would
    // corrupt uniqueTools and the repeat scan, so the arrays win outright.
    const buf = new TrajectoryBuffer('ses_t', 'ws_t')
    buf.push(event({ tools: ['Bash'] }))
    buf.push(event({ toolName: 'coding' })) // no tools array

    const s = buf.toSummary([], 0)
    expect(s.uniqueTools).toEqual(['Bash'])
    expect(s.toolCallCount).toBe(1)
  })

  it('keeps per-request facts on the request axis: tokens and errors', () => {
    const buf = new TrajectoryBuffer('ses_t', 'ws_t')
    buf.push(event({ tools: ['Read', 'Edit'], inputTokens: 10, outputTokens: 5 }))
    buf.push(event({ tools: [], status: 'error', inputTokens: 20, outputTokens: 0 }))

    const s = buf.toSummary([], 0)
    // Tokens sum over REQUESTS — flattening tool calls must not multiply them.
    expect(s.totalTokens).toBe(35)
    expect(s.errorCount).toBe(1)
  })
})
