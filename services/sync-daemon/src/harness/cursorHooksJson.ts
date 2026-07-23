/**
 * cursorHooksJson.ts — Cursor native hooks.json writer (v1.7+ hook API).
 *
 * Writes Cursor's native hooks.json at two levels:
 *   1. User-level:    ~/.cursor/hooks.json
 *   2. Project-level: <workspaceRoot>/.cursor/hooks.json
 *
 * The hook command references the shared pre-tool-check.js script installed
 * by WS-4A. On beforeMCPExecution and beforeShellExecution events, Cursor
 * invokes this script with the tool context on stdin; exit 0 allows,
 * exit 2 blocks (fail-closed).
 *
 * Deep-merges into any existing hooks.json so other hooks are preserved.
 *
 * LLD #14 — Phase 4 WS-4C native hook script writers
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-cursor-hooks-json')

/** Absolute path to the shared pre-tool-check.js installed by WS-4A. */
const HOOK_SCRIPT = node_path.join(node_os.homedir(), '.intutic', 'hooks', 'pre-tool-check.js')

/** Hook events covered by this writer (Cursor v1.7+ API). */
const HOOK_EVENTS = ['beforeMCPExecution', 'beforeShellExecution'] as const

/** Shape of the Cursor hooks.json `hooks` object. */
type CursorHooksMap = Record<string, Array<{ command: string }>>

/** Shape of the full Cursor hooks.json document. */
interface CursorHooksJson {
  version: number
  hooks: CursorHooksMap
  [key: string]: unknown
}

/**
 * Build the Intutic hook entry for a given event.
 *
 * @param hookScriptPath - Absolute path to the pre-tool-check.js script.
 */
function buildHookEntry(hookScriptPath: string): { command: string } {
  return { command: `node ${hookScriptPath}` }
}

/**
 * Read and parse an existing hooks.json, returning a default document if
 * the file does not exist or is not valid JSON.
 */
async function readExistingHooksJson(filePath: string): Promise<CursorHooksJson> {
  try {
    const raw = await node_fs.readFile(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'hooks' in parsed &&
      typeof (parsed as Record<string, unknown>).hooks === 'object'
    ) {
      return parsed as CursorHooksJson
    }
  } catch {
    // File absent or malformed — start from scratch
  }
  return { version: 1, hooks: {} }
}

/**
 * Deep-merge our Intutic hook entries into an existing hooks map.
 *
 * For each covered event, we append our entry if a hook with the same
 * command is not already present, preserving all other hooks.
 *
 * @param existing - The existing hooks map (mutated in place).
 * @param hookScriptPath - Absolute path to the governance hook script.
 * @returns The merged hooks map.
 */
function mergeHooks(existing: CursorHooksMap, hookScriptPath: string): CursorHooksMap {
  const entry = buildHookEntry(hookScriptPath)

  for (const event of HOOK_EVENTS) {
    const current: Array<{ command: string }> = Array.isArray(existing[event])
      ? (existing[event] as Array<{ command: string }>)
      : []

    const alreadyPresent = current.some((h) => h.command === entry.command)
    if (!alreadyPresent) {
      existing[event] = [...current, entry]
    } else {
      existing[event] = current
    }
  }

  return existing
}

/**
 * Write hooks.json atomically (tmp → rename) to the given path,
 * deep-merging our entries into any existing configuration.
 *
 * @param filePath - Absolute path to the hooks.json to write.
 * @param hookScriptPath - Absolute path to the governance hook script.
 * @param level - Human-readable label for log context.
 */
async function writeHooksJson(filePath: string, hookScriptPath: string, level: string): Promise<void> {
  await node_fs.mkdir(node_path.dirname(filePath), { recursive: true })

  const doc = await readExistingHooksJson(filePath)
  doc.version = 1
  doc.hooks = mergeHooks(doc.hooks, hookScriptPath)

  const tmp = filePath + '.intutic-tmp'
  await node_fs.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8')
  await node_fs.rename(tmp, filePath)

  log.info(
    { action: 'cursor_hooks_json_written', level, path: filePath },
    `Cursor hooks.json written (${level})`,
  )
}

/**
 * Write Cursor native hooks.json at user-level and project-level.
 *
 * The hook command (`node ~/.intutic/hooks/pre-tool-check.js`) is installed
 * by WS-4A; this writer only registers it in hooks.json.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 */
export async function writeCursorHooksJson(workspaceRoot: string): Promise<void> {
  // 1. User-level: ~/.cursor/hooks.json
  const userHooksPath = node_path.join(node_os.homedir(), '.cursor', 'hooks.json')
  await writeHooksJson(userHooksPath, HOOK_SCRIPT, 'user')

  // 2. Project-level: <workspaceRoot>/.cursor/hooks.json
  const projectHooksPath = node_path.join(workspaceRoot, '.cursor', 'hooks.json')
  await writeHooksJson(projectHooksPath, HOOK_SCRIPT, 'project')
}
