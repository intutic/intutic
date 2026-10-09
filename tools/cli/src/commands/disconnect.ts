/**
 * `intutic disconnect` — undo what `intutic connect` set up on this machine.
 *
 * Every harness config connect wrote is put back (see
 * `@intutic/sync-daemon`'s `planDisconnect` for the files), and on a full
 * disconnect the machine-level pieces go too: the background services, the
 * Intutic CA connect trusted in the login keychain, the Valkey container it
 * started, the gate caches and, unless `--keep-login`, the stored
 * credentials.
 *
 * Everything is planned before anything changes, so `--dry-run` prints
 * exactly what a real run does. Running connect would write it all straight
 * back, so a real run stops the services first and refuses while another
 * `intutic connect` is still running.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DisconnectPlan, planDisconnect, HARNESS_REVERSERS } from '@intutic/sync-daemon'
import { HarnessType } from '@intutic/shared-types'
import type { IntuticConfig } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { clearCredentials, loadConfig, saveConfig } from '../config/store.js'
import { getCredentialsPath, getIntuticDir } from '../config/paths.js'
import { getServicePaths, uninstallDaemon, uninstallMcpDaemon, uninstallProxyService, type ServiceTarget } from './install-daemon.js'

export interface DisconnectOptions {
  /** One harness id; every harness when omitted. */
  harness?: string
  dryRun?: boolean
  keepLogin?: boolean
}

const SERVICE_UNINSTALL: Record<ServiceTarget, () => Promise<void>> = {
  sync: () => uninstallDaemon(),
  mcp: () => uninstallMcpDaemon(),
  proxy: () => uninstallProxyService(),
}

/** The workspaces to clean: the one `intutic init` recorded, and the current one if connect wrote into it. */
async function workspaceRoots(config: IntuticConfig | null): Promise<string[]> {
  const roots = new Set<string>()
  if (config?.workspaceRoot) roots.add(config.workspaceRoot)
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    await node_fs.access(node_path.join(top, '.intutic'))
    roots.add(top)
  } catch {
    // Not in a repository, or not one connect wrote into.
  }
  return [...roots]
}

/** Services `intutic daemon install` set up for this user; a system-level one needs root and is only reported. */
async function planServices(plan: DisconnectPlan): Promise<void> {
  for (const target of Object.keys(SERVICE_UNINSTALL) as ServiceTarget[]) {
    const user = getServicePaths(false, target)
    try {
      await node_fs.access(user.targetPath)
      plan.change(user.targetPath, `stop and remove the ${user.label} service`, SERVICE_UNINSTALL[target])
    } catch {
      // Not installed for this user.
    }
    const system = getServicePaths(true, target)
    try {
      await node_fs.access(system.targetPath)
      plan.note(system.targetPath, `a system-wide service; remove it with \`sudo intutic daemon uninstall --system${target === 'sync' ? '' : ` --${target}`}\``)
    } catch {
      // Not installed system-wide.
    }
  }
}

/**
 * The Intutic CA connect trusts in the macOS login keychain when the proxy's
 * certificate is not trusted yet. The administrator's machine-wide install
 * trusts it in the System keychain instead, so a copy in the login keychain
 * is connect's.
 */
