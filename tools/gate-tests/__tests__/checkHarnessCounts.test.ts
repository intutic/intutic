/**
 * The harness-count gate's gate-kind counts (tools/scripts/check-harness-counts.js).
 *
 * The docs said "native hook gates in 19" after Continue, whose hooks never
 * fire, moved to the proxy-governed set and left 18. These run the real script
 * against a fixture tree, since the thing under test is its exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-harness-counts.js')

function runGate(...args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

// 40 harnesses: 30 hook-gated, 6 SDK-gated, 4 neither.
const MEMBERS = Array.from({ length: 40 }, (_, i) => `H${i}`)
const set = (name: string, members: string[]) =>
  `export const ${name}: ReadonlySet<HarnessTypeT> = new Set([\n${members.map((m) => `  HarnessType.${m},`).join('\n')}\n])\n`

let root: string
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harnesscounts-'))
  await put(
    'packages/shared-types/src/enums.ts',
    `export const HarnessType = {\n${MEMBERS.map((m) => `  ${m}: '${m.toLowerCase()}',`).join('\n')}\n} as const\n\n` +
      'export const HARNESS_COUNT = Object.keys(HarnessType).length\n' +
      'export const HARNESS_HEADLINE_COUNT = HARNESS_COUNT - [].length\n',
  )
  await put(
    'apps/docs/reference/harness-security-matrix.md',
    MEMBERS.map((m, i) => `| ${i + 1} | ${m} |`).join('\n') + '\n',
  )
  await put(
    'services/sync-daemon/src/harness/gateKind.ts',
    set('SDK_GATED_HARNESSES', MEMBERS.slice(30, 36)) +
      set('NO_GATE_HARNESSES', MEMBERS.slice(36, 38)) +
      set('DELEGATED_GATE_HARNESSES', MEMBERS.slice(38, 39)) +
      'export const BRIDGE_GATED_HARNESSES: ReadonlySet<HarnessTypeT> = new Set([HarnessType.H39])\n',
  )
  await put('README.md', 'Intutic ships **40 harness adapters**: 30 install as native hook gates in the harness config.\n')
  await put('services/sync-daemon/README.md', '# Sync daemon\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const page = (body: string) => put('apps/docs/compare/x.md', `# Compare\n\n${body}\n`)

describe('gate-kind counts', () => {
  it('passes counts that match gateKind.ts', async () => {
    await page('Native hook gates in 30 of the 40 harnesses and in-process SDK gates in 6; the other four are governed through the proxies.')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('30 hook-gated and 6 SDK-gated')
  })

  it.each([
    ['native hook gates in 31 of them', 'says 31 harnesses are hook-gated', 'makes it 30'],
    ['in-process SDK gates in 7 agent frameworks', 'says 7 harnesses are SDK-gated', 'makes it 6'],
    ['the other three are governed through the proxies', 'says 3 harnesses are neither hook- nor SDK-gated', 'makes it 4'],
  ])('fails "%s"', async (claim, says, makes) => {
    await page(claim)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(says)
    expect(r.out).toContain(makes)
  })

  it('checks the website category counts with --website', async () => {
    await page('Native hook gates in 30.')
    const site = join(root, 'site')
    await mkdir(site)
    await writeFile(
      join(site, 'index.html'),
      '<!-- HARNESS_COUNT:sync -->40<!-- /HARNESS_COUNT:sync --> harnesses\n' +
        '<li><strong>Native hook gates</strong> (30, installed in the harness config)</li>\n' +
        '<li><strong>SDK-gated frameworks</strong> (5, in-process)</li>\n',
    )
    const r = await runGate(root, '--website', site)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('says 5 harnesses are SDK-gated')
    expect(r.out).not.toContain('says 30 harnesses')
  })
})
