/**
 * Bound a rule's linear memory before V8 ever compiles it (TD-440).
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

/** One WebAssembly page. */
export const WASM_PAGE_BYTES = 64 * 1024

const MEMORY_SECTION_ID = 5
const HEADER_BYTES = 8 // `\0asm` + version

function readU32(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  for (let i = at; i < bytes.length && i < at + 5; i++) {
    const byte = bytes[i]!
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: i + 1 }
    shift += 7
  }
  throw new Error('malformed WASM module: truncated or oversized LEB128 integer')
}

function writeU32(value: number): number[] {
  const out: number[] = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value !== 0) byte |= 0x80
    out.push(byte)
  } while (value !== 0)
  return out
}

/**
 * The module with every memory declaring `max <= maxPages`. Throws when a
 * memory's initial size is already over the ceiling, or it is shared/64-bit.
 */
export function capDeclaredMemory(bytes: Uint8Array<ArrayBuffer>, maxPages: number): Uint8Array<ArrayBuffer> {
  let at = HEADER_BYTES
  while (at < bytes.length) {
    const sectionStart = at
    const id = bytes[at]!
    const size = readU32(bytes, at + 1)
    const payloadStart = size.next
    const payloadEnd = payloadStart + size.value
    if (payloadEnd > bytes.length) throw new Error('malformed WASM module: section runs past the end')

    if (id === MEMORY_SECTION_ID) {
      const count = readU32(bytes, payloadStart)
      let p = count.next
      const payload = writeU32(count.value)
      for (let i = 0; i < count.value; i++) {
        const flags = bytes[p]
        if (flags !== 0x00 && flags !== 0x01) {
          throw new Error(`WASM rule declares a shared or 64-bit memory (limits flag 0x${(flags ?? 0).toString(16)}), which the runner does not support`)
        }
        const min = readU32(bytes, p + 1)
        p = min.next
        let max = maxPages
        if (flags === 0x01) {
          const declared = readU32(bytes, p)
          p = declared.next
          max = Math.min(declared.value, maxPages)
        }
        if (min.value > maxPages) {
          throw new Error(`WASM rule declares ${min.value * WASM_PAGE_BYTES} bytes of initial memory, over the ${maxPages * WASM_PAGE_BYTES}-byte ceiling`)
        }
        payload.push(0x01, ...writeU32(min.value), ...writeU32(max))
      }
      if (p !== payloadEnd) throw new Error('malformed WASM module: memory section length mismatch')

      const out = new Uint8Array(sectionStart + 1 + writeU32(payload.length).length + payload.length + (bytes.length - payloadEnd))
      out.set(bytes.subarray(0, sectionStart), 0)
      const section = [MEMORY_SECTION_ID, ...writeU32(payload.length), ...payload]
      out.set(section, sectionStart)
      out.set(bytes.subarray(payloadEnd), sectionStart + section.length)
      return out
    }
    at = payloadEnd
  }
  return bytes
}
