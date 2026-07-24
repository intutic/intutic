import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { log } from '../lib/logger.js'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'

async function getClient(dev?: boolean) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  const controlPlaneUrl = resolveControlPlaneUrl(devMode)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

export async function runPolicyEnable(policyId: string, opts: { dev?: boolean }): Promise<void> {
  log.header(`Intutic — Enable Policy: ${policyId}`)

  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; currentVersion?: number }>(
      `/api/v1/policies/${policyId}/enable`
    )

    if (res && res.ok) {
      log.success(`Successfully enabled compliance policy "${policyId}"!`)
      if (res.currentVersion) {
        log.field('Current Version', String(res.currentVersion))
      }
    } else {
      log.error(`Failed to enable policy: ${policyId}`)
      process.exit(1)
    }
  } catch (err: any) {
    log.error(`Failed to enable policy: ${err.message}`)
    process.exit(1)
  }
}

export async function runPolicyDisable(policyId: string, opts: { dev?: boolean }): Promise<void> {
  log.header(`Intutic — Disable Policy: ${policyId}`)

  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; currentVersion?: number }>(
      `/api/v1/policies/${policyId}/disable`
    )

    if (res && res.ok) {
      log.success(`Successfully disabled compliance policy "${policyId}"!`)
      if (res.currentVersion) {
        log.field('Current Version', String(res.currentVersion))
      }
    } else {
      log.error(`Failed to disable policy: ${policyId}`)
      process.exit(1)
    }
  } catch (err: any) {
    log.error(`Failed to disable policy: ${err.message}`)
    process.exit(1)
  }
}

export async function runPolicyRollback(
  policyId: string,
  opts: { version: string; dev?: boolean }
): Promise<void> {
  log.header(`Intutic — Rollback Policy: ${policyId}`)

  const targetVer = parseInt(opts.version, 10)
  if (isNaN(targetVer)) {
    log.error(`Invalid version format: "${opts.version}". Must be an integer.`)
    process.exit(1)
  }

  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; currentVersion?: number }>(
      `/api/v1/policies/${policyId}/rollback`,
      { version: targetVer }
    )

    if (res && res.ok) {
      log.success(`Successfully rolled back policy "${policyId}" to version ${targetVer}!`)
      if (res.currentVersion) {
        log.field('Current Version', String(res.currentVersion))
      }
    } else {
      log.error(`Failed to rollback policy: ${policyId}`)
      process.exit(1)
    }
  } catch (err: any) {
    log.error(`Failed to rollback policy: ${err.message}`)
    process.exit(1)
  }
}

export async function runPolicyExport(opts: { all?: boolean; dev?: boolean }): Promise<void> {
  if (!opts.all) {
    log.warn('Export command expects `--all` flag. Exporting all policies by default.')
  }

  const client = await getClient(opts.dev)
  try {
    const res = await client.get<{ ok: boolean; policies: any[] }>('/api/v1/policies')
    if (res && res.ok && Array.isArray(res.policies)) {
      console.log(JSON.stringify(res.policies, null, 2))
    } else {
      log.error('Failed to export policies.')
      process.exit(1)
    }
  } catch (err: any) {
    log.error(`Failed to export policies: ${err.message}`)
    process.exit(1)
  }
}

/**
 * Minimal RequestContext used to validate a rule instantiates and evaluates
 * before install. Mirrors packages/wasm-sdk/assembly/mock_context_allow.json
 * (embedded so `intutic policy install` works outside the monorepo).
 */
export const DEFAULT_ALLOW_MOCK = JSON.stringify({
  session_id: 'sess_test123',
  workspace_id: 'ws_test123',
  virtual_key_prefix: 'vk_test',
  model: 'claude-3-5-sonnet',
  tools: [],
  tool_calls: [],
  estimated_input_tokens: 120,
  budget_remaining_usd: 15.5,
  risk_tier: 'Low',
  dlp_findings: []
})

