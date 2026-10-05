/**
 * The dashboard style gate (tools/scripts/check-styles.js).
 *
 * The scanner functions are tested directly; the allowlist contract (unlisted
 * files fail, listed files are tolerated, a listed file that stopped failing
 * is itself a failure) is tested by running the real script against fixture
 * trees, because the exit code is what CI reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-styles.js')
const gate = createRequire(import.meta.url)(SCRIPT) as {
  findVarCalls(text: string): { name: string | null; fallback: string | null; complete: boolean }[]
  normalizeValue(value: string): string
  cssRawColors(css: string, basename: string): { line: number; message: string }[]
  cssDefinitions(css: string): { name: string; value: string | null }[]
  tsLiterals(source: string, fileName: string): { text: string; line: number }[]
  tsLiteralColor(text: string): string | null
}

describe('TS literal scanning', () => {
  it('reads string and template literals, not comments or JSX text', () => {
    const src = [
      '// #123456 in a comment',
      'const a = <p>Don\'t use #fff here</p>',
      "const b = '#123456'",
      'const c = `x ${y} rgb(1, 2, 3)`',
      'const r = /\'/',
      'const d = <i color="#abc" />',
    ].join('\n')
    const texts = gate.tsLiterals(src, 'x.tsx').map((l) => l.text)
    expect(texts).toContain('#123456')
    expect(texts).toContain('#abc')
    expect(texts).toContain(' rgb(1, 2, 3)')
    expect(texts.join('|')).not.toContain('#fff')
  })

  it('reports the literal line', () => {
    expect(gate.tsLiterals("\n\nconst x = '#fff'", 'x.ts')).toEqual([{ text: '#fff', line: 3 }])
  })

  it('flags full hex and colour functions only', () => {
    for (const c of ['#fff', '#ffff', '#a1b2c3', '#a1b2c3d4', ' #FFF ', 'rgba(0,0,0,.3)', '1px solid hsl(1 2% 3%)', 'oklch(0.7 0.1 200)']) {
      expect(gate.tsLiteralColor(c), c).not.toBeNull()
    }
    for (const c of ['#12345', 'issue #123', '#fffff', 'var(--x, rgba(0,0,0,.3))', 'rgba(var(--color-accent-rgb), 0.1)', 'background', 'xrgb(1)']) {
      expect(gate.tsLiteralColor(c), c).toBeNull()
    }
  })
})

describe('CSS scanning', () => {
  it('ignores comments, var() fallbacks and token-built colours', () => {
    const css = [
      '/* LLD #40, #135, rgb(1,2,3) */',
      '.a { color: var(--x, rgb(1, 2, 3)); }',
      '.b { background: rgba(var(--color-accent-rgb), 0.1); }',
      '.c { color: #fff; }',
    ].join('\n')
    expect(gate.cssRawColors(css, 'a.css')).toEqual([])
  })

  it('makes colour functions errors, keeping the old overlay exemptions', () => {
    const css = '.a {\n  color: rgba(255, 193, 7, 0.06);\n  border-color: rgba(0, 0, 0, 0.2);\n  fill: oklch(0.5 0.1 20);\n  stroke: #123456;\n}'
    expect(gate.cssRawColors(css, 'a.css').map((v) => v.line)).toEqual([5, 2, 4])
  })

  it('reads definitions, including @property', () => {
    const defs = gate.cssDefinitions(':root { --a: #fff; --b: var(--a) }\n@property --c { syntax: "*" }')
    expect(defs.map((d) => [d.name, d.value])).toEqual([['--a', '#fff'], ['--b', 'var(--a)'], ['--c', null]])
  })

  it('splits var() at the first top-level comma, through nested parens', () => {
    expect(gate.findVarCalls('var(--a, rgba(0, 0, 0, .5))')[0]).toMatchObject({ name: '--a', fallback: 'rgba(0, 0, 0, .5)', complete: true })
    expect(gate.findVarCalls('var(--color-')[0]).toMatchObject({ complete: false })
    expect(gate.findVarCalls('var(--a, var(--b, 1px))').map((c) => c.name)).toEqual(['--a', '--b'])
  })

  it('normalises equivalent values', () => {
    expect(gate.normalizeValue('#FFF')).toBe(gate.normalizeValue('rgba(255, 255, 255, 1)'))
    expect(gate.normalizeValue('rgba(29,106,229,0.15)')).toBe(gate.normalizeValue('rgba(29, 106, 229, .150)'))
    expect(gate.normalizeValue('1.0rem')).toBe('1rem')
    expect(gate.normalizeValue('8px')).not.toBe(gate.normalizeValue('.5rem'))
  })
})

