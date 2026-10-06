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
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-styles.js')
const gate = createRequire(import.meta.url)(SCRIPT) as {
  findVarCalls(text: string): { name: string | null; invalidName: string | null; fallback: string | null; complete: boolean }[]
  normalizeValue(value: string): string
  cssRawColors(css: string, basename: string): { line: number; message: string }[]
  cssDefinitions(css: string): { name: string; value: string | null }[]
  tsLiterals(source: string, fileName: string): { text: string; line: number; key?: string }[]
  tsLiteralColor(text: string): string | null
  cssGlass(css: string): { line: number; message: string }[]
  tsGlass(source: string, literals: { text: string; line: number }[]): { line: number; message: string }[]
  motionProblems(property: string, value: string): string[]
  cssMotion(css: string, file: string): { line: number; message: string }[]
}

const GLOBALS = 'apps/dashboard/src/styles/globals.css'
const RESET = [
  '@media (prefers-reduced-motion: reduce) {',
  '  *,',
  '  *::before,',
  '  *::after {',
  '    animation-duration: 0.01ms !important;',
  '    animation-iteration-count: 1 !important;',
  '    transition-duration: 0.01ms !important;',
  '  }',
  '}',
].join('\n')

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

  it('marks a dotted or otherwise malformed name invalid, since browsers drop the declaration', () => {
    expect(gate.findVarCalls('var(--space-2.5)')[0]).toMatchObject({ name: null, invalidName: '--space-2.5' })
    expect(gate.findVarCalls('var(--space-2-5)')[0]).toMatchObject({ name: '--space-2-5', invalidName: null })
    expect(gate.findVarCalls('var(--color-)')[0]).toMatchObject({ name: '--color-', invalidName: null })
  })

  it('finds the glass look in CSS but not the break-glass feature', () => {
    const css = [
      '/* .glass-panel in a comment */',
      '.glass-panel { color: red; }',
      '.card { -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }',
      '.break-glass-page .breakglass-row { color: red; }',
    ].join('\n')
    expect(gate.cssGlass(css)).toEqual([
      { line: 2, message: 'glass class .glass-panel' },
      { line: 3, message: 'backdrop-filter' },
      { line: 3, message: 'backdrop-filter' },
    ])
  })

  it('finds glass classes and backdropFilter keys in TS', () => {
    const src = [
      'const a = <div className="card glass-panel--elevated" />',
      "const b = { backdropFilter: 'blur(2px)' }",
      "const c = <a href=\"/break-glass\" className=\"break-glass-link\">Break glass</a>",
    ].join('\n')
    expect(gate.tsGlass(src, gate.tsLiterals(src, 'a.tsx'))).toEqual([
      { line: 1, message: 'glass class glass-panel--elevated' },
      { line: 2, message: 'backdropFilter' },
    ])
  })

  it('normalises equivalent values', () => {
    expect(gate.normalizeValue('#FFF')).toBe(gate.normalizeValue('rgba(255, 255, 255, 1)'))
    expect(gate.normalizeValue('rgba(29,106,229,0.15)')).toBe(gate.normalizeValue('rgba(29, 106, 229, .150)'))
    expect(gate.normalizeValue('1.0rem')).toBe('1rem')
    expect(gate.normalizeValue('8px')).not.toBe(gate.normalizeValue('.5rem'))
  })
})

