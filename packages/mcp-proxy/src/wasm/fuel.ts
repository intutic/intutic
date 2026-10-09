/**
 * Instruction budget for WASM rules (TD-440): the MCP proxy's stand-in for
 * Wasmtime fuel, which `runner.rs` sets to 1,000,000 per evaluation.
 *
 * V8 has no metering hook, so the rule's own code is rewritten at load to
 * count. A new mutable i32 global starts at the budget, and a charge is
 * inserted at every function entry and every loop header: subtract the number
 * of instructions that can run before the next charge point, and trap
 * (`unreachable`) once the counter goes negative. Code between two charge
 * points is straight-line apart from forward branches, so each charge is an
 * upper bound on what it pays for, and the budget bounds the instructions the
 * rule actually executes. Structural instructions (`block`, `loop`, `end`,
 * `else`, `nop`, `drop`, `return`, `unreachable`) cost nothing, roughly as
 * Wasmtime prices them.
 *
 * The global is exported as `FUEL_EXPORT` so the worker can tell a trap caused
 * by the budget from any other trap. Each evaluation instantiates the module
 * afresh, so the budget is per evaluation, like a Wasmtime `Store`.
 *
 * The decoder knows the MVP instruction set plus the extensions compilers
 * emit by default (sign extension, saturating truncation, bulk memory,
 * reference types, multi-value, tail calls, SIMD). A module using anything
 * else (exceptions, GC, threads) is refused at load rather than run unmetered.
 */

import {
  assembleModule,
  concat,
  malformed,
  putSection,
  readSections,
  readU32,
  skipLeb,
  writeS32,
  writeU32,
  type Section,
} from './wasmBinary.js'

/** `runner.rs`: `store.set_fuel(1_000_000)`. */
export const DEFAULT_FUEL_BUDGET = 1_000_000

/**
 * A Rego rule's budget: three times the Rust proxy's 100,000,000
 * (`limits::REGO`), because this meter counts differently.
 *
 * It charges each straight-line run in full at its entry, branches skipped or
 * not, and an OPA build is mostly short runs with early exits: on the largest
 * input (a 64 KB command) the destructive-shell and production-deploy examples
 * count 74,000,000 here against 21,000,000 under Wasmtime, and the
 * deny-writes and conformance policies about 8,000,000. The budget is four
 * times the largest, so a heavier policy on the largest input still fits, and
 * a rule that does not fit is stopped deterministically, whatever the load.
 * Using it all up takes at most 350 ms idle and 4.4 s on a loaded machine;
 * the deadline (`REGO_EVALUATE_TIMEOUT_MS`) is set above that.
 */
export const REGO_FUEL_BUDGET = 300_000_000

/** The export the worker reads to tell budget exhaustion from other traps. */
export const FUEL_EXPORT = '__intutic_fuel'

const SECTION = { import: 2, global: 6, export: 7, code: 10 } as const
const EXPORT_KIND_GLOBAL = 0x03
const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f])
const ZERO_COST = new Set([0x00, 0x01, 0x02, 0x03, 0x05, 0x0b, 0x0f, 0x1a])
const OP = { block: 0x02, loop: 0x03, if: 0x04, end: 0x0b } as const

function unsupported(op: string): Error {
  return new Error(`WASM rule uses instruction ${op}, which the instruction budget cannot meter; rebuild it without exceptions, GC or threads`)
}

function skipBlockType(b: Uint8Array, p: number): number {
  const t = b[p]!
  if (t === 0x40 || VALTYPES.has(t)) return p + 1
  // A type index, as a non-negative s33: a first byte below 0x40, or one
  // with the continuation bit set.
  if (t < 0x40 || (t & 0x80) !== 0) return skipLeb(b, p)
  throw unsupported(`with block type 0x${t.toString(16)}`)
}

function skipMemarg(b: Uint8Array, p: number): number {
  const align = readU32(b, p)
  p = align.next
  if (align.value & 0x40) p = skipLeb(b, p) // multi-memory index
  return skipLeb(b, p)
}

function skipN(b: Uint8Array, p: number, n: number): number {
  for (let i = 0; i < n; i++) p = skipLeb(b, p)
  return p
}

