/**
 * hostImports.test.ts — `read_referenced_file` against a fake guest memory
 * (TD-441): the code-for-code port of `host.rs`'s `read_referenced_file_impl`.
 */
import { describe, it, expect } from 'vitest'
import { createHostImports, newHostImportState } from '../wasm/hostImports.js'
import {
  ReferencedFiles,
  ERR_BAD_ARGS,
  ERR_BUDGET,
  ERR_BUFFER_TOO_SMALL,
  ERR_NOT_FOUND,
  ERR_REFUSED,
  MAX_READS_PER_EVALUATION,
} from '../wasm/referencedFiles.js'

type ReadFn = (pathPtr: number, pathLen: number, outPtr: number, outCap: number) => number

function harness(files: ReferencedFiles) {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const state = newHostImportState(files)
  const env = createHostImports(() => memory, state)
  const read = env['read_referenced_file'] as ReadFn
  const put = (text: string, at: number) => {
    const bytes = new TextEncoder().encode(text)
    new Uint8Array(memory.buffer).set(bytes, at)
    return bytes.length
  }
  return { memory, state, read, put }
}

const table = (entries: Array<[string, string | number]>) =>
  ReferencedFiles.fromTable(
    entries.map(([t, v]) => [
      t,
      typeof v === 'string'
        ? { kind: 'content', bytes: new TextEncoder().encode(v) }
        : v === ERR_NOT_FOUND
          ? { kind: 'not_found' }
          : { kind: 'refused', why: 'test' },
    ]),
  )

describe('read_referenced_file host import', () => {
  it('sizes with outCap=0, then copies the bytes', () => {
    const { read, put, memory } = harness(table([['k8s/deploy.yaml', 'kind: Pod']]))
    const len = put('k8s/deploy.yaml', 0)
    expect(read(0, len, 0, 0)).toBe(9)
    expect(read(0, len, 100, 64)).toBe(9)
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 100, 9))).toBe('kind: Pod')
  })

  it('reports a too-small buffer without writing', () => {
    const { read, put, memory } = harness(table([['a.yaml', 'kind: Pod']]))
    const len = put('a.yaml', 0)
    expect(read(0, len, 100, 4)).toBe(ERR_BUFFER_TOO_SMALL)
    expect(new Uint8Array(memory.buffer, 100, 9).every((b) => b === 0)).toBe(true)
  })

  it('returns the table code for a withheld or unreferenced path', () => {
    const { read, put } = harness(table([['gone.yaml', ERR_NOT_FOUND]]))
    let len = put('gone.yaml', 0)
    expect(read(0, len, 0, 0)).toBe(ERR_NOT_FOUND)
    len = put('other.yaml', 0)
    expect(read(0, len, 0, 0)).toBe(ERR_REFUSED)
  })

  it('refuses everything with an empty table (no manifest root)', () => {
    const { read, put } = harness(ReferencedFiles.empty())
    const len = put('a.yaml', 0)
    expect(read(0, len, 0, 0)).toBe(ERR_REFUSED)
  })

  it('malformed arguments are ERR_BAD_ARGS, never a throw', () => {
    const { read, put } = harness(table([['a.yaml', 'x']]))
    const len = put('a.yaml', 0)
    expect(read(-1, len, 0, 0)).toBe(ERR_BAD_ARGS)
    expect(read(0, 0, 0, 0)).toBe(ERR_BAD_ARGS)
    expect(read(0, 5000, 0, 0)).toBe(ERR_BAD_ARGS)
    expect(read(0, len, 0, -1)).toBe(ERR_BAD_ARGS)
    expect(read(0, 1 << 20, 0, 0)).toBe(ERR_BAD_ARGS) // path past the end of memory
    expect(read(0, len, 1 << 20, 64)).toBe(ERR_BAD_ARGS) // out buffer past the end
  })

  it('charges the read budget before validation and stops at the cap', () => {
    const { read, put, state } = harness(table([['a.yaml', 'x']]))
    const len = put('a.yaml', 0)
    for (let i = 0; i < MAX_READS_PER_EVALUATION; i += 1) expect(read(-1, len, 0, 0)).toBe(ERR_BAD_ARGS)
    expect(state.fileReadsRemaining).toBe(0)
    expect(read(0, len, 0, 0)).toBe(ERR_BUDGET)
  })

  it('a missing memory export is ERR_BAD_ARGS', () => {
    const env = createHostImports(() => undefined, newHostImportState(table([['a.yaml', 'x']])))
    expect((env['read_referenced_file'] as ReadFn)(0, 6, 0, 0)).toBe(ERR_BAD_ARGS)
  })
})
