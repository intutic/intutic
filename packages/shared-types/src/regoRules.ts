/**
 * Rego policies compiled by OPA (`opa build -t wasm`), run as Intutic rules —
 * the TypeScript host, mirroring `packages/proxy/src/wasm/opa.rs`.
 *
 * Used by every TypeScript surface that loads or runs a Rego rule: the MCP
 * governance proxy evaluates with it, `intutic rules build|test` and
 * `intutic policy install` validate and run with it, and the control plane
 * checks an upload with it. One host, so a rule one of them accepts the others
 * do not refuse.
 *
 * Browser-safe: no Node imports. The two hash builtins take the host's digest
 * function through {@link RegoHostOptions}; without one, a policy using them
 * is refused at load.
 *
 * The contract a policy is written against — the input document, the result
 * shapes and the packaging — is documented once, on the guide page
 * "Rego policies", and in `opa.rs`.
 *
 * @module
 */

import { REGO_HOST_BUILTINS, type RegoBuiltin, type RegoDigest } from './regoBuiltins.js'

/** The custom section `intutic rules build` writes a rule's metadata into. */
export const REGO_METADATA_SECTION = 'intutic.rule'

/** `input.v`: bumped only for a change a policy could observe. */
export const REGO_INPUT_VERSION = 1

/** Largest policy input, in bytes; long strings in `args` are cut to fit. */
export const REGO_MAX_INPUT_BYTES = 64 * 1024

/** Set to `1` to refuse Rego rules on a host. */
export const REGO_DISABLE_ENV = 'INTUTIC_DISABLE_REGO_RULES'

const TRUNCATION_STEPS = [16 * 1024, 4 * 1024, 1024, 256]
const MAX_MEMORY_PAGES = 256
const MAX_BUILTIN_RESULT_BYTES = 1024 * 1024

export type RegoRiskTier = 'low' | 'medium' | 'high' | 'critical'
const RISK_TIERS: readonly RegoRiskTier[] = ['low', 'medium', 'high', 'critical']

export interface RegoRuleMetadata {
  v: number
  abi: string
  entrypoint?: string
  risk_tier?: string
}

export interface RegoHostOptions {
  digest?: RegoDigest
  /** Called with each new instance's exports, before evaluation (the MCP proxy reads its fuel counter). */
  onInstance?: (exports: Record<string, unknown>) => void
}

/** A loaded Rego rule: what evaluation needs, resolved once. */
export interface RegoRule {
  module: WebAssembly.Module
  /** Pages of memory the module's import asks for at least. */
  memoryPages: number
  entrypoint: string
  entrypointId: number
  /** By the module's own builtin ids. */
  builtins: ReadonlyMap<number, RegoBuiltin>
  /** Applied to a decision that does not name its own. */
  riskTier?: RegoRiskTier
}

export type RegoDecision =
  | { decision: 'allow'; riskTier?: RegoRiskTier }
  | { decision: 'deny' | 'hold' | 'reask'; reason: string; riskTier?: RegoRiskTier }

/** Whether `module` was produced by `opa build -t wasm`. */
export function isOpaModule(module: WebAssembly.Module): boolean {
  const importsMemory = WebAssembly.Module.imports(module).some((i) => i.module === 'env' && i.name === 'memory')
  const exports = new Set(WebAssembly.Module.exports(module).map((e) => e.name))
  return importsMemory && exports.has('opa_eval') && exports.has('opa_wasm_abi_version')
}

/** The rule's metadata, or null without one. Throws for a section that does not parse. */
export function readRegoMetadata(module: WebAssembly.Module): RegoRuleMetadata | null {
  const sections = WebAssembly.Module.customSections(module, REGO_METADATA_SECTION)
  if (sections.length === 0) return null
  let meta: RegoRuleMetadata
  try {
    meta = JSON.parse(new TextDecoder().decode(sections[0])) as RegoRuleMetadata
  } catch (err) {
    throw new Error(`unreadable \`${REGO_METADATA_SECTION}\` section: ${(err as Error).message}`, { cause: err })
  }
  if (meta.v !== 1) throw new Error(`\`${REGO_METADATA_SECTION}\` version ${String(meta.v)} is not supported (1 is)`)
  return meta
}

function leb128(n: number): number[] {
  const out: number[] = []
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n !== 0) byte |= 0x80
    out.push(byte)
  } while (n !== 0)
  return out
}

/** `bytes` with a metadata custom section appended (custom sections may go anywhere). */
export function withRegoMetadata(bytes: Uint8Array, meta: RegoRuleMetadata): Uint8Array {
  const name = new TextEncoder().encode(REGO_METADATA_SECTION)
  const payload = new TextEncoder().encode(JSON.stringify(meta))
  const body = [...leb128(name.length), ...name, ...payload]
  const out = new Uint8Array(bytes.length + 1 + leb128(body.length).length + body.length)
  out.set(bytes, 0)
  out.set([0, ...leb128(body.length), ...body], bytes.length)
  return out
}

