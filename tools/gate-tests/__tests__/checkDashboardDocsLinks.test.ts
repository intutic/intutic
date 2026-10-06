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
