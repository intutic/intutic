import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApiClient } from '../lib/api.js'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => null),
}))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))

const { postWithStatusMock, getWithStatusMock, postFormMock } = vi.hoisted(() => ({
  postWithStatusMock: vi.fn(),
  getWithStatusMock: vi.fn(),
  postFormMock: vi.fn(),
}))
vi.mock('../lib/api.js', () => ({
  createApiClient: () => ({ postWithStatus: postWithStatusMock, getWithStatus: getWithStatusMock, postForm: postFormMock }),
}))

import {
  buildCompileArgs,
  fetchCandidateSource,
  uploadCandidateBundle,
  runPolicyCompile,
  candidateSourcePath,
  candidateOutPath,
  sourceSha256Of,
  installedFileName,
  instantiateAndEvaluate,
  parseRuleFileName,
  runPolicyInstall,
  runPolicyReplay,
  DEFAULT_ALLOW_MOCK,
  HOST_IMPORT_NAMES,
  unsupportedImports,
  explainUnsupportedImport
} from './policy.js'

describe('parseRuleFileName', () => {
  it('parses NN_name.wasm into priority and name', () => {
    expect(parseRuleFileName('10_block-prod-db.wasm')).toEqual({
      priority: 10,
      name: 'block-prod-db'
    })
    expect(parseRuleFileName('05_a.wasm')).toEqual({ priority: 5, name: 'a' })
  })

  it('defaults to priority 100 without a numeric prefix', () => {
    expect(parseRuleFileName('my-rule.wasm')).toEqual({ priority: 100, name: 'my-rule' })
    expect(parseRuleFileName('block_prod.wasm')).toEqual({ priority: 100, name: 'block_prod' })
    expect(parseRuleFileName('_hidden.wasm')).toEqual({ priority: 100, name: '_hidden' })
  })
})

describe('installedFileName', () => {
  it('formats priority_name.wasm and sanitizes unsafe characters', () => {
    expect(installedFileName(10, 'block-prod-db')).toBe('10_block-prod-db.wasm')
    expect(installedFileName(100, 'my rule.wasm')).toBe('100_my-rule.wasm')
    expect(installedFileName(5, 'a/b\\c')).toBe('5_a-b-c.wasm')
  })

  it('round-trips through parseRuleFileName', () => {
    const file = installedFileName(42, 'budget-guard')
    expect(parseRuleFileName(file)).toEqual({ priority: 42, name: 'budget-guard' })
  })

  it('preserves leading underscores so names round-trip', () => {
    expect(installedFileName(100, '_hidden')).toBe('100__hidden.wasm')
    expect(parseRuleFileName('100__hidden.wasm')).toEqual({ priority: 100, name: '_hidden' })
  })
})

describe('buildCompileArgs', () => {
  it('mirrors the wasm-sdk build flags with defaults', () => {
    expect(buildCompileArgs({})).toEqual([
      '--no-install',
      'asc',
      'assembly/index.ts',
      '-o',
      'build/rule.wasm',
      '--optimize',
      '--exportRuntime'
    ])
  })

  it('honors src/out overrides and adds debug flags only on demand', () => {
    const args = buildCompileArgs({ src: 'rules/main.ts', out: 'out/r.wasm', debug: true })
    expect(args).toContain('rules/main.ts')
    expect(args).toContain('out/r.wasm')
    expect(args).toContain('--debug')
    expect(args).toContain('--sourceMap')
    expect(buildCompileArgs({})).not.toContain('--sourceMap')
  })
})