/**
 * Instantiate a compiled WASM rule with the standard host imports and run
 * `evaluate` against a JSON-serialized RequestContext. Returns the raw
 * verdict code (0=ALLOW, 1=BLOCK, 2=REDACT). Throws on any instantiation or
 * ABI failure — callers decide how to surface it.
 */
export async function instantiateAndEvaluate(
  wasmBuffer: Uint8Array,
  mockStr: string,
  opts: { forceAnomaly?: boolean } = {}
): Promise<number> {
  let instanceRef: any = null
  const imports = {
    env: {
      // Mirrors the proxy's host import set (packages/proxy/src/wasm/host.rs)
      // — a rule that links in the proxy must link here too, or install
      // validation would reject rules the sandbox runs fine (and vice versa).
      log_info(message: number, len: number) {
        if (instanceRef && message) {
          const memory = instanceRef.exports.memory as WebAssembly.Memory
          const bytes = new Uint8Array(memory.buffer, message, len)
          console.log(`[WASM Log] ${Buffer.from(bytes).toString('utf-8')}`)
        }
      },
      abort(message: number, fileName: number, line: number, column: number) {
        let errorMsg = 'AssemblyScript abort'
        if (instanceRef && message) {
          const memory = instanceRef.exports.memory as WebAssembly.Memory
          const size = new Uint32Array(memory.buffer, message - 4, 1)[0]
          const memView16 = new Uint16Array(memory.buffer)
          const chars: string[] = []
          for (let i = 0; i < size / 2; i++) {
            chars.push(String.fromCharCode(memView16[(message / 2) + i]))
          }
          errorMsg = chars.join('')
        }
        throw new Error(`WASM Abort: ${errorMsg} (at line ${line}, col ${column})`)
      },
      trace(message: number, n: number) {
        if (instanceRef && message) {
          const memory = instanceRef.exports.memory as WebAssembly.Memory
          const size = new Uint32Array(memory.buffer, message - 4, 1)[0]
          const memView16 = new Uint16Array(memory.buffer)
          const chars: string[] = []
          for (let i = 0; i < size / 2; i++) {
            chars.push(String.fromCharCode(memView16[(message / 2) + i]))
          }
          console.log(`[WASM Trace] ${chars.join('')}`)
        } else {
          console.log(`[WASM Trace Pointer] ${message}`)
        }
      },
      seed() {
        return Math.random()
      }
    },
    onnx_rules: {
      runOnnxInference(modelNamePtr: number, inputDataPtr: number): number {
        if (instanceRef && opts.forceAnomaly) {
          const memory = instanceRef.exports.memory as WebAssembly.Memory
          // TypedArray layout in AssemblyScript: buffer at offset 0, dataStart at offset 4
          const dataStart = new Uint32Array(memory.buffer, inputDataPtr + 4, 1)[0]
          // Mutate the backing buffer floats to trigger MSE reconstruction error
          const floats = new Float32Array(memory.buffer, dataStart, 180)
          for (let i = 0; i < floats.length; i++) {
            floats[i] = 99.0 // force large difference from one-hot 0.0/1.0
          }
        }
        return inputDataPtr
      }
    }
  }

  const { instance } = (await WebAssembly.instantiate(wasmBuffer, imports)) as any
  instanceRef = instance
  const jsonBytes = Buffer.from(mockStr)

  // Accept exactly the allocator exports the proxy runner accepts
  // (packages/proxy/src/wasm/runner.rs: `allocate`, then `__new`) — anything
  // looser would validate rules the proxy then silently fails open on.
  let offset = 0
  if (typeof instance.exports.allocate === 'function') {
    offset = (instance.exports.allocate as Function)(jsonBytes.length)
  } else if (typeof instance.exports.__new === 'function') {
    offset = (instance.exports.__new as Function)(jsonBytes.length, 0)
  } else {
    throw new Error("WASM module is missing 'allocate' or '__new' memory helpers.")
  }

  const memory = instance.exports.memory as WebAssembly.Memory
  const memView = new Uint8Array(memory.buffer, offset, jsonBytes.length)
  memView.set(jsonBytes)

  const evaluate = instance.exports.evaluate as Function
  if (typeof evaluate !== 'function') {
    throw new Error("WASM module is missing 'evaluate' function export.")
  }

  return evaluate(offset, jsonBytes.length)
}

