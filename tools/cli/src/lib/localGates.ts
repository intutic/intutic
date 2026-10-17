/**
 * Harness gates and rules files with no control plane: what
 * `intutic gates install` writes, and `intutic start` refreshes.
 *
 * The same writers `intutic connect` runs, fed from this machine only: the
 * local `.intutic/sops` for the rules files and the `review_before:` tokens,
 * and a policy snapshot compiled from no workspace policy
 * (`writeLocalPolicySnapshot`), which still carries the destructive-command
 * and skill tiers. Nothing here fetches, drains or reports; no MCP server is
 * wrapped and no file is made immutable. The harnesses' LLM traffic is
 * pointed at the local proxy only with `routing`, since a harness routed at a
 * proxy that is not running stops working.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { homedir } from 'node:os'
import { gateKindForHarness, HarnessType } from '@intutic/shared-types'
import type { GateKind } from '@intutic/shared-types'
import {
  buildSnapshotRules,
  findGateFile,
  loadLocalSopEntries,
  localHoldTokensFor,
  localResolvedPolicy,
  noteProxyUrl,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  updatePreToolUseHooks,
  writeLocalPolicySnapshot,
  writeRuntimeEnv,
} from '@intutic/sync-daemon'
import { getAdapter } from '../harness/detector.js'
import { writeHarnessConfigs } from '../harness/writeHarnessConfigs.js'
import { loadCredentials } from '../config/store.js'
import { localProxyPort } from './localProxy.js'

/** The hook events log is rotated past this size; nothing drains it without a control plane. */
export const HOOK_EVENTS_ROTATE_BYTES = 10 * 1024 * 1024

export interface LocalGatesOptions {
  workspaceRoot: string
  /** The harnesses to install for: recorded ones, less any disconnected. */
  harnesses: readonly string[]
  /** Also point each harness's LLM traffic at the local proxy. */
  routing: boolean
  /** Compute and report, write nothing. */
  dryRun?: boolean
  /** Where warnings go. */
  warn?: (line: string) => void
}

export interface LocalGate {
  harness: string
  kind: GateKind
  /** The gate file on disk, for a `hook` gate; null when there is none. */
  path: string | null
}

export interface LocalGatesResult {
  /** Files written (on a dry run, the files that would be). */
  files: string[]
  gates: LocalGate[]
  /** The snapshot written; on a dry run, its rule count and no digest. */
  snapshot: { digest: string; ruleCount: number }
  /** The `review_before:` tokens compiled into refusals. */
  holdTokens: string[]
  /** The proxy the routing names, written or not. */
  proxyUrl: string
}

function snapshotDir(): string {
  return node_path.join(homedir(), '.intutic', 'hooks')
}

/**
 * Who wrote the policy snapshot the gates read: `local` (this module, marked
 * `source: local`), `connect` (any other snapshot), or `none`.
 */
export async function gatesSource(): Promise<'local' | 'connect' | 'none'> {
  let text: string
  try {
    text = await node_fs.readFile(node_path.join(snapshotDir(), SNAPSHOT_JSON), 'utf-8')
  } catch {
    return 'none'
  }
  try {
    return (JSON.parse(text) as { source?: unknown }).source === 'local' ? 'local' : 'connect'
  } catch {
    return 'connect'
  }
}

/** Whether the snapshot on this machine is one this module wrote. */
export async function localGatesInstalled(): Promise<boolean> {
  return (await gatesSource()) === 'local'
}

/** Whether `runtime.env` still holds an API key, from a control plane this machine no longer has a login for. */
async function staleRuntimeKey(envPath: string): Promise<boolean> {
  let text: string
  try {
    text = await node_fs.readFile(envPath, 'utf-8')
  } catch {
    return false
  }
  return text.split('\n').some((line) => /^INTUTIC_API_KEY=\S/.test(line.trim()))
}

