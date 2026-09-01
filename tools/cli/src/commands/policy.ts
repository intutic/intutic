import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { log } from '../lib/logger.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import {
  WASM_HOST_IMPORTS,
  unsupportedWasmImports,
  explainWasmImport,
} from '@intutic/shared-types'
import { loadCredentials, loadConfig } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { resolveSnapshotRulesPath, SNAPSHOT_RULES_FILE } from '../lib/policySnapshot.js'
import type { EnforcementAction, InterventionMode, RiskCategory } from '@intutic/shared-types'

/**
 * Message of a caught value.
 *
 * `catch` binds `unknown` — a thrown non-Error (or an Error subclass with no
 * message) is not hypothetical here, since `abort` below and the WASM runtime
 * both throw across the host boundary.
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The control plane these commands talk to, and the credentials for it.
 *
 * Lifted out of `getClient` because `policy snapshot` needs the workspace id and
 * the raw key rather than an API client — and resolving them a second way is how
 * one command ends up pointed at production while its neighbour is on --dev.
 */
async function resolveTarget(
  dev?: boolean,
): Promise<{ controlPlaneUrl: string; apiKey: string; workspaceId: string }> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const config = loadConfig()
  const devMode = dev || config?.devMode || process.env.INTUTIC_DEV === '1'
  return {
    controlPlaneUrl: resolveControlPlaneUrl(devMode),
    apiKey: creds.apiKey,
    workspaceId: creds.workspaceId,
  }
}

async function getClient(dev?: boolean) {
  const { controlPlaneUrl, apiKey } = await resolveTarget(dev)
  return createApiClient(controlPlaneUrl, apiKey)
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
  } catch (err) {
    log.error(`Failed to enable policy: ${errMessage(err)}`)
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
  } catch (err) {
    log.error(`Failed to disable policy: ${errMessage(err)}`)
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
  } catch (err) {
    log.error(`Failed to rollback policy: ${errMessage(err)}`)
    process.exit(1)
  }
}

/**
 * A compliance policy exactly as `GET /api/v1/policies` serializes it: the
 * `pcas_policies` columns (`packages/db/src/schema.ts`) after a JSON round
 * trip, so timestamps arrive as ISO strings and nullable columns as `null`.
 *
 * `intutic policy export` prints these verbatim and is the documented way to
 * get policies out of a workspace, which makes this the shape a caller piping
 * the export into another tool depends on. Written out rather than left as
 * `any[]` for that reason: a column rename on the control plane should be a
 * visible change here, not a silently different file on someone's disk.
 */
