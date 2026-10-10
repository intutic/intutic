/**
 * The internal-id gate (tools/scripts/check-internal-ids.js).
 *
 * The docs site shipped 64 tech-debt ids and links to the tech-debt tracker
 * under docs/, a file the public repo does not have; the mirrored source then
 * carried 925 more lines of them. These run the real script against fixture
 * trees, since the thing under test is its exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-internal-ids.js')

/** Ids and the tracker's name are assembled here so this file carries none of its own. */
const id = (prefix: string, sep: string) => `${prefix}${sep}7`
const TRACKER = ['TECH', 'DEBT.md'].join('_')

function runGate(...args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
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
let base: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'internalids-'))
  root = join(base, 'repo')
  await mkdir(join(root, 'apps/docs/guide'), { recursive: true })
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function put(rel: string, body: string, at = root) {
  await mkdir(dirname(join(at, rel)), { recursive: true })
  await writeFile(join(at, rel), body)
}
const page = (body: string) => put('apps/docs/guide/page.md', body)

describe('internal ids in published docs', () => {
  it('passes plain prose, docs-site links and source links', async () => {
    await page(
      'The gate fails closed. See [Plans](/guide/plans), [setup](../guide/setup.md) and ' +
        '[metering.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/metering.rs). ' +
        'Rule TDX-12 and the SLD-4 header are not ids.\n',
    )
    await put('README.md', 'See [the docs](apps/docs/guide/page.md).\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS] 2 file(s) in the public tree')
  })

  it.each([
    `This is tracked as ${id('TD', '-')}.`,
    `Described in ${id('LLD', ' #')}.`,
    `See ${id('LLD', '-')} for the design.`,
    `An earlier design (${id('LLD', ' ')}) said otherwise.`,
    `See \`docs/${TRACKER}\` for the record.`,
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
    await put('README.md', 'Intro.\n\nSee [ADRs](docs/adr/).\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('README.md:3')
  })
})

describe('internal ids in mirrored source (public checkout)', () => {
  it.each([
    ['packages/proxy/src/lib.rs', `// Fails closed; see ${id('TD', '-')}.\n`],
    ['packages/intutic-clawde/intutic_clawde/gate.py', `"""Adapter (${id('LLD', ' #')})."""\n`],
    ['services/sync-daemon/src/index.ts', `// ${TRACKER} has the record\n`],
    ['tools/scripts/check-x.js', `// per ${id('LLD', '-')}\n`],
    ['tools/cli/src/cli.test.ts', `it('refuses a stale key (${id('TD', '-')})', () => {})\n`],
    ['.github/workflows/ci.yml', `    # ${id('TD', '-')}: the Rust job is slow\n`],
    ['eslint.config.mjs', `// see ${id('TD', '-')}\n`],
  ])('fails %s', async (rel, body) => {
    await page('Clean.\n')
    await put(rel, `first line\n${body}`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`${rel}:2`)
  })

  it('passes look-alikes: STD-1, HTTP-2, TDX-12, an LLD with no number', async () => {
    await page('Clean.\n')
    await put('packages/proxy/src/lib.rs', '// STD-1 and HTTP-2 and TDX-12; the LLD covers it\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
  })

  it.each([
    'packages/gate-js/node_modules/dep/index.js',
    'packages/gate-js/dist/index.js',
    'packages/proxy/target/debug/build.rs',
    'pnpm-lock.yaml',
    'packages/proxy/Cargo.lock',
    'services/sync-daemon/__tests__/__snapshots__/gate.test.ts.snap',
    'packages/shared-types/src/modelCatalog.generated.ts',
  ])('skips %s', async (rel) => {
    await page('Clean.\n')
    await put(rel, `// ${id('TD', '-')}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
  })

  it('lets the tracker validator name the tracker, and nothing else', async () => {
    await page('Clean.\n')
    const rel = 'tools/scripts/check-tech-debt-status.js'
    await put(rel, `const DOC = join(ROOT, 'docs', '${TRACKER}')\n`)
    expect((await runGate(root)).status).toBe(0)
    await put(rel, `const DOC = join(ROOT, 'docs', '${TRACKER}')\n// see ${id('TD', '-')}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`${rel}:2`)
  })
})

describe('internal ids in the enterprise checkout', () => {
  beforeEach(async () => {
    await page('Clean.\n')
    await put('services/control-plane/src/app.ts', `// ${id('TD', '-')}\n`)
  })

  it('leaves files that never reach the public repo alone', async () => {
    await put('packages/db/src/schema.ts', `// ${id('TD', '-')}\n`)
    await put('tools/scripts/deploy.sh', `# ${id('TD', '-')}\n`)
    await put('.github/workflows/ci.yml', `# ${id('TD', '-')}\n`)
    await put('turbo.json', `{"//": "${id('TD', '-')}"}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('wholesale-mirrored trees only')
  })

  it('scans the wholesale-mirrored trees without a public checkout', async () => {
    await put('packages/proxy/src/lib.rs', `// ${id('TD', '-')}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('packages/proxy/src/lib.rs:1')
  })

  it('scans a shared file the public checkout also has, and skips one it lacks', async () => {
    const pub = join(base, 'public')
    await put('tools/scripts/check-x.js', `// ${id('TD', '-')}\n`)
    await put('tools/scripts/deploy.sh', `# ${id('TD', '-')}\n`)
    await put('apps/docs/guide/page.md', 'Clean.\n', pub)

    let r = await runGate(root, '--public', pub)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('files the public checkout')

    await put('tools/scripts/check-x.js', '// clean upstream\n', pub)
    r = await runGate(root, '--public', pub)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('tools/scripts/check-x.js:1')
    expect(r.out).not.toContain('deploy.sh')
  })

  it('refuses a --public path that does not exist', async () => {
    const r = await runGate(root, '--public', join(base, 'nope'))
    expect(r.status, r.out).toBe(2)
  })
})