/** Keeps one previous log (`.1`) once the live one passes {@link HOOK_EVENTS_ROTATE_BYTES}. */
async function rotateHookEvents(workspaceRoot: string, dryRun: boolean): Promise<string | null> {
  const log = node_path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  try {
    if ((await node_fs.stat(log)).size <= HOOK_EVENTS_ROTATE_BYTES) return null
  } catch {
    return null
  }
  if (!dryRun) await node_fs.rename(log, `${log}.1`)
  return `${log}.1`
}

/**
 * Writes (or with `dryRun`, reports) the local gates. See the module note for
 * what it does not do.
 */
export async function installLocalGates(opts: LocalGatesOptions): Promise<LocalGatesResult> {
  const root = opts.workspaceRoot
  const harnesses = [...opts.harnesses]
  const dryRun = Boolean(opts.dryRun)
  const warn = opts.warn ?? (() => undefined)
  const proxyUrl = `http://127.0.0.1:${localProxyPort()}`
  const home = homedir()
  const files: string[] = []

  // The same reads connect makes: the rules files' SOPs (honouring the
  // session's selection), and every local SOP's review_before: tokens.
  const sops = await loadLocalSopEntries(root, harnesses as HarnessType[], {
    onError: (err) =>
      warn(`Could not read every local SOP in .intutic/sops; the rules files are written without the ones that failed: ${err instanceof Error ? err.message : String(err)}`),
  })
  const holdTokens = await localHoldTokensFor(root, [], undefined, harnesses as HarnessType[])

  let snapshot: { digest: string; ruleCount: number }
  if (dryRun) {
    snapshot = { digest: '', ruleCount: buildSnapshotRules(localResolvedPolicy(), holdTokens, 'block').length }
  } else {
    snapshot = await writeLocalPolicySnapshot({ localHoldTokens: holdTokens, snapshotDir: snapshotDir() })
  }
  files.push(node_path.join(snapshotDir(), SNAPSHOT_RULES), node_path.join(snapshotDir(), SNAPSHOT_JSON))

  if (dryRun) {
    for (const h of harnesses) {
      const file = getAdapter(h)?.configFileName
      if (file && sops.some((sop) => sop.harnessTargets.includes(h as HarnessType))) files.push(node_path.resolve(root, file))
    }
  } else {
    // disconnect recognises the base URLs it is written into by it.
    if (opts.routing) await noteProxyUrl(proxyUrl)
    await writeHarnessConfigs(harnesses, root, sops, proxyUrl, false, {
      routing: opts.routing,
      onRulesFile: (path) => files.push(path),
    })
  }

  if (harnesses.includes(HarnessType.CLAUDE_CODE)) {
    if (!dryRun) await updatePreToolUseHooks(root, [], undefined)
    files.push(node_path.join(root, '.claude', 'settings.json'))
    if (!process.env['VITEST'] && !process.env['INTUTIC_SKIP_GLOBAL_HOOKS']) files.push(node_path.join(home, '.claude', 'settings.json'))
  }

  // A key left by an earlier connect makes every gate post its events to that
  // control plane. With no login here, nothing should.
  const runtimeEnv = node_path.join(home, '.intutic', 'env', 'runtime.env')
  if ((await loadCredentials()) === null && (await staleRuntimeKey(runtimeEnv))) {
    if (!dryRun) await writeRuntimeEnv({ controlPlaneUrl: '', apiKey: '', workspaceId: '', envPath: runtimeEnv })
    files.push(runtimeEnv)
  }

  const rotated = await rotateHookEvents(root, dryRun)
  if (rotated) files.push(rotated)

  const gates: LocalGate[] = []
  for (const harness of harnesses) {
    const kind = gateKindForHarness(harness as HarnessType)
    gates.push({ harness, kind, path: kind === 'hook' ? await findGateFile(harness, root, home) : null })
  }

  return { files: [...new Set(files)], gates, snapshot, holdTokens, proxyUrl }
}
