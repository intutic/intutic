/**
 * The dashboard docs-link gate (tools/scripts/check-dashboard-docs-links.js).
 *
 * 14 of the dashboard's 22 help links answered 404 before it existed: their
 * pages were left out of docs.intutic.ai, and three Settings anchors named
 * headings the page never had. These pin VitePress's heading slugs, the page
 * lookup, and the public-repo skip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-dashboard-docs-links.js')
const gate = (await import(SCRIPT)) as {
  slugify(text: string): string
  headingAnchors(markdown: string): Set<string>
  check(root: string): { skipped: boolean; links: number; problems: string[] }
  helpLinkProblems(root: string, exempt?: Map<string, string>): string[]
}

describe('heading anchors', () => {
  it('slugs heading text the way VitePress does', () => {
    expect(gate.slugify('AI Routing & Caching')).toBe('ai-routing-caching')
    expect(gate.slugify('Team Members')).toBe('team-members')
    expect(gate.slugify('2FA setup')).toBe('_2fa-setup')
  })

  it('takes an explicit {#id}, drops badges and markup, and skips fenced code', () => {
    const md = [
      '# Settings',
      '## Team Members {#members}',
      '## AI Routing & Caching <Badge type="tip" text="Cloud" />',
      '## The `sync` [daemon](/x)',
      '```md',
      '## Not a heading',
      '```',
    ].join('\n')
    expect([...gate.headingAnchors(md)]).toEqual(['settings', 'members', 'ai-routing-caching', 'the-sync-daemon'])
  })
})

describe('check', () => {
  let root: string
  const put = async (file: string, text: string) => {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'docs-links-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('passes links to pages and headings that exist, including an index page', async () => {
    await put('apps/docs/guide/settings.md', '# Settings\n## Team Members {#members}\n')
    await put('apps/docs/integrations/index.md', '# Integrations\n')
    await put(
      'apps/dashboard/src/Page.tsx',
      "const a = 'https://docs.intutic.ai/guide/settings#members'; const b = 'https://docs.intutic.ai/integrations/'",
    )
    expect(gate.check(root)).toEqual({ skipped: false, links: 2, problems: [] })
  })

  it('fails a missing page and a missing anchor, and ignores tests', async () => {
    await put('apps/docs/guide/settings.md', '# Settings\n## Team Members\n')
    await put(
      'apps/dashboard/src/Page.tsx',
      "'https://docs.intutic.ai/guide/compliance'; 'https://docs.intutic.ai/guide/settings#members'",
    )
    await put('apps/dashboard/src/Page.test.tsx', "'https://docs.intutic.ai/guide/nope'")
    const { links, problems } = gate.check(root)
    expect(links).toBe(2)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('no page at apps/docs/guide/compliance')
    expect(problems[1]).toContain('no heading with anchor #members')
  })

  it('skips a checkout without the dashboard (the public repo)', async () => {
    await put('apps/docs/index.md', '# Docs\n')
    expect(gate.check(root)).toEqual({ skipped: true, links: 0, problems: [] })
  })
})

describe('help links on navigation pages', () => {
  let root: string
  const put = async (file: string, text: string) => {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }
  const LINKED = "export function A() { return <a href={docs('https://docs.intutic.ai/guide/a')}>A guide</a> }"

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'help-links-'))
    await put(
      'apps/dashboard/src/components/layout/areas.tsx',
      [
        'export const AREAS: Area[] = [',
        "  { id: 'a', label: 'A', root: '/a', pages: [{ path: '/a', label: 'A' }, { path: '/a/b', label: 'B', roles: LEADS }] },",
        ']',
        '',
        "export function areaForPath(p: string) { return p === '/elsewhere' }",
      ].join('\n'),
    )
    await put(
      'apps/dashboard/src/main.tsx',
      [
        "const a = createRoute({ path: '/a', component: lazyRouteComponent(() => import('./routes/APage'), 'APage') })",
        "const b = createRoute({",
        "  path: '/a/b',",
        "  component: lazyRouteComponent(() => import('./routes/BPage'), 'BPage'),",
        '})',
        "const login = createRoute({ path: '/login', component: LoginPage })",
      ].join('\n'),
    )
    await put('apps/dashboard/src/routes/APage.tsx', LINKED)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('passes when every page in AREAS has a docs link in its route module', async () => {
    await put('apps/dashboard/src/routes/BPage.tsx', LINKED)
    expect(gate.helpLinkProblems(root)).toEqual([])
  })

  it('fails a page whose route module has no docs link', async () => {
    await put('apps/dashboard/src/routes/BPage.tsx', 'export function BPage() { return <h1>B</h1> }')
    const problems = gate.helpLinkProblems(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('/a/b (apps/dashboard/src/routes/BPage.tsx): no https://docs.intutic.ai/ help link')
  })

  it('accepts an exemption with a reason, and fails one that is stale', async () => {
    await put('apps/dashboard/src/routes/BPage.tsx', 'export function BPage() { return <h1>B</h1> }')
    expect(gate.helpLinkProblems(root, new Map([['/a/b', 'a redirect with no content of its own']]))).toEqual([])
    const stale = gate.helpLinkProblems(
      root,
      new Map([
        ['/a', 'linked already'],
        ['/a/b', 'reason'],
        ['/gone', 'removed page'],
      ]),
    )
    expect(stale).toEqual([
      '/a: has a help link now; remove its NO_HELP_LINK entry',
      'NO_HELP_LINK lists /gone, which AREAS does not; remove the entry',
    ])
  })

  it('fails a page main.tsx renders from no route module', async () => {
    await put('apps/dashboard/src/main.tsx', "const a = createRoute({ path: '/a', component: lazyRouteComponent(() => import('./routes/APage'), 'APage') })")
    expect(gate.helpLinkProblems(root)).toEqual(['/a/b: apps/dashboard/src/main.tsx registers no ./routes/ module for it'])
  })
})
