import * as fs from 'node:fs/promises'
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

export async function runPolicyTest(opts: { wasm: string; mock: string }): Promise<void> {
  log.header('Intutic — Test Local WASM Policy Rule')

  // 1. Read files
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

  // 2. Initialize WASM instance
  let instanceRef: any = null
  const imports = {
    env: {
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
        if (instanceRef && forceAnomaly) {
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

  try {
    const { instance } = (await WebAssembly.instantiate(wasmBuffer, imports)) as any
    instanceRef = instance
    const jsonBytes = Buffer.from(mockStr)

    // 3. Allocate memory
    let offset = 0
    if (typeof instance.exports.allocate === 'function') {
      offset = (instance.exports.allocate as Function)(jsonBytes.length)
    } else if (typeof instance.exports.__allocate === 'function') {
      offset = (instance.exports.__allocate as Function)(jsonBytes.length)
    } else if (typeof instance.exports.__new === 'function') {
      offset = (instance.exports.__new as Function)(jsonBytes.length, 0)
    } else {
      log.error("WASM module is missing 'allocate', '__allocate' or '__new' memory helpers.")
      process.exit(1)
    }

    // 4. Write memory
    const memory = instance.exports.memory as WebAssembly.Memory
    const memView = new Uint8Array(memory.buffer, offset, jsonBytes.length)
    memView.set(jsonBytes)

    // 5. Evaluate
    const evaluate = instance.exports.evaluate as Function
    if (typeof evaluate !== 'function') {
      log.error("WASM module is missing 'evaluate' function export.")
      process.exit(1)
    }

    const verdict = evaluate(offset, jsonBytes.length)
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
