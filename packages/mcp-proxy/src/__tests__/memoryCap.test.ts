/**
 * capDeclaredMemory (TD-440): hand-assembled modules, so each limits encoding
 * is exercised exactly rather than whatever a compiler happens to emit.
 */
import { describe, it, expect } from 'vitest'
import { capDeclaredMemory } from '@intutic/shared-types'

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
// type section: one type, (i32) -> i32
const TYPES = [0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]
// function section: one function of type 0
const FUNCS = [0x03, 0x02, 0x01, 0x00]
// export section: "grow" -> func 0, "memory" -> memory 0
const EXPORTS = [
  0x07, 0x11, 0x02,
  0x04, ...Buffer.from('grow'), 0x00, 0x00,
  0x06, ...Buffer.from('memory'), 0x02, 0x00,
]
// code section: (local.get 0) memory.grow 0, end
const CODE = [0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x40, 0x00, 0x0b]
// A trailing custom section, to prove bytes after the memory section survive.
const CUSTOM = [0x00, 0x04, 0x03, ...Buffer.from('end')]

function moduleWithLimits(limits: number[]): Uint8Array {
  const memory = [0x05, limits.length + 1, 0x01, ...limits]
  return new Uint8Array([...HEADER, ...TYPES, ...FUNCS, ...memory, ...EXPORTS, ...CODE, ...CUSTOM])
}

function instantiate(bytes: Uint8Array) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes))
  return instance.exports as { grow: (pages: number) => number; memory: WebAssembly.Memory }
}

describe('capDeclaredMemory', () => {
  it('gives a memory with no maximum one at the ceiling, so V8 refuses growth past it', () => {
    const uncapped = instantiate(moduleWithLimits([0x00, 0x01]))
    expect(uncapped.grow(300)).toBe(1) // the gap this closes

    const capped = instantiate(capDeclaredMemory(moduleWithLimits([0x00, 0x01]), 256))
    expect(capped.grow(300)).toBe(-1)
    expect(capped.memory.buffer.byteLength).toBe(64 * 1024)
    expect(capped.grow(255)).toBe(1) // up to the ceiling still works
    expect(capped.grow(1)).toBe(-1)
  })

  it('lowers a declared maximum above the ceiling and keeps one below it', () => {
    // max 1000 pages (LEB128 0xe8 0x07)
    const lowered = instantiate(capDeclaredMemory(moduleWithLimits([0x01, 0x01, 0xe8, 0x07]), 256))
    expect(lowered.grow(256)).toBe(-1)
    expect(lowered.grow(255)).toBe(1)

    const kept = instantiate(capDeclaredMemory(moduleWithLimits([0x01, 0x01, 0x04]), 256))
    expect(kept.grow(4)).toBe(-1)
    expect(kept.grow(3)).toBe(1)
  })

  it('copies every other section through unchanged', () => {
    const capped = capDeclaredMemory(moduleWithLimits([0x00, 0x01]), 256)
    expect(WebAssembly.Module.customSections(new WebAssembly.Module(capped), 'end')).toHaveLength(1)
    expect(Array.from(capped.slice(-CUSTOM.length))).toEqual(CUSTOM)
  })

  it('refuses an initial size over the ceiling, and shared or 64-bit memories', () => {
    // initial 300 pages (0xac 0x02)
    expect(() => capDeclaredMemory(moduleWithLimits([0x00, 0xac, 0x02]), 256)).toThrow(/initial memory/)
    expect(() => capDeclaredMemory(moduleWithLimits([0x03, 0x01, 0x02]), 256)).toThrow(/shared or 64-bit/)
    expect(() => capDeclaredMemory(moduleWithLimits([0x04, 0x01]), 256)).toThrow(/shared or 64-bit/)
  })

  it('returns a module with no memory section as it was', () => {
    const bytes = new Uint8Array([...HEADER, ...TYPES])
    expect(capDeclaredMemory(bytes, 256)).toBe(bytes)
  })
})
