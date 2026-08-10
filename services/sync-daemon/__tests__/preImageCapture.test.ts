/**
 * The capture half of the rollback rung (TD-328), against the REAL emitted gate.
 *
 * `emitPreImageCapture()` is executed exactly as the daemon writes it into a
 * generated hook, rather than reimplemented here: a test against a local copy
 * of the logic would pass while every shipped hook captured nothing.
 *
 * The RESTORE half lives in `tools/cli` with the command that performs it;
 * both sides read `PreImageEntry` from shared-types so the record format
 * cannot drift across the package boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { emitPreImageCapture } from '../src/harness/gateBody.js'

/**
 * Runs the emitted capture function in a sandbox that mimics the hook's
 * environment: `fs`, `path`, `crypto`, `process.cwd()` and `_intuticWsId` are
 * exactly what the generated script has in scope at that point.
 */
function captureInWorkspace(
  workspace: string,
  toolName: string,
  input: Record<string, unknown>,
  ruleId: string,
): void {
  const body = emitPreImageCapture()
  const fn = new Function(
    'fs',
    'path',
    'crypto',
    'process',
    '_intuticWsId',
    'toolName',
    'input',
    'ruleId',
    `${body}\n_intuticCapturePreImage(toolName, input, ruleId);`,
  )
  fn(
    fs,
    path,
    require('node:crypto'),
    { ...process, cwd: () => workspace },
    'ws_rollback_test',
    toolName,
    input,
    ruleId,
  )
}

describe('pre-image capture (the emitted gate)', () => {
  let ws: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  const enable = (on: boolean) => {
    fs.mkdirSync(path.join(ws, '.intutic'), { recursive: true })
    fs.writeFileSync(
      path.join(ws, '.intutic', 'config.json'),
      JSON.stringify({ captureRollbackPreImages: on }),
    )
  }
  const manifest = () =>
    fs
      .readFileSync(path.join(ws, '.intutic', 'rollback', 'manifest.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-rollback-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(ws)
  })
  afterEach(() => {
    cwdSpy.mockRestore()
    fs.rmSync(ws, { recursive: true, force: true })
  })
  it('captures nothing until the workspace opts in', () => {
    enable(false)
    const target = path.join(ws, 'app.ts')
    fs.writeFileSync(target, 'original')
    captureInWorkspace(ws, 'Write', { file_path: target }, 'r1')
    expect(
      fs.existsSync(path.join(ws, '.intutic', 'rollback', 'manifest.jsonl')),
      'storing copies of a user’s files is opted into, never defaulted on',
    ).toBe(false)
  })

  it('refuses a path outside the workspace', () => {
    enable(true)
    const outside = path.join(os.tmpdir(), `intutic-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'a secret elsewhere on disk')
    try {
      captureInWorkspace(ws, 'Write', { file_path: outside }, 'r5')
      const written = fs.existsSync(path.join(ws, '.intutic', 'rollback', 'manifest.jsonl'))
      expect(
        written,
        'copying a file from outside the workspace into a directory the agent can read ' +
          'would be an exfiltration primitive wearing a governance badge',
      ).toBe(false)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('refuses a file larger than the ceiling rather than truncating it', () => {
    enable(true)
    const target = path.join(ws, 'big.bin')
    fs.writeFileSync(target, Buffer.alloc(3 * 1024 * 1024, 1)) // over the 2 MiB cap
    captureInWorkspace(ws, 'Write', { file_path: target }, 'r6')
    expect(
      fs.existsSync(path.join(ws, '.intutic', 'rollback', 'manifest.jsonl')),
      'a truncated pre-image restores a file to a state it was never in',
    ).toBe(false)
  })

  it('gitignores its own directory', () => {
    enable(true)
    const target = path.join(ws, 'd.ts')
    fs.writeFileSync(target, 'x')
    captureInWorkspace(ws, 'Write', { file_path: target }, 'r7')
    expect(fs.readFileSync(path.join(ws, '.intutic', 'rollback', '.gitignore'), 'utf-8')).toContain(
      '*',
    )
  })

  it('writes the record shape the CLI reads back', () => {
    enable(true)
    const target = path.join(ws, 'shape.ts')
    fs.writeFileSync(target, 'x')
    captureInWorkspace(ws, 'Write', { file_path: target }, 'r-shape')
    const [e] = manifest()
    // The fields `PreImageEntry` in shared-types declares. A writer that drops
    // one produces a manifest describing a restore the CLI cannot perform.
    for (const k of ['id','capturedAt','tool','target','existed','bytes','ruleId','workspaceId']) {
      expect(e, `emitted manifest is missing ${k}`).toHaveProperty(k)
    }
    expect(path.isAbsolute(e.target)).toBe(true)
  })
})
