/**
 * The plan-name gate (tools/scripts/check-plan-names.js).
 *
 * It caught "Pro plan" but not "Choose a Pro, Team or Enterprise plan.", the
 * onboarding drawer's copy for months after Pro and Team were retired, because
 * its pattern needed the word "plan" right after the retired name. These run
 * the real script against fixture trees, since the thing under test is its
 * exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-plan-names.js')

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
  root = await mkdtemp(join(tmpdir(), 'plannames-'))
  await mkdir(join(root, 'apps/docs/guide'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const page = (body: string) => writeFile(join(root, 'apps/docs/guide/plans.md'), body)

describe('plan names', () => {
  it('passes the current plans, alone and in a list', async () => {
    await page('Choose a Self-serve, Biz Org or Enterprise plan. The Free trial is 14 days. (Biz Org+)\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS]')
  })

  it.each([
    'Choose a Pro, Team or Enterprise plan.',
    'Available on Team and Enterprise plans.',
    'Pro, Team, or Enterprise tiers',
    'Attenuate a key (team+)',
    'Upgrade to a Pro plan.',
    'The 14-day personal trial includes SSO.',
  ])('fails "%s"', async (line) => {
    await page(`${line}\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/plans.md:1')
  })
})
