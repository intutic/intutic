/**
 * The shared-window scope (Wave 5.3, TD-437): what the sibling proxy
 * processes of one harness session derive in common, and when a process
 * honestly has nothing to share.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionScope, startTokenFromProcStat, readParentStartToken } from '../sessionScope.js'

describe('buildSessionScope', () => {
  it('an explicit override wins, sanitised to a plain identifier', () => {
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 42, envOverride: 'sess one/../x' })).toBe('ws_1:mcp:env:sessone..x')
  })

  it('an override that sanitises to nothing falls back to the parent-derived scope', () => {
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 42, envOverride: '///' })).toBe('ws_1:mcp:42')
  })

  it('an orphaned process (ppid <= 1) has no shareable identity', () => {
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 1 })).toBeUndefined()
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 0 })).toBeUndefined()
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: Number.NaN })).toBeUndefined()
  })

  it('the parent start token defeats pid reuse when it is known, and is omitted when it is not', () => {
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 42, parentStartToken: 'abc123def456' })).toBe('ws_1:mcp:42:abc123def456')
    expect(buildSessionScope({ workspaceId: 'ws_1', ppid: 42, parentStartToken: '  ' })).toBe('ws_1:mcp:42')
  })
})

describe('startTokenFromProcStat', () => {
  it('reads field 22 after the last ")" even when the comm carries spaces and parentheses', () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime …
    const stat = '4242 (node (x) y) S 1 4242 4242 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 12 0 987654321 123456 0 0'
    const token = startTokenFromProcStat(stat)
    expect(token).toMatch(/^[0-9a-f]{12}$/)
    // Same starttime, same token; a different one, a different token.
    expect(startTokenFromProcStat(stat.replace('987654321', '987654322'))).not.toBe(token)
    expect(startTokenFromProcStat(stat)).toBe(token)
  })

  it('a stat line it cannot parse yields no token rather than a wrong one', () => {
    expect(startTokenFromProcStat('garbage')).toBeUndefined()
    expect(startTokenFromProcStat('1 (init) S')).toBeUndefined()
  })
})

describe('readParentStartToken', () => {
  it('never throws and answers within the budget for this process’s own parent', async () => {
    const started = Date.now()
    const token = await readParentStartToken(process.ppid)
    expect(Date.now() - started).toBeLessThan(2000)
    if (token !== undefined) expect(token).toMatch(/^[0-9a-f]{12}$/)
  })

  it('an unsupported platform yields no token', async () => {
    expect(await readParentStartToken(process.ppid, 'win32')).toBeUndefined()
  })
})
