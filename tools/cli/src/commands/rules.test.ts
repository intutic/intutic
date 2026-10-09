import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { loadRegoRule } from '@intutic/shared-types'
import {
  REGO_HOST,
  decideCase,
  defaultOutPath,
  extractPolicyWasm,
  parseCases,
  runRulesBuild,
  runRulesTest,
  type RegoCase,
} from './rules.js'
import { runPolicyInstall } from './policy.js'

// The proxy's fixtures: the same OPA builds every host is tested on.
const fixtures = fileURLToPath(new URL('../../../../packages/proxy/tests/fixtures/rego/', import.meta.url))
const EXAMPLES = ['block_destructive_shell', 'hold_prod_deploys', 'deny_writes_outside_repo']

let exitCode: number | null
let output: string[]

beforeEach(() => {
  exitCode = null
  output = []
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`process.exit(${code})`)
  }) as never)
  const capture = (...args: unknown[]) => void output.push(args.join(' '))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['INTUTIC_OPA_BIN']
  delete process.env['INTUTIC_WASM_DIR']
})

async function exits(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
  }
}

describe('intutic rules test', () => {
  it.each(EXAMPLES)('every case for the %s example gets the decision it expects', async (example) => {
    const rule = loadRegoRule(await fs.readFile(path.join(fixtures, 'examples', `${example}.wasm`)), undefined, REGO_HOST)
    const cases = parseCases(await fs.readFile(path.join(fixtures, 'examples', `${example}.cases.json`), 'utf-8'))
    expect(cases.length).toBeGreaterThan(3)
    for (const c of cases) expect(decideCase(rule!, c.input).decision, c.name).toBe(c.expect)
  })

  it('reports the metadata risk tier when a decision names none', async () => {
    const rule = loadRegoRule(await fs.readFile(path.join(fixtures, 'examples/block_destructive_shell.wasm')), undefined, REGO_HOST)
    expect(rule?.riskTier).toBe('critical')
    expect(decideCase(rule!, { tool: 'Bash', args: { command: 'rm -rf /' } })).toEqual({
      decision: 'deny',
      reason: 'destructive shell command blocked: rm -rf /',
      riskTier: 'critical',
    })
  })

  it('passes a case file whose expectations hold, and exits 1 on one that does not', async () => {
    const shell = path.join(fixtures, 'examples/block_destructive_shell.wasm')
    await exits(() => runRulesTest(shell, { input: [path.join(fixtures, 'examples/block_destructive_shell.cases.json')] }))
    expect(exitCode).toBeNull()

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rules-test-'))
    const wrong: RegoCase[] = [{ name: 'wrongly expected', input: { tool: 'Bash', args: { command: 'rm -rf /' } }, expect: 'allow' }]
    await fs.writeFile(path.join(dir, 'cases.json'), JSON.stringify(wrong))
    await exits(() => runRulesTest(shell, { input: [path.join(dir, 'cases.json')] }))
    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('wrongly expected: expected ALLOW, got DENY')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('accepts one bare input document as a case', () => {
    expect(parseCases('{"tool":"Bash"}')).toEqual([{ input: { tool: 'Bash' } }])
    expect(() => parseCases('[{"tool":"Bash"}]')).toThrow(/case 1 has no "input"/)
  })

  it('refuses a native rule, pointing at policy test', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rules-native-'))
    const native = path.join(dir, 'native.wasm')
    await fs.writeFile(native, new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
    await exits(() => runRulesTest(native, { input: [] }))
    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('intutic policy test')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('intutic rules build', () => {
  it('says how to get OPA when it is missing', async () => {
    process.env['INTUTIC_OPA_BIN'] = '/nonexistent/opa'
    await exits(() => runRulesBuild({ rego: 'x.rego', entrypoint: 'intutic/deny' }))
    expect(exitCode).toBe(1)
    expect(output.join('\n')).toMatch(/OPA is required.*INTUTIC_OPA_BIN/s)
  })

  it('refuses an unknown risk tier and a malformed entrypoint before running anything', async () => {
    await exits(() => runRulesBuild({ rego: 'x.rego', entrypoint: 'intutic/deny', riskTier: 'severe' }))
    expect(exitCode).toBe(1)
    exitCode = null
    await exits(() => runRulesBuild({ rego: 'x.rego', entrypoint: 'deny' }))
    expect(exitCode).toBe(1)
  })

  it('reads policy.wasm out of the bundle opa build writes', () => {
    const tarEntry = (name: string, body: Buffer): Buffer => {
      const header = Buffer.alloc(512)
      header.write(name, 0)
      header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
      return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
    }
    const bundle = gzipSync(
      Buffer.concat([tarEntry('/data.json', Buffer.from('{}')), tarEntry('/policy.wasm', Buffer.from('wasm!')), Buffer.alloc(1024)]),
    )
    expect(extractPolicyWasm(bundle).toString()).toBe('wasm!')
    expect(() => extractPolicyWasm(gzipSync(Buffer.alloc(1024)))).toThrow(/no policy.wasm/)
  })

  it('names the output after the entrypoint', () => {
    expect(defaultOutPath('intutic/shell/deny')).toBe(path.join('build', 'intutic_shell_deny.wasm'))
  })
})

describe('intutic policy install with a Rego rule', () => {
  it('installs a Rego rule after loading and evaluating it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rules-install-'))
    process.env['INTUTIC_WASM_DIR'] = dir
    await exits(() =>
      runPolicyInstall({ wasm: path.join(fixtures, 'examples/hold_prod_deploys.wasm'), name: 'deploys', priority: '20' }),
    )
    expect(exitCode).toBeNull()
    expect(await fs.readdir(dir)).toEqual(['20_deploys.wasm'])
    expect(output.join('\n')).toContain('Installed Rego rule "deploys"')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('refuses one needing a builtin no host provides, by name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rules-install-'))
    process.env['INTUTIC_WASM_DIR'] = dir
    await exits(() => runPolicyInstall({ wasm: path.join(fixtures, 'unsupported_builtin.wasm') }))
    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('crypto.md5')
    expect(await fs.readdir(dir)).toEqual([])
    await fs.rm(dir, { recursive: true, force: true })
  })
})
