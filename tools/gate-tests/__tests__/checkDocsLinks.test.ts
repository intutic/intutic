/**
 * The docs link gate (tools/scripts/check-docs-links.js).
 *
 * The docs build ignores dead links and VitePress never checks #anchors, so
 * 17 links to renamed headings and 10 links to repo source files (which the
 * site cannot serve) went unnoticed. These pin what counts as a link, how a
 * target resolves, and what fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-docs-links.js')
const gate = (await import(SCRIPT)) as { check(root: string): { links: number; problems: string[] } }

describe('docs links', () => {
  let root: string
  const put = async (file: string, text: string) => {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'docs-internal-'))
    await put(
      'apps/docs/guide/loops.md',
      '# Loops\n## How it works\n## Setup\n## How it works\n### 2. Circuit Breaker Enforcement {#circuit-breaker-enforcement}\n',
    )
    await put('apps/docs/integrations/index.md', '# Integrations\n')
    await put('apps/docs/public/downloads/SKILL.md', 'served as is\n')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('passes pages, .md links, same-page and repeated-heading anchors, public files, and skips code and other sites', async () => {
    await put(
      'apps/docs/guide/budgets.md',
      [
        '# Budgets',
        '## Limits',
        'See [loops](/guide/loops#circuit-breaker-enforcement), [the second](./loops.md#how-it-works-1),',
        '[above](#limits), [integrations](/integrations/), [skill](/downloads/SKILL.md),',
        '[site](https://docs.intutic.ai/guide/loops#setup) and [GitHub](https://github.com/intutic/intutic).',
        '```md',
        '[not a link](/nope)',
        '```',
        'Inline `[nor this](/nope)` either.',
      ].join('\n'),
    )
    expect(gate.check(root)).toEqual({ links: 6, problems: [] })
  })

  it('fails a missing page, a missing anchor, a repo-relative source link, and a stray character', async () => {
    await put(
      'apps/docs/guide/budgets.md',
      [
        '# Budgets',
        '[a](/guide/nope) [b](/guide/loops#_2-circuit-breaker-enforcement)',
        '[c](../../../packages/proxy/src/metering.rs) [d](/guide/loops#setup")',
      ].join('\n'),
    )
    const { problems } = gate.check(root)
    expect(problems).toHaveLength(4)
    expect(problems[0]).toContain('no page apps/docs/guide/nope')
    expect(problems[1]).toContain('no heading #_2-circuit-breaker-enforcement')
    expect(problems[2]).toContain('packages/proxy/src/metering.rs')
    expect(problems[3]).toContain('no heading #setup"')
  })
})
