/**
 * clineHooks.test.ts — the Cline gate is a file hook Cline actually runs.
 *
 * It used to be registered in a `.cline/hooks/hooks.json` with per-tool
 * matchers — a mechanism Cline does not have — and read `tool_name`/
 * `tool_input`, fields neither Cline payload carries. These pin the shape
 * Cline's source defines: an executable `.clinerules/hooks/PreToolUse`, fed
 * either the extension's `preToolUse` or the SDK's `tool_call` payload, that
 * refuses with `{"cancel": true}` on stdout.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { writeClineHooks, ensureClinerulesDirectory } from '../../src/harness/clineHooks.js'

function runGate(script: string, payload: unknown, home: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      env: { ...process.env, HOME: home, USERPROFILE: home, INTUTIC_SNAPSHOT_RULES: path.join(home, 'none.rules') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout }))
    child.stdin.end(JSON.stringify(payload))
  })
}

const cancelled = (stdout: string) =>
  stdout.trim().split('\n').some((line) => {
    try { return JSON.parse(line)?.cancel === true } catch { return false }
  })

describe('writeClineHooks', () => {
  let root: string
  let home: string
  const prevHome = process.env.HOME

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-cline-'))
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-cline-home-'))
    process.env.HOME = home
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  it('writes an executable .clinerules/hooks/PreToolUse — the file Cline runs', async () => {
    const written = await writeClineHooks(root, 'http://127.0.0.1:4000', 'ws_test')
    const gate = path.join(root, '.clinerules', 'hooks', 'PreToolUse')
    expect(written).toBe(gate)
    expect((await fs.stat(gate)).mode & 0o111).not.toBe(0)
  })

  it('cancels a write to a protected path in both payload shapes Cline sends, and allows a benign call', async () => {
    const gate = (await writeClineHooks(root, 'http://127.0.0.1:4000', 'ws_test'))!

    // VS Code extension: parameter values are JSON-encoded strings.
    const ext = await runGate(gate, { hookName: 'PreToolUse', preToolUse: { toolName: 'write_to_file', parameters: { path: '.claude/settings.json', content: '{}' } } }, home)
    expect(cancelled(ext.stdout), ext.stdout).toBe(true)
    expect(ext.status).toBe(0)

    // CLI/SDK: tool_call, a shell command touching the same path.
    const sdk = await runGate(gate, { hookName: 'PreToolUse', tool_call: { id: 't1', name: 'run_commands', input: { commands: ['rm .claude/settings.json'] } } }, home)
    expect(cancelled(sdk.stdout), sdk.stdout).toBe(true)

    const benign = await runGate(gate, { hookName: 'PreToolUse', tool_call: { id: 't2', name: 'read_files', input: { files: [{ path: 'README.md' }] } } }, home)
    expect(cancelled(benign.stdout), benign.stdout).toBe(false)
  })

  it('converts the flat .clinerules an earlier version wrote, and removes its unused hooks.json registration', async () => {
    await fs.writeFile(path.join(root, '.clinerules'), '# Intutic Governance Rules (auto-generated)\n# old\n')
    await fs.mkdir(path.join(root, '.cline', 'hooks'), { recursive: true })
    await fs.writeFile(path.join(root, '.cline', 'hooks', 'hooks.json'), JSON.stringify({ _comment: 'Intutic governance hooks — auto-generated. DO NOT EDIT.', hooks: [] }))
    await fs.writeFile(path.join(root, '.cline', 'hooks', 'intutic-check.js'), '// old gate\n')

    expect(await writeClineHooks(root, 'http://127.0.0.1:4000', 'ws_test')).not.toBeNull()
    expect((await fs.stat(path.join(root, '.clinerules'))).isDirectory()).toBe(true)
    await expect(fs.access(path.join(root, '.cline', 'hooks', 'hooks.json'))).rejects.toThrow()
    await expect(fs.access(path.join(root, '.cline', 'hooks', 'intutic-check.js'))).rejects.toThrow()
  })

  it('leaves a .clinerules file the user wrote, and a PreToolUse hook the user wrote, untouched', async () => {
    await fs.writeFile(path.join(root, '.clinerules'), 'Always write tests.\n')
    expect(await ensureClinerulesDirectory(root)).toBe(false)
    expect(await writeClineHooks(root, 'http://127.0.0.1:4000', 'ws_test')).toBeNull()
    expect(await fs.readFile(path.join(root, '.clinerules'), 'utf-8')).toBe('Always write tests.\n')

    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-cline-own-'))
    try {
      await fs.mkdir(path.join(other, '.clinerules', 'hooks'), { recursive: true })
      await fs.writeFile(path.join(other, '.clinerules', 'hooks', 'PreToolUse'), '#!/bin/sh\necho {}\n')
      expect(await writeClineHooks(other, 'http://127.0.0.1:4000', 'ws_test')).toBeNull()
      expect(await fs.readFile(path.join(other, '.clinerules', 'hooks', 'PreToolUse'), 'utf-8')).toBe('#!/bin/sh\necho {}\n')
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })
})
