/**
 * gooseHardener.test.ts — the hardened Goose plugin stays runnable.
 *
 * Goose runs the gate as the command its hooks.json names, `sh -c '<script>'`,
 * so the script must keep its execute bits: at 444 the command fails with exit
 * 126 and, with `on_failure: block`, Goose refuses every tool call. The other
 * plugin files are read-only (444).
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { hardenGoosePlugin, unharden } from '../../src/harness/gooseHardener.js'

describe('hardenGoosePlugin', () => {
  let dir = ''

  afterEach(async () => {
    for (const f of ['plugin.json', 'hooks/hooks.json', 'scripts/intutic-check.sh']) {
      await unharden(node_path.join(dir, f))
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves the gate script executable and every file read-only', async () => {
    dir = mkdtempSync(node_path.join(node_os.tmpdir(), 'goose-harden-'))
    mkdirSync(node_path.join(dir, 'hooks'))
    mkdirSync(node_path.join(dir, 'scripts'))
    writeFileSync(node_path.join(dir, 'plugin.json'), '{}')
    writeFileSync(node_path.join(dir, 'hooks', 'hooks.json'), '{}')
    const script = node_path.join(dir, 'scripts', 'intutic-check.sh')
    writeFileSync(script, '#!/bin/sh\necho ok\n', { mode: 0o755 })

    await hardenGoosePlugin(dir)

    expect(statSync(script).mode & 0o777).toBe(0o555)
    expect(statSync(node_path.join(dir, 'plugin.json')).mode & 0o777).toBe(0o444)
    expect(statSync(node_path.join(dir, 'hooks', 'hooks.json')).mode & 0o777).toBe(0o444)
    // As Goose runs it: the command is the script's quoted path.
    const run = spawnSync('sh', ['-c', `'${script}'`], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('ok')
  })
})
