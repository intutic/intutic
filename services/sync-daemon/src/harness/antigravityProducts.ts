/**
 * antigravityProducts.ts — which of the two Google products behind the
 * `antigravity` harness are on this machine.
 *
 * The harness installs two gates: Google Antigravity's (`PreToolUse` in
 * `~/.gemini/config/hooks.json`) and Gemini CLI's (`BeforeTool` in
 * `~/.gemini/settings.json`). Each reports under its own gate id
 * (`gateIdentitiesOf` in `@intutic/shared-types`), and this says which of
 * them to expect: the agent report registers a gate for each product found,
 * so the silent-gate check does not wait on a gate whose product is absent,
 * and the AI inventory lists each product with its own gate file and last
 * event. The CLI's harness detection uses the same answer, so a machine with
 * only Gemini CLI installed is detected too.
 *
 * - Antigravity: its app-data directories under `~/.gemini` (the 2.0 app, the
 *   CLI and the IDE), a project `.agents/hooks.json`, or `antigravity` on PATH.
 * - Gemini CLI: `gemini` on PATH, a project `.gemini` directory, or a
 *   `~/.gemini/settings.json` holding a setting of its own. Intutic writes
 *   only `hooks` into that file, so a file with nothing else in it is Intutic's
 *   and says nothing about Gemini CLI.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { homedir } from 'node:os'
import { GEMINI_CLI_GATE_ID } from '@intutic/shared-types'

export interface ProductProbeOptions {
  home?: string
  /** The PATH to search; defaults to this process's. */
  path?: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await node_fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Whether an executable named `bin` is in one of PATH's directories. */
async function onPath(bin: string, pathEnv: string): Promise<boolean> {
  const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]
  for (const dir of pathEnv.split(node_path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      try {
        await node_fs.access(node_path.join(dir, name), node_fs.constants.X_OK)
        return true
      } catch {
        // not here
      }
    }
  }
  return false
}

/** Whether `~/.gemini/settings.json` holds any setting besides the hooks Intutic writes. */
async function geminiSettingsInUse(home: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await node_fs.readFile(node_path.join(home, '.gemini', 'settings.json'), 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).some((k) => k !== 'hooks')
  } catch {
    return false
  }
}

async function antigravityPresent(workspaceRoot: string, home: string, pathEnv: string): Promise<boolean> {
  for (const dir of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
    if (await exists(node_path.join(home, '.gemini', dir))) return true
  }
  return (await exists(node_path.join(workspaceRoot, '.agents', 'hooks.json'))) || onPath('antigravity', pathEnv)
}

async function geminiCliPresent(workspaceRoot: string, home: string, pathEnv: string): Promise<boolean> {
  return (
    (await onPath('gemini', pathEnv)) ||
    (await exists(node_path.join(workspaceRoot, '.gemini'))) ||
    geminiSettingsInUse(home)
  )
}

/**
 * The gate ids of the `antigravity` harness whose products are on this
 * machine: `antigravity`, `gemini-cli`, both, or neither.
 */
export async function antigravityGateIdentities(workspaceRoot: string, opts: ProductProbeOptions = {}): Promise<string[]> {
  const home = opts.home ?? homedir()
  const pathEnv = opts.path ?? process.env.PATH ?? ''
  const [antigravity, geminiCli] = await Promise.all([
    antigravityPresent(workspaceRoot, home, pathEnv),
    geminiCliPresent(workspaceRoot, home, pathEnv),
  ])
  return [...(antigravity ? ['antigravity'] : []), ...(geminiCli ? [GEMINI_CLI_GATE_ID] : [])]
}

/**
 * The gate ids a configured harness reports under on this machine: for
 * `antigravity`, the products found, or the harness id itself when neither is
 * (a configured harness is never dropped); for any other harness, its own id.
 */
export async function presentGateIdentities(harness: string, workspaceRoot: string, opts: ProductProbeOptions = {}): Promise<string[]> {
  if (harness !== 'antigravity') return [harness]
  const found = await antigravityGateIdentities(workspaceRoot, opts)
  return found.length > 0 ? found : [harness]
}