/** Offset just past the instruction at `p`, immediates included. */
function nextInstruction(b: Uint8Array, p: number): number {
  const op = b[p]!
  const q = p + 1
  if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1) return q
  if (op >= 0x45 && op <= 0xc4) return q // numeric, sign extension
  switch (op) {
    case 0x02: case 0x03: case 0x04: return skipBlockType(b, q)
    case 0x0c: case 0x0d: case 0x10: case 0x12: case 0xd2: return skipLeb(b, q)
    case 0x0e: { const n = readU32(b, q); return skipN(b, n.next, n.value + 1) }
    case 0x11: case 0x13: return skipN(b, q, 2)
    case 0x1c: {
      const n = readU32(b, q)
      for (let i = 0; i < n.value; i++) if (!VALTYPES.has(b[n.next + i]!)) throw unsupported('select with a non-numeric type')
      return n.next + n.value
    }
    case 0x3f: case 0x40: case 0x41: case 0x42: return skipLeb(b, q)
    case 0x43: return q + 4
    case 0x44: return q + 8
    case 0xd0: {
      if (b[q] !== 0x70 && b[q] !== 0x6f) throw unsupported('ref.null with a GC heap type')
      return q + 1
    }
    case 0xfc: return nextPrefixedFc(b, q)
    case 0xfd: return nextSimd(b, q)
  }
  if (op >= 0x20 && op <= 0x26) return skipLeb(b, q) // locals, globals, table.get/set
  if (op >= 0x28 && op <= 0x3e) return skipMemarg(b, q) // loads and stores
  throw unsupported(`0x${op.toString(16)}`)
}

function nextPrefixedFc(b: Uint8Array, q: number): number {
  const sub = readU32(b, q)
  const p = sub.next
  if (sub.value <= 7) return p // saturating truncation
  switch (sub.value) {
    case 8: case 10: case 12: case 14: return skipN(b, p, 2) // memory.init, memory.copy, table.init, table.copy
    case 9: case 11: case 13: case 15: case 16: case 17: return skipLeb(b, p)
  }
  throw unsupported(`0xfc ${sub.value}`)
}

function nextSimd(b: Uint8Array, q: number): number {
  const sub = readU32(b, q)
  const p = sub.next
  const op = sub.value
  if (op <= 11 || op === 92 || op === 93) return skipMemarg(b, p) // v128 loads/stores, load*_zero
  if (op === 12 || op === 13) return p + 16 // v128.const, i8x16.shuffle
  if (op >= 21 && op <= 34) return p + 1 // extract/replace lane
  if (op >= 84 && op <= 91) return skipMemarg(b, p) + 1 // load/store lane
  if (op <= 0x113) return p // everything else in SIMD and relaxed SIMD has no immediate
  throw unsupported(`0xfd ${op}`)
}

function chargeSequence(cost: number, global: number): number[] {
  const g = writeU32(global)
  return [
    0x23, ...g, 0x41, ...writeS32(cost), 0x6b, 0x24, ...g, // fuel -= cost
    0x23, ...g, 0x41, 0x00, 0x48, 0x04, 0x40, 0x00, 0x0b, // if (fuel < 0) unreachable
  ]
}

/** One function body with a charge at its entry and at every loop header. */
function meterBody(body: Uint8Array, global: number): Uint8Array {
  let p = 0
  const groups = readU32(body, p)
  p = groups.next
  for (let i = 0; i < groups.value; i++) {
    p = readU32(body, p).next
    if (!VALTYPES.has(body[p]!)) throw unsupported('a local of a GC type')
    p += 1
  }

  interface Region { at: number; cost: number }
  const regions: Region[] = [{ at: p, cost: 0 }]
  const closed: Region[] = []
  const blocks: boolean[] = [] // true for a loop
  let ended = false
  while (p < body.length) {
    if (ended) throw malformed('instructions after a function body ends')
    const op = body[p]!
    const next = nextInstruction(body, p)
    if (!ZERO_COST.has(op)) regions[regions.length - 1]!.cost += 1
    if (op === OP.block || op === OP.if) blocks.push(false)
    else if (op === OP.loop) {
      blocks.push(true)
      regions.push({ at: next, cost: 0 })
    } else if (op === OP.end) {
      if (blocks.length === 0) {
        closed.push(regions.pop()!)
        ended = true
      } else if (blocks.pop()) {
        closed.push(regions.pop()!)
      }
    }
    p = next
  }
  if (!ended || regions.length !== 0) throw malformed('unbalanced function body')

  closed.sort((a, b) => a.at - b.at)
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const r of closed) {
    parts.push(body.subarray(cursor, r.at), Uint8Array.from(chargeSequence(Math.max(1, r.cost), global)))
    cursor = r.at
  }
  parts.push(body.subarray(cursor))
  return concat(parts)
}