async function planCaTrust(plan: DisconnectPlan): Promise<void> {
  const certPath = node_path.join(getIntuticDir(), 'ca.crt')
  let sha1: string
  try {
    sha1 = new X509Certificate(await node_fs.readFile(certPath)).fingerprint.replace(/:/g, '')
  } catch {
    return
  }
  if (process.platform === 'darwin') {
    const keychain = node_path.join(node_os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
    let listed: string
    try {
      listed = execFileSync('security', ['find-certificate', '-a', '-Z', keychain], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return
    }
    if (!listed.toUpperCase().includes(sha1.toUpperCase())) return
    plan.change(keychain, 'remove the Intutic CA certificate connect trusted', async () => {
      try {
        execFileSync('security', ['remove-trusted-cert', '-d', certPath], { stdio: 'ignore' })
      } catch {
        // No admin trust setting left for it: the certificate removal below is what matters.
      }
      execFileSync('security', ['delete-certificate', '-Z', sha1, keychain], { stdio: 'ignore' })
    })
  } else if (process.platform === 'win32') {
    plan.note(
      'Root certificate store',
      `connect may have added the Intutic CA (thumbprint ${sha1}); unless an administrator's machine-wide install put it there, remove it with \`certutil -delstore Root ${sha1}\``,
    )
  }
}

/** The Valkey container connect starts when nothing answers on 6379. */
function planValkeyContainer(plan: DisconnectPlan): void {
  let name: string
  try {
    name = execFileSync('docker', ['ps', '-a', '--filter', 'name=^/intutic-valkey$', '--format', '{{.Names}}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return
  }
  if (name !== 'intutic-valkey') return
  plan.change('docker container intutic-valkey', 'stop and remove the Valkey container connect started', async () => {
    execFileSync('docker', ['rm', '-f', 'intutic-valkey'], { stdio: 'ignore' })
  })
}

/** `~/.intutic/config.json`: a later connect must rewrite everything, and must leave a disconnected harness alone. */
function planConfig(plan: DisconnectPlan, config: IntuticConfig | null, harness: string | undefined): void {
  if (!config) return
  const file = node_path.join(getIntuticDir(), 'config.json')
  if (harness === undefined) {
    if (config.configVersion === 0 && config.disconnectedHarnesses === undefined) return
    plan.change(file, 'reset the synced config version, so `intutic connect` writes everything again', async () => {
      saveConfig({ ...config, configVersion: 0, disconnectedHarnesses: undefined })
    })
    return
  }
  const id = harness as HarnessType
  if (!config.harnesses.includes(id) && config.disconnectedHarnesses?.includes(id)) return
  plan.change(file, `stop connect managing ${harness} (\`intutic init\` adds it back)`, async () => {
    saveConfig({
      ...config,
      harnesses: config.harnesses.filter((h) => h !== id),
      disconnectedHarnesses: [...new Set([...(config.disconnectedHarnesses ?? []), id])],
    })
  })
}

/** PIDs of `intutic connect` processes other than this one. */
function runningConnects(): number[] {
  if (process.platform === 'win32') return []
  let out: string
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter(([, pid, command]) => Number(pid) !== process.pid && /(?:^|[\\/\s])intutic(?:\.js|\.cjs|\.mjs)?\s+connect\b|cli\.js\s+connect\b/.test(command!))
    .map(([, pid]) => Number(pid))
}

function show(p: string): string {
  const home = node_os.homedir()
  return p === home || p.startsWith(home + node_path.sep) ? `~${p.slice(home.length)}` : p
}

function printPlan(plans: DisconnectPlan[], dryRun: boolean): number {
  const changes = plans.flatMap((p) => p.visible())
  const notes = plans.flatMap((p) => p.notes)
  if (changes.length === 0) {
    log.info('Nothing to undo: no Intutic changes were found.')
  } else {
    log.header(dryRun ? 'intutic disconnect would:' : 'intutic disconnect will:')
    for (const c of changes) console.log(`  ${c.describe}: ${show(c.path)}`)
  }
  if (notes.length > 0) {
    log.header('Left as they are:')
    for (const n of notes) console.log(`  ${show(n.path)}: ${n.message}`)
  }
  return changes.length
}

export async function runDisconnect(opts: DisconnectOptions): Promise<void> {
  // Every harness id is accepted; one connect writes nothing for has nothing to undo.
  const known: string[] = [...new Set([...Object.values(HarnessType), ...Object.keys(HARNESS_REVERSERS)])]
  if (opts.harness !== undefined && !known.includes(opts.harness)) {
    log.error(`Unknown harness "${opts.harness}". Known harnesses: ${known.sort().join(', ')}`)
    process.exitCode = 1
    return
  }
  const full = opts.harness === undefined
  const config = loadConfig()

  // Services first: while one runs, connect would write the files straight back.
  const services = new DisconnectPlan()
  if (full) await planServices(services)

  const files = await planDisconnect({
    workspaceRoots: await workspaceRoots(config),
    harnesses: full ? undefined : [opts.harness!],
    remaining: full ? [] : (config?.harnesses ?? []).filter((h) => h !== opts.harness),
  })

  const machine = new DisconnectPlan()
  if (full) {
    await planCaTrust(machine)
    planValkeyContainer(machine)
  }
  planConfig(machine, config, opts.harness)
  if (full && !opts.keepLogin) {
    try {
      await node_fs.access(getCredentialsPath())
      machine.change(getCredentialsPath(), 'log out (remove the stored credentials and keychain entry)', clearCredentials)
    } catch {
      // Not logged in.
    }
  }

  const count = printPlan([services, files, machine], Boolean(opts.dryRun))
  const others = runningConnects()
  if (opts.dryRun) {
    if (others.length > 0) log.warn(`intutic connect is running (pid ${others.join(', ')}); stop it before a real run, or it writes everything back.`)
    return
  }
  if (count === 0) return

  await services.apply()
  const still = runningConnects()
  if (still.length > 0) {
    log.error(`intutic connect is still running (pid ${still.join(', ')}) and would write everything back. Stop it, then run intutic disconnect again.`)
    process.exitCode = 1
    return
  }
  await files.apply()
  await machine.apply()
  log.success(
    full
      ? 'Disconnected. Run `intutic init` and `intutic connect` to connect again.'
      : `Disconnected ${opts.harness}. Run \`intutic init\` to manage it again.`,
  )
}
