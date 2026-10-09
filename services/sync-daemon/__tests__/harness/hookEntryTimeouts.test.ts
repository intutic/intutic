/**
 * Every hook gate refuses at a deadline inside the hook timeout its harness
 * applies, and not much earlier; and every hook entry a writer registers sets
 * the harness's fail-closed switch where it has one, and the timeout the
 * deadline was derived from where it has a key for one.
 *
 * Most harnesses run a call whose PreToolUse hook outlives its timeout, or
 * fails, as if the hook had allowed it. The gate refuses at its deadline;
 * these settings are the harness-side half: Goose's `on_failure: "block"`
 * and Hermes's `fail_closed: true` turn a failed or timed-out gate into a
 * refusal, Cursor's `failClosed: true` likewise, and the timeouts keep a
 * stalled gate from holding the agent for minutes. Each harness's file is also
 * checked against the shape the harness loads: the Goose, Hermes and OpenHands
 * registrations used to be shapes those harnesses skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  GATE_DEADLINE_MARGIN_MS,
  HOOK_GATE_TIMEOUTS,
  HOOK_TIMEOUT_SECONDS,
  gateDeadlineMs,
  type HookGateHarness,
} from '@intutic/shared-types'
import { GATES, emittedHarness, type GateEntry } from './gateRegistry.js'

const root = mkdtempSync(join(tmpdir(), 'intutic-hook-entries-'))
const savedHome = process.env.HOME

const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, any>
const yaml = (rel: string) => parseYaml(readFileSync(join(root, rel), 'utf8')) as Record<string, any>
const commandHooks = (entries: Array<{ hooks: Array<Record<string, any>> }>) => entries.flatMap((e) => e.hooks)

/** The contracts of gates that run per tool call, and so under a deadline. */
const PER_CALL = new Set(['exit2', 'stdout-cancel', 'stdout-decision-deny', 'plugin-throw', 'plugin-block'])
const DEADLINE_GATES = GATES.filter((g) => g.migrated && PER_CALL.has(g.contract))

/**
 * The timeouts, in milliseconds, of every hook entry that runs a gate, as
 * written by the harness's writer: read back from the files the harness
 * reads, not from the table they were written from. Only for the harnesses
 * whose timeout connect sets.
 */
const WRITTEN_TIMEOUTS_MS: Record<string, () => number[]> = {
  claudeCode: () => commandHooks(json('.claude/settings.json').hooks.PreToolUse).map((h) => h.timeout * 1000),
  codex: () => commandHooks(json('.codex/hooks.json').hooks.PreToolUse).map((h) => h.timeout * 1000),
  githubCopilot: () => [
    ...commandHooks(json('.github/hooks/intutic-governance.json').hooks.PreToolUse),
    ...commandHooks(json('.copilot/hooks/intutic-governance.json').hooks.PreToolUse),
  ].map((h) => h.timeout * 1000),
  antigravityCli: () => commandHooks(json('.gemini/config/hooks.json')['intutic-governance'].PreToolUse).map((h) => h.timeout * 1000),
  // Gemini CLI's timeout is in milliseconds.
  antigravity: () => commandHooks(json('.gemini/settings.json').hooks.BeforeTool).map((h) => h.timeout),
  grok: () => commandHooks(json('.grok/hooks/intutic-governance.json').hooks.PreToolUse).map((h) => h.timeout * 1000),
  goose: () => commandHooks(json('.agents/plugins/intutic-governance/hooks/hooks.json').hooks.PreToolUse).map((h) => h.timeout * 1000),
  hermes: () => (yaml('.hermes/config.yaml').hooks.pre_tool_call as Array<Record<string, any>>).map((h) => h.timeout * 1000),
  openhands: () => commandHooks(json('.openhands/hooks.json').hooks.PreToolUse).map((h) => h.timeout * 1000),
  cursor: () => (Object.values(json('.cursor/hooks.json').hooks) as Array<Array<Record<string, any>>>).flat().map((h) => h.timeout * 1000),
  openclaw: () => [...artifactText(GATES.find((g) => g.name === 'openclaw')!).matchAll(/timeoutMs: (\d+)/g)].map((m) => Number(m[1])),
}

