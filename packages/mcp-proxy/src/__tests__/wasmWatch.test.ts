import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { watchWasmDir } from '../wasm/watch.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-wasm-watch-'))
  dirs.push(d)
  return d
}

describe('watchWasmDir (TD-442)', () => {
  it('returns null for a directory that does not exist', () => {
    expect(watchWasmDir(path.join(os.tmpdir(), 'nope-' + Date.now()), () => {})).toBeNull()
  })

  it('fires once, debounced, when a .wasm file lands', async () => {
    const dir = tmp()
    let calls = 0
    const w = watchWasmDir(dir, () => { calls += 1 }, 100)
    expect(w).not.toBeNull()
    fs.writeFileSync(path.join(dir, 'rule.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
    fs.writeFileSync(path.join(dir, 'rule.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1]))
    await new Promise((r) => setTimeout(r, 700))
    w!.close()
    expect(calls).toBe(1)
  }, 5_000)

  it('ignores files that are not .wasm', async () => {
    const dir = tmp()
    let calls = 0
    const w = watchWasmDir(dir, () => { calls += 1 }, 100)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    await new Promise((r) => setTimeout(r, 500))
    w!.close()
    expect(calls).toBe(0)
  }, 5_000)
})