describe('check-styles.js', () => {
  let root: string

  async function put(rel: string, content: string) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }

  function run(): Promise<{ status: number; out: string }> {
    return new Promise((res, reject) => {
      const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
      child.on('error', reject)
      child.on('close', (status) => res({ status: status ?? -1, out }))
    })
  }

  const allow = (lists: Record<string, string[]>) =>
    put('tools/scripts/check-styles.allowlist.json', JSON.stringify(lists))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-styles-'))
    await put('packages/theme/dist/variables.css', ':root { --color-text: #F8FAFC; --space-2: 0.5rem; }\n[data-theme=\'light\'] { --color-text: #0f172a; }')
    await put('apps/dashboard/src/styles/globals.css', ':root { --gap: var(--space-2); }')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('skips when the dashboard is absent (the public repo)', async () => {
    await rm(join(root, 'apps'), { recursive: true, force: true })
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.out).toContain('Skipping style checks')
  })

  it('fails clearly when the theme is not built', async () => {
    await rm(join(root, 'packages'), { recursive: true, force: true })
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('pnpm turbo build --filter=@intutic/theme')
  })

  it('passes a clean tree', async () => {
    await put('apps/dashboard/src/a.css', '.a { color: var(--color-text, #0F172A); gap: var(--gap, .5rem); }')
    await put('apps/dashboard/src/A.tsx', "export const A = () => <div style={{ '--w': '1px', width: 'var(--w)' }}>Don't #fff</div>")
    const r = await run()
    expect(r.out).toContain('Style Check Passed')
    expect(r.status).toBe(0)
  })

  it('fails each check in an unlisted file', async () => {
    await put('apps/dashboard/src/a.css', '.a { color: hsl(1, 2%, 3%); margin: var(--nope); padding: var(--space-2, 8px); }')
    await put('apps/dashboard/src/A.tsx', "export const c = '#123456'")
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('css-raw-color: apps/dashboard/src/a.css:1')
    expect(r.out).toContain('ts-raw-color: apps/dashboard/src/A.tsx:1 hex colour #123456')
    expect(r.out).toContain('undefined-var: apps/dashboard/src/a.css:1 --nope is not defined')
    expect(r.out).toContain('var-fallback-mismatch: apps/dashboard/src/a.css:1 var(--space-2, 8px)')
  })

  it('tolerates allowlisted files, and fails on a stale or unsorted entry', async () => {
    await put('apps/dashboard/src/b.css', '.b { margin: var(--nope); }')
    await allow({ 'undefined-var': ['apps/dashboard/src/b.css'] })
    expect((await run()).status).toBe(0)

    await put('apps/dashboard/src/b.css', '.b { margin: 0; }')
    const stale = await run()
    expect(stale.status).toBe(1)
    expect(stale.out).toContain('apps/dashboard/src/b.css is allowlisted but no longer fails this check')

    await allow({ 'undefined-var': ['z', 'a'] })
    expect((await run()).out).toContain('must be sorted')
  })

  it('test files are not scanned', async () => {
    await put('apps/dashboard/src/A.test.tsx', "expect(x).toBe('#123456')")
    expect((await run()).status).toBe(0)
  })
})
