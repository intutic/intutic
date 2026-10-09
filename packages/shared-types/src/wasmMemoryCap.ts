/**
 * Bound a rule's linear memory before V8 ever compiles it.
 *
 * V8 has no grow hook, but it enforces the maximum a module DECLARES for its
 * own memory: past it, `memory.grow` returns -1 instead of growing. So the
 * memory section is rewritten to declare a maximum no larger than the ceiling,
 * and the engine does the rest, the same guarantee `runner.rs` gets from
 * Wasmtime's `StoreLimits`. A rule that asks for more is refused at load.
 *
 * Only the memory section (id 5) is touched; every other byte is copied
 * through. Shared and 64-bit memories are refused rather than rewritten: the
 * runner never supplies either, and their limits encode differently.
 */

import { assembleModule, malformed, putSection, readSections, readU32, writeU32 } from './wasmBinary.js'

/** One WebAssembly page. */
export const WASM_PAGE_BYTES = 64 * 1024

const MEMORY_SECTION_ID = 5

/**
 * The module with every memory declaring `max <= maxPages`. Throws when a
 * memory's initial size is already over the ceiling, or it is shared/64-bit.
 */
export function capDeclaredMemory(bytes: Uint8Array<ArrayBuffer>, maxPages: number): Uint8Array<ArrayBuffer> {
  const sections = readSections(bytes)
  const memory = sections.find((s) => s.id === MEMORY_SECTION_ID)
  if (!memory) return bytes

  const b = memory.payload
  const count = readU32(b, 0)
  let p = count.next
  const payload = writeU32(count.value)
  for (let i = 0; i < count.value; i++) {
    const flags = b[p]
    if (flags !== 0x00 && flags !== 0x01) {
      throw new Error(`WASM rule declares a shared or 64-bit memory (limits flag 0x${(flags ?? 0).toString(16)}), which the runner does not support`)
    }
    const min = readU32(b, p + 1)
    p = min.next
    let max = maxPages
    if (flags === 0x01) {
      const declared = readU32(b, p)
      p = declared.next
      max = Math.min(declared.value, maxPages)
    }
    if (min.value > maxPages) {
      throw new Error(`WASM rule declares ${min.value * WASM_PAGE_BYTES} bytes of initial memory, over the ${maxPages * WASM_PAGE_BYTES}-byte ceiling`)
    }
    payload.push(0x01, ...writeU32(min.value), ...writeU32(max))
  }
  if (p !== b.length) throw malformed('memory section length mismatch')

  putSection(sections, MEMORY_SECTION_ID, Uint8Array.from(payload))
  return assembleModule(bytes, sections)
}
