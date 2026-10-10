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

describe('watchWasmDir', () => {
  it('returns null for a directory that does not exist', () => {
    expect(watchWasmDir(path.join(os.tmpdir(), 'nope-' + Date.now()), () => {})).toBeNull()
  })

  it('fires once, debounced, when a .wasm file lands', async () => {
    const dir = tmp()
    let calls = 0
    const w = watchWasmDir(dir, () => { calls += 1 }, 100)
    expect(w).not.toBeNull()
    const until = async (done: () => boolean, ms: number) => {
      for (let waited = 0; !done() && waited < ms; waited += 50) await new Promise((r) => setTimeout(r, 50))
    }
    // The watcher misses writes made before its event stream is running,
    // which on a loaded machine is seconds after fs.watch returns (the policy
    // tick rescans those in production). So first a probe file, rewritten
    // until the watcher reports it, then quiet until no late event is left.
    for (let i = 0; calls === 0 && i < 120; i++) {
      fs.writeFileSync(path.join(dir, 'probe.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, i]))
      await until(() => calls > 0, 250)
    }
    expect(calls, 'the watcher never reported a .wasm write').toBeGreaterThan(0)
    for (let seen = -1; seen !== calls; ) {
      seen = calls
      await new Promise((r) => setTimeout(r, 2_000))
    }
    const before = calls
    // Two writes in one debounce window: one call.
    fs.writeFileSync(path.join(dir, 'rule.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
    fs.writeFileSync(path.join(dir, 'rule.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1]))
    // Wait for the event rather than a fixed time: a loaded machine delivers it
    // late. Then one more debounce window, so a second call would have landed.
    await until(() => calls > before, 30_000)
    await new Promise((r) => setTimeout(r, 400))
    w!.close()
    expect(calls - before).toBe(1)
  }, 120_000)

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