export async function runPolicyTest(opts: { wasm: string; mock: string }): Promise<void> {
  log.header('Intutic — Test Local WASM Policy Rule')

  let wasmBuffer: Buffer
  let mockStr: string
  let forceAnomaly = false
  try {
    wasmBuffer = await fs.readFile(opts.wasm)
  } catch (err: any) {
    log.error(`Failed to read WASM file at "${opts.wasm}": ${err.message}`)
    process.exit(1)
  }

  try {
    mockStr = await fs.readFile(opts.mock, 'utf-8')
    const parsed = JSON.parse(mockStr) // syntax check
    if (parsed && parsed.mock_anomaly === true) {
      forceAnomaly = true
    }
  } catch (err: any) {
    log.error(`Failed to read or parse mock context JSON at "${opts.mock}": ${err.message}`)
    process.exit(1)
  }

  try {
    const verdict = await instantiateAndEvaluate(wasmBuffer, mockStr, { forceAnomaly })
    log.info(`Dry-run evaluation executed successfully.`)
    log.field('WASM Verdict Code', String(verdict))

    if (verdict === 0) {
      log.success('Result: BYPASS / ALLOW')
    } else if (verdict === 1) {
      log.warn('Result: BLOCK / KILL')
    } else if (verdict === 2) {
      log.warn('Result: REDACT / BLOCK')
    } else {
      log.error(`Result: Unknown verdict code ${verdict}`)
    }
  } catch (err: any) {
    log.error(`Execution error during WASM policy test: ${err.message}`)
    process.exit(1)
  }
}

/**
 * Local rules dir the proxy scans: INTUTIC_WASM_DIR overrides ~/.intutic/wasm
 * (tilde-expanded, mirroring the proxy's resolver). Note the proxy can also
 * be pointed elsewhere via `intutic_settings.wasm_local_dir` in its
 * config.yaml — the CLI cannot see that file, so installs print the target
 * path for the user to verify.
 */
export function resolveLocalWasmDir(): string {
  const envDir = process.env.INTUTIC_WASM_DIR
  if (envDir && envDir.length > 0) {
    return envDir.startsWith('~/') ? path.join(os.homedir(), envDir.slice(2)) : envDir
  }
  return path.join(os.homedir(), '.intutic', 'wasm')
}

/** Mirrors the proxy's `NN_name.wasm` convention (default priority 100). */
export function parseRuleFileName(fileName: string): { priority: number; name: string } {
  const stem = fileName.endsWith('.wasm') ? fileName.slice(0, -'.wasm'.length) : fileName
  const sep = stem.indexOf('_')
  if (sep > 0 && sep < stem.length - 1) {
    const prefix = stem.slice(0, sep)
    if (/^\d+$/.test(prefix)) {
      return { priority: parseInt(prefix, 10), name: stem.slice(sep + 1) }
    }
  }
  return { priority: 100, name: stem }
}

/**
 * Installed file name for a rule: `{priority}_{name}.wasm`. Leading
 * underscores are preserved — `NN__x.wasm` parses back to name `_x` in both
 * the CLI and the proxy, so stripping them would silently rename rules.
 */
export function installedFileName(priority: number, name: string): string {
  const sanitized = name.replace(/\.wasm$/, '').replace(/[/\\\s]+/g, '-')
  return `${priority}_${sanitized}.wasm`
}

/**
 * asc argv for `intutic policy compile` — mirrors the @intutic/wasm-sdk build
 * script, with debug info/source maps only behind --debug. `--no-install`
 * stops npx from fetching the unrelated `asc` npm package when AssemblyScript
 * isn't installed locally.
 */
export function buildCompileArgs(opts: { src?: string; out?: string; debug?: boolean }): string[] {
  const src = opts.src ?? 'assembly/index.ts'
  const out = opts.out ?? 'build/rule.wasm'
  const args = ['--no-install', 'asc', src, '-o', out, '--optimize', '--exportRuntime']
  if (opts.debug) {
    args.push('--debug', '--sourceMap')
  }
  return args
}

