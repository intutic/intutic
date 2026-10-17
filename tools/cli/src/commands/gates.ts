/**
 * `intutic gates install` — install the harness hook gates and rules files on
 * a machine with no control plane.
 *
 * `intutic connect` installs the same gates and keeps them in sync with a
 * control plane. This writes them from this machine alone: the gate per
 * recorded harness, the rules files from the local `.intutic/sops`, and a
 * policy snapshot with the built-in tiers and the local `review_before:`
 * tokens, which refuse rather than hold (nothing could approve a hold). The
 * harnesses' LLM traffic is routed through the local proxy only with
 * `--route`. See lib/localGates.ts.
 *
 * Refused while this machine has a login: connect owns the gates then.
 *
 * @module
 */

import * as node_os from 'node:os'
import * as node_path from 'node:path'
import pc from 'picocolors'
import { HarnessType } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { loadConfig, loadCredentials, saveConfig } from '../config/store.js'
import { installLocalGates, type LocalGate } from '../lib/localGates.js'

export interface GatesInstallOptions {
  harness?: string
  add?: boolean
  route?: boolean
  dryRun?: boolean
  workspace?: string
}

export const CONNECTED_REFUSAL =
  'This machine is connected to a control plane; `intutic connect` installs and refreshes gates. ' +
  'Run `intutic disconnect` first to switch to local gates.'

function show(p: string): string {
  const home = node_os.homedir()
  return p === home || p.startsWith(home + node_path.sep) ? `~${p.slice(home.length)}` : p
}

function describeGate(gate: LocalGate): string {
  if (gate.kind === 'hook') return gate.path ? show(gate.path) : pc.yellow('no gate file found')
  if (gate.kind === 'sdk') return pc.dim('gated in your code by the Intutic SDK; rules file only')
  if (gate.kind === 'delegated') return pc.dim('gated by the harness it runs inside')
  if (gate.kind === 'bridge') return pc.dim('gated through its MCP bridge')
  return pc.dim('no tool-call gate; rules file only')
}

export async function runGatesInstall(opts: GatesInstallOptions): Promise<void> {
  if ((await loadCredentials()) !== null) {
    log.error(CONNECTED_REFUSAL)
    process.exitCode = 1
    return
  }
  const config = loadConfig()
  if (!config) {
    log.error('Workspace not initialized. Run `intutic init` first.')
    process.exitCode = 1
    return
  }

  const workspaceRoot = opts.workspace ? node_path.resolve(opts.workspace) : config.workspaceRoot
  const disconnected = new Set<string>(config.disconnectedHarnesses ?? [])
  let harnesses: string[] = config.harnesses.filter((h) => !disconnected.has(h))

  if (opts.harness !== undefined) {
    const id = opts.harness
    const known: string[] = Object.values(HarnessType)
    if (!known.includes(id)) {
      log.error(`Unknown harness "${id}". Known harnesses: ${[...known].sort().join(', ')}`)
      process.exitCode = 1
      return
    }
    if (!harnesses.includes(id)) {
      if (!opts.add) {
        log.error(`${id} is not recorded for this workspace. Run \`intutic init\` to detect it, or add --add to record it.`)
        process.exitCode = 1
        return
      }
      if (!opts.dryRun) {
        saveConfig({
          ...config,
          harnesses: [...new Set([...config.harnesses, id as HarnessType])],
          disconnectedHarnesses: config.disconnectedHarnesses?.filter((h) => h !== id),
        })
      }
      log.info(`${opts.dryRun ? 'Would record' : 'Recorded'} ${id} in ~/.intutic/config.json.`)
    }
    harnesses = [id]
  }

  if (harnesses.length === 0) {
    log.error('No harnesses are recorded for this workspace. Run `intutic init` to detect them, or pass --harness <id> --add.')
    process.exitCode = 1
    return
  }

  const routing = Boolean(opts.route)
  const result = await installLocalGates({
    workspaceRoot,
    harnesses,
    routing,
    dryRun: opts.dryRun,
    warn: (line) => log.warn(line),
  })

  log.header(opts.dryRun ? 'intutic gates install would write:' : 'Intutic — local gates installed')
  log.field('Workspace', workspaceRoot)
  log.field(
    'Routing',
    routing
      ? `${result.proxyUrl} — the proxy must be running (\`intutic start\`, or \`intutic daemon install --proxy\`)`
      : 'off (add --route to also send the harnesses\' LLM traffic through the local proxy)',
  )
  console.log('')
  for (const file of result.files) console.log(`  ${opts.dryRun ? 'would write' : 'wrote'} ${show(file)}`)
  console.log('')
  log.info(
    `Policy snapshot: ${result.snapshot.ruleCount} rule(s)` +
      (result.snapshot.digest ? `, digest ${result.snapshot.digest}` : '') +
      (result.holdTokens.length > 0 ? `; review_before: ${result.holdTokens.join(', ')} refused (no control plane to hold for)` : ''),
  )
  console.log('')
  log.info('Gates:')
  const width = Math.max(...result.gates.map((g) => g.harness.length))
  for (const gate of result.gates) {
    const mark = gate.kind !== 'hook' ? pc.dim('–') : gate.path ? pc.green('✔') : pc.yellow('!')
    console.log(`  ${mark} ${gate.harness.padEnd(width)}  ${describeGate(gate)}`)
  }
  console.log('')
  if (opts.dryRun) {
    log.dim('Nothing was written (--dry-run).')
    return
  }
  log.dim('Re-run after editing .intutic/sops, or keep `intutic start` running: it refreshes them when the SOPs change.')
  log.success('Undo with `intutic disconnect`.')
}