function parseRiskTier(tier: string): RegoRiskTier | undefined {
  const t = tier.toLowerCase() as RegoRiskTier
  return RISK_TIERS.includes(t) ? t : undefined
}

interface Instantiated {
  exports: Record<string, unknown>
  memory: WebAssembly.Memory
}

function fn<T extends (...args: never[]) => unknown>(exports: Record<string, unknown>, name: string): T {
  const f = exports[name]
  if (typeof f !== 'function') throw new Error(`the OPA module does not export \`${name}\``)
  return f as T
}

function readCString(memory: WebAssembly.Memory, addr: number): string {
  const bytes = new Uint8Array(memory.buffer)
  if (addr < 0 || addr >= bytes.length) throw new Error(`string address ${addr} is outside memory`)
  const end = bytes.indexOf(0, addr)
  if (end < 0) throw new Error(`unterminated string at ${addr}`)
  return new TextDecoder().decode(bytes.subarray(addr, end))
}

function dumpValue(inst: Instantiated, addr: number): unknown {
  return JSON.parse(readCString(inst.memory, fn<(a: number) => number>(inst.exports, 'opa_json_dump')(addr)))
}

/** Write JSON text into the module and parse it into an OPA value. */
function loadValue(inst: Instantiated, json: string): number {
  const bytes = new TextEncoder().encode(json)
  const addr = fn<(n: number) => number>(inst.exports, 'opa_malloc')(bytes.length)
  new Uint8Array(inst.memory.buffer).set(bytes, addr)
  return fn<(a: number, n: number) => number>(inst.exports, 'opa_json_parse')(addr, bytes.length)
}

function leb(bytes: Uint8Array, p: number): { value: number; next: number } {
  let value = 0
  for (let shift = 0; shift < 35; shift += 7) {
    const b = bytes[p++]
    if (b === undefined) break
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) return { value, next: p }
  }
  throw new Error('malformed WASM binary')
}

/**
 * The minimum pages of the module's imported memory. `WebAssembly.Module`
 * does not expose import limits, so this reads the import section.
 */
export function importedMemoryPages(bytes: Uint8Array): number {
  let p = 8
  while (p < bytes.length) {
    const id = bytes[p] as number
    const size = leb(bytes, p + 1)
    const end = size.next + size.value
    if (id === 2) {
      let q = size.next
      const count = leb(bytes, q)
      q = count.next
      for (let i = 0; i < count.value; i++) {
        for (let n = 0; n < 2; n++) {
          const len = leb(bytes, q)
          q = len.next + len.value
        }
        const kind = bytes[q++]
        if (kind === 0) q = leb(bytes, q).next
        else if (kind === 1) q = skipLimits(bytes, q + 1)
        else if (kind === 2) return leb(bytes, q + 1).value
        else if (kind === 3) q += 2
        else throw new Error(`unknown import kind ${String(kind)}`)
      }
    }
    p = end
  }
  throw new Error('not an OPA module: no env.memory import')
}

function skipLimits(bytes: Uint8Array, p: number): number {
  const flags = bytes[p] as number
  let q = leb(bytes, p + 1).next
  if (flags & 1) q = leb(bytes, q).next
  return q
}

function instantiate(
  rule: Pick<RegoRule, 'module' | 'memoryPages'>,
  builtins: ReadonlyMap<number, RegoBuiltin>,
  options: RegoHostOptions,
): Instantiated {
  const memory = new WebAssembly.Memory({ initial: rule.memoryPages, maximum: MAX_MEMORY_PAGES })
  const holder: { inst?: Instantiated } = {}
  const ctx = { nowNs: BigInt(Date.now()) * 1_000_000n, digest: options.digest }
  const call = (id: number, args: number[]): number => {
    const builtin = builtins.get(id)
    const inst = holder.inst
    if (!builtin || !inst) throw new Error(`the policy called builtin ${id}, which was not provided`)
    let json: string
    try {
      const result = builtin(ctx, args.map((a) => dumpValue(inst, a)))
      json = typeof result === 'bigint' ? result.toString() : JSON.stringify(result)
      if (json === undefined) return 0
      if (json.length > MAX_BUILTIN_RESULT_BYTES) return 0
    } catch {
      // OPA's "undefined": the expression fails, as `opa eval` does with a
      // builtin error outside strict mode.
      return 0
    }
    return loadValue(inst, json)
  }
  const env = {
    memory,
    opa_abort: () => {
      throw new Error('the OPA policy aborted')
    },
    opa_println: () => {},
    opa_builtin0: (id: number) => call(id, []),
    opa_builtin1: (id: number, _ctx: number, a: number) => call(id, [a]),
    opa_builtin2: (id: number, _ctx: number, a: number, b: number) => call(id, [a, b]),
    opa_builtin3: (id: number, _ctx: number, a: number, b: number, c: number) => call(id, [a, b, c]),
    opa_builtin4: (id: number, _ctx: number, a: number, b: number, c: number, d: number) => call(id, [a, b, c, d]),
  }
  const instance = new WebAssembly.Instance(rule.module, { env })
  holder.inst = { exports: instance.exports as Record<string, unknown>, memory }
  options.onInstance?.(holder.inst.exports)
  return holder.inst
}

