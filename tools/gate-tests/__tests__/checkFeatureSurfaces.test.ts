/**
 * The feature-surfaces gate (tools/scripts/check-feature-surfaces.js).
 *
 * Runs the real script against fixture trees, since what is under test is its
 * exit code: a feature that says nothing about an interface, evidence that does
 * not exist, a gap whose wanted surface now exists, a docs badge naming a
 * different plan than the feature's, a route whose role drifted, and a new
 * route, command, page, refusal code or event type that no feature claims must
 * each fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-feature-surfaces.js')
const INTERFACES = [
  'api',
  'dashboard',
  'cli',
  'gateSdk',
  'clawdeSdk',
  'mcpTools',
  'kitkat',
  'terraform',
  'docs',
  'website',
  'events',
  'enforcement',
]

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, INTUTIC_WEBSITE_DIR: '' },
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

let root: string
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'featuresurfaces-'))
  await put('apps/docs/guide/widgets.md', '# Widgets <Badge type="tip" text="Cloud" />\n\n## Widget budgets\n\nText.\n')
  await put(
    'apps/docs/reference/api.md',
    '### `widgets.ts` <Badge type="tip" text="Cloud" />\n\n| Method | Path | Auth | Description |\n|---|---|---|---|\n| GET | `/api/v1/widgets` | OWNER/ADMIN | List widgets |\n',
  )
  await put(
    'apps/docs/reference/cli.md',
    '# CLI\n\n## `intutic widgets list` <Badge type="tip" text="Cloud" />\n\n| `--json` | Print JSON |\n',
  )
  await put('tools/cli/src/cli.ts', "program.command('widgets').command('list').option('--json')\n")
  // The two reference pages are surfaces too; they predate the fixture's feature.
  await baseline({ docsPages: ['reference/api.md', 'reference/cli.md'] })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Surfaces = Record<string, unknown>
const none = { none: 'not part of this fixture' }
const feature = (surfaces: Surfaces, extra: Record<string, unknown> = {}) => ({
  id: 'widgets',
  title: 'Widgets',
  plan: 'Cloud',
  ...extra,
  surfaces: {
    ...Object.fromEntries(INTERFACES.map((i) => [i, none])),
    ...surfaces,
  },
})
const manifest = (features: unknown[], unclaimed?: unknown) =>
  put('tools/scripts/feature-surfaces.json', JSON.stringify({ features, unclaimed }))
const baseline = (b: Record<string, string[]>) => put('tools/scripts/feature-surfaces-baseline.json', JSON.stringify(b))

const present = {
  api: ['GET /api/v1/widgets'],
  cli: ['widgets list --json'],
  docs: ['guide/widgets.md#widget-budgets'],
}

describe('feature surfaces', () => {
  it('passes when every listed surface exists and every interface is decided', async () => {
    await manifest([feature(present)])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('3 surface(s) exist')
  })

  it('fails a feature that says nothing about an interface', async () => {
    const f = feature(present)
    delete (f.surfaces as Surfaces).kitkat
    await manifest([f])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('says nothing about kitkat')
  })

  it.each([
    ['api', ['POST /api/v1/widgets'], 'route catalog has no POST /api/v1/widgets'],
    ['cli', ['widgets list --yaml'], 'does not document --yaml'],
    ['cli', ['widgets show'], 'no section for `intutic widgets show`'],
    ['docs', ['guide/widgets.md#widget-limits'], 'has no heading #widget-limits'],
    ['kitkat', ['widget refusals'], 'the Kitkat SKILL.md is missing'],
    ['mcpTools', ['intutic_widgets'], 'registers no tool named intutic_widgets'],
    ['terraform', ['intutic_widget'], 'registers no intutic_widget'],
    ['terraform', ['workspace_settings.widgets'], 'workspace_settings_keys.json is missing'],
    ['events', ['widget.created'], 'NotificationEventType has no widget.created'],
    ['enforcement', ['mcp:WIDGET_DENIED'], 'refusal-codes.json has no mcp:WIDGET_DENIED'],
  ])('fails missing %s evidence %j', async (iface, evidence, why) => {
    await manifest([feature({ ...present, [iface]: evidence })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(why)
  })

  it('resolves MCP tools, Terraform resources and settings keys, events and refusal codes', async () => {
    await put('packages/mcp-proxy/src/proxy.ts', "server.tool(\n  'intutic_widgets',\n  'Lists widgets.',\n)\n")
    await put(
      'packages/terraform-provider-intutic/internal/provider/widget_resource.go',
      'resp.TypeName = req.ProviderTypeName + "_widget"\n',
    )
    await put('packages/terraform-provider-intutic/internal/provider/workspace_settings_keys.json', '{"keys":["widgets"]}')
    await put('apps/docs/reference/terraform/resources/widget.md', '# intutic_widget\n')
    await put(
      'packages/shared-types/src/notifications.ts',
      "export type NotificationEventType =\n  | 'widget.created'\n  | 'widget.deleted'\n\nexport {}\n",
    )
    await put('apps/docs/guide/settings.md', '# Settings\n\n| `widget.created` | A widget was made |\n')
    await put(
      'packages/shared-types/fixtures/refusal-codes.json',
      JSON.stringify({ mcp: { refusals: [{ code: 'WIDGET_DENIED' }] } }),
    )
    await baseline({ docsPages: ['reference/api.md', 'reference/cli.md', 'guide/settings.md'], eventTypes: [] })
    const f = feature({
      ...present,
      mcpTools: ['intutic_widgets'],
      terraform: ['intutic_widget', 'workspace_settings.widgets'],
      events: ['widget.created'],
      enforcement: ['mcp:WIDGET_DENIED'],
    })
    await manifest([f])
    let r = await runGate(root)
    // widget.deleted is in the union, and nothing claims it.
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('eventTypes: widget.deleted is new and no feature claims it')
    expect(r.out).not.toContain('reference/terraform/resources/widget.md')

    await manifest([f], { eventTypes: { 'widget.deleted': 'retired with the widgets API' } })
    r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('8 surface(s) exist')
  })

  it('fails a route whose role differs from the one the feature pins', async () => {
    await manifest([feature({ ...present, api: [{ ref: 'GET /api/v1/widgets', auth: 'OWNER/ADMIN/EM' }] })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('gives GET /api/v1/widgets the role "OWNER/ADMIN", not "OWNER/ADMIN/EM"')

    await manifest([feature({ ...present, api: [{ ref: 'GET /api/v1/widgets', auth: 'OWNER/ADMIN' }] })])
    expect((await runGate(root)).status).toBe(0)
  })

  it('fails a gap whose wanted surface now exists', async () => {
    await manifest([feature({ ...present, cli: { gap: 'no list command', want: ['widgets list'] } })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('the cli gap is closed')
  })

  it('keeps an open gap quiet', async () => {
    await manifest([feature({ ...present, cli: { gap: 'no show command', want: ['widgets show'], have: ['widgets list'] } })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
  })

  it('fails a surface whose plan badge differs from the feature plan, unless it is a known badge gap', async () => {
    await manifest([feature(present, { plan: 'Biz Org+' })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('carries the "Cloud" badge')

    const known = Object.fromEntries(
      ['GET /api/v1/widgets', 'widgets list --json', 'guide/widgets.md#widget-budgets'].map((l) => [l, 'docs lag the plan']),
    )
    await manifest([feature(present, { plan: 'Biz Org+', badgeGaps: known })])
    expect((await runGate(root)).status).toBe(0)

    await manifest([feature(present, { badgeGaps: { 'GET /api/v1/widgets': 'docs lag the plan' } })])
    const closed = await runGate(root)
    expect(closed.status, closed.out).toBe(1)
    expect(closed.out).toContain('badge gap on GET /api/v1/widgets is closed')
  })

  describe('surfaces no feature claims', () => {
    beforeEach(async () => {
      await appendFile(join(root, 'apps/docs/reference/api.md'), '| POST | `/api/v1/widgets/frob` | OWNER/ADMIN | Frob |\n')
    })

    it('fails a new route that no feature cites', async () => {
      await manifest([feature(present)])
      const r = await runGate(root)
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('routes: POST /api/v1/widgets/frob is new and no feature claims it')
    })

    it('passes once a feature claims it, or "unclaimed" excuses it with a reason', async () => {
      await manifest([feature({ ...present, api: ['GET /api/v1/widgets', 'POST /api/v1/widgets/frob'] })])
      expect((await runGate(root)).status).toBe(0)

      await manifest([feature(present)], { routes: { 'POST /api/v1/widgets/frob': 'an internal health hook' } })
      expect((await runGate(root)).status).toBe(0)

      await manifest([feature(present)], { routes: { 'POST /api/v1/widgets/frob': ' ' } })
      const r = await runGate(root)
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('unclaimed routes: POST /api/v1/widgets/frob has no reason')
    })

    it('fails a baseline entry that is gone, or that a feature now claims', async () => {
      await baseline({
        routes: ['POST /api/v1/widgets/frob', 'DELETE /api/v1/widgets'],
        docsPages: ['reference/api.md', 'reference/cli.md', 'guide/widgets.md'],
      })
      await manifest([feature(present)])
      const r = await runGate(root)
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain('baseline routes: DELETE /api/v1/widgets no longer exists')
      expect(r.out).toContain('baseline docsPages: guide/widgets.md is claimed by "widgets"')
    })

    it('skips the SIEM inventory where the control plane is absent, and says so', async () => {
      await manifest([feature(present)], { routes: { 'POST /api/v1/widgets/frob': 'an internal health hook' } })
      await baseline({ docsPages: ['reference/api.md', 'reference/cli.md'], eventTypes: ['siem:widget_rows'] })
      const r = await runGate(root)
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain('1 skipped')
    })
  })

  it('fails when every surface it lists was skipped as enterprise-only', async () => {
    await baseline({
      routes: ['GET /api/v1/widgets'],
      cli: ['widgets list'],
      docsPages: ['reference/api.md', 'reference/cli.md', 'guide/widgets.md'],
    })
    await manifest([feature({ dashboard: [{ file: 'apps/dashboard/src/Widgets.tsx' }] })])
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('asserted nothing')
  })
})