function skipLimits(b: Uint8Array, p: number): number {
  const flags = b[p]!
  p = skipLeb(b, p + 1)
  return flags & 0x01 ? skipLeb(b, p) : p
}

function countImportedGlobals(s: Section | undefined): number {
  if (!s) return 0
  const b = s.payload
  const n = readU32(b, 0)
  let p = n.next
  let globals = 0
  for (let i = 0; i < n.value; i++) {
    for (let name = 0; name < 2; name++) {
      const len = readU32(b, p)
      p = len.next + len.value
    }
    const kind = b[p++]
    if (kind === 0x00 || kind === 0x04) p = skipLeb(b, kind === 0x04 ? p + 1 : p)
    else if (kind === 0x01) {
      if (b[p] !== 0x70 && b[p] !== 0x6f) throw unsupported('an imported table of a GC type')
      p = skipLimits(b, p + 1)
    } else if (kind === 0x02) p = skipLimits(b, p)
    else if (kind === 0x03) {
      if (!VALTYPES.has(b[p]!)) throw unsupported('an imported global of a GC type')
      p += 2
      globals += 1
    } else throw malformed(`import kind ${kind}`)
  }
  return globals
}

function exportNames(s: Section | undefined): string[] {
  if (!s) return []
  const b = s.payload
  const n = readU32(b, 0)
  let p = n.next
  const names: string[] = []
  for (let i = 0; i < n.value; i++) {
    const len = readU32(b, p)
    names.push(new TextDecoder().decode(b.subarray(len.next, len.next + len.value)))
    p = readU32(b, len.next + len.value + 1).next
  }
  return names
}

/** Prepend-count helper: a vector section with `extra` appended. */
function appendToVector(s: Section | undefined, extra: number[]): Uint8Array<ArrayBuffer> {
  if (!s) return Uint8Array.from([0x01, ...extra])
  const n = readU32(s.payload, 0)
  return concat([Uint8Array.from(writeU32(n.value + 1)), s.payload.subarray(n.next), Uint8Array.from(extra)])
}

/**
 * The module with every function metered against `budget` instructions per
 * instantiation, and the counter exported as `FUEL_EXPORT`. Throws for a
 * module the decoder cannot meter.
 */
export function meterFuel(bytes: Uint8Array<ArrayBuffer>, budget: number): Uint8Array<ArrayBuffer> {
  const sections = readSections(bytes)
  const find = (id: number) => sections.find((s) => s.id === id)
  const code = find(SECTION.code)
  if (!code) return bytes

  const exports = find(SECTION.export)
  if (exportNames(exports).includes(FUEL_EXPORT)) {
    throw new Error(`WASM rule already exports "${FUEL_EXPORT}", which the instruction budget reserves`)
  }
  const globals = find(SECTION.global)
  const fuelGlobal = countImportedGlobals(find(SECTION.import)) + (globals ? readU32(globals.payload, 0).value : 0)

  const count = readU32(code.payload, 0)
  const bodies: Uint8Array[] = [Uint8Array.from(writeU32(count.value))]
  let p = count.next
  for (let i = 0; i < count.value; i++) {
    const size = readU32(code.payload, p)
    const end = size.next + size.value
    if (end > code.payload.length) throw malformed('function body runs past the code section')
    const metered = meterBody(code.payload.subarray(size.next, end), fuelGlobal)
    bodies.push(Uint8Array.from(writeU32(metered.length)), metered)
    p = end
  }
  if (p !== code.payload.length) throw malformed('code section length mismatch')

  putSection(sections, SECTION.global, appendToVector(globals, [0x7f, 0x01, 0x41, ...writeS32(budget), 0x0b]))
  const name = [...new TextEncoder().encode(FUEL_EXPORT)]
  putSection(sections, SECTION.export, appendToVector(exports, [...writeU32(name.length), ...name, EXPORT_KIND_GLOBAL, ...writeU32(fuelGlobal)]))
  putSection(sections, SECTION.code, concat(bodies))
  return assembleModule(bytes, sections)
}