export async function runPolicyCompile(opts: {
  src?: string
  out?: string
  debug?: boolean
}): Promise<void> {
  log.header('Intutic — Compile WASM Policy Rule')
  const args = buildCompileArgs(opts)
  const out = opts.out ?? 'build/rule.wasm'

  try {
    await fs.mkdir(path.dirname(out), { recursive: true })
  } catch {
    // best-effort; asc reports the real error if the dir is unusable
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('npx', args, { stdio: 'inherit' })
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code ?? -1))
  })

  if (exitCode !== 0) {
    log.error('AssemblyScript compilation failed.')
    log.info('If `asc` is not installed, add it to your project:')
    log.info('  pnpm add -D assemblyscript assemblyscript-json')
    process.exit(1)
  }

  log.success(`Compiled ${opts.src ?? 'assembly/index.ts'} → ${out}`)
  log.info('Next: dry-run with `intutic policy test --wasm <out> --mock <mock.json>`')
}

export async function runPolicyInstall(opts: {
  wasm: string
  name?: string
  priority?: string
}): Promise<void> {
  log.header('Intutic — Install Local WASM Policy Rule')

  let wasmBuffer: Buffer
  try {
    wasmBuffer = await fs.readFile(opts.wasm)
  } catch (err: any) {
    log.error(`Failed to read WASM file at "${opts.wasm}": ${err.message}`)
    process.exit(1)
  }

  // Refuse to install a rule that cannot instantiate or evaluate — a broken
  // rule enforces nothing (the proxy sandbox fails open).
  try {
    await instantiateAndEvaluate(wasmBuffer, DEFAULT_ALLOW_MOCK)
  } catch (err: any) {
    log.error(`Rule failed validation and was NOT installed: ${err.message}`)
    process.exit(1)
  }

  const priority = parseInt(opts.priority ?? '100', 10)
  if (isNaN(priority) || priority < 0) {
    log.error(`Invalid priority "${opts.priority}". Must be a non-negative integer.`)
    process.exit(1)
  }
  const name = opts.name ?? parseRuleFileName(path.basename(opts.wasm)).name
  const fileName = installedFileName(priority, name)

  const dir = resolveLocalWasmDir()
  const dest = path.join(dir, fileName)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(dest, wasmBuffer)
  } catch (err: any) {
    log.error(`Failed to install rule to "${dest}": ${err.message}`)
    process.exit(1)
  }

  const sha256 = createHash('sha256').update(wasmBuffer).digest('hex')
  log.success(`Installed rule "${name}"`)
  log.field('Path', dest)
  log.field('Priority', String(priority))
  log.field('SHA-256', sha256)
  log.info('The proxy picks up local rule changes within ~5 s on the next request.')
  log.info(
    'If your proxy config.yaml sets intutic_settings.wasm_local_dir, make sure it matches this path (or set INTUTIC_WASM_DIR for both).'
  )
}

export async function runPolicyListLocal(): Promise<void> {
  log.header('Intutic — Local WASM Policy Rules')
  const dir = resolveLocalWasmDir()

  let entries: string[]
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.wasm')).sort()
  } catch {
    log.info(`No local rules directory yet (${dir}).`)
    log.info('Install one with `intutic policy install --wasm <rule.wasm>`.')
    return
  }

  if (entries.length === 0) {
    log.info(`No rules installed in ${dir}.`)
    return
  }

  for (const file of entries) {
    const full = path.join(dir, file)
    try {
      const [stat, bytes] = await Promise.all([fs.stat(full), fs.readFile(full)])
      const { priority, name } = parseRuleFileName(file)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      log.field(name, `priority=${priority} size=${stat.size}B mtime=${stat.mtime.toISOString()} sha256=${sha256.slice(0, 16)}…`)
    } catch (err: any) {
      log.warn(`${file}: unreadable (${err.message})`)
    }
  }
}
