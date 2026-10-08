/**
 * The internal-id gate (tools/scripts/check-internal-ids.js).
 *
 * The docs site shipped 64 tech-debt ids and links to docs/TECH_DEBT.md, a
 * file the public repo does not have. These run the real script against
 * fixture trees, since the thing under test is its exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-internal-ids.js')

/** Ids are assembled here so this file carries none of its own. */
const id = (prefix: string, sep: string) => `${prefix}${sep}7`

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
    })
    child.stderr.on('data', (d: string) => {
      out += d
    })
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'internalids-'))
  await mkdir(join(root, 'apps/docs/guide'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const page = (body: string) => writeFile(join(root, 'apps/docs/guide/page.md'), body)

describe('internal ids in published docs', () => {
  it('passes plain prose, docs-site links and source links', async () => {
    await page(
      'The gate fails closed. See [Plans](/guide/plans), [setup](../guide/setup.md) and ' +
        '[metering.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/metering.rs). ' +
        'Rule TDX-12 and the SLD-4 header are not ids.\n',
    )
    await writeFile(join(root, 'README.md'), 'See [the docs](apps/docs/guide/page.md).\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS] 2 published file(s)')
  })

  it.each([
    `This is tracked as ${id('TD', '-')}.`,
    `Described in ${id('LLD', ' #')}.`,
    `See ${id('LLD', '-')} for the design.`,
    'See `docs/TECH_DEBT.md` for the record.',
    'See [the record](https://github.com/intutic/intutic/blob/main/docs/decisions.md).',
    'See [the record](../../../docs/decisions.md).',
  ])('fails "%s"', async (line) => {
    await page(`${line}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/page.md:1')
  })

  it('checks the root README, including its relative docs/ links', async () => {
    await page('Clean.\n')
    await writeFile(join(root, 'README.md'), 'Intro.\n\nSee [ADRs](docs/adr/).\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('README.md:3')
  })
})
