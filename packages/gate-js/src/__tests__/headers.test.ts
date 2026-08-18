import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { intuticHeaders } from '../headers.js'

// Port of the intutic_headers portion of
// packages/intutic-clawde/tests/test_gate_framework.py.

const ENV_KEYS = ['INTUTIC_SESSION_ID', 'INTUTIC_WORKSPACE_ID'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('intuticHeaders', () => {
  it('includes session and workspace when given explicitly', () => {
    const h = intuticHeaders({ sessionId: 's_1', workspaceId: 'ws_1' })
    expect(h['x-session-id']).toBe('s_1')
    expect(h['x-workspace-id']).toBe('ws_1')
  })

  it('defaults harness to generic', () => {
    expect(intuticHeaders({ sessionId: 's' })['x-intutic-harness']).toBe('generic')
  })

  it('honours an explicit harness', () => {
    expect(intuticHeaders({ sessionId: 's', harness: 'crewai' })['x-intutic-harness']).toBe('crewai')
  })

  it('falls back to the environment for session/workspace', () => {
    process.env.INTUTIC_SESSION_ID = 's_env'
    process.env.INTUTIC_WORKSPACE_ID = 'ws_env'
    const h = intuticHeaders()
    expect(h['x-session-id']).toBe('s_env')
    expect(h['x-workspace-id']).toBe('ws_env')
  })

  it('omits session/workspace entirely when neither is set', () => {
    expect(intuticHeaders()).toEqual({ 'x-intutic-harness': 'generic' })
  })
})
