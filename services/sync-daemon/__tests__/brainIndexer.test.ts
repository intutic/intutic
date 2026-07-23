/**
 * BrainIndexer Unit Tests
 *
 * Validates the walking, hashing, categorization, and delta computation
 * features of the local sync daemon indexer.
 *
 * LLD #16 §7.1
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { BrainIndexer } from '../src/brainIndexer.js'

describe('BrainIndexer Unit Tests', () => {
  const testWorkspaceRoot = node_path.join(__dirname, 'mock_workspace')

  beforeAll(async () => {
    // Create mock workspace structure
    await node_fs.mkdir(testWorkspaceRoot, { recursive: true })
    await node_fs.mkdir(node_path.join(testWorkspaceRoot, '.gemini'), { recursive: true })
    await node_fs.mkdir(node_path.join(testWorkspaceRoot, '.claude'), { recursive: true })
    await node_fs.mkdir(node_path.join(testWorkspaceRoot, 'src'), { recursive: true })

    // Create mock files
    await node_fs.writeFile(node_path.join(testWorkspaceRoot, '.gemini', 'implementation_plan.md'), 'plan content')
    await node_fs.writeFile(node_path.join(testWorkspaceRoot, '.claude', 'walkthrough.md'), 'walkthrough content')
    await node_fs.writeFile(node_path.join(testWorkspaceRoot, '.cursorrules'), 'rules content')
    await node_fs.writeFile(node_path.join(testWorkspaceRoot, 'src', 'app.ts'), 'app code') // Should be skipped
  })

  afterAll(async () => {
    // Cleanup mock workspace
    await node_fs.rm(testWorkspaceRoot, { recursive: true, force: true })
  })

  it('should correctly categorize files', () => {
    expect(BrainIndexer.categorizeFile('.gemini/implementation_plan.md')).toBe('plan')
    expect(BrainIndexer.categorizeFile('.claude/walkthrough.md')).toBe('walkthrough')
    expect(BrainIndexer.categorizeFile('.cursorrules')).toBe('rule')
    expect(BrainIndexer.categorizeFile('.gemini/scratch/test_script.ts')).toBe('scratch')
    expect(BrainIndexer.categorizeFile('.gemini/other.txt')).toBe('general')
  })

  it('should correctly scan workspace directories and filter non-agent directories', async () => {
    const scanResult = await BrainIndexer.scanWorkspace(testWorkspaceRoot)

    expect(scanResult.workspaceRoot).toBe(testWorkspaceRoot)

    const scannedPaths = Object.keys(scanResult.files)
    // Should scan the agent files
    expect(scannedPaths).toContain('.gemini/implementation_plan.md')
    expect(scannedPaths).toContain('.claude/walkthrough.md')
    expect(scannedPaths).toContain('.cursorrules')

    // Should NOT contain src/app.ts
    expect(scannedPaths).not.toContain('src/app.ts')
  })

  it('should compute correct delta (upserted vs deleted)', () => {
    const scanResult = {
      workspaceRoot: testWorkspaceRoot,
      files: {
        'file1.md': { hash: 'hash1', size: 10, lastModified: 'now', name: 'file1.md', type: 'plan' as const },
        'file2.md': { hash: 'hash2-new', size: 20, lastModified: 'now', name: 'file2.md', type: 'walkthrough' as const },
        'file3.md': { hash: 'hash3', size: 30, lastModified: 'now', name: 'file3.md', type: 'rule' as const },
      },
    }

    const integrityStore = {
      lastSyncAt: 'now',
      configVersion: 1,
      files: {
        'file2.md': 'hash2-old', // Modified
        'file3.md': 'hash3',     // Unchanged
        'file4.md': 'hash4',     // Deleted
      },
    }

    const delta = BrainIndexer.computeDelta(scanResult, integrityStore)

    // file1.md is added, file2.md is modified
    expect(delta.upserted.map((f) => f.path)).toContain('file1.md')
    expect(delta.upserted.map((f) => f.path)).toContain('file2.md')
    expect(delta.upserted.map((f) => f.path)).not.toContain('file3.md')

    // file4.md is deleted
    expect(delta.deleted).toContain('file4.md')
    expect(delta.deleted).not.toContain('file3.md')
  })
})
