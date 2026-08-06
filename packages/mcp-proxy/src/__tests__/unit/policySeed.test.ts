/**
 * Seeding the daemon's policy cache from the local snapshot.
 *
 * The interesting assertions here are the negative ones. The snapshot carries
 * two rule arrays and they are not interchangeable: `rules` is the *gate*
 * projection (space-padded EREs, `{source, severity, subject}`, `warn` rules
 * already dropped), `sopRules` is the resolve response (`{toolPattern, action}`).
 * Seeding from `rules` passes this module's own parse and is then rejected
 * wholesale by `isSopRule` downstream — producing a cache that reports entries
 * and enforces nothing. That failure is silent, which is why it is tested
 * directly rather than left to review.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFromSnapshot, invalidatePolicy, resolvePolicy } from '../../daemon/policyCache.js'
import { isSopRule } from '../../policy.js'

const WS = 'ws_seed_test'

function writeSnapshot(dir: string, body: Record<string, unknown>): string {
  const p = join(dir, 'policy-snapshot.json')
  writeFileSync(p, JSON.stringify(body, null, 2))
  return p
}

describe('seedFromSnapshot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-seed-'))
  })

  afterEach(() => {
    invalidatePolicy(WS)
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds rules the downstream guard actually accepts', async () => {
    const file = writeSnapshot(dir, {
      workspaceId: WS,
      generatedAt: new Date().toISOString(),
      interventionMode: 'ENFORCE',
      sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' }],
      rules: [{ id: 'sop.s1', source: ' (Bash) ', subject: 'tool', severity: 'block', reason: 'no shell' }],
    })

    expect(await seedFromSnapshot(file)).toBe(WS)

    // Resolves with no network call — the whole point.
    const policy = await resolvePolicy(WS)
    expect(policy).not.toBeNull()
    expect(policy!.sopRules).toHaveLength(1)

    // The load-bearing assertion: these survive `isSopRule`. Seeding the `rules`
    // array instead would satisfy every check above and fail this one.
    expect(
      policy!.sopRules.filter((r) => isSopRule(r)),
      'seeded rules were dropped by isSopRule — the cache would enforce nothing',
    ).toHaveLength(1)
  })

  it('refuses to seed a snapshot that carries only the gate projection', async () => {
    // An older snapshot format. Seeding an empty policy here would be
    // indistinguishable downstream from "this workspace has no rules".
    const file = writeSnapshot(dir, {
      workspaceId: WS,
      generatedAt: new Date().toISOString(),
      rules: [{ id: 'sop.s1', source: ' (Bash) ', severity: 'block' }],
    })
    expect(await seedFromSnapshot(file)).toBeNull()
    expect(await resolvePolicy(WS).catch(() => null)).not.toMatchObject({ sopRules: [] })
  })

  it('carries the snapshot’s own age rather than stamping it fresh', async () => {
    // A snapshot written three days ago must seed AND be recognised as stale, so
    // the first request answers instantly and refreshes behind it. Stamping
    // Date.now() would present three-day-old policy as current for a full TTL.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const file = writeSnapshot(dir, {
      workspaceId: WS,
      generatedAt: threeDaysAgo,
      sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }],
    })
    expect(await seedFromSnapshot(file)).toBe(WS)
    const policy = await resolvePolicy(WS)
    expect(policy).not.toBeNull()
    expect(
      Date.now() - policy!.cachedAt,
      'the snapshot was stamped fresh, so its staleness is now invisible',
    ).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('treats an unparseable timestamp as maximally stale, not as fresh', async () => {
    const file = writeSnapshot(dir, {
      workspaceId: WS,
      generatedAt: 'not a date',
      sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }],
    })
    expect(await seedFromSnapshot(file)).toBe(WS)
    const policy = await resolvePolicy(WS)
    expect(policy!.cachedAt).toBe(0)
  })

  it('returns null instead of throwing on a missing or malformed snapshot', async () => {
    // This runs inside the daemon's main(), whose rejections become
    // process.exit(1) on a KeepAlive service — a throw would be a restart loop.
    expect(await seedFromSnapshot(join(dir, 'nope.json'))).toBeNull()

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(await seedFromSnapshot(bad)).toBeNull()

    const noWs = writeSnapshot(dir, { sopRules: [] })
    expect(await seedFromSnapshot(noWs)).toBeNull()
  })
})
