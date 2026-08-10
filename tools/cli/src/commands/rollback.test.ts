/**
 * The restore half of the rollback rung (TD-328).
 *
 * The CAPTURE half — the emitted gate body that writes these records — is
 * tested in `services/sync-daemon/__tests__/preImageCapture.test.ts`, against
 * the real emitted script. Splitting them follows the package boundary: the
 * daemon writes, the CLI restores.
 *
 * The seam that split creates is the record format, so both sides read
 * `PreImageEntry` from shared-types and the daemon test asserts its writer
 * emits every field this reader needs. Two hand-kept copies of a record
 * format across a package boundary is how a manifest starts describing
 * restores it cannot perform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PreImageEntry } from '@intutic/shared-types'
import { runRollback } from './rollback.js'

describe('rollback restore', () => {
  let ws: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  const rollbackDir = () => path.join(ws, '.intutic', 'rollback')

  /** Writes a capture the way the emitted gate does. */
  const seedCapture = (target: string, priorContents: string | null): PreImageEntry => {
    fs.mkdirSync(rollbackDir(), { recursive: true })
    const id = Math.random().toString(16).slice(2, 18)
    if (priorContents !== null) {
      fs.writeFileSync(path.join(rollbackDir(), `${id}.blob`), priorContents)
    }
    const entry: PreImageEntry = {
      id,
      capturedAt: new Date().toISOString(),
      tool: 'Write',
      target,
      existed: priorContents !== null,
      bytes: priorContents?.length ?? 0,
      ruleId: 'protected-path',
      workspaceId: 'ws_rollback_test',
    }
    fs.appendFileSync(path.join(rollbackDir(), 'manifest.jsonl'), JSON.stringify(entry) + '\n')
    return entry
  }

  const manifest = (): PreImageEntry[] =>
    fs
      .readFileSync(path.join(rollbackDir(), 'manifest.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PreImageEntry)

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-restore-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(ws)
  })
  afterEach(() => {
    cwdSpy.mockRestore()
    fs.rmSync(ws, { recursive: true, force: true })
    process.exitCode = 0
  })

  it('restores the captured contents over what the agent wrote', async () => {
    const target = path.join(ws, 'app.ts')
    const entry = seedCapture(target, 'the original line')
    fs.writeFileSync(target, 'what the agent wrote instead')

    await runRollback({ id: entry.id })
    expect(fs.readFileSync(target, 'utf-8')).toBe('the original line')
  })

  it('records the restore in the same trail the gate writes', async () => {
    const target = path.join(ws, 'b.ts')
    const entry = seedCapture(target, 'before')
    fs.writeFileSync(target, 'after')
    await runRollback({ id: entry.id })

    const events = fs
      .readFileSync(path.join(ws, '.intutic', 'events', 'hook-events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(
      events.some((e) => e.event === 'tool_reverted'),
      'an unlogged undo is indistinguishable from tampering',
    ).toBe(true)
  })

  it('captures the current contents before replacing them, so the undo is undoable', async () => {
    const target = path.join(ws, 'c.ts')
    const first = seedCapture(target, 'v1')
    fs.writeFileSync(target, 'v2')

    await runRollback({ id: first.id })
    expect(fs.readFileSync(target, 'utf-8')).toBe('v1')

    const undo = manifest().find((e) => e.ruleId === `undo-of-${first.id}`)
    expect(undo, 'restoring is an edit; without this it is the one with no way back').toBeTruthy()
    await runRollback({ id: undo!.id })
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2')
  })

  it('undoing a creation deletes the file', async () => {
    const target = path.join(ws, 'new.ts')
    const entry = seedCapture(target, null) // did not exist when flagged
    fs.writeFileSync(target, 'created by the agent')

    await runRollback({ id: entry.id })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('refuses a listed capture whose blob was evicted', async () => {
    const target = path.join(ws, 'gone.ts')
    const entry = seedCapture(target, 'original')
    fs.writeFileSync(target, 'current')
    fs.unlinkSync(path.join(rollbackDir(), `${entry.id}.blob`)) // retention ceiling reaped it

    await runRollback({ id: entry.id })
    expect(process.exitCode).toBe(1)
    expect(
      fs.readFileSync(target, 'utf-8'),
      'a partial restore leaves the file in a state it was never in',
    ).toBe('current')
  })

  it('refuses an id it does not have', async () => {
    fs.mkdirSync(rollbackDir(), { recursive: true })
    fs.writeFileSync(path.join(rollbackDir(), 'manifest.jsonl'), '')
    await runRollback({ id: 'nope' })
    expect(process.exitCode).toBe(1)
  })

  it('listing an empty store says how to turn capture on', async () => {
    // Nothing to restore is the normal state — capture is opt-in — so the
    // listing has to explain that rather than read as a malfunction.
    await expect(runRollback({ list: true })).resolves.toBeUndefined()
    expect(process.exitCode).not.toBe(1)
  })
})
