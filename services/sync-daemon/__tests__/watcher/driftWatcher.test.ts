/**
 * driftWatcher.test.ts — Unit tests for real-time file watcher.
 *
 * Verifies that the filesystem watcher correctly detects mutations and deletions
 * of governed files and invokes the change callback.
 *
 * LLD #14 — Test Strategy
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { startWatcher } from '../../src/watcher/driftWatcher.js'
import { HarnessType } from '@intutic/shared-types'

describe('Drift Filesystem Watcher', () => {
  it('correctly detects modifications and deletions on watched files', async () => {
    // 1. Setup a temporary workspace directory
    const tempDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-watch-test-'))
    const cursorRulesPath = node_path.join(tempDir, '.cursorrules')

    // Write initial mock file
    await node_fs.writeFile(cursorRulesPath, 'governance: initial rules', 'utf-8')

    const changedFiles: string[] = []
    const onChange = async (filePath: string) => {
      changedFiles.push(filePath)
    }

    // 2. Start watcher on CURSOR harness file
    const watcher = startWatcher(tempDir, [HarnessType.CURSOR], onChange)

    // Wait for chokidar ready
    await new Promise((resolve) => setTimeout(resolve, 300))

    // 3. Mutate file
    await node_fs.writeFile(cursorRulesPath, 'governance: drifted rules', 'utf-8')

    // Wait for write finish stability threshold
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(changedFiles.length).toBeGreaterThanOrEqual(1)
    // Use .some() because the watcher also watches ~/.claude/settings.json
    // (privilege escalation guard), which may fire before .cursorrules if
    // the global settings file already exists and gets a spurious event.
    expect(changedFiles.some((f) => f.includes('.cursorrules'))).toBe(true)

    // 4. Test delete / unlink detection
    changedFiles.length = 0 // clear
    await node_fs.unlink(cursorRulesPath)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(changedFiles.length).toBeGreaterThanOrEqual(1)
    expect(changedFiles.some((f) => f.includes('.cursorrules'))).toBe(true)

    // Cleanup
    watcher.stop()
    await node_fs.rm(tempDir, { recursive: true, force: true })
  })

  it('onDriftDetected fires within 1s and appends a config_tamper event to the JSONL log', async () => {
    // 1. Setup temporary workspace and events log path
    const tempDir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-tamper-test-'))
    const cursorRulesPath = node_path.join(tempDir, '.cursorrules')
    const testEventsLog = node_path.join(tempDir, '.intutic', 'events', 'hook-events.jsonl')
    await node_fs.mkdir(node_path.dirname(testEventsLog), { recursive: true })

    // Write initial mock file
    await node_fs.writeFile(cursorRulesPath, 'governance: initial rules', 'utf-8')

    let callbackFired = false
    const startTime = Date.now()

    const onDriftDetected = async (changedPath: string) => {
      callbackFired = true
      // Append config_tamper event to the temp log file
      const tamperEntry = JSON.stringify({
        event: 'config_tamper',
        toolName: 'config_file',
        reason: 'Harness config file modified outside sync-daemon',
        workspaceId: 'ws-test-123',
        filePath: changedPath,
        timestamp: new Date().toISOString(),
        incidentId: 'test-tamper-id',
      }) + '\n'
      await node_fs.appendFile(testEventsLog, tamperEntry, 'utf-8')
    }

    // 2. Start watcher on CURSOR harness
    const watcher = startWatcher(tempDir, [HarnessType.CURSOR], onDriftDetected)

    // Wait for chokidar to initialize
    await new Promise((resolve) => setTimeout(resolve, 300))

    // 3. Mutate file to trigger watch event
    await node_fs.writeFile(cursorRulesPath, 'governance: modified rules', 'utf-8')

    // Wait up to 1 second for the event
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (callbackFired || Date.now() - startTime > 1000) {
          clearInterval(interval)
          resolve(null)
        }
      }, 50)
    })

    const duration = Date.now() - startTime
    expect(callbackFired).toBe(true)
    expect(duration).toBeLessThan(1000) // Fires within 1s

    // 4. Verify config_tamper event was written to JSONL
    const content = await node_fs.readFile(testEventsLog, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    const events = lines.map(l => JSON.parse(l))
    const event = events.find(e => e.filePath === cursorRulesPath)
    expect(event).toBeDefined()
    expect(event).toHaveProperty('event', 'config_tamper')
    expect(event).toHaveProperty('toolName', 'config_file')
    expect(event).toHaveProperty('workspaceId', 'ws-test-123')

    // Cleanup
    watcher.stop()
    await node_fs.rm(tempDir, { recursive: true, force: true })
  })
})
