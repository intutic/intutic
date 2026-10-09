/**
 * Every hook entry a writer registers sets the harness's fail-closed switch
 * where it has one, and an explicit timeout where it has a key for one, above
 * the gate's own deadline.
 *
 * Most harnesses run a call whose PreToolUse hook outlives its timeout, or
 * fails, as if the hook had allowed it. The gate refuses at GATE_DEADLINE_MS;
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
import { GATE_DEADLINE_MS } from '@intutic/shared-types'
import { GATES } from './gateRegistry.js'

const root = mkdtempSync(join(tmpdir(), 'intutic-hook-entries-'))
const savedHome = process.env.HOME
let HOOK_TIMEOUT_SECONDS = 0

const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, any>

beforeAll(async () => {
  // HOME first: several writers resolve their paths from it at import.
  process.env.HOME = root
  process.env.USERPROFILE = root
  HOOK_TIMEOUT_SECONDS = (await import('../../src/harness/gateBody.js')).HOOK_TIMEOUT_SECONDS
  for (const name of ['claudeCode', 'codex', 'githubCopilot', 'antigravityCli', 'antigravity', 'grok', 'goose', 'hermes', 'openhands', 'cursor']) {
    const g = GATES.find((x) => x.name === name)!
    await g.invoke(await import(g.module), root)
  }
}, 60_000)

afterAll(() => {
  process.env.HOME = savedHome
  // goose hardens its files with `chflags uchg`.
  spawnSync('chflags', ['-R', 'nouchg', root])
  rmSync(root, { recursive: true, force: true })
})

describe('hook entries', () => {
  it('time out above the gate deadline', () => {
    expect(HOOK_TIMEOUT_SECONDS * 1000).toBeGreaterThan(GATE_DEADLINE_MS)
  })

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

  it('Grok Build keeps its 5 s, which the deadline sits under', () => {
    const hooks = json('.grok/hooks/intutic-governance.json').hooks.PreToolUse[0].hooks
    expect(hooks[0].timeout * 1000).toBeGreaterThan(GATE_DEADLINE_MS)
  })

  it('Cursor fails closed', () => {
    for (const entries of Object.values(json('.cursor/hooks.json').hooks) as Array<Array<Record<string, unknown>>>) {
      for (const e of entries) expect(e.failClosed, JSON.stringify(e)).toBe(true)
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
    const config = parseYaml(readFileSync(join(root, '.hermes/config.yaml'), 'utf8')) as Record<string, any>
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
