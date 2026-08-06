/**
 * The claim gate had no test of its own.
 *
 * It is the only thing standing between an invented benchmark number and the
 * marketing site, and every previous hole in it was found by reading it rather
 * than by running it: it required the literal word "in" before "under 50ms"; it
 * matched raw source, so `<span>&lt;5</span><span>ms</span>` rendered to "<5ms"
 * and slipped past; its ceiling exemption applied to a whole line, so one
 * legitimate "(<1ms)" pardoned every claim beside it.
 *
 * A gate with no test is a gate whose exit code can invert without anyone
 * noticing — and this one now runs inside `pnpm lint`, which `deploy.sh` calls,
 * so an inverted exit code means unsupported claims ship.
 *
 * These run the real script as a subprocess against fixture trees, because the
 * thing under test IS the process exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-latency-claims.js')

function runGate(
  roots: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, ...roots], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
  root = await mkdtemp(join(tmpdir(), 'claimgate-'))
  await mkdir(root, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = (name: string, body: string) => writeFile(join(root, name), body)

describe('the gate passes clean trees', () => {
  it('accepts prose with no performance claim', async () => {
    await write('a.md', '# Intutic\n\nBlocks the call before it runs.\n')
    const r = await runGate([root])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS]')
  })

  it('accepts a figure that carries its provenance', async () => {
    await write(
      'a.md',
      '209 µs p95 proxy overhead — 1 KB payload, standalone mode, M4 Pro, delta vs a stub upstream.\n',
    )
    const r = await runGate([root])
    expect(r.status, r.out).toBe(0)
  })
})

describe('the gate catches what it was widened to catch', () => {
  it('flags "under 50ms" without the literal word "in"', async () => {
    // The original pattern was /in under \d+ms/ and this exact line — from
    // compare/langsmith.md — was live for months.
    await write('a.md', '| **Execution Path** | Synchronous interceptor (under 50ms) |\n')
    const r = await runGate([root])
    expect(r.status, `not flagged:\n${r.out}`).toBe(1)
  })

  it('flags a claim split across HTML tags and entities', async () => {
    // Renders as "<5 ms". Matching raw source misses it entirely, and the
    // marketing site is HTML, so this is the shape that matters there.
    await write('a.html', '<p><span>&lt;5</span><span>ms</span> overhead</p>\n')
    const r = await runGate([root])
    expect(r.status, `not flagged:\n${r.out}`).toBe(1)
  })

  it('does not let a distant ceiling phrase pardon an unrelated claim', async () => {
    // The exemption is scoped to ±60 chars around the match, not the line.
    const filler = 'x'.repeat(200)
    await write('a.md', `A hard ceiling of 5ms is enforced by fuel limits. ${filler} Responses in under 20ms.\n`)
    const r = await runGate([root])
    expect(r.status, `the far claim was pardoned by the near one:\n${r.out}`).toBe(1)
  })

  it('reports the file and line, not just a count', async () => {
    await write('a.md', 'ok\nok\nAdds under 3ms of latency.\n')
    const r = await runGate([root])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/a\.md:3/)
  })
})

describe('the gate refuses to pass while asserting nothing', () => {
  it('fails when a named root is missing', async () => {
    // The likelier state than "all trees present": the marketing site is a
    // separate repository. A note plus exit 0 is indistinguishable from a
    // clean run of full coverage.
    const r = await runGate([root, join(root, 'does-not-exist')])
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('not checked out')
  })

  it('fails when no root exists at all', async () => {
    const r = await runGate([join(root, 'nope')])
    expect(r.status, r.out).toBe(1)
    // The missing-root check fires first now, so this is the message. The
    // "asserted nothing" backstop below is what catches the case where someone
    // waives the missing roots and there is consequently nothing left to scan.
    expect(r.out).toContain('not checked out')
  })

  it('still fails when the waiver leaves nothing to scan', async () => {
    // INTUTIC_CLAIM_ROOTS_OPTIONAL downgrades a missing root to a warning. It
    // must not downgrade a run that ends up covering zero files — that is a
    // gate reporting PASS having opened nothing.
    const r = await runGate([join(root, 'nope')], { INTUTIC_CLAIM_ROOTS_OPTIONAL: '1' })
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('asserted nothing')
  })

  it('downgrades a missing root only when explicitly told to', async () => {
    await write('a.md', 'nothing to see\n')
    const r = await runGate([root, join(root, 'nope')], { INTUTIC_CLAIM_ROOTS_OPTIONAL: '1' })
    expect(r.status, r.out).toBe(0)
    expect(r.out, 'partial coverage must be stated, not silent').toContain('partial coverage')
  })

  it('scans .html as well as .md', async () => {
    // The website is HTML. A gate that only reads markdown covers the docs site
    // and none of the marketing copy, which is where the invented numbers were.
    await write('a.html', '<p>Adds under 3ms of latency.</p>\n')
    const r = await runGate([root])
    expect(r.status, `html was not scanned:\n${r.out}`).toBe(1)
  })
})
