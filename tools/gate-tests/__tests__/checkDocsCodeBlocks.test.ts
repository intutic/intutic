/**
 * The docs code-block lint (tools/scripts/check-docs-code-blocks.js).
 *
 * configuration.md closed a YAML block with "``` `litellm_params.api_key`…",
 * which CommonMark reads as code, so the rest of the page rendered as one
 * block; and 21 integration pages showed `intutic init` printing relative
 * paths the CLI never prints. These run the real script against a fixture
 * tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/check-docs-code-blocks.js')

function runGate(root: string): Promise<{ status: number; out: string }> {
  return new Promise((res, reject) => {
    const child = spawn('node', [SCRIPT, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (out += d))
    child.on('error', reject)
    child.on('close', (code) => res({ status: code === null ? -1 : code, out }))
  })
}

const MEMBERS = Array.from({ length: 30 }, (_, i) => `h${i}`)
const INIT = '```\n  ✔ cursor → /path/to/project/.cursor/rules/intutic-governance.mdc\n```\n'

let root: string
const put = async (rel: string, body: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body)
}
const page = (body: string) => put('apps/docs/guide/x.md', `# X\n\n${body}\n`)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'docscodeblocks-'))
  await put(
    'packages/shared-types/src/enums.ts',
    `export const HarnessType = {\n  CURSOR: 'cursor',\n${MEMBERS.map((m) => `  ${m.toUpperCase()}: '${m}',`).join('\n')}\n} as const\n`,
  )
  await put('README.md', '# Intutic\n')
  await put('apps/docs/integrations/cursor.md', `# Cursor\n\n${INIT}`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('code fences', () => {
  it('passes language tags, VitePress extras and nested samples in a longer fence', async () => {
    await page('```ts{1,3}\nconst a = 1\n```\n\n```js [config.js]\nx\n```\n\n````markdown\n```bash\nls\n```\n````\n\n~~~\nplain\n~~~\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('[PASS]')
  })

  it('fails a closing fence with prose after it (the configuration.md bug)', async () => {
    await page('```yaml\na: 1\n``` `api_key` is ignored.\n\nMore prose.\n\n```bash\nls\n```\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/x.md:5: a fence line inside the code block opened at line 3 has "`api_key` is ignored."')
  })

  it('fails an opening fence with prose instead of a language tag', async () => {
    await page('```bash run this first\nls\n```\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/x.md:3: a code fence opens with "bash run this first"')
  })

  it('fails a block that never closes', async () => {
    await page('```bash\nls\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/x.md:3: this code block never closes')
  })
})

describe('intutic init samples', () => {
  it('fails a relative path, naming the absolute form', async () => {
    await page('```\n  ✔ codex → AGENTS.md\n```\n')
    await put('packages/shared-types/src/enums.ts', `export const HarnessType = {\n  CURSOR: 'cursor',\n  CODEX: 'codex',\n${MEMBERS.map((m) => `  ${m.toUpperCase()}: '${m}',`).join('\n')}\n} as const\n`)
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('apps/docs/guide/x.md:4: `intutic init` sample shows "AGENTS.md"')
    expect(r.out).toContain('/path/to/project/AGENTS.md')
  })

  it('fails a home-relative path', async () => {
    await page('```\n  ✔ cursor → ~/Library/x.json\n```\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('sample shows "~/Library/x.json"')
  })

  it('fails a harness type the enum does not have', async () => {
    await page('```\n  ✔ cursr → /path/to/project/x\n```\n')
    const r = await runGate(root)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain('names "cursr", which is not a HarnessType value')
  })
})
