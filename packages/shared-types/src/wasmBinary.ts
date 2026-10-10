/**
 * The few pieces of the WebAssembly binary format the load-time rewrites
 * (`wasmMemoryCap.ts`, `wasmFuel.ts`) share: LEB128 integers, the section list, and
 * reassembly. Not a general decoder; each rewrite parses only what it changes.
 */

const HEADER_BYTES = 8 // `\0asm` + version

export interface Section {
  id: number
  payload: Uint8Array<ArrayBuffer>
}

export function malformed(what: string): Error {
  return new Error(`malformed WASM module: ${what}`)
}

export function readU32(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  for (let i = at; i < bytes.length && i < at + 5; i++) {
    const byte = bytes[i]!
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: i + 1 }
    shift += 7
  }
  throw malformed('truncated or oversized LEB128 integer')
}

/** Skip any LEB128 integer, signed or unsigned, up to 64 bits. */
export function skipLeb(bytes: Uint8Array, at: number): number {
  for (let i = at; i < bytes.length && i < at + 10; i++) {
    if ((bytes[i]! & 0x80) === 0) return i + 1
  }
  throw malformed('truncated or oversized LEB128 integer')
}

export function writeU32(value: number): number[] {
  const out: number[] = []
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value !== 0) byte |= 0x80
    out.push(byte)
  } while (value !== 0)
  return out
}

/** Signed LEB128, for `i32.const` immediates. */
export function writeS32(value: number): number[] {
  const out: number[] = []
  for (;;) {
    const byte = value & 0x7f
    value >>= 7
    const done = (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)
    out.push(done ? byte : byte | 0x80)
    if (done) return out
  }
}

export function readSections(bytes: Uint8Array<ArrayBuffer>): Section[] {
  const sections: Section[] = []
  let at = HEADER_BYTES
  while (at < bytes.length) {
    const id = bytes[at]!
    const size = readU32(bytes, at + 1)
    const end = size.next + size.value
    if (end > bytes.length) throw malformed('section runs past the end')
    sections.push({ id, payload: bytes.subarray(size.next, end) })
    at = end
  }
  return sections
}

/** Section order the spec requires; custom sections (id 0) may sit anywhere. */
const SECTION_RANK: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 }

/** Replace the section with `id`, or insert it where the spec's order puts it. */
export function putSection(sections: Section[], id: number, payload: Uint8Array<ArrayBuffer>): void {
  const existing = sections.findIndex((s) => s.id === id)
  if (existing >= 0) {
    sections[existing] = { id, payload }
    return
  }
  const rank = SECTION_RANK[id]!
  let insertAt = 0
  sections.forEach((s, i) => {
    if (s.id !== 0 && SECTION_RANK[s.id]! < rank) insertAt = i + 1
  })
  sections.splice(insertAt, 0, { id, payload })
}

export function assembleModule(header: Uint8Array, sections: Section[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [header.subarray(0, HEADER_BYTES)]
  for (const s of sections) {
    parts.push(Uint8Array.from([s.id, ...writeU32(s.payload.length)]), s.payload)
  }
  return concat(parts)
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