export interface CompliancePolicy {
  policyId: string
  workspaceId: string
  name: string
  description: string | null
  riskCategory: RiskCategory | null
  /** Glob matched against the tool name the agent is calling. */
  targetToolPattern: string
  enforcementAction: EnforcementAction
  interventionMode: InterventionMode | null
  priority: number | null
  /** Free-form JSON match conditions — the column is `jsonb` with no schema. */
  conditions: unknown
  isActive: boolean | null
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export async function runPolicyExport(opts: { all?: boolean; dev?: boolean }): Promise<void> {
  if (!opts.all) {
    log.warn('Export command expects `--all` flag. Exporting all policies by default.')
  }

  const client = await getClient(opts.dev)
  try {
    const res = await client.get<{ ok: boolean; policies: CompliancePolicy[] }>('/api/v1/policies')
    if (res && res.ok && Array.isArray(res.policies)) {
      console.log(JSON.stringify(res.policies, null, 2))
    } else {
      log.error('Failed to export policies.')
      process.exit(1)
    }
  } catch (err) {
    log.error(`Failed to export policies: ${errMessage(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic policy snapshot` — compile this workspace's policy to disk.
 *
 * The snapshot is the dynamic tier: every harness gate reads
 * `~/.intutic/hooks/policy-snapshot.rules` and enforces the compiled floor and
 * nothing else when it is missing. Until this command existed the only thing
 * that ever wrote it was `intutic connect`, so arming the gates meant running a
 * daemon that also rewrites five harnesses' hook configs, starts a drift
 * watcher and provisions Valkey. This does the one thing.
 */
export async function runPolicySnapshot(opts: { dev?: boolean }): Promise<void> {
  log.header('Intutic — Refresh Policy Snapshot')

  const { controlPlaneUrl, apiKey, workspaceId } = await resolveTarget(opts.dev)

  // The gates consult INTUTIC_SNAPSHOT_RULES before the default path, so writing
  // to the default while they read elsewhere would produce a snapshot nothing
  // enforces — the precise silent failure this command exists to end.
  const rulesPath = resolveSnapshotRulesPath()
  const snapshotDir = path.dirname(rulesPath)
  if (path.basename(rulesPath) !== SNAPSHOT_RULES_FILE) {
    log.warn(
      `INTUTIC_SNAPSHOT_RULES names "${path.basename(rulesPath)}", but the writer always produces ` +
        `"${SNAPSHOT_RULES_FILE}" — the gates will read a file this command does not write.`
    )
  }

  // Imported here rather than at module scope: @intutic/sync-daemon pulls in ws,
  // ioredis and chokidar, and every other `intutic policy` subcommand would pay
  // that startup cost without ever touching a snapshot.
  const { refreshPolicySnapshot } = await import('@intutic/sync-daemon')

  const result = await refreshPolicySnapshot({ controlPlaneUrl, apiKey, workspaceId, snapshotDir })

  // `refreshPolicySnapshot` never throws — policy refresh must not be able to
  // take down the daemon's sync loop — so null is the only failure signal it
  // has. Reporting that as success is how a machine comes to enforce nothing
  // while the command meant to arm it said it worked.
  if (!result) {
    log.error('Snapshot NOT written — GET /api/v1/policy/resolve returned nothing usable.')
    log.field('Control plane', controlPlaneUrl)
    log.field('Workspace', workspaceId)
    log.info('Any previous snapshot is untouched and still enforced.')
    log.info('Check the control plane is reachable and the key is still valid: `intutic whoami`.')
    process.exit(1)
  }

  log.success(`Policy snapshot written — ${result.ruleCount} rule(s) now enforced by every gate.`)
  log.field('Digest', result.digest)
  log.field('Workspace', workspaceId)
  log.field('Path', path.join(snapshotDir, SNAPSHOT_RULES_FILE))
  log.info('Confirm the gates accept it with `intutic doctor`.')
}

/**
 * Minimal RequestContext used to validate a rule instantiates and evaluates
 * before install. Mirrors packages/wasm-sdk/assembly/mock_context_allow.json
 * (embedded so `intutic policy install` works outside the monorepo).
 */
export const DEFAULT_ALLOW_MOCK = JSON.stringify({
  session_id: 'sess_test123',
  workspace_id: 'wk_test123',
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
 * Every host function the proxy registers, declared once on this side.
 *
 * `tools/scripts/check-wasm-host-imports.js` asserts this equals
 * `HOST_IMPORTS` in `packages/proxy/src/wasm/host.rs`. The two had already
 * drifted — this side offered `seed`, the proxy never has — and the drift was
 * invisible because it only surfaced as a per-request warning in a process
 * nobody was reading.
 */
export const HOST_IMPORT_NAMES = WASM_HOST_IMPORTS

/**
 * The guest side of the ABI, resolved from a module's exports.
 *
 * These are exactly the three things the proxy runner needs of a rule
 * (`packages/proxy/src/wasm/runner.rs`): linear memory to pass the context
 * through, an allocator to reserve space in it, and the entry point.
 *
 * Every lookup that produces one is checked at run time — a `.wasm` file can
 * export anything or nothing, and the compiler cannot know which. Declaring
 * the shape and asserting a module has it are separate jobs; `resolveGuestAbi`
 * does the second and names whichever piece is missing.
 */
export interface WasmGuestAbi {
  /** Guest linear memory. Every pointer crossing the boundary indexes into it. */
  memory: WebAssembly.Memory
  /** `allocate(size) -> ptr`, or AssemblyScript's `__new(size, 0) -> ptr`. */
  allocate(size: number): number
  /** The rule entry point: `evaluate(ptr, len) -> i32` verdict code. */
  evaluate(offset: number, length: number): number
}

/**
 * A callable export, or null when the module does not export that name (or
 * exports it as a global/table/memory instead of a function).
 *
 * The variadic signature is the widest thing every guest function here fits;
 * `resolveGuestAbi` immediately narrows each one to its real arity by way of
 * the `WasmGuestAbi` members it assigns them to.
 */
function exportedFunction(
  exports: WebAssembly.Exports,
  name: string,
): ((...args: number[]) => number) | null {
  const value = exports[name]
  return typeof value === 'function' ? (value as (...args: number[]) => number) : null
}

/** Resolve the guest ABI, throwing a message that names the missing export. */
function resolveGuestAbi(instance: WebAssembly.Instance): WasmGuestAbi {
  const { exports } = instance

  const memory = exports.memory
  if (!(memory instanceof WebAssembly.Memory)) {
    // Previously read as `exports.memory as WebAssembly.Memory` and dereferenced,
    // so a module without a memory export failed with "Cannot read properties of
    // undefined (reading 'buffer')" instead of saying what was wrong.
    throw new Error(
      "WASM module does not export 'memory'. Compile with AssemblyScript's " +
        'default settings (`--exportRuntime`) so the host can read what the rule returns.',
    )
  }

  // Accept exactly the allocator exports the proxy runner accepts
  // (packages/proxy/src/wasm/runner.rs: `allocate`, then `__new`) — anything
  // looser would validate rules the proxy then silently fails open on.
  let allocate: (size: number) => number
  const allocateExport = exportedFunction(exports, 'allocate')
  if (allocateExport) {
    allocate = allocateExport
  } else {
    const newExport = exportedFunction(exports, '__new')
    if (!newExport) {
      throw new Error("WASM module is missing 'allocate' or '__new' memory helpers.")
    }
    allocate = (size) => newExport(size, 0)
  }

  const evaluate = exportedFunction(exports, 'evaluate')
  if (!evaluate) {
    throw new Error("WASM module is missing 'evaluate' function export.")
  }

  return { memory, allocate, evaluate }
}

/**
 * Read `len` UTF-8 bytes at `ptr` out of guest memory, or null if that range is
 * not wholly inside it.
 */
function readGuestUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string | null {
  const size = memory.buffer.byteLength
  if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0 || ptr + len > size) {
    return null
  }
  return Buffer.from(memory.buffer, ptr, len).toString('utf-8')
}

/**
 * Read an AssemblyScript string — UTF-16LE, with a 4-byte little-endian byte
 * length in the header immediately before the pointer — out of guest memory.
 * Returns null if the pointer or the length it declares is out of bounds.
 *
 * That bounds check is the point of the helper. The two copies of this loop it
 * replaces trusted the header, which is a value the guest writes: a rule
 * aborting with a bogus pointer could name a 4 GB string and send the CLI into
 * a multi-billion-iteration loop building it one char at a time. The proxy host
 * checks the same range and logs the raw pointer when it does not fit
 * (`packages/proxy/src/wasm/host.rs`).
 */
function readGuestString(memory: WebAssembly.Memory, ptr: number): string | null {
  const size = memory.buffer.byteLength
  if (!Number.isInteger(ptr) || ptr < 4 || ptr > size) return null
  const byteLength = new DataView(memory.buffer).getUint32(ptr - 4, true)
  if (byteLength % 2 !== 0 || ptr + byteLength > size) return null
  return Buffer.from(memory.buffer, ptr, byteLength).toString('utf16le')
}

/**
 * Instantiate a compiled WASM rule with the standard host imports and run
 * `evaluate` against a JSON-serialized RequestContext. Returns the raw
 * verdict code (0=ALLOW, 1=BLOCK, 3=REASK; 2 is a deprecated block). Throws on any instantiation or
 * ABI failure — callers decide how to surface it.
 */
/**
 * Re-exported so existing callers and tests keep one import site.
 *
 * The implementations live in `@intutic/shared-types` because three surfaces
 * need them — this CLI, the control plane's upload endpoint, and the SDK test
 * harness — and each having its own copy is precisely how `seed` came to be
 * offered here and never registered by the proxy.
 */
export const unsupportedImports = unsupportedWasmImports
export const explainUnsupportedImport = explainWasmImport

/**
 * Instantiates a compiled rule with the proxy's host imports and evaluates it
 * against one mock context, returning the raw verdict code.
 *
 * The import set here is the proxy's, not a convenient superset: a rule that
 * links in this sandbox must link in the proxy, or install validation passes
 * something the proxy then silently bypasses.
 */
export async function instantiateAndEvaluate(
  wasmBuffer: Uint8Array,
  mockStr: string,
): Promise<number> {
  let instanceRef: WebAssembly.Instance | null = null

  /**
   * Guest memory, or null before `WebAssembly.instantiate` has resolved.
   *
   * The null is load-bearing, not defensive padding: AssemblyScript's start
   * function runs during instantiation and can call `abort` or `trace` from
   * there, so a host import can be invoked before there is an instance to read
   * memory from.
   */
  const guestMemory = (): WebAssembly.Memory | null => {
    const memory = instanceRef?.exports.memory
    return memory instanceof WebAssembly.Memory ? memory : null
  }

  const imports: WebAssembly.Imports = {
    env: {
      // Mirrors the proxy's host import set (packages/proxy/src/wasm/host.rs)
      // — a rule that links in the proxy must link here too, or install
      // validation would reject rules the sandbox runs fine (and vice versa).
      log_info(message: number, len: number) {
        const memory = guestMemory()
        if (!memory || !message) return
        const text = readGuestUtf8(memory, message, len)
        console.log(
          text === null
            ? `[WASM Log] <out of bounds: ptr=${message} len=${len}>`
            : `[WASM Log] ${text}`,
        )
      },
      // `fileName` is part of AssemblyScript's fixed abort ABI and deliberately
      // unused: it points at the source path, which is only populated under
      // --debug and is a bare pointer otherwise. Not renamed to `_fileName`
      // because it is a real parameter of a foreign ABI and the name documents
      // the slot; `args: 'after-used'` means an unused parameter before two used
      // ones is not reported anyway.
      abort(message: number, fileName: number, line: number, column: number) {
        const memory = guestMemory()
        const text = memory && message ? readGuestString(memory, message) : null
        throw new Error(`WASM Abort: ${text ?? 'AssemblyScript abort'} (at line ${line}, col ${column})`)
      },
      /**
       * AssemblyScript's `trace(message, n, a0..a4)`: `n` says how many of the
       * five f64 slots carry a value.
       *
       * The five slots were absent from this signature and `n` was accepted and
       * dropped, so a rule calling `trace("tokens left", 1, remaining)` printed
       * "tokens left" here and nothing else — the number the author was tracing
       * never reached the output of the command whose whole job is to show them
       * what their rule does. The proxy at least logs `n`
       * (`packages/proxy/src/wasm/host.rs`).
       */
      trace(
        message: number,
        n: number,
        a0: number,
        a1: number,
        a2: number,
        a3: number,
        a4: number,
      ) {
        const memory = guestMemory()
        const text = memory && message ? readGuestString(memory, message) : null
        // A module may declare a narrower `env.trace`, in which case JS passes
        // undefined for the slots it did not declare; drop anything non-finite.
        const count = Number.isInteger(n) ? Math.min(Math.max(n, 0), 5) : 0
        const values = [a0, a1, a2, a3, a4].slice(0, count).filter((v) => Number.isFinite(v))
        const suffix = values.length > 0 ? ` ${values.join(' ')}` : ''
        if (text === null) {
          console.log(`[WASM Trace Pointer] ${message} (n=${n})${suffix}`)
        } else {
          console.log(`[WASM Trace] ${text}${suffix}`)
        }
      },
      /**
       * `env.read_referenced_file(pathPtr, pathLen, outPtr, outCap) -> i32`
       *
       * Always refuses here, and that is the honest answer rather than a gap:
       * the proxy builds its readable-file table from the tool calls of a live
       * request, and `intutic policy test` has a mock context, not a request.
       * Pretending otherwise — serving the mock's paths off the developer's own
       * disk — would make this harness disagree with production in the
       * permissive direction, which is the failure the `runOnnxInference` mock
       * below was removed for.
       *
       * -2 is ERR_REFUSED from `packages/proxy/src/wasm/referenced_files.rs`.
       * A rule exercised here therefore takes its no-manifest-available branch,
       * which is the branch worth checking anyway: it is what runs in any
       * deployment that has not configured a manifest root.
       */
      read_referenced_file(_pathPtr: number, _pathLen: number, _outPtr: number, _outCap: number) {
        return -2
      },
      // `seed()` used to be here, and the comment above — asserting this set
      // mirrors the proxy's — was false two lines later. `host.rs` has never
      // registered it. AssemblyScript emits `env.seed` for anything reaching
      // `Math.random()`, so a rule using randomness validated here, installed,
      // and then failed to link in the proxy on every request, where fail-open
      // turned it into a silent allow. Removing it cannot make enforcement
      // worse: such a rule was already fully bypassed, and now it is refused
      // loudly at install instead of quietly at runtime.
      //
      // Not added to the proxy instead, deliberately: a governance verdict that
      // samples is not a verdict. The same request would get different answers.
    },
    // The `onnx_rules.runOnnxInference` mock lived here and is gone with the host
    // import it imitated.
    //
    // It was worse than the production stub it stood for. The proxy's version returned
    // the input pointer unchanged, so the rule it backed could never fire; this one,
    // under --force-anomaly, rewrote the input buffer to 99.0 so the reconstruction
    // error was enormous and the rule DID fire. A rule author could watch their
    // sequence-anomaly rule block a request in `policy test`, ship it, and have it
    // never block anything in production. A harness that disagrees with production in
    // the permissive direction is worse than no harness.
  }

  // `Uint8Array` means `Uint8Array<ArrayBufferLike>`, and `BufferSource` demands
  // `ArrayBufferView<ArrayBuffer>` — a view over a SharedArrayBuffer is not one,
  // so the parameter type callers actually use (`Buffer` from `fs.readFile`) does
  // not fit `WebAssembly.instantiate`. The old `as any` on the result hid that
  // mismatch by silently selecting the `Module` overload instead, which returns a
  // bare `Instance` with no `.instance` property: the destructuring below was
  // reading a field the declared type does not have. Copy into a plainly-backed
  // array rather than narrowing the parameter, which would reject `Buffer`. One
  // copy of a rule binary, once per validation.
  // Compile first and inspect the import section, so an unprovided import is
  // named rather than surfacing as V8's "Import #3 module=env function=seed
  // error: function import requires a callable". Same outcome either way — the
  // instantiate below would throw — but a rule author needs to know it was
  // `Math.random()`.
  const compiled = await WebAssembly.compile(new Uint8Array(wasmBuffer))
  const unsupported = unsupportedImports(compiled)
  if (unsupported.length > 0) {
    throw new Error(
      `rule imports ${unsupported.length} function(s) the proxy sandbox does not provide:\n` +
        unsupported.map((n) => `    ${explainUnsupportedImport(n)}`).join('\n') +
        `\n  Available: ${HOST_IMPORT_NAMES.map((n) => `env.${n}`).join(', ')}.`,
    )
  }

  const instance = await WebAssembly.instantiate(compiled, imports)
  instanceRef = instance
  const abi = resolveGuestAbi(instance)

  const jsonBytes = Buffer.from(mockStr)
  const offset = abi.allocate(jsonBytes.length)

  // Re-read `abi.memory.buffer` here rather than caching a view: `allocate` can
  // grow the memory, which detaches every ArrayBuffer taken before the call.
  const memView = new Uint8Array(abi.memory.buffer, offset, jsonBytes.length)
  memView.set(jsonBytes)

  return abi.evaluate(offset, jsonBytes.length)
}

export async function runPolicyTest(opts: { wasm: string; mock: string }): Promise<void> {
  log.header('Intutic — Test Local WASM Policy Rule')

  let wasmBuffer: Buffer
  let mockStr: string
  try {
    wasmBuffer = await fs.readFile(opts.wasm)
  } catch (err) {
    log.error(`Failed to read WASM file at "${opts.wasm}": ${errMessage(err)}`)
    process.exit(1)
  }

  try {
    mockStr = await fs.readFile(opts.mock, 'utf-8')
    JSON.parse(mockStr) // syntax check
  } catch (err) {
    log.error(`Failed to read or parse mock context JSON at "${opts.mock}": ${errMessage(err)}`)
    process.exit(1)
  }

  try {
    const verdict = await instantiateAndEvaluate(wasmBuffer, mockStr)
    log.info(`Dry-run evaluation executed successfully.`)
    log.field('WASM Verdict Code', String(verdict))

    if (verdict === 0) {
      log.success('Result: BYPASS / ALLOW')
    } else if (verdict === 1) {
      log.warn('Result: BLOCK / KILL')
    } else if (verdict === 3) {
      log.warn('Result: REASK — the agent is told why and may retry')
    } else if (verdict === 2) {
      log.warn('Result: BLOCK (deprecated code 2)')
      log.info('  2 was specified as REDACT and never could be: a rule is not given')
      log.info('  the request body, so there is nothing to redact. The proxy treats it')
      log.info('  as a block. Return 1 to block, or 3 to reask.')
    } else {
      log.error(`Result: unmapped verdict code ${verdict}`)
      log.info('  Valid codes are 0 (allow), 1 (block) and 3 (reask). The proxy allows')
      log.info('  anything else, so a rule returning this enforces nothing.')
    }
  } catch (err) {
    log.error(`Execution error during WASM policy test: ${errMessage(err)}`)
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
  } catch (err) {
    log.error(`Failed to read WASM file at "${opts.wasm}": ${errMessage(err)}`)
    process.exit(1)
  }

  // Refuse to install a rule that cannot instantiate or evaluate — a broken
  // rule enforces nothing (the proxy sandbox fails open).
  try {
    const validationVerdict = await instantiateAndEvaluate(wasmBuffer, DEFAULT_ALLOW_MOCK)
    // Refuse a code the proxy does not map. Everything outside {0,1,2,3} is
    // allowed at runtime with a warning, so a rule inventing a rung installs
    // clean and then enforces nothing — the same silent shape as a rule that
    // cannot link. 2 is accepted here because already-installed rules use it,
    // but it is deprecated and reported as such.
    if (validationVerdict === 2) {
      // Accepted, because refusing it would break reinstalling a rule that
      // already shipped — but never silently. The guest never receives the
      // request body, so redaction was never expressible, and the proxy maps 2
      // to a block. An author who believes they are redacting is blocking.
      log.warn(
        'Rule returned verdict code 2 (REDACT), which is deprecated. The proxy treats it ' +
          'as a block. Return 1 to block, or 3 to reask.'
      )
    }
    if (![0, 1, 2, 3].includes(validationVerdict)) {
      log.error(
        `Rule returned verdict code ${validationVerdict}, which the proxy does not map — ` +
          'it would be allowed on every request. Valid codes: 0 allow, 1 block, 3 reask.'
      )
      process.exit(1)
    }
  } catch (err) {
    log.error(`Rule failed validation and was NOT installed: ${errMessage(err)}`)
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
  } catch (err) {
    log.error(`Failed to install rule to "${dest}": ${errMessage(err)}`)
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

/**
 * Shape `POST /api/v1/wasm-rules/:id/replay` returns on success — mirrors
 * `ReplaySummary` in `services/control-plane/src/services/ruleBundleGates.ts`
 * plus the two fields the route adds (`ruleId`, `since`).
 */
interface ReplayResult {
  ruleId: string
  since: string | null
  contextCount: number
  wouldActCount: number
  wouldActRate: number
  verdictCounts: Record<string, number>
  sampleMatches: Record<string, unknown>[]
}

const VERDICT_NAMES: Record<string, string> = {
  '0': 'allow',
  '1': 'block',
  '2': 'block (deprecated code 2)',
  '3': 'reask',
}

/**
 * `intutic policy replay <ruleId>` — "prove before enforce": run an installed
 * or not-yet-active rule against a sample of this workspace's own recent
 * traffic and report what it would have done, without touching enforcement.
 *
 * Uses `postWithStatus` rather than `post`: the 422 the route returns for too
 * little sampled traffic is an answer this command exists to report, not a
 * request failure to throw past.
 */
export async function runPolicyReplay(
  ruleId: string,
  opts: { limit?: string; since?: string; dev?: boolean },
): Promise<void> {
  log.header(`Intutic — Replay Policy Rule: ${ruleId}`)

  const client = await getClient(opts.dev)

  const body: { limit?: number; since?: string } = {}
  if (opts.limit !== undefined) {
    const limit = parseInt(opts.limit, 10)
    if (isNaN(limit) || limit <= 0) {
      log.error(`Invalid --limit "${opts.limit}". Must be a positive integer.`)
      process.exit(1)
    }
    body.limit = limit
  }
  if (opts.since !== undefined) {
    body.since = opts.since
  }

  try {
    const { status, body: result } = await client.postWithStatus<
      ReplayResult | { error: string; message?: string; contextCount?: number; minRequired?: number }
    >(`/api/v1/wasm-rules/${ruleId}/replay`, body)

    if (status === 404) {
      log.error(`Rule "${ruleId}" not found in this workspace.`)
      process.exit(1)
    }

    if (status === 422) {
      const err = result as { error: string; message?: string; contextCount?: number; minRequired?: number }
      if (err.error === 'not_enough_traffic') {
        log.warn('Not enough sampled traffic to estimate a would-act rate.')
        log.field('Sampled contexts', String(err.contextCount ?? 0))
        log.field('Required', String(err.minRequired ?? 0))
        log.info(
          'Contexts are sampled at WASM_CONTEXT_SNAPSHOT_RATE (default 5%) as traffic flows ' +
            'through the proxy — this grows with time and traffic, not with --limit.',
        )
      } else {
        log.error(`Replay could not evaluate the rule: ${err.message ?? err.error}`)
      }
      process.exit(1)
    }

    if (status !== 200) {
      log.error(`Replay failed (${status}): ${JSON.stringify(result)}`)
      process.exit(1)
    }

    const summary = result as ReplayResult
    log.success(`Replayed against ${summary.contextCount} sampled context(s).`)
    log.field('Since', summary.since ?? '(all sampled history)')
    log.field('Would act (block/reask/other)', `${summary.wouldActCount} (${(summary.wouldActRate * 100).toFixed(1)}%)`)
    for (const [code, count] of Object.entries(summary.verdictCounts)) {
      log.field(`  verdict ${code} (${VERDICT_NAMES[code] ?? 'unmapped'})`, String(count))
    }
    if (summary.sampleMatches.length > 0) {
      log.info(`First ${summary.sampleMatches.length} non-allow context(s):`)
      console.log(JSON.stringify(summary.sampleMatches, null, 2))
    }
  } catch (err) {
    log.error(`Failed to replay rule: ${errMessage(err)}`)
    process.exit(1)
  }
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
    } catch (err) {
      log.warn(`${file}: unreadable (${errMessage(err)})`)
    }
  }
}