describe('instantiateAndEvaluate', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sdkWasm = path.resolve(here, '../../../../packages/wasm-sdk/build/rule.wasm')

  it('rejects a buffer that is not a WASM module', async () => {
    await expect(
      instantiateAndEvaluate(Buffer.from('not wasm'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow()
  })

  it('evaluates the checked-in wasm-sdk rule against the allow mock', async () => {
    // Monorepo-only fixture: skip when the built SDK rule is absent.
    let wasmBuffer: Buffer
    try {
      wasmBuffer = await fs.readFile(sdkWasm)
    } catch {
      console.log('skipping: packages/wasm-sdk/build/rule.wasm not present')
      return
    }
    const verdict = await instantiateAndEvaluate(wasmBuffer, DEFAULT_ALLOW_MOCK)
    expect(verdict).toBe(0)
  })
})

/** LEB128-length-prefixed UTF-8 bytes of a name, shared by every hand-encoded fixture below. */
const str = (v: string) => [v.length, ...[...v].map((c) => c.charCodeAt(0))]

/**
 * Builds a minimal, valid WASM module whose only content is one function import.
 *
 * Hand-encoded rather than compiled. A checked-in `.wasm` fixture is a binary
 * nobody can read in review, and compiling one with `asc` at test time would
 * make this depend on the SDK building — turning a toolchain problem into a
 * silent pass on the one assertion that stops a rule enforcing nothing.
 */
function moduleImporting(module: string, name: string): Uint8Array<ArrayBuffer> {
  // One type: () -> f64, which is `seed`'s signature. The import section is all
  // this reads; the type only has to be valid.
  const typeSection = [0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7c]
  const entry = [...str(module), ...str(name), 0x00, 0x00]
  const importSection = [0x02, entry.length + 1, 0x01, ...entry]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...importSection,
  ])
}

/**
 * Builds a minimal, valid, IMPORT-FREE rule module that ignores its input and
 * always returns `verdictCode` — for testing what `runPolicyInstall` does with
 * a verdict the proxy does not map, without depending on `asc` or a real rule.
 *
 * Exports exactly what `resolveGuestAbi` requires: `memory`, `allocate`
 * (i32 -> i32, body ignored — the caller's `evaluate` never reads what it
 * wrote), and `evaluate` (i32, i32 -> i32, body ignores both params and
 * returns the constant).
 */
function moduleReturningVerdict(verdictCode: number): Uint8Array<ArrayBuffer> {
  const typeSection = [
    0x01, // section id
    0x0c, // byte length
    0x02, // 2 types
    0x60, 0x01, 0x7f, 0x01, 0x7f, // type 0: (i32) -> i32        [allocate]
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type 1: (i32, i32) -> i32   [evaluate]
  ]
  const functionSection = [0x03, 0x03, 0x02, 0x00, 0x01] // 2 funcs: type 0, type 1
  const memorySection = [0x05, 0x03, 0x01, 0x00, 0x01] // 1 memory, min 1 page
  const exports = [
    ...str('memory'), 0x02, 0x00, // memory export, index 0
    ...str('allocate'), 0x00, 0x00, // func export, index 0
    ...str('evaluate'), 0x00, 0x01, // func export, index 1
  ]
  const exportSection = [0x07, exports.length + 1, 0x03, ...exports]
  const allocateBody = [0x00, 0x41, 0x00, 0x0b] // locals: none; i32.const 0; end
  const evaluateBody = [0x00, 0x41, verdictCode, 0x0b] // locals: none; i32.const <code>; end
  const code = [
    0x02, // 2 function bodies
    allocateBody.length, ...allocateBody,
    evaluateBody.length, ...evaluateBody,
  ]
  const codeSection = [0x0a, code.length, ...code]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ])
}

