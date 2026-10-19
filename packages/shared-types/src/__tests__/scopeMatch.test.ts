/**
 * Scope and plan semantics: the shared vectors through the
 * module and through the JavaScript source the hook gates embed, and the
 * lists held to the proxy's own (manifest.rs, actions.rs).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHRASES_JS_SOURCE } from '../phrases.js'
import * as scope from '../scopeMatch.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/scope-plan-vectors.json'), 'utf-8')) as any

type Api = Pick<
  typeof scope,
  'isWithinScope' | 'collectScopePaths' | 'collectPlanSteps' | 'planOffSteps' | 'changeTargets' | 'diffChangedPaths' | 'scopeRelativePath' | 'isPlanExemptTool' | 'isFileWriteCall'
>

const EMITTED = new Function(
  `${PHRASES_JS_SOURCE}\n${scope.SCOPE_MATCH_JS_SOURCE}\nreturn { isWithinScope, collectScopePaths, collectPlanSteps, planOffSteps, changeTargets, diffChangedPaths, scopeRelativePath, isPlanExemptTool, isFileWriteCall }`,
)() as Api

describe.each([
  ['the module', scope as Api],
  ['the emitted source', EMITTED],
] as const)('scope and plan through %s', (_label, api) => {
  it('matches targets to scopes', () => {
    for (const c of V.isWithinScope) expect(api.isWithinScope(c.target, c.scopes), JSON.stringify(c)).toBe(c.within)
  })

  it('collects the scope in force, org ceiling included', () => {
    for (const c of V.collectScopePaths) expect(api.collectScopePaths(c.sops, c.role), c.name).toEqual(c.paths)
  })

  it('collects the plan in force, org ceiling included', () => {
    for (const c of V.collectPlanSteps) expect(api.collectPlanSteps(c.sops, c.role), c.name).toEqual(c.steps)
  })

  it('finds off-plan steps', () => {
    for (const c of V.planOffSteps) expect(api.planOffSteps(c.sequence, c.plan, c.tolerance).offPlan, c.name).toEqual(c.offPlan)
  })

  it('reads the mutations of a call', () => {
    for (const c of V.changeTargets) expect(api.changeTargets(c.tool, c.input), c.name).toEqual(c.targets)
  })

  it('reads the paths a diff changes', () => {
    for (const c of V.diffChangedPaths) expect(api.diffChangedPaths(c.diff), c.name).toEqual(c.paths)
  })

  it('makes a gate target relative to the workspace root', () => {
    for (const c of V.scopeRelativePath) expect(api.scopeRelativePath(c.target, c.cwd, c.root), c.name).toBe(c.path)
  })

  it('exempts the investigative tools from plan approval', () => {
    for (const t of V.planExemptTools.exempt) expect(api.isPlanExemptTool(t), t).toBe(true)
    for (const t of V.planExemptTools.notExempt) expect(api.isPlanExemptTool(t), t).toBe(false)
  })

  it('says which calls change files', () => {
    for (const c of V.isFileWriteCall) expect(api.isFileWriteCall(c.tool, c.input), c.name).toBe(c.write)
  })
})

describe('the lists', () => {
  it('pins the plan-exempt tools', () => {
    expect([...scope.PLAN_EXEMPT_TOOLS]).toEqual(V.planExemptTools.list)
  })

  it('writes every list into the functions the gates embed', () => {
    // The functions carry their own copies so the emitted source needs no
    // module scope; each copy must be the exported list.
    const src = scope.SCOPE_MATCH_JS_SOURCE
    for (const list of [
      scope.SCOPE_WRITE_TOOLS,
      scope.SCOPE_EDIT_TOOLS,
      scope.SCOPE_DELETE_TOOLS,
      scope.SCOPE_MOVE_TOOLS,
      scope.SCOPE_EDITOR_TOOLS,
      scope.SCOPE_PATH_KEYS,
      scope.SCOPE_COMMAND_KEYS,
      scope.SCOPE_SHELL_TOOLS,
      scope.SCOPE_MOVE_FROM_KEYS,
      scope.SCOPE_MOVE_TO_KEYS,
      scope.PLAN_EXEMPT_TOOLS,
      scope.FILE_WRITE_SHELL_PHRASES,
    ]) {
      expect(src.replace(/"/g, "'"), JSON.stringify(list)).toContain(`[${list.map((t) => `'${t}'`).join(', ')}]`)
    }
    expect(src).toContain(JSON.stringify(scope.NARROWED_TO_NOTHING))
  })
})

describe('parity with the proxy', () => {
  const ROOT = join(__dirname, '../../../proxy/src')
  const MANIFEST_RS = readFileSync(join(ROOT, 'manifest.rs'), 'utf-8')
  const ACTIONS_RS = readFileSync(join(ROOT, 'plugins/anomaly/actions.rs'), 'utf-8')

  /** The string literals of a `const NAME: &[&str] = &[...]` in the Rust source, comments skipped. */
  function rustList(source: string, name: string): string[] {
    const m = source.match(new RegExp(`const ${name}: &\\[&str\\] =\\s*&\\[([\\s\\S]*?)\\];`))
    expect(m, `${name} not found`).not.toBeNull()
    const body = m![1]!.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!)
  }

  it.each([
    ['WRITE_TOOLS', scope.SCOPE_WRITE_TOOLS],
    ['EDIT_TOOLS', scope.SCOPE_EDIT_TOOLS],
    ['DELETE_TOOLS', scope.SCOPE_DELETE_TOOLS],
    ['MOVE_TOOLS', scope.SCOPE_MOVE_TOOLS],
    ['PATH_KEYS', scope.SCOPE_PATH_KEYS],
    ['COMMAND_KEYS', scope.SCOPE_COMMAND_KEYS],
  ] as const)('manifest.rs %s', (name, list) => {
    expect([...list]).toEqual(rustList(MANIFEST_RS, name))
  })

  it.each([
    ['EDITOR_TOOLS', scope.SCOPE_EDITOR_TOOLS],
    ['SHELL_TOOLS', scope.SCOPE_SHELL_TOOLS],
    ['READ_TOOLS', scope.SCOPE_READ_TOOLS],
  ] as const)('actions.rs %s', (name, list) => {
    expect([...list]).toEqual(rustList(ACTIONS_RS, name))
  })

  it("reads a move's ends with manifest.rs's keys", () => {
    expect(MANIFEST_RS).toContain(`&[${scope.SCOPE_MOVE_FROM_KEYS.map((k) => `"${k}"`).join(', ')}]`)
    expect(MANIFEST_RS.replace(/\s+/g, ' ')).toContain(`&[${scope.SCOPE_MOVE_TO_KEYS.map((k) => `"${k}"`).join(', ')}]`)
  })

  it('names the sentinel and the tolerance as the proxy does', () => {
    expect(readFileSync(join(ROOT, 'sops.rs'), 'utf-8')).toContain(`"${scope.NARROWED_TO_NOTHING}"`)
    expect(readFileSync(join(ROOT, 'plugins/anomaly/detectors.rs'), 'utf-8')).toMatch(/PLAN_DEVIATION_TOLERANCE: f64 = 0\.4;/)
    expect(MANIFEST_RS).toMatch(/const TARGET_MAX: usize = 512;/)
  })
})
