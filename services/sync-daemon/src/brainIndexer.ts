/**
 * BrainIndexer — WS1: ContextGraph & Codebase RAG Federation
 *
 * Implements the client-side filesystem scanner that recursively walks agent folders
 * (.gemini/, .claude/, .cursor/) and root config files (.cursorrules, .clauderules),
 * computes SHA-256 hashes, categorizes file types, and determines sync deltas.
 *
 * LLD #16 — Contextual Data Indexing
 * HLD §3.18
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as crypto from 'node:crypto'
import type { IntegrityStore } from '@intutic/shared-types'

export interface ScanResult {
  workspaceRoot: string
  files: Record<
    string,
    {
      hash: string;
      size: number;
      lastModified: string;
      name: string;
      type: 'plan' | 'walkthrough' | 'rule' | 'scratch' | 'general'
    }
  >
}

export interface DeltaPayload {
  upserted: Array<{
    path: string
    name: string
    hash: string
    size: number
    type: 'plan' | 'walkthrough' | 'rule' | 'scratch' | 'general'
    lastModified: string
  }>
  deleted: string[]
}

export class BrainIndexer {
  private static EXCLUSIONS = new Set(['node_modules', '.git', 'dist', 'build', '.dist', '.turbo'])
  private static AGENT_FOLDERS = new Set(['.gemini', '.claude', '.cursor'])

  /**
   * Scans the workspace root recursively for agent config folders.
   */
  static async scanWorkspace(workspaceRoot: string): Promise<ScanResult> {
    const files: ScanResult['files'] = {}

    async function walk(dir: string) {
      let entries: any[] = []
      try {
        entries = await node_fs.readdir(dir, { withFileTypes: true })
      } catch {
        return // Skip unreadable directories
      }

      for (const entry of entries) {
        const fullPath = node_path.join(dir, entry.name)

        if (entry.isDirectory()) {
          if (BrainIndexer.EXCLUSIONS.has(entry.name)) {
            continue
          }

          // If we are at the workspace root, only traverse into .gemini, .claude, .cursor
          const relativeDir = node_path.relative(workspaceRoot, fullPath)
          const dirParts = relativeDir.split(node_path.sep)
          if (dirParts.length === 1 && !BrainIndexer.AGENT_FOLDERS.has(entry.name)) {
            continue
          }

          await walk(fullPath)
        } else if (entry.isFile()) {
          const relativePath = node_path.relative(workspaceRoot, fullPath)
          const dirParts = relativePath.split(node_path.sep)
          const isInAgentFolder = dirParts.length > 1 && BrainIndexer.AGENT_FOLDERS.has(dirParts[0])
          const isRootAgentFile =
            dirParts.length === 1 &&
            (entry.name === '.cursorrules' ||
              entry.name === '.clauderules' ||
              entry.name === '.gemini')

          if (!isInAgentFolder && !isRootAgentFile) {
            continue
          }

          try {
            const stat = await node_fs.stat(fullPath)
            if (stat.size > 5 * 1024 * 1024) {
              continue // 5MB cap limit
            }

            const hash = await computeFileHash(fullPath)
            files[relativePath] = {
              hash,
              size: stat.size,
              lastModified: stat.mtime.toISOString(),
              name: entry.name,
              type: BrainIndexer.categorizeFile(relativePath),
            }
          } catch {
            // Skip failed file reads
          }
        }
      }
    }

    try {
      await node_fs.access(workspaceRoot)
      await walk(workspaceRoot)
    } catch {
      // Root folder inaccessible
    }

    return { workspaceRoot, files }
  }

  /**
   * Categorizes files into standard types.
   */
  static categorizeFile(filePath: string): 'plan' | 'walkthrough' | 'rule' | 'scratch' | 'general' {
    const name = node_path.basename(filePath).toLowerCase()
    if (name.includes('plan') || name.includes('roadmap') || name.includes('implementation')) {
      return 'plan'
    }
    if (name.includes('walkthrough') || name.includes('summary') || name.includes('report')) {
      return 'walkthrough'
    }
    if (
      name.includes('rules') ||
      name.includes('instructions') ||
      name.includes('guidelines') ||
      name.includes('system') ||
      name.includes('claude.md') ||
      name.includes('agents.md')
    ) {
      return 'rule'
    }
    if (
      name.includes('scratch') ||
      name.includes('temp') ||
      name.includes('test') ||
      name.includes('debug') ||
      name.includes('simulate')
    ) {
      return 'scratch'
    }
    return 'general'
  }

  /**
   * Compares the scan result against the local integrity store to calculate changes.
   */
  static computeDelta(scanResult: ScanResult, integrityStore: IntegrityStore | null): DeltaPayload {
    const upserted: DeltaPayload['upserted'] = []
    const deleted: string[] = []

    const storeFiles = integrityStore?.files ?? {}

    // Identify added or modified files
    for (const [path, file] of Object.entries(scanResult.files)) {
      const cachedHash = storeFiles[path]
      if (!cachedHash || cachedHash !== file.hash) {
        upserted.push({
          path,
          name: file.name,
          hash: file.hash,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
        })
      }
    }

    // Identify deleted files
    for (const path of Object.keys(storeFiles)) {
      if (!scanResult.files[path]) {
        deleted.push(path)
      }
    }

    return { upserted, deleted }
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await node_fs.readFile(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}