describe('host import enforcement', () => {
  /**
   * The bypass this closes: `env.seed` was offered by the CLI's validation shim
   * and never registered by the proxy. A rule reaching `Math.random()` — which
   * AssemblyScript compiles to `env.seed` — passed `policy test` and
   * `policy install`, then failed to instantiate in the proxy. The proxy's WASM
   * runner fails OPEN on every error path, so the rule enforced nothing and
   * nothing said so.
   */
  it('names an import the sandbox does not provide', async () => {
    const mod = await WebAssembly.compile(moduleImporting('env', 'seed'))
    expect(unsupportedImports(mod)).toEqual(['env.seed'])
  })

  it.each([...HOST_IMPORT_NAMES])('accepts env.%s, which the proxy registers', async (name) => {
    const mod = await WebAssembly.compile(moduleImporting('env', name))
    expect(unsupportedImports(mod)).toEqual([])
  })

  it('rejects an import from a module other than env', async () => {
    const mod = await WebAssembly.compile(moduleImporting('wasi_snapshot_preview1', 'fd_write'))
    expect(unsupportedImports(mod)).toEqual(['wasi_snapshot_preview1.fd_write'])
  })

  it('fails validation naming the import, not with a V8 LinkError', async () => {
    // The outcome was already a rejection — instantiation cannot succeed without
    // the import. What was missing is any way for the author to learn the cause
    // was `Math.random()`.
    await expect(
      instantiateAndEvaluate(moduleImporting('env', 'seed'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow(/env\.seed/)
  })

  it('explains why randomness in particular is refused', () => {
    const why = explainUnsupportedImport('env.seed')
    expect(why).toMatch(/Math\.random/)
    expect(why, 'the reason must be stated, or it reads as an oversight').toMatch(/audit/i)
  })

  it('offers the available imports in the failure', async () => {
    await expect(
      instantiateAndEvaluate(moduleImporting('env', 'seed'), DEFAULT_ALLOW_MOCK)
    ).rejects.toThrow(/env\.log_info/)
  })
})

/**
 * `runPolicyInstall` end to end: everything above tests the two primitives it
 * calls, never the command itself. The gap that leaves is real — a regression
 * in how `runPolicyInstall` wires `instantiateAndEvaluate`'s rejection to
 * `process.exit` (an unwrapped call, a swallowed catch, an `if` that only
 * warns) would pass every test above and still let a `seed`-importing or
 * unmapped-verdict rule install clean.
 */
describe('runPolicyInstall end to end', () => {
  let wasmDir: string
  let exitCode: number | null
  let envDirBefore: string | undefined

  beforeEach(async () => {
    wasmDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-policy-install-'))
    envDirBefore = process.env.INTUTIC_WASM_DIR
    process.env.INTUTIC_WASM_DIR = wasmDir
    exitCode = null
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (envDirBefore === undefined) delete process.env.INTUTIC_WASM_DIR
    else process.env.INTUTIC_WASM_DIR = envDirBefore
    await fs.rm(wasmDir, { recursive: true, force: true })
  })

  /** Runs `runPolicyInstall`, converting the mocked `process.exit` throw into a plain result. */
  async function install(wasmPath: string): Promise<void> {
    try {
      await runPolicyInstall({ wasm: wasmPath })
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('refuses to install a rule importing env.seed', async () => {
    const wasmPath = path.join(wasmDir, 'seed-rule.wasm')
    await fs.writeFile(wasmPath, moduleImporting('env', 'seed'))

    await install(wasmPath)

    expect(exitCode, 'a seed-importing rule must not install').toBe(1)
    const installed = (await fs.readdir(wasmDir)).filter((f) => f !== 'seed-rule.wasm')
    expect(installed, 'nothing should have been written to the local rules directory').toEqual([])
  })

  it('installs a rule that only imports what the proxy registers', async () => {
    // Positive control: confirms the fixture above is refused for importing
    // `seed`, not for some unrelated reason (a malformed module, a bad path).
    const wasmPath = path.join(wasmDir, 'clean-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(1))

    await install(wasmPath)

    expect(exitCode, 'a rule using only registered imports must install').toBeNull()
    const installed = await fs.readdir(wasmDir)
    expect(installed.some((f) => f.endsWith('.wasm') && f !== 'clean-rule.wasm')).toBe(true)
  })

  it('refuses to install a rule returning a verdict code the proxy does not map', async () => {
    // The bypass this closes: outside {0,1,2,3}, the proxy's runner logs a
    // warning and falls through to Bypass — so a rule that ships believing in
    // a rung it can never reach (an author inventing "4 = escalate to human")
    // would install clean and then allow every request it thinks it refuses.
    const wasmPath = path.join(wasmDir, 'unmapped-verdict-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(5))

    await install(wasmPath)

    expect(exitCode, 'a rule returning an unmapped verdict code must not install').toBe(1)
    const installed = (await fs.readdir(wasmDir)).filter((f) => f !== 'unmapped-verdict-rule.wasm')
    expect(installed, 'nothing should have been written to the local rules directory').toEqual([])
  })

  it('accepts the deprecated verdict code 2 with a warning, since it already shipped', async () => {
    const wasmPath = path.join(wasmDir, 'legacy-redact-rule.wasm')
    await fs.writeFile(wasmPath, moduleReturningVerdict(2))

    await install(wasmPath)

    expect(exitCode, 'code 2 is deprecated, not refused — already-installed rules use it').toBeNull()
  })
})

/**
 * `runPolicyReplay` end to end, against a mocked `postWithStatus`. The point
 * of this suite is the status-branch wiring — 404, the 422 `not_enough_traffic`
 * shape, and 200 — not the route's own logic, which
 * `services/control-plane/__tests__/integration/ruleGeneration.test.ts` and
 * `replaySummary.test.ts` already cover.
 */
describe('runPolicyReplay end to end', () => {
  let exitCode: number | null

  beforeEach(() => {
    exitCode = null
    postWithStatusMock.mockReset()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function replay(ruleId: string, opts: { limit?: string; since?: string } = {}): Promise<void> {
    try {
      await runPolicyReplay(ruleId, opts)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('exits 1 on a 404 without touching enforcement', async () => {
    postWithStatusMock.mockResolvedValue({ status: 404, body: { error: 'Rule not found' } })
    await replay('wasm_missing')
    expect(exitCode).toBe(1)
  })

  it('reports not_enough_traffic on a 422 rather than a generic failure', async () => {
    postWithStatusMock.mockResolvedValue({
      status: 422,
      body: { error: 'not_enough_traffic', contextCount: 3, minRequired: 50 },
    })
    await replay('wasm_abc')
    expect(exitCode).toBe(1)
    expect(postWithStatusMock).toHaveBeenCalledWith('/api/v1/wasm-rules/wasm_abc/replay', {})
  })

  it('rejects a non-positive --limit before making a network call', async () => {
    await replay('wasm_abc', { limit: '0' })
    expect(exitCode).toBe(1)
    expect(postWithStatusMock).not.toHaveBeenCalled()
  })

  it('passes --limit and --since through as the request body', async () => {
    postWithStatusMock.mockResolvedValue({
      status: 200,
      body: {
        ruleId: 'wasm_abc',
        since: '7d',
        contextCount: 120,
        wouldActCount: 6,
        wouldActRate: 0.05,
        verdictCounts: { '0': 114, '1': 6 },
        sampleMatches: [],
      },
    })
    await replay('wasm_abc', { limit: '250', since: '7d' })
    expect(exitCode).toBeNull()
    expect(postWithStatusMock).toHaveBeenCalledWith('/api/v1/wasm-rules/wasm_abc/replay', {
      limit: 250,
      since: '7d',
    })
  })

  it('exits cleanly on a 200 and prints sample matches when present', async () => {
    postWithStatusMock.mockResolvedValue({
      status: 200,
      body: {
        ruleId: 'wasm_abc',
        since: null,
        contextCount: 60,
        wouldActCount: 1,
        wouldActRate: 1 / 60,
        verdictCounts: { '0': 59, '1': 1 },
        sampleMatches: [{ session_id: 'sess_1' }],
      },
    })
    await replay('wasm_abc')
    expect(exitCode).toBeNull()
  })
})

/**
 * `intutic policy compile --candidate` (LLD #71, Wave 7): the source of
 * record is fetched, hash-checked and written where its SDK import resolves;
 * the upload carries the hash the server recomputes. Nothing here reaches
 * `asc` — every case stops before the compiler or exercises the two helpers
 * around it.
 */
describe('runPolicyCompile --candidate', () => {
  let exitCode: number | null
  let project: string
  let previousCwd: string
  const SOURCE = '// Candidate: "rc_cited"\nexport function evaluate(o: i32, l: i32): i32 { return 0; }\n'
  const HASH = sourceSha256Of(SOURCE)

  beforeEach(async () => {
    exitCode = null
    getWithStatusMock.mockReset()
    postFormMock.mockReset()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    previousCwd = process.cwd()
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-rule-project-'))
    await fs.mkdir(path.join(project, 'assembly'), { recursive: true })
    await fs.writeFile(path.join(project, 'assembly', 'index.ts'), '// sdk\n')
    process.chdir(project)
  })

  afterEach(async () => {
    process.chdir(previousCwd)
    await fs.rm(project, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // vi.fn's inferred signature is narrower than the client method it stands in for.
  const asClient = (stub: unknown) => stub as Pick<ApiClient, 'getWithStatus' | 'postForm'>

  const compile = async (opts: Parameters<typeof runPolicyCompile>[0]) => {
    try {
      await runPolicyCompile(opts)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err
    }
  }

  it('refuses --src together with --candidate before touching the network', async () => {
    await compile({ candidate: 'rc_cited', src: 'rules/mine.ts' })
    expect(exitCode).toBe(1)
    expect(getWithStatusMock).not.toHaveBeenCalled()
  })

  it('refuses --upload without --candidate', async () => {
    await compile({ upload: true })
    expect(exitCode).toBe(1)
    expect(getWithStatusMock).not.toHaveBeenCalled()
  })

  it('refuses to run outside a rule project, where the generated import cannot resolve', async () => {
    await fs.rm(path.join(project, 'assembly'), { recursive: true, force: true })
    await compile({ candidate: 'rc_cited' })
    expect(exitCode).toBe(1)
    expect(getWithStatusMock).not.toHaveBeenCalled()
  })

  it('refuses a served source that does not hash to the hash the server states, and writes nothing', async () => {
    getWithStatusMock.mockResolvedValue({
      status: 200,
      body: { candidateId: 'rc_cited', guardrailId: 'pgr_1', status: 'MOCKS_SELECTED', source: SOURCE, sourceSha256: '0'.repeat(64) },
    })
    await compile({ candidate: 'rc_cited' })
    expect(exitCode).toBe(1)
    await expect(fs.access(candidateSourcePath('rc_cited'))).rejects.toBeTruthy()
  })

  it('fetchCandidateSource returns the verified source and normalises the hash', async () => {
    const client = { getWithStatus: vi.fn(async () => ({ status: 200, body: { candidateId: 'rc_cited', guardrailId: 'pgr_1', status: 'PROPOSED', source: SOURCE, sourceSha256: HASH.toUpperCase() } })) }
    const got = await fetchCandidateSource(asClient(client), 'rc_cited')
    expect(got.source).toBe(SOURCE)
    expect(got.sourceSha256).toBe(HASH)
    expect(client.getWithStatus).toHaveBeenCalledWith('/api/v1/rule-candidates/rc_cited/source')
    expect(candidateSourcePath('rc_cited')).toBe(path.join('generated', 'candidates', 'rc_cited.ts'))
    expect(candidateOutPath('rc_cited')).toBe(path.join('build', 'rc_cited.wasm'))
  })

  it('fetchCandidateSource exits 1 on source_drift and on a missing candidate', async () => {
    const drift = { getWithStatus: vi.fn(async () => ({ status: 409, body: { error: 'source_drift', detail: 'the candidate changed after it was handed off' } })) }
    await expect(fetchCandidateSource(asClient(drift), 'rc_cited')).rejects.toThrow('process.exit(1)')
    expect(exitCode).toBe(1)
    const missing = { getWithStatus: vi.fn(async () => ({ status: 404, body: { error: 'Candidate not found' } })) }
    await expect(fetchCandidateSource(asClient(missing), 'rc_gone')).rejects.toThrow('process.exit(1)')
  })

  it('uploadCandidateBundle sends the bundle and the source hash as multipart and prints the gates', async () => {
    const wasm = path.join(project, 'build', 'rc_cited.wasm')
    await fs.mkdir(path.dirname(wasm), { recursive: true })
    await fs.writeFile(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
    let sent: FormData | null = null
    const client = {
      postForm: vi.fn(async (_path: string, form: FormData) => {
        sent = form
        return { status: 201, body: { accepted: true, ruleId: 'wasm_1', mode: 'SHADOW', gates: [{ gate: 'compiles_and_links', passed: true, detail: 'ok' }] } }
      }),
    }
    await uploadCandidateBundle(asClient(client), 'rc_cited', wasm, HASH)
    expect(exitCode).toBeNull()
    expect(client.postForm).toHaveBeenCalledWith('/api/v1/rule-candidates/rc_cited/bundle', expect.any(FormData))
    expect(sent!.get('source_sha256')).toBe(HASH)
    const file = sent!.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as Blob).size).toBe(8)
  })

  it('uploadCandidateBundle exits 1 when the server refuses the source hash or a gate fails', async () => {
    const wasm = path.join(project, 'build', 'rc_cited.wasm')
    await fs.mkdir(path.dirname(wasm), { recursive: true })
    await fs.writeFile(wasm, Buffer.from([0x00]))
    const mismatch = { postForm: vi.fn(async () => ({ status: 400, body: { error: 'source_mismatch', detail: 'not compiled from the source of record' } })) }
    await expect(uploadCandidateBundle(asClient(mismatch), 'rc_cited', wasm, HASH)).rejects.toThrow('process.exit(1)')
    expect(exitCode).toBe(1)
    exitCode = null
    const refused = { postForm: vi.fn(async () => ({ status: 200, body: { accepted: false, gates: [{ gate: 'default_allow', passed: false, detail: 'fires on the empty context' }] } })) }
    await expect(uploadCandidateBundle(asClient(refused), 'rc_cited', wasm, HASH)).rejects.toThrow('process.exit(1)')
    expect(exitCode).toBe(1)
  })
})