describe('motion scanning', () => {
  it('accepts token timings, zero durations and properties named one by one', () => {
    for (const [prop, value] of [
      ['transition', 'opacity var(--duration-fast) var(--ease-out), transform var(--duration-normal) var(--ease-out)'],
      ['transition', 'overlay var(--duration-fast) allow-discrete'],
      ['transition', 'none'],
      ['transition-duration', '0s'],
      ['transition-duration', '0ms'],
      ['transition-property', 'opacity, transform'],
      ['animation', 'spin var(--duration-spin) var(--ease-linear) infinite'],
      ['animation', 'none'],
      ['animation-delay', '150ms'],
      ['transform', 'scale(0.98)'],
    ] as const) {
      expect(gate.motionProblems(prop, value), `${prop}: ${value}`).toEqual([])
    }
  })

  it('rejects transition: all and transition-property: all', () => {
    expect(gate.motionProblems('transition', 'all var(--duration-fast) var(--ease-out)')).toEqual(['transition: all (name the properties)'])
    expect(gate.motionProblems('transition-property', 'all')).toEqual(['transition-property: all (name the properties)'])
  })

  it('rejects a literal duration or easing in each timed property', () => {
    for (const prop of ['transition', 'transition-duration', 'animation', 'animation-duration']) {
      for (const d of ['200ms', '0.2s', '.3s', '2s']) {
        expect(gate.motionProblems(prop, d), `${prop}: ${d}`).toEqual([`literal duration ${d} in ${prop} (use a --duration-* token)`])
      }
    }
    for (const prop of ['transition', 'transition-timing-function', 'animation', 'animation-timing-function']) {
      for (const e of ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-end']) {
        expect(gate.motionProblems(prop, e), `${prop}: ${e}`).toEqual([`literal easing ${e} in ${prop} (use an --ease-* token)`])
      }
      for (const [fn, value] of [['cubic-bezier', 'cubic-bezier(0.16, 1, 0.3, 1)'], ['steps', 'steps(4, end)'], ['linear', 'linear(0, 1)']]) {
        expect(gate.motionProblems(prop, value), `${prop}: ${value}`).toEqual([`literal easing ${fn}() in ${prop} (use an --ease-* token)`])
      }
    }
    expect(gate.motionProblems('transition', 'all 0.2s ease-in-out')).toHaveLength(3)
  })

  it('reads CSS declarations with their lines, skipping comments', () => {
    const css = [
      '/* transition: all 1s ease */',
      '.a {',
      '  color: red;',
      '  transition: color 0.15s ease;',
      '}',
      '.b { animation: fadeIn 200ms var(--ease-out); }',
    ].join('\n')
    expect(gate.cssMotion(css, 'apps/dashboard/src/a.css')).toEqual([
      { line: 4, message: 'literal duration 0.15s in transition (use a --duration-* token)' },
      { line: 4, message: 'literal easing ease in transition (use an --ease-* token)' },
      { line: 6, message: 'literal duration 200ms in animation (use a --duration-* token)' },
    ])
  })

  it('exempts only the reduced-motion reset in globals.css', () => {
    expect(gate.cssMotion(RESET, GLOBALS)).toEqual([])
    // The same block in another file is not the reset.
    expect(gate.cssMotion(RESET, 'apps/dashboard/src/a.css').map((v) => v.line)).toEqual([5, 7])
    // Another selector under the same media query is not exempt.
    expect(gate.cssMotion(RESET.replace('*::after {', '*::after, .x {'), GLOBALS).map((v) => v.line)).toEqual([5, 7])
    // Nor is the universal rule outside the media query.
    expect(gate.cssMotion('*, *::before, *::after { transition-duration: 0.01ms !important; }', GLOBALS)).toHaveLength(1)
    // Nor another value or property inside the reset.
    expect(gate.cssMotion(RESET.replace('transition-duration: 0.01ms', 'transition-duration: 1s'), GLOBALS).map((v) => v.line)).toEqual([7])
    expect(gate.cssMotion(RESET.replace('animation-iteration-count: 1', 'transition: all 0.01ms'), GLOBALS).map((v) => v.message)).toEqual([
      'transition: all (name the properties)',
      'literal duration 0.01ms in transition (use a --duration-* token)',
    ])
  })

  it('finds the style key a TS literal is the value of', () => {
    const src = [
      "const a = { transition: 'opacity 0.2s ease' }",
      "const b = { 'animation-duration': '1s', transitionTimingFunction: reduced ? 'none' : 'ease-in' }",
      'el.style.transition = `all ${ms}ms`',
      "const c = { padding: '2s' }",
      "const d = '200ms'",
    ].join('\n')
    const keyed = gate.tsLiterals(src, 'a.tsx').filter((l) => l.key).map((l) => [l.key, l.text])
    expect(keyed).toEqual([
      ['transition', 'opacity 0.2s ease'],
      ['animation-duration', '1s'],
      ['transition-timing-function', 'none'],
      ['transition-timing-function', 'ease-in'],
      ['transition', 'all '],
      ['transition', 'ms'],
      ['padding', '2s'],
    ])
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

  /** A built theme whose source-hash matches its (fixture) sources, as build-tokens.ts writes it. */
  async function theme(css: string, sources = ['export const tokens = {}', '// build']) {
    await put('packages/theme/src/tokens.ts', sources[0]!)
    await put('packages/theme/src/build-tokens.ts', sources[1]!)
    const hash = createHash('sha256').update(sources.join('\0')).digest('hex')
    await put('packages/theme/dist/variables.css', `/* source-hash: ${hash} */\n${css}`)
  }

  const allow = (lists: Record<string, string[]>) =>
    put('tools/scripts/check-styles.allowlist.json', JSON.stringify(lists))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-styles-'))
    await theme(':root { --color-text: #F8FAFC; --space-2: 0.5rem; }\n[data-theme=\'light\'] { --color-text: #0f172a; }')
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

  it('fails fast when the built theme is older than its sources', async () => {
    await put('packages/theme/src/tokens.ts', 'export const tokens = { changed: true }')
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('variables.css is stale')
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

  it('fails invalid-var and no-glass, which have no allowlist', async () => {
    await put('apps/dashboard/src/a.css', '.glass-panel { padding: var(--space-2.5); }')
    await put('apps/dashboard/src/A.tsx', "export const s = { padding: 'var(--space-1.25)' }")
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('invalid-var: apps/dashboard/src/a.css:1 var(--space-2.5) is not a valid custom property')
    expect(r.out).toContain('invalid-var: apps/dashboard/src/A.tsx:1 var(--space-1.25) is not a valid custom property')
    expect(r.out).toContain('no-glass: apps/dashboard/src/a.css:1 glass class .glass-panel')
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

  it('passes token motion and the reduced-motion reset', async () => {
    await put(GLOBALS, `:root { --gap: var(--space-2); }\n${RESET}`)
    await put('apps/dashboard/src/a.css', '.a { transition: opacity var(--duration-fast) var(--ease-out); animation: spin var(--duration-spin) var(--ease-linear) infinite; }')
    await put('apps/dashboard/src/A.tsx', "export const s = { transition: 'opacity var(--duration-fast) var(--ease-out)', transitionDuration: '0ms' }")
    await theme(':root { --space-2: 0.5rem; --duration-fast: 120ms; --duration-spin: 800ms; --ease-out: cubic-bezier(0.16, 1, 0.3, 1); --ease-linear: linear; }')
    const r = await run()
    expect(r.out).toContain('motion: 0 violation(s)')
    expect(r.status).toBe(0)
  })

  it('fails motion, which has no allowlist, in CSS and in TS style objects', async () => {
    await put('apps/dashboard/src/a.css', [
      '.a { transition: all var(--duration-fast) var(--ease-out); }',
      '.b { transition-property: all; }',
      '.c { transition: opacity 0.2s var(--ease-out); }',
      '.d { animation: spin 1s var(--ease-linear) infinite; }',
      '.e { transition-timing-function: ease-in-out; }',
      '.f { animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
      '.g { transition-duration: 300ms; animation-duration: 2s; }',
    ].join('\n'))
    await put('apps/dashboard/src/A.tsx', [
      "export const s = { transition: 'transform 150ms ease' }",
      'export const f = (el: HTMLElement) => { el.style.animation = `pulse 2s linear` }',
    ].join('\n'))
    const r = await run()
    expect(r.status).toBe(1)
    for (const line of [
      'motion: apps/dashboard/src/a.css:1 transition: all (name the properties)',
      'motion: apps/dashboard/src/a.css:2 transition-property: all (name the properties)',
      'motion: apps/dashboard/src/a.css:3 literal duration 0.2s in transition',
      'motion: apps/dashboard/src/a.css:4 literal duration 1s in animation',
      'motion: apps/dashboard/src/a.css:5 literal easing ease-in-out in transition-timing-function',
      'motion: apps/dashboard/src/a.css:6 literal easing cubic-bezier() in animation-timing-function',
      'motion: apps/dashboard/src/a.css:7 literal duration 300ms in transition-duration',
      'motion: apps/dashboard/src/a.css:7 literal duration 2s in animation-duration',
      'motion: apps/dashboard/src/A.tsx:1 literal duration 150ms in transition',
      'motion: apps/dashboard/src/A.tsx:1 literal easing ease in transition',
      'motion: apps/dashboard/src/A.tsx:2 literal duration 2s in animation',
      'motion: apps/dashboard/src/A.tsx:2 literal easing linear in animation',
    ]) {
      expect(r.out).toContain(line)
    }
  })

  it('test files are not scanned', async () => {
    await put('apps/dashboard/src/A.test.tsx', "expect(x).toBe('#123456')")
    expect((await run()).status).toBe(0)
  })
})