/**
 * Load a module as a Rego rule: null for a native rule, an Error for an OPA
 * build this host cannot run, naming what is missing.
 *
 * `module` is `bytes` compiled; a caller that rewrites a module before running
 * it (the MCP proxy meters fuel) passes the rewritten one.
 */
export function loadRegoRule(
  bytes: Uint8Array,
  module: WebAssembly.Module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>),
  options: RegoHostOptions = {},
): RegoRule | null {
  const meta = readRegoMetadata(module)
  if (!isOpaModule(module)) {
    if (meta?.abi === 'opa') throw new Error('the metadata says abi `opa`, but the module is not an OPA build')
    return null
  }
  if (meta && meta.abi !== 'opa') throw new Error(`an OPA build whose metadata says abi \`${meta.abi}\``)
  for (const i of WebAssembly.Module.imports(module)) {
    const ok =
      i.module === 'env' &&
      (i.name === 'memory' || i.name === 'opa_abort' || i.name === 'opa_println' || i.name.startsWith('opa_builtin'))
    if (!ok) throw new Error(`the OPA module imports \`${i.module}.${i.name}\`, which the host does not provide`)
  }

  const memoryPages = importedMemoryPages(bytes)
  if (memoryPages > MAX_MEMORY_PAGES) {
    throw new Error(`the module asks for ${memoryPages} pages of memory; the cap is ${MAX_MEMORY_PAGES}`)
  }
  const inst = instantiate({ module, memoryPages }, new Map(), options)
  const abi = (name: string): number => {
    const g = inst.exports[name]
    if (!(g instanceof WebAssembly.Global)) throw new Error(`missing ABI global \`${name}\``)
    return g.value as number
  }
  const [major, minor] = [abi('opa_wasm_abi_version'), abi('opa_wasm_abi_minor_version')]
  if (major !== 1 || minor < 2) throw new Error(`OPA WASM ABI ${major}.${minor}; the host needs 1.2 or later (opa_eval)`)

  const wanted = dumpValue(inst, fn<() => number>(inst.exports, 'builtins')()) as Record<string, number>
  const builtins = new Map<number, RegoBuiltin>()
  const missing: string[] = []
  for (const [name, id] of Object.entries(wanted)) {
    const builtin = REGO_HOST_BUILTINS[name]
    const needsDigest = name === 'crypto.sha1' || name === 'crypto.sha256'
    if (builtin && (!needsDigest || options.digest)) builtins.set(id, builtin)
    else missing.push(name)
  }
  if (missing.length > 0) {
    throw new Error(
      `the policy uses builtins this host does not provide: ${missing.sort().join(', ')}. Host-provided builtins: ` +
        `${Object.keys(REGO_HOST_BUILTINS).sort().join(', ')}; most others are compiled into the module by OPA`,
    )
  }

  const entrypoints = dumpValue(inst, fn<() => number>(inst.exports, 'entrypoints')()) as Record<string, number>
  const names = Object.keys(entrypoints)
  let entrypoint: string
  if (meta?.entrypoint) entrypoint = meta.entrypoint
  else if (names.length === 1) entrypoint = names[0] as string
  else {
    throw new Error(
      `the module has ${names.length} entrypoints and no metadata naming one; build it with ` +
        '`intutic rules build --rego <path> --entrypoint <package/rule>`',
    )
  }
  const entrypointId = entrypoints[entrypoint]
  if (typeof entrypointId !== 'number') {
    throw new Error(
      `no \`${entrypoint}\` entrypoint in the module (it has ${names.join(', ')}); build with ` +
        `\`opa build -t wasm -e ${entrypoint}\``,
    )
  }

  let riskTier: RegoRiskTier | undefined
  if (meta?.risk_tier !== undefined) {
    riskTier = parseRiskTier(meta.risk_tier)
    if (!riskTier) throw new Error(`unknown risk tier \`${meta.risk_tier}\` in the metadata`)
  }
  return { module, memoryPages, entrypoint, entrypointId, builtins, ...(riskTier ? { riskTier } : {}) }
}

