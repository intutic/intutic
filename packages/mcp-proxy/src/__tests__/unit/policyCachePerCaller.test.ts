/**
 * The daemon's shared (Valkey) policy entry is the caller's, not the
 * workspace's: `GET /api/v1/policy/resolve` answers for the calling key's
 * member (their role's hook rules, their principal), so two daemons with
 * different members' keys on one Valkey must never be served each other's
 * entry. One invalidation reaches every caller's entry, by generation.
 *
 * Two daemons are two fresh imports of the module (two in-process caches)
 * over one Valkey, against a stand-in control plane that answers by bearer.
 * Needs a Valkey at VALKEY_URL; without one the test is skipped, and says so.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { mcpDaemonPolicyGenKey } from '@intutic/shared-types'

type PolicyCacheModule = typeof import('../../daemon/policyCache.js')

const DEV_KEY = ['vk', 'devpercaller', 'ws'].join('_')
const ADMIN_KEY = ['vk', 'adminpercaller', 'ws'].join('_')

describe('the daemon policy cache is per caller', () => {
  const ws = `ws_per_caller_${Date.now()}`
  let server: http.Server
  let valkey: Redis | null = null
  let retired = false
  const saved = { key: process.env['INTUTIC_API_KEY'], cp: process.env['CONTROL_PLANE_URL'] }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const developer = req.headers.authorization === `Bearer ${DEV_KEY}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          workspaceId: ws,
          // A developer-scoped refusal, served only to the developer's key.
          sopRules: developer && !retired ? [{ id: 'guardrail.pgr_dev', toolPattern: '^Bash$', action: 'block', reason: 'no prod-db', origin: 'guardrail', roles: ['developer'] }] : [],
          dlpPatterns: [],
          interventionMode: 'TRANSPARENT',
          mcpRegistry: { defaultPolicy: 'allow', servers: [] },
          principal: { memberId: developer ? 'mem_dev' : 'mem_admin', email: 'x@example.test', role: developer ? 'DEVELOPER' : 'ADMIN', ssoGroups: [] },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const probe = new Redis(process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
    try {
      await probe.connect()
      valkey = probe
    } catch {
      probe.disconnect()
    }
  })

  afterAll(async () => {
    if (saved.key === undefined) delete process.env['INTUTIC_API_KEY']
    else process.env['INTUTIC_API_KEY'] = saved.key
    if (saved.cp === undefined) delete process.env['CONTROL_PLANE_URL']
    else process.env['CONTROL_PLANE_URL'] = saved.cp
    if (valkey) {
      const keys = await valkey.keys(`mcp_daemon:policy*${ws}*`)
      if (keys.length) await valkey.del(...keys)
      valkey.disconnect()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** A fresh daemon whose cache is empty in process; once its shared tier is up, so a Valkey hit is possible. */
  async function freshDaemon(): Promise<PolicyCacheModule> {
    vi.resetModules()
    const mod = await import('../../daemon/policyCache.js')
    // The module connects lazily: the first miss only starts the connection.
    // Resolve throwaway workspaces until one is written through, so the
    // shared tier is up before the workspace under test.
    for (let i = 0; i < 40; i++) {
      const warm = `${ws}_warm${i}`
      await mod.resolvePolicy(warm)
      await new Promise((r) => setTimeout(r, 25))
      if ((await valkey!.keys(`mcp_daemon:policy:${warm}*`)).length > 0) return mod
    }
    throw new Error('the daemon never wrote through to Valkey')
  }

  async function resolveAs(daemon: PolicyCacheModule, key: string) {
    process.env['INTUTIC_API_KEY'] = key
    const p = await daemon.resolvePolicy(ws)
    return { rules: (p?.sopRules ?? []).map((r) => r['id']), role: p?.principal?.role }
  }

  /** Every shared entry for the workspace under test, whatever its key shape. */
  const entries = async () => [...(await valkey!.keys(`mcp_daemon:policy:${ws}`)), ...(await valkey!.keys(`mcp_daemon:policy:${ws}:*`))]

  async function sharedEntries(n: number): Promise<string[]> {
    for (let i = 0; i < 40; i++) {
      const keys = await entries()
      if (keys.length >= n) return keys
      await new Promise((r) => setTimeout(r, 25))
    }
    return entries()
  }

  it('serves each member their own set from the shared tier, and one invalidation reaches both', { timeout: 30_000 }, async (ctx) => {
    if (!valkey) {
      ctx.skip()
      return
    }
    process.env['INTUTIC_API_KEY'] = DEV_KEY
    const dev = await freshDaemon()
    expect(await resolveAs(dev, DEV_KEY)).toEqual({ rules: ['guardrail.pgr_dev'], role: 'DEVELOPER' })
    expect(await sharedEntries(1)).toHaveLength(1)

    process.env['INTUTIC_API_KEY'] = ADMIN_KEY
    const admin = await freshDaemon()
    expect(await resolveAs(admin, ADMIN_KEY), "the admin's daemon was served the developer's entry").toEqual({ rules: [], role: 'ADMIN' })
    expect(await sharedEntries(2)).toHaveLength(2)

    process.env['INTUTIC_API_KEY'] = DEV_KEY
    expect(await resolveAs(await freshDaemon(), DEV_KEY), "the developer's daemon was served the admin's entry").toEqual({ rules: ['guardrail.pgr_dev'], role: 'DEVELOPER' })

    // The control plane retires the rule and bumps the generation, as
    // `invalidatePolicyCaches` does: neither caller's entry is read again.
    retired = true
    await valkey.incr(mcpDaemonPolicyGenKey(ws))
    expect(await resolveAs(await freshDaemon(), DEV_KEY)).toEqual({ rules: [], role: 'DEVELOPER' })
    process.env['INTUTIC_API_KEY'] = ADMIN_KEY
    expect(await resolveAs(await freshDaemon(), ADMIN_KEY)).toEqual({ rules: [], role: 'ADMIN' })
  })
})
