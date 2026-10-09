/**
 * claudeAgentsMd.ts — whether Claude Code reads the workspace's `AGENTS.md`.
 *
 * Claude Code gets its rule sets and the decisions log from
 * `.claude/rules/`, which it loads at launch whatever other instruction
 * files exist. It also reads `AGENTS.md`, but only sometimes
 * (https://code.claude.com/docs/en/memory#when-claude-code-reads-agentsmd):
 *
 * - under the default **Project instructions** setting,
 *   `claude-md-or-agents-md`, only when there is no `CLAUDE.md`,
 *   `.claude/CLAUDE.md` or `CLAUDE.local.md` in the working directory or a
 *   directory above it (`~/.claude/CLAUDE.md` does not count);
 * - always under `claude-md-and-agents-md`, and never under `claude-md` or
 *   `managed-only`.
 *
 * The setting is honoured only from user, `--settings` or managed settings,
 * under `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`
 * (`agents-md@builtin` before v2.1.285); a project's settings cannot change
 * it. This reads the user's `~/.claude/settings.json`.
 *
 * When Claude Code reads `AGENTS.md`, whatever Intutic puts there for the
 * other harnesses reaches Claude Code too, so the writers leave it out of
 * `.claude/rules/` to keep Claude Code from reading it twice.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const PLUGIN_IDS = ['cc-plugin-agents-md@builtin', 'agents-md@builtin']

/** The Project instructions value in the user's settings; undefined when unset. */
async function instructionFilesSetting(): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf-8')) as {
      pluginConfigs?: Record<string, { options?: { instructionFiles?: unknown } }>
    }
    for (const id of PLUGIN_IDS) {
      const value = settings.pluginConfigs?.[id]?.options?.instructionFiles
      if (typeof value === 'string') return value
    }
  } catch {
    // No user settings, or not JSON: the default applies.
  }
  return undefined
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** Whether a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` is in `dir` or above it, the user's own `~/.claude/CLAUDE.md` aside. */
async function claudeMdOnPath(dir: string): Promise<boolean> {
  const userFile = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  let current = path.resolve(dir)
  for (;;) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const file = path.join(current, name)
      if (file !== userFile && (await exists(file))) return true
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/** Whether Claude Code, started in `workspaceRoot`, reads its `AGENTS.md`. */
export async function claudeCodeReadsAgentsMd(workspaceRoot: string): Promise<boolean> {
  const setting = await instructionFilesSetting()
  if (setting === 'claude-md-and-agents-md') return true
  if (setting === 'claude-md' || setting === 'managed-only') return false
  return !(await claudeMdOnPath(workspaceRoot))
}