function artifactText(g: GateEntry): string {
  return readFileSync(join(root, g.artifact), 'utf8')
}

const harnessOf = (g: GateEntry): HookGateHarness => emittedHarness(artifactText(g))

/** The deadline a gate was emitted with: the bash watchdog's sleep, or the JS gate's vm timeout. */
function emittedDeadlineMs(g: GateEntry): number {
  const text = artifactText(g)
  const values = g.runner === 'bash'
    ? [...text.matchAll(/\( sleep ([\d.]+); pkill/g)].map((m) => Number(m[1]) * 1000)
    : [...text.matchAll(/var _deadlineMs = (?:Math\.max\(1, )?(\d+)/g)].map((m) => Number(m[1]))
  expect(values, `${g.name}: one deadline in the gate`).toHaveLength(1)
  return values[0]!
}

beforeAll(async () => {
  // HOME first: several writers resolve their paths from it at import.
  process.env.HOME = root
  process.env.USERPROFILE = root
  for (const g of DEADLINE_GATES) await g.invoke(await import(g.module), root)
}, 60_000)

afterAll(() => {
  process.env.HOME = savedHome
  // goose hardens its files with `chflags uchg`.
  spawnSync('chflags', ['-R', 'nouchg', root])
  rmSync(root, { recursive: true, force: true })
})

describe('gate deadlines', () => {
  it('every hook gate is emitted for a harness whose hook timeout is known, and every known one has a gate', () => {
    expect(DEADLINE_GATES.length).toBeGreaterThanOrEqual(16)
    const emitted = DEADLINE_GATES.map(harnessOf)
    for (const h of emitted) expect(Object.keys(HOOK_GATE_TIMEOUTS), h).toContain(h)
    expect([...new Set(emitted)].sort()).toEqual(Object.keys(HOOK_GATE_TIMEOUTS).sort())
  })

  it('connect writes the timeout each deadline is derived from', () => {
    for (const g of DEADLINE_GATES) {
      const harness = harnessOf(g)
      const { setBy, timeoutMs } = HOOK_GATE_TIMEOUTS[harness]
      const read = WRITTEN_TIMEOUTS_MS[g.name]
      if (setBy !== 'connect') {
        expect(read, `${g.name}: ${harness} sets no timeout, but the test reads one`).toBeUndefined()
        continue
      }
      expect(read, `${g.name}: connect sets ${harness}'s timeout; read it back here`).toBeDefined()
      const written = read!()
      expect(written.length, g.name).toBeGreaterThan(0)
      for (const ms of written) expect(ms, `${g.name} hook entry`).toBe(timeoutMs)
    }
  })

  it('each gate refuses a margin inside its harness timeout, and no earlier than it must', () => {
    const cap = HOOK_TIMEOUT_SECONDS * 1000
    for (const g of DEADLINE_GATES) {
      const harness = harnessOf(g)
      const deadline = emittedDeadlineMs(g)
      const timeoutMs: number | null = HOOK_GATE_TIMEOUTS[harness].timeoutMs
      expect(deadline, `${g.name}`).toBe(gateDeadlineMs(harness))
      // Inside the harness's timeout, with room to start and to be read.
      if (timeoutMs !== null) {
        expect(deadline + GATE_DEADLINE_MARGIN_MS, `${g.name}: ${harness} gives up at ${timeoutMs} ms`).toBeLessThanOrEqual(timeoutMs)
      }
      // Not shorter than needed: as long as the timeout allows, up to the
      // 10 s connect sets, where the harness waits longer or without limit.
      expect(deadline, `${g.name}: a legitimate call refused for want of time`).toBe(
        Math.min(timeoutMs ?? cap, cap) - GATE_DEADLINE_MARGIN_MS,
      )
    }
  })
})

describe('hook entries', () => {
  it('Claude Code, Codex, Copilot / VS Code and Antigravity set an explicit timeout', () => {
    const entries = [
      ...json('.claude/settings.json').hooks.PreToolUse,
      ...json('.codex/hooks.json').hooks.PreToolUse,
      ...json('.github/hooks/intutic-governance.json').hooks.PreToolUse,
      ...json('.gemini/config/hooks.json')['intutic-governance'].PreToolUse,
    ]
    expect(entries.length).toBeGreaterThanOrEqual(4)
    for (const e of entries) for (const h of e.hooks) expect(h.timeout, JSON.stringify(h)).toBe(HOOK_TIMEOUT_SECONDS)
  })

  it('Gemini CLI sets an explicit timeout, in its milliseconds', () => {
    const entries = json('.gemini/settings.json').hooks.BeforeTool
    for (const e of entries) for (const h of e.hooks) expect(h.timeout).toBe(HOOK_TIMEOUT_SECONDS * 1000)
  })

  it('Grok Build keeps its 5 s default', () => {
    const hooks = json('.grok/hooks/intutic-governance.json').hooks.PreToolUse[0].hooks
    expect(hooks[0].timeout).toBe(5)
  })

  it('Cursor fails closed, with an explicit timeout', () => {
    for (const entries of Object.values(json('.cursor/hooks.json').hooks) as Array<Array<Record<string, unknown>>>) {
      for (const e of entries) {
        expect(e.failClosed, JSON.stringify(e)).toBe(true)
        expect(e.timeout, JSON.stringify(e)).toBe(HOOK_TIMEOUT_SECONDS)
      }
    }
  })

  it('Goose: a plugin with a manifest, rules in its schema, the gate blocking on failure', () => {
    const plugin = '.agents/plugins/intutic-governance'
    expect(json(`${plugin}/plugin.json`).name).toBe('intutic-governance')
    const hooks = json(`${plugin}/hooks/hooks.json`).hooks
    // Goose's HooksFile: event -> [{matcher?, hooks: [{type, command, timeout?, on_failure?}]}]
    for (const rules of Object.values(hooks) as unknown[]) {
      expect(Array.isArray(rules)).toBe(true)
      for (const rule of rules as Array<Record<string, any>>) {
        expect(Array.isArray(rule.hooks)).toBe(true)
        for (const a of rule.hooks) {
          expect(a.type).toBe('command')
          expect(typeof a.command).toBe('string')
          expect(a.timeout).toBe(HOOK_TIMEOUT_SECONDS)
        }
      }
    }
    const pre = hooks.PreToolUse[0].hooks[0]
    expect(pre.command).toContain('intutic-check.sh')
    expect(pre.on_failure).toBe('block')
    // Goose interprets on_failure on PreToolUse only, and a PostToolUse hook cannot block.
    expect(hooks.PostToolUse[0].hooks[0]).not.toHaveProperty('on_failure')
  })

  it('Hermes: a pre_tool_call shell hook that fails closed', () => {
    const config = yaml('.hermes/config.yaml')
    const entries = config.hooks.pre_tool_call as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]!.command).toMatch(/hermes-check\.sh'?$/)
    expect(entries[0]!.fail_closed).toBe(true)
    expect(entries[0]!.timeout).toBe(HOOK_TIMEOUT_SECONDS)
    expect(config.hooks).not.toHaveProperty('preToolUse')
  })

  it('OpenHands: the SDK HookConfig schema, with a timeout', () => {
    const file = json('.openhands/hooks.json')
    // HookConfig accepts {hooks: {...}} and drops any other top-level key with a warning.
    expect(Object.keys(file)).toEqual(['hooks'])
    for (const [event, matchers] of Object.entries(file.hooks) as Array<[string, Array<Record<string, any>>]>) {
      expect(['PreToolUse', 'Stop']).toContain(event)
      for (const m of matchers) {
        expect(typeof m.matcher).toBe('string')
        for (const h of m.hooks) {
          expect(h.type).toBe('command')
          expect(h.timeout).toBe(HOOK_TIMEOUT_SECONDS)
          expect(h.name).toBe('Intutic governance hook')
        }
      }
    }
    expect(file.hooks.PreToolUse[0].hooks[0].command).toMatch(/openhands-check\.sh$/)
  })
})
