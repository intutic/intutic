/**
 * The dashboard link gate (tools/scripts/check-dashboard-links.js).
 *
 * Its first version read only `${APP_URL}/…` in the Slack adapters and
 * `url: \`/…\`` metadata, and so passed while six other backend links 404'd.
 * These pin each link shape it must now see, the `$param` matching the detail
 * routes rely on, and the exit code CI reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-dashboard-links.js')
const gate = (await import(SCRIPT)) as {
  registeredRoutes(src: string): Set<string>
  linkPath(raw: string): string
  matchesRoute(path: string, routes: Set<string>): boolean
  extractLinks(t: typeof ts, source: string, fileName: string): { line: number; kind: string; raw: string }[]
  legacyRedirects(src: string): Map<string, string | null>
}

const paths = (src: string) => gate.extractLinks(ts, src, 'x.ts').map((l) => `${l.kind} ${gate.linkPath(l.raw)}`)

describe('route matching', () => {
  const routes = gate.registeredRoutes("createRoute({ path: '/incidents/$incidentId' }); createRoute({ path: '/sops' })")

  it('accepts an interpolated id against a $param segment', () => {
    expect(gate.linkPath('/incidents/${data.incidentId ?? ""}?tab=x')).toBe('/incidents/:id')
    expect(gate.matchesRoute('/incidents/:id', routes)).toBe(true)
    expect(gate.matchesRoute('/incidents/inc_1', routes)).toBe(true)
  })

  it('rejects a missing route, an extra segment, and a static segment where an id is', () => {
    expect(gate.matchesRoute('/sops/:id', routes)).toBe(false)
    expect(gate.matchesRoute('/incidents/:id/edit', routes)).toBe(false)
    expect(gate.matchesRoute('/settings/org', routes)).toBe(false)
  })
})

describe('legacy redirects', () => {
  it('reads each from: path with its to:, collapsing nothing but a trailing slash', () => {
    const src = [
      'export const LEGACY_REDIRECTS = [',
      "  { from: '/traces', to: '/activity/traces' },",
      "  { from: '/sops/$sopId', to: '/policies/guidelines/$sopId' },",
      "  { from: \"/intelligence\", search: (s: { tab?: string }) => s },",
      '] as const',
    ].join('\n')
    expect([...gate.legacyRedirects(src)]).toEqual([
      ['/traces', '/activity/traces'],
      ['/sops/$sopId', '/policies/guidelines/$sopId'],
      ['/intelligence', null],
    ])
  })
})

describe('link extraction', () => {
  it('reads action_url and *_url/*Url keys: single-quoted, template, through ?: and ??', () => {
    const src = [
      "const a = { action_url: '/decisions' }",
      'const b = { action_url: card.sopId ? `/sops/${card.sopId}` : null }',
      "const c = { returnUrl: x ?? '/upgrade', href: '/traces', link: \"/agents\" }",
      "const d = { title: '/not-a-link', sourceUrl: 'https://example.test/x', url: '//cdn.test/x' }",
    ].join('\n')
    expect(paths(src)).toEqual(['relative /decisions', 'relative /sops/:id', 'relative /upgrade', 'relative /traces', 'relative /agents'])
  })

  it('reads links built on the app URL, mid-template and via bound locals', () => {
    const src = [
      "const APP_URL = process.env.APP_URL ?? 'https://app.example.test'",
      'function getAppUrl() { return process.env.APP_URL ?? "" }',
      'const s = { success_url: `${appUrl}/settings/org?checkout=success`, cancel_url: `${appUrl}/marketplace` }',
      'const html = `',
      '  <p>See <a href="${getAppUrl()}/pricing">plans</a></p>`',
      "const base = getAppUrl().replace(/\\/$/, '')",
      'const n = `${base}/incidents/${id}`',
      "const p = APP_URL + '/guide/getting-started'",
      'c.redirect(`${APP_URL}/settings?tab=notifications`)',
      'const api = `${APP_URL}/api/v1/callback`',
      'const other = `${somethingElse}/not-app`',
    ].join('\n')
    expect(paths(src)).toEqual([
      'app-url /settings/org',
      'app-url /marketplace',
      'app-url /pricing',
      'app-url /incidents/:id',
      'app-url /guide/getting-started',
      'app-url /settings',
      'app-url /api/v1/callback',
    ])
  })

  it('reports the line the link is on, not the first line of its template', () => {
    const links = gate.extractLinks(ts, 'const html = `\n\n<a href="${appUrl}/pricing">`', 'x.ts')
    expect(links).toEqual([{ line: 3, kind: 'app-url', raw: '/pricing' }])
  })
})

describe('check-dashboard-links.js', () => {
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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'check-dashboard-links-'))
    await put('apps/dashboard/src/main.tsx', [
      "createRoute({ path: '/incidents' })",
      "createRoute({ path: '/incidents/$incidentId' })",
      "createRoute({ path: '/settings' })",
    ].join('\n'))
    await put('services/control-plane/src/services/router.ts', [
      "const APP_URL = process.env.APP_URL ?? ''",
      'export const a = { action_url: `/incidents/${data.incidentId}` }',
      'export const b = `${APP_URL}/settings?tab=billing`',
    ].join('\n'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('passes when every link has a route, including /incidents/${id} against /incidents/$incidentId', async () => {
    const r = await run()
    expect(r.out).toContain('✓ all 2 dashboard link(s)')
    expect(r.status).toBe(0)
  })

  it('fails on a missing route and names it', async () => {
    await put('services/control-plane/src/routes/orgs.ts', 'export const s = { success_url: `${appUrl}/settings/org?checkout=success` }')
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('services/control-plane/src/routes/orgs.ts:1  (app-url)')
    expect(r.out).toMatch(/Missing routes:\n {2}\/settings\/org {2}\(1 link\)/)
  })

  it('ignores test files', async () => {
    await put('services/control-plane/src/services/router.test.ts', "export const t = { url: '/nowhere' }")
    expect((await run()).status).toBe(0)
  })

  it('fails rather than passing vacuously when no relative links are found', async () => {
    await put('services/control-plane/src/services/router.ts', 'export const b = `${APP_URL}/settings`')
    const r = await run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('no relative dashboard links found')
  })

  describe('legacy paths', () => {
    // The dashboard after PR 2: canonical routes in main.tsx, old ones only in
    // legacyRedirects.ts.
    beforeEach(async () => {
      await put('apps/dashboard/src/main.tsx', [
        "createRoute({ path: '/findings/incidents' })",
        "createRoute({ path: '/findings/incidents/$incidentId' })",
        "createRoute({ path: '/policies/guidelines/$sopId' })",
        "createRoute({ path: '/settings' })",
      ].join('\n'))
      await put('apps/dashboard/src/routes/legacyRedirects.ts', [
        'export const LEGACY_REDIRECTS = [',
        "  { from: '/incidents', to: '/findings/incidents' },",
        "  { from: '/incidents/$incidentId', to: '/findings/incidents/$incidentId' },",
        "  { from: '/sops/$sopId', to: '/policies/guidelines/$sopId' },",
        '] as const',
      ].join('\n'))
    })

    it('fails on a link to a legacy path, naming the redirect target', async () => {
      await put('services/control-plane/src/services/router.ts', [
        "const APP_URL = process.env.APP_URL ?? ''",
        "export const a = { action_url: '/findings/incidents' }",
        'export const b = `${APP_URL}/incidents?tab=alerts`',
      ].join('\n'))
      const r = await run()
      expect(r.status).toBe(1)
      expect(r.out).toContain('1 dashboard link(s) use a legacy path')
      expect(r.out).toContain('services/control-plane/src/services/router.ts:3  (app-url)')
      expect(r.out).toContain('/incidents matches the legacy path /incidents, which redirects to /findings/incidents')
      // A legacy path is reported as legacy, not as a missing route as well.
      expect(r.out).not.toContain('point at routes that do not exist')
    })

    it('passes when every link uses the canonical path', async () => {
      await put('services/control-plane/src/services/router.ts', [
        "const APP_URL = process.env.APP_URL ?? ''",
        'export const a = { action_url: `/findings/incidents/${data.incidentId}` }',
        'export const b = `${APP_URL}/findings/incidents?tab=alerts`',
        'export const c = { url: `/policies/guidelines/${sopId}` }',
      ].join('\n'))
      const r = await run()
      expect(r.out).toContain('✓ all 3 dashboard link(s)')
      expect(r.out).toContain('none uses one of 3 legacy path(s)')
      expect(r.status).toBe(0)
    })

    it('matches an interpolated detail id against a $param legacy segment', async () => {
      await put('services/control-plane/src/services/router.ts', [
        "const APP_URL = process.env.APP_URL ?? ''",
        'export const a = { action_url: card.sopId ? `/sops/${card.sopId}` : null }',
        'export const b = `${APP_URL}/findings/incidents`',
      ].join('\n'))
      const r = await run()
      expect(r.status).toBe(1)
      expect(r.out).toContain('/sops/:id matches the legacy path /sops/$sopId, which redirects to /policies/guidelines/$sopId')
    })

    it('fails rather than passing vacuously when legacyRedirects.ts lists no paths', async () => {
      await put('apps/dashboard/src/routes/legacyRedirects.ts', 'export const LEGACY_REDIRECTS = LIST')
      const r = await run()
      expect(r.status).toBe(1)
      expect(r.out).toContain('no `from:` paths parsed')
    })
  })

  it('without legacyRedirects.ts, still resolves links and says the legacy check did not run', async () => {
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.out).toContain('no apps/dashboard/src/routes/legacyRedirects.ts, so no legacy-path check')
  })

  it('skips when the dashboard is absent (the public repo)', async () => {
    await put('apps/dashboard/src/routes/legacyRedirects.ts', "export const LEGACY_REDIRECTS = [{ from: '/traces', to: '/activity/traces' }]")
    await rm(join(root, 'apps'), { recursive: true, force: true })
    const r = await run()
    expect(r.status).toBe(0)
    expect(r.out).toContain('Skipping dashboard link check')
  })
})
