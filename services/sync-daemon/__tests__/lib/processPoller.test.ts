/**
 * processPoller.test.ts — the two pure functions behind
 * `detectTmuxParentedAgents` (O1's Xirp tmux-ancestry heuristic).
 *
 * `detectTmuxParentedAgents` itself is not exercised here (it shells out to
 * the real `ps`, the same reason `getActiveAgentProcesses` has no test in
 * this codebase) — everything decision-relevant lives in
 * `parseProcessTreeOutput` and `hasTmuxParentedAgent`, both pure, so those
 * are what get real fixture coverage.
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { parseProcessTreeOutput, hasTmuxParentedAgent, type ProcessTreeEntry } from '../../src/lib/processPoller.js'

describe('parseProcessTreeOutput', () => {
  it('parses well-formed pid/ppid/comm rows', () => {
    const output = ' 1 0 launchd\n 100 1 tmux\n 101 100 claude\n'
    expect(parseProcessTreeOutput(output)).toEqual([
      { pid: 1, ppid: 0, comm: 'launchd' },
      { pid: 100, ppid: 1, comm: 'tmux' },
      { pid: 101, ppid: 100, comm: 'claude' },
    ])
  })

  it('skips blank lines and a header row whose PID column is not numeric', () => {
    const output = '  PID  PPID COMM\n\n  55    1 codex\n   \n'
    expect(parseProcessTreeOutput(output)).toEqual([{ pid: 55, ppid: 1, comm: 'codex' }])
  })

  it('skips malformed rows with fewer than three columns', () => {
    const output = '55 1\n56 1 codex\n'
    expect(parseProcessTreeOutput(output)).toEqual([{ pid: 56, ppid: 1, comm: 'codex' }])
  })

  it('returns [] for empty input', () => {
    expect(parseProcessTreeOutput('')).toEqual([])
  })
})

describe('hasTmuxParentedAgent', () => {
  const launchd: ProcessTreeEntry = { pid: 1, ppid: 0, comm: 'launchd' }
  const tmuxServer: ProcessTreeEntry = { pid: 100, ppid: 1, comm: 'tmux' }

  it('is true when claude is a direct child of a tmux process — the Xirp shape', () => {
    const claude: ProcessTreeEntry = { pid: 101, ppid: 100, comm: 'claude' }
    expect(hasTmuxParentedAgent([launchd, tmuxServer, claude])).toBe(true)
  })

  it('is true for codex and gemini too, and true through an intermediate shell', () => {
    // tmux -> shell -> codex: the ancestry walk must not stop at the first hop.
    const shell: ProcessTreeEntry = { pid: 150, ppid: 100, comm: 'zsh' }
    const codex: ProcessTreeEntry = { pid: 151, ppid: 150, comm: 'codex' }
    expect(hasTmuxParentedAgent([launchd, tmuxServer, shell, codex])).toBe(true)

    const gemini: ProcessTreeEntry = { pid: 160, ppid: 100, comm: 'gemini' }
    expect(hasTmuxParentedAgent([launchd, tmuxServer, gemini])).toBe(true)
  })

  it('matches macOS-style "tmux: server" comm values too', () => {
    const tmuxServerLong: ProcessTreeEntry = { pid: 100, ppid: 1, comm: 'tmux:' }
    const claude: ProcessTreeEntry = { pid: 101, ppid: 100, comm: 'claude' }
    expect(hasTmuxParentedAgent([launchd, tmuxServerLong, claude])).toBe(true)
  })

  it('is false when the same agent runs with no tmux ancestor at all', () => {
    const claude: ProcessTreeEntry = { pid: 101, ppid: 1, comm: 'claude' }
    expect(hasTmuxParentedAgent([launchd, claude])).toBe(false)
  })

  it('is false when tmux is running but nothing agent-shaped is a descendant of it', () => {
    const unrelated: ProcessTreeEntry = { pid: 102, ppid: 100, comm: 'zsh' }
    expect(hasTmuxParentedAgent([launchd, tmuxServer, unrelated])).toBe(false)
  })

  it('does not false-positive on a process whose comm merely CONTAINS an agent name', () => {
    // e.g. a hypothetical `claude-helper` or `codex-lsp` binary — comm match
    // is exact (`^claude$` etc.), not substring, precisely to avoid this.
    const notClaude: ProcessTreeEntry = { pid: 101, ppid: 100, comm: 'claude-helper' }
    expect(hasTmuxParentedAgent([launchd, tmuxServer, notClaude])).toBe(false)
  })

  it('is false for an empty process tree', () => {
    expect(hasTmuxParentedAgent([])).toBe(false)
  })

  it('terminates instead of looping forever on a cyclic PPID chain', () => {
    // Pathological input (has happened on some container/namespace setups):
    // 101 claims 102 as parent, 102 claims 101 as parent. The walk must
    // detect the cycle and stop, not hang.
    const a: ProcessTreeEntry = { pid: 101, ppid: 102, comm: 'claude' }
    const b: ProcessTreeEntry = { pid: 102, ppid: 101, comm: 'zsh' }
    expect(hasTmuxParentedAgent([a, b])).toBe(false)
  })
})