/**
 * Evaluate `rule` once against an input document (JSON text), returning the
 * raw `opa_eval` result: `[{"result": …}]`, or `[]` when undefined.
 */
export function evaluateRegoRule(rule: RegoRule, input: string, options: RegoHostOptions = {}): unknown {
  const inst = instantiate(rule, rule.builtins, options)
  const data = loadValue(inst, '{}')
  const bytes = new TextEncoder().encode(input)
  const heap = fn<() => number>(inst.exports, 'opa_heap_ptr_get')()
  const end = heap + bytes.length
  if (end > inst.memory.buffer.byteLength) {
    inst.memory.grow(Math.ceil((end - inst.memory.buffer.byteLength) / 65536))
  }
  new Uint8Array(inst.memory.buffer).set(bytes, heap)
  const result = fn<(...a: number[]) => number>(inst.exports, 'opa_eval')(
    0,
    rule.entrypointId,
    data,
    heap,
    bytes.length,
    end,
    0,
  )
  return JSON.parse(readCString(inst.memory, result))
}

/** Rust's `char::is_control`: C0, DEL and C1. */
const isControl = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
}

/** A policy-supplied reason made safe to show, as the Rust host's `sanitize_reason`. */
function sanitize(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = [...text.trim()]
    .slice(0, 480)
    .filter((ch) => !isControl(ch))
    .join('')
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Thrown by {@link regoDecision} for a result in none of the documented
 * shapes: the rule reached no decision, and the host's fail setting decides
 * what that means for the call, as for a rule that ran out of time.
 */
export class RegoResultError extends Error {
  override name = 'RegoResultError'
}

/**
 * Map an `opa_eval` result to a decision. Undefined allows; a result in none
 * of the documented shapes throws {@link RegoResultError}.
 */
export function regoDecision(result: unknown, entrypoint: string): RegoDecision {
  const value = Array.isArray(result) ? (result[0] as { result?: unknown } | undefined)?.result : undefined
  const fallback = (verb: string): string => `${verb} by Rego policy ${entrypoint}`
  if (value === undefined || value === false) return { decision: 'allow' }
  if (value === true) return { decision: 'deny', reason: fallback('Denied') }
  if (Array.isArray(value)) {
    return value.length === 0 ? { decision: 'allow' } : { decision: 'deny', reason: sanitize(value[0]) ?? fallback('Denied') }
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const riskTier = typeof obj['risk_tier'] === 'string' ? parseRiskTier(obj['risk_tier']) : undefined
    const tier = riskTier ? { riskTier } : {}
    switch (obj['decision']) {
      case 'allow':
        return { decision: 'allow', ...tier }
      case 'deny':
        return { decision: 'deny', reason: sanitize(obj['reason']) ?? fallback('Denied'), ...tier }
      case 'hold':
        return { decision: 'hold', reason: sanitize(obj['reason']) ?? fallback('Held for approval'), ...tier }
      case 'reask':
        return { decision: 'reask', reason: sanitize(obj['reason']) ?? fallback('Refused'), ...tier }
    }
    throw new RegoResultError('it returned an object without a known `decision` (allow, deny, hold, reask)')
  }
  throw new RegoResultError('it returned neither a boolean, a set of messages nor a decision object')
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length

/** Cut a string to at most `limit` UTF-8 bytes, at a character boundary. */
function cut(s: string, limit: number): string {
  if (utf8Length(s) <= limit) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = utf8Length(ch)
    if (used + n > limit) break
    out += ch
    used += n
  }
  return out
}

function truncateStrings(v: unknown, limit: number): unknown {
  if (typeof v === 'string') return cut(v, limit)
  if (Array.isArray(v)) return v.map((x) => truncateStrings(x, limit))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, truncateStrings(x, limit)]))
  }
  return v
}

/**
 * Serialise a policy input, cutting long strings in `args` until it fits in
 * {@link REGO_MAX_INPUT_BYTES} — the same steps as the Rust host, so both
 * hosts hand a policy the same document.
 */
export function boundedRegoInput(input: Record<string, unknown>): string {
  let doc: Record<string, unknown> = { ...input, truncated: false }
  let text = JSON.stringify(doc)
  if (utf8Length(text) <= REGO_MAX_INPUT_BYTES) return text
  doc = { ...doc, truncated: true }
  for (const limit of TRUNCATION_STEPS) {
    doc = { ...doc, args: truncateStrings(doc['args'], limit) }
    text = JSON.stringify(doc)
    if (utf8Length(text) <= REGO_MAX_INPUT_BYTES) return text
  }
  return JSON.stringify({ ...doc, args: null })
}
