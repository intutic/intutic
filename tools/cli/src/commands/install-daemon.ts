/**
 * install-daemon.ts — System-level sync-daemon & mcp-daemon persistence installer.
 *
 * Registers the Intutic sync-daemon or mcp-daemon as system-level services so they
 * auto-start on login/boot and restart automatically on any exit.
 *
 * Platform support:
 *   - macOS : LaunchAgent/LaunchDaemon (LaunchDaemon requires root/system flag)
 *   - Linux : systemd user/system service (system service requires root/system flag)
 *
 * WS-5 — Q3 Layer 4 (LaunchAgent / systemd persistence) & WS-5MCP
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config/store.js'

// ── Error definitions ──────────────────────────────────────────────────

export class ElevationRequiredError extends Error {
  constructor(targetPath: string) {
    super(`System-level operation requires root privileges to access ${targetPath}. Try running with sudo.`)
    this.name = 'ElevationRequiredError'
  }
}

// ── Options ───────────────────────────────────────────────────────────

export interface InstallDaemonOptions {
  workspaceId: string
  apiKey: string
  /** Override the intutic CLI binary path (defaults to process.execPath) */
  binaryPath?: string
  /** Control plane URL (defaults to https://api.intutic.ai) */
  controlPlaneUrl?: string
  /** If true, just print what would be done without writing files */
  dryRun?: boolean
  /** Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux) */
  system?: boolean
}

export interface UninstallDaemonOptions {
  /** If true, just print what would be done without writing files */
  dryRun?: boolean
  /** Uninstall the system-level service */
  system?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────

export function checkRootPrivileges(system: boolean, targetPath = '/Library/LaunchDaemons/ or /etc/systemd/system/'): void {
  if (system && typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new ElevationRequiredError(targetPath)
  }
}

export interface ResolvedPaths {
  label: string
  unitName?: string
  targetDir: string
  targetPath: string
  logsDir: string
  logPath: string
  errPath: string
}

export function getPaths(system: boolean, isMcp: boolean, platform: string = process.platform): ResolvedPaths {
  const label = isMcp ? 'ai.intutic.mcp-daemon' : 'ai.intutic.sync-daemon'
  const unitName = isMcp ? 'intutic-mcp-daemon.service' : 'intutic-sync-daemon.service'

  if (platform === 'darwin') {
    const dir = system ? '/Library/LaunchDaemons' : path.join(os.homedir(), 'Library', 'LaunchAgents')
    const plistPath = path.join(dir, `${label}.plist`)
    const logsDir = system ? '/Library/Logs/Intutic' : path.join(os.homedir(), '.intutic', 'logs')
    return {
      label,
      targetDir: dir,
      targetPath: plistPath,
      logsDir,
      logPath: path.join(logsDir, isMcp ? 'mcp-daemon.log' : 'sync-daemon.log'),
      errPath: path.join(logsDir, isMcp ? 'mcp-daemon.err' : 'sync-daemon.err'),
    }
  } else {
    const dir = system ? '/etc/systemd/system' : path.join(os.homedir(), '.config', 'systemd', 'user')
    const unitPath = path.join(dir, unitName)
    const logsDir = system ? '/var/log/intutic' : path.join(os.homedir(), '.intutic', 'logs')
    return {
      label,
      unitName,
      targetDir: dir,
      targetPath: unitPath,
      logsDir,
      logPath: path.join(logsDir, isMcp ? 'mcp-daemon.log' : 'sync-daemon.log'),
      errPath: path.join(logsDir, isMcp ? 'mcp-daemon.err' : 'sync-daemon.err'),
    }
  }
}

// ── macOS LaunchAgent & LaunchDaemon ──────────────────────────────────

export function buildPlist(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'binaryPath' | 'controlPlaneUrl'>>,
  system = false
): string {
  const paths = getPaths(system, false, 'darwin')
  const argStrings: string[] = []

  if (opts.binaryPath.endsWith('.js') || opts.binaryPath.endsWith('.ts')) {
    argStrings.push(`    <string>${process.execPath}</string>`)
    argStrings.push(`    <string>${opts.binaryPath}</string>`)
  } else if (opts.binaryPath.includes('node') && !opts.binaryPath.endsWith('intutic')) {
    const scriptPath = process.argv[1]
    argStrings.push(`    <string>${opts.binaryPath}</string>`)
    argStrings.push(`    <string>${scriptPath}</string>`)
  } else {
    argStrings.push(`    <string>${opts.binaryPath}</string>`)
  }

  const runAtLoad = system ? '' : '\n  <key>RunAtLoad</key>\n  <true/>'

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${paths.label}</string>

  <key>ProgramArguments</key>
  <array>
${argStrings.join('\n')}
    <string>connect</string>
    <string>--workspace-id</string>
    <string>${opts.workspaceId}</string>
    <string>--api-key</string>
    <string>${opts.apiKey}</string>
    <string>--control-plane-url</string>
    <string>${opts.controlPlaneUrl}</string>
  </array>

  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>${runAtLoad}

  <key>StandardOutPath</key>
  <string>${paths.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${paths.errPath}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>INTUTIC_WORKSPACE_ID</key>
    <string>${opts.workspaceId}</string>
    <key>INTUTIC_API_KEY</key>
    <string>${opts.apiKey}</string>
    <key>INTUTIC_CONTROL_PLANE_URL</key>
    <string>${opts.controlPlaneUrl}</string>
  </dict>
</dict>
</plist>
`
}

/**
 * Resolve the argv used to launch the MCP daemon from a service definition.
 *
 * Both launchd and systemd exec the program directly rather than through a
 * shell, and neither searches PATH: launchd requires an absolute path in
 * `ProgramArguments[0]`, and systemd rejects a unit whose `ExecStart` does not
 * start with an absolute path. So `which` is run for its *output* — the
 * absolute location — not merely as a presence check.
 *
 * Falls back to running the bundled daemon entry point under the current Node
 * when `intutic-mcp-daemon` is not installed on PATH.
 */
function resolveMcpDaemonExec(daemonPath: string): string[] {
  const fallback = [process.execPath, daemonPath]
  try {
    // stderr is dropped so a "not found" message never reaches the CLI output;
    // `which` exits non-zero in that case and the catch below handles it.
    const resolved = execFileSync('which', ['intutic-mcp-daemon'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')[0]
      .trim()
    return path.isAbsolute(resolved) ? [resolved] : fallback
  } catch {
    return fallback
  }
}

export function buildMcpPlist(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'controlPlaneUrl'>>,
  system = false
): string {
  const paths = getPaths(system, true, 'darwin')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const daemonPath = path.join(workspaceRoot, 'packages', 'mcp-proxy', 'dist', 'daemon', 'index.js')

  const execArgs = resolveMcpDaemonExec(daemonPath)

  const programArgsXml = execArgs.map(arg => `    <string>${arg}</string>`).join('\n')
  const runAtLoad = system ? '' : '\n  <key>RunAtLoad</key>\n  <true/>'

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${paths.label}</string>

  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>

  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>${runAtLoad}

  <key>StandardOutPath</key>
  <string>${paths.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${paths.errPath}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>INTUTIC_WORKSPACE_ID</key>
    <string>${opts.workspaceId}</string>
    <key>INTUTIC_API_KEY</key>
    <string>${opts.apiKey}</string>
    <key>INTUTIC_CONTROL_PLANE_URL</key>
    <string>${opts.controlPlaneUrl}</string>
    <key>CONTROL_PLANE_URL</key>
    <string>${opts.controlPlaneUrl}</string>
  </dict>
</dict>
</plist>
`
}

function sanitizeConfigFile(rawContent: string): string {
  return rawContent
    .replace(/(INTUTIC_API_KEY\s*=\s*)([^\n]+)/gi, '$1***MASKED***')
    .replace(/(<key>INTUTIC_API_KEY<\/key>\s*<string>)([^<]+)/gi, '$1***MASKED***')
}

async function installMacos(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'binaryPath' | 'controlPlaneUrl'>>,
  system = false,
  dryRun = false
): Promise<void> {
  const paths = getPaths(system, false, 'darwin')
  if (!dryRun) {
    checkRootPrivileges(system, paths.targetPath)
  }
  const plist = buildPlist(opts, system)

  console.log(`\n📦 Installing macOS Launch${system ? 'Daemon' : 'Agent'}: ${paths.targetPath}`)
  console.log(`   Binary : ${opts.binaryPath}`)
  console.log(`   Workspace: ${opts.workspaceId}`)

  if (dryRun) {
    console.log('\n[dry-run] Would write plist:')
    console.log(sanitizeConfigFile(plist))
    return
  }

  await fs.mkdir(paths.targetDir, { recursive: true })
  await fs.mkdir(paths.logsDir, { recursive: true })

  try {
    execFileSync('launchctl', ['unload', '-w', paths.targetPath], { stdio: 'ignore' })
  } catch {
    // Best-effort: this unload exists only to release a previously installed
    // agent before its plist is overwritten. On a first install there is no
    // plist and nothing loaded, so launchctl exits non-zero — the expected
    // case, not a failure. A real problem surfaces at the `load` below, which
    // is deliberately not wrapped.
  }

  await fs.writeFile(paths.targetPath, plist, 'utf-8')
  execFileSync('launchctl', ['load', '-w', paths.targetPath])

  console.log(`\n✅ Launch${system ? 'Daemon' : 'Agent'} installed and started.`)
}

// ── Linux systemd ─────────────────────────────────────────────────────

export function buildUnit(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'binaryPath' | 'controlPlaneUrl'>>,
  system = false
): string {
  const paths = getPaths(system, false, 'linux')
  let execStart: string
  if (opts.binaryPath.endsWith('.js') || opts.binaryPath.endsWith('.ts')) {
    execStart = `${process.execPath} ${opts.binaryPath}`
  } else if (opts.binaryPath.includes('node') && !opts.binaryPath.endsWith('intutic')) {
    const scriptPath = process.argv[1]
    execStart = `${opts.binaryPath} ${scriptPath}`
  } else {
    execStart = opts.binaryPath
  }

  return `[Unit]
Description=Intutic Sync Daemon — Governance enforcement for AI agent harnesses
Documentation=https://docs.intutic.ai/daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart} connect \\
  --workspace-id ${opts.workspaceId} \\
  --api-key ${opts.apiKey} \\
  --control-plane-url ${opts.controlPlaneUrl}

Restart=always
RestartSec=5

Environment=INTUTIC_WORKSPACE_ID=${opts.workspaceId}
Environment=INTUTIC_API_KEY=${opts.apiKey}
Environment=INTUTIC_CONTROL_PLANE_URL=${opts.controlPlaneUrl}

StandardOutput=append:${paths.logPath}
StandardError=append:${paths.errPath}

[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`
}

export function buildMcpUnit(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'controlPlaneUrl'>>,
  system = false
): string {
  const paths = getPaths(system, true, 'linux')
  const config = loadConfig()
  const workspaceRoot = config?.workspaceRoot ?? process.cwd()
  const daemonPath = path.join(workspaceRoot, 'packages', 'mcp-proxy', 'dist', 'daemon', 'index.js')

  const execStart = resolveMcpDaemonExec(daemonPath).join(' ')

  return `[Unit]
Description=Intutic MCP Daemon — Persistent policy and telemetry cache for MCP harnesses
Documentation=https://docs.intutic.ai/daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}

Restart=always
RestartSec=5

Environment=INTUTIC_WORKSPACE_ID=${opts.workspaceId}
Environment=INTUTIC_API_KEY=${opts.apiKey}
Environment=INTUTIC_CONTROL_PLANE_URL=${opts.controlPlaneUrl}
Environment=CONTROL_PLANE_URL=${opts.controlPlaneUrl}

StandardOutput=append:${paths.logPath}
StandardError=append:${paths.errPath}

[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`
}

async function installLinux(
  opts: Required<Pick<InstallDaemonOptions, 'workspaceId' | 'apiKey' | 'binaryPath' | 'controlPlaneUrl'>>,
  system = false,
  dryRun = false
): Promise<void> {
  const paths = getPaths(system, false, 'linux')
  if (!dryRun) {
    checkRootPrivileges(system, paths.targetPath)
  }
  const unit = buildUnit(opts, system)

  console.log(`\n📦 Installing systemd ${system ? 'system' : 'user'} unit: ${paths.targetPath}`)
  console.log(`   Binary : ${opts.binaryPath}`)
  console.log(`   Workspace: ${opts.workspaceId}`)

  if (dryRun) {
    console.log('\n[dry-run] Would write unit:')
    console.log(sanitizeConfigFile(unit))
    return
  }

  await fs.mkdir(paths.targetDir, { recursive: true })
  await fs.mkdir(paths.logsDir, { recursive: true })
  await fs.writeFile(paths.targetPath, unit, 'utf-8')

  const cmdArgs = system ? [] : ['--user']
  execFileSync('systemctl', [...cmdArgs, 'daemon-reload'])
  execFileSync('systemctl', [...cmdArgs, 'enable', '--now', paths.unitName!])

  console.log(`\n✅ systemd ${system ? 'system' : 'user'} unit installed and started.`)
}

// ── Public API (sync-daemon) ──────────────────────────────────────────

export async function installDaemon(opts: InstallDaemonOptions): Promise<void> {
  const resolved = {
    workspaceId:     opts.workspaceId,
    apiKey:          opts.apiKey,
    binaryPath:      opts.binaryPath ?? process.execPath,
    controlPlaneUrl: opts.controlPlaneUrl ?? 'https://api.intutic.ai',
  }
  const system = !!opts.system

  switch (process.platform) {
    case 'darwin':
      await installMacos(resolved, system, opts.dryRun)
      break
    case 'linux':
      await installLinux(resolved, system, opts.dryRun)
      break
    default:
      console.log(`\n⚠️  Platform '${process.platform}' is not supported by install-daemon.`)
  }
}

export async function uninstallDaemon(opts: UninstallDaemonOptions = {}): Promise<void> {
  const system = !!opts.system
  const paths = getPaths(system, false)
  if (!opts.dryRun) {
    checkRootPrivileges(system, paths.targetPath)
  }

  switch (process.platform) {
    case 'darwin': {
      console.log(`\n🗑  Removing Launch${system ? 'Daemon' : 'Agent'}: ${paths.targetPath}`)
      if (!opts.dryRun) {
        try {
          execFileSync('launchctl', ['unload', '-w', paths.targetPath], { stdio: 'ignore' })
        } catch {
          // Best-effort: uninstall is idempotent. launchctl exits non-zero when
          // the agent is already unloaded or was never loaded, and in both cases
          // the desired end state is reached. The plist removal below is what
          // actually has to happen, so it must not be skipped on this failure.
        }
        try {
          await fs.unlink(paths.targetPath)
        } catch {
          // Best-effort: ENOENT means an earlier uninstall already removed the
          // plist, which is success for this command. Other errors (EACCES on a
          // /Library/LaunchDaemons plist) are already pre-empted by the
          // checkRootPrivileges call above.
        }
      }
      console.log(`✅ Launch${system ? 'Daemon' : 'Agent'} removed.`)
      break
    }
    case 'linux': {
      console.log(`\n🗑  Removing systemd ${system ? 'system' : 'user'} unit: ${paths.targetPath}`)
      if (!opts.dryRun) {
        const cmdArgs = system ? [] : ['--user']
        try {
          execFileSync('systemctl', [...cmdArgs, 'disable', '--now', paths.unitName!], { stdio: 'ignore' })
        } catch {
          // Best-effort: `disable --now` exits non-zero when the unit is not
          // enabled, not loaded, or absent entirely — all of which mean the work
          // this call was going to do is already done. The unit file removal
          // below is the part that must still run.
        }
        try {
          await fs.unlink(paths.targetPath)
          execFileSync('systemctl', [...cmdArgs, 'daemon-reload'], { stdio: 'ignore' })
        } catch {
          // Best-effort: ENOENT means the unit file is already gone, and the
          // reload is deliberately inside the same block — if nothing was
          // removed there is no change for systemd to pick up.
        }
      }
      console.log(`✅ systemd ${system ? 'system' : 'user'} unit removed.`)
      break
    }
    default:
      console.log(`\n⚠️  Platform '${process.platform}' is not supported.`)
  }
}

export async function daemonStatus(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        const scopeStr = system ? 'System-level (LaunchDaemon)' : 'User-level (LaunchAgent)'
        if (plistExists) {
          console.log(`✅ Daemon: ${scopeStr} installed at ${paths.targetPath}`)
          try {
            execFileSync('launchctl', ['list', paths.label], { stdio: 'inherit' })
          } catch {
            console.log(`   ⚠️  ${scopeStr} plist file exists but is not loaded.`)
          }
        } else {
          console.log(`⬜ Daemon: ${scopeStr} not installed`)
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'linux')
        const scopeStr = system ? 'System-level' : 'User-level'
        const cmdArgs = system ? [] : ['--user']
        try {
          console.log(`\n--- ${scopeStr} Status ---`)
          execFileSync('systemctl', [...cmdArgs, 'status', paths.unitName!], { stdio: 'inherit' })
        } catch {
          console.log(`⬜ Daemon: ${scopeStr} not running`)
        }
      }
      break
    }
  }
}

export async function daemonStop(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (plistExists) {
          console.log(`\n🛑 Stopping Launch${system ? 'Daemon' : 'Agent'}: ${paths.label}`)
          try {
            execFileSync('launchctl', ['unload', paths.targetPath], { stdio: 'ignore' })
            console.log(`✅ Successfully stopped ${system ? 'system' : 'user'} sync-daemon.`)
          } catch (e) {
            console.log(`❌ Failed to stop ${system ? 'system' : 'user'} sync-daemon: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'linux')
        const unitExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (unitExists) {
          try {
            const cmdArgs = system ? [] : ['--user']
            execFileSync('systemctl', [...cmdArgs, 'stop', paths.unitName!], { stdio: 'ignore' })
            console.log(`✅ Successfully stopped ${system ? 'system' : 'user'} sync-daemon unit.`)
          } catch (e) {
            console.log(`❌ Failed to stop ${system ? 'system' : 'user'} sync-daemon unit: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
  }
}

export async function daemonStart(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (plistExists) {
          try {
            execFileSync('launchctl', ['load', '-w', paths.targetPath], { stdio: 'ignore' })
            console.log(`✅ Successfully started ${system ? 'system' : 'user'} sync-daemon.`)
          } catch (e) {
            console.log(`❌ Failed to start ${system ? 'system' : 'user'} sync-daemon: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, false, 'linux')
        const unitExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (unitExists) {
          try {
            const cmdArgs = system ? [] : ['--user']
            execFileSync('systemctl', [...cmdArgs, 'start', paths.unitName!], { stdio: 'ignore' })
            console.log(`✅ Successfully started ${system ? 'system' : 'user'} sync-daemon unit.`)
          } catch (e) {
            console.log(`❌ Failed to start ${system ? 'system' : 'user'} sync-daemon unit: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
  }
}

// ── Public API (mcp-daemon) ──────────────────────────────────────────

export async function installMcpDaemon(opts: InstallDaemonOptions): Promise<void> {
  const resolved = {
    workspaceId:     opts.workspaceId,
    apiKey:          opts.apiKey,
    controlPlaneUrl: opts.controlPlaneUrl ?? 'https://api.intutic.ai',
  }
  const system = !!opts.system

  switch (process.platform) {
    case 'darwin': {
      const paths = getPaths(system, true, 'darwin')
      if (!opts.dryRun) {
        checkRootPrivileges(system, paths.targetPath)
      }
      const plist = buildMcpPlist(resolved, system)
      console.log(`\n📦 Installing MCP macOS Launch${system ? 'Daemon' : 'Agent'}: ${paths.targetPath}`)
      if (opts.dryRun) {
        console.log('\n[dry-run] Would write plist:')
        console.log(sanitizeConfigFile(plist))
        return
      }
      await fs.mkdir(paths.targetDir, { recursive: true })
      await fs.mkdir(paths.logsDir, { recursive: true })
      try {
        execFileSync('launchctl', ['unload', '-w', paths.targetPath], { stdio: 'ignore' })
      } catch {
        // Best-effort: releases a previously installed MCP agent before its
        // plist is overwritten. Nothing is loaded on a first install, so a
        // non-zero exit here is the normal path. The `load` below is unwrapped
        // and will report a genuine failure.
      }
      await fs.writeFile(paths.targetPath, plist, 'utf-8')
      execFileSync('launchctl', ['load', '-w', paths.targetPath])
      console.log(`\n✅ MCP Launch${system ? 'Daemon' : 'Agent'} installed and started.`)
      break
    }
    case 'linux': {
      const paths = getPaths(system, true, 'linux')
      if (!opts.dryRun) {
        checkRootPrivileges(system, paths.targetPath)
      }
      const unit = buildMcpUnit(resolved, system)
      console.log(`\n📦 Installing MCP systemd ${system ? 'system' : 'user'} unit: ${paths.targetPath}`)
      if (opts.dryRun) {
        console.log('\n[dry-run] Would write unit:')
        console.log(sanitizeConfigFile(unit))
        return
      }
      await fs.mkdir(paths.targetDir, { recursive: true })
      await fs.mkdir(paths.logsDir, { recursive: true })
      await fs.writeFile(paths.targetPath, unit, 'utf-8')
      const cmdArgs = system ? [] : ['--user']
      execFileSync('systemctl', [...cmdArgs, 'daemon-reload'])
      execFileSync('systemctl', [...cmdArgs, 'enable', '--now', paths.unitName!])
      console.log(`\n✅ MCP systemd ${system ? 'system' : 'user'} unit installed and started.`)
      break
    }
    default:
      console.log(`\n⚠️  Platform '${process.platform}' not supported.`)
  }
}

export async function uninstallMcpDaemon(opts: UninstallDaemonOptions = {}): Promise<void> {
  const system = !!opts.system
  const paths = getPaths(system, true)
  if (!opts.dryRun) {
    checkRootPrivileges(system, paths.targetPath)
  }

  switch (process.platform) {
    case 'darwin': {
      console.log(`\n🗑  Removing MCP Launch${system ? 'Daemon' : 'Agent'}: ${paths.targetPath}`)
      if (!opts.dryRun) {
        try {
          execFileSync('launchctl', ['unload', '-w', paths.targetPath], { stdio: 'ignore' })
        } catch {
          // Best-effort: uninstall is idempotent. An MCP agent that is already
          // unloaded (or never was) makes launchctl exit non-zero while leaving
          // the desired end state in place, and the plist removal below still
          // has to run.
        }
        try {
          await fs.unlink(paths.targetPath)
        } catch {
          // Best-effort: ENOENT means a previous uninstall already removed the
          // plist, which is the outcome this command wants. Permission failures
          // on the /Library/LaunchDaemons copy are pre-empted by the
          // checkRootPrivileges call above.
        }
      }
      console.log(`✅ MCP Launch${system ? 'Daemon' : 'Agent'} removed.`)
      break
    }
    case 'linux': {
      console.log(`\n🗑  Removing MCP systemd ${system ? 'system' : 'user'} unit: ${paths.targetPath}`)
      if (!opts.dryRun) {
        const cmdArgs = system ? [] : ['--user']
        try {
          execFileSync('systemctl', [...cmdArgs, 'disable', '--now', paths.unitName!], { stdio: 'ignore' })
        } catch {
          // Best-effort: a unit that is not enabled, not loaded, or absent makes
          // `disable --now` exit non-zero, and each of those already satisfies
          // what this call was for. Removal of the unit file below must not be
          // skipped because of it.
        }
        try {
          await fs.unlink(paths.targetPath)
          execFileSync('systemctl', [...cmdArgs, 'daemon-reload'], { stdio: 'ignore' })
        } catch {
          // Best-effort: ENOENT means the unit file is already gone. The reload
          // shares this block on purpose — with nothing removed there is no
          // change for systemd to reload.
        }
      }
      console.log(`✅ MCP systemd ${system ? 'system' : 'user'} unit removed.`)
      break
    }
  }
}

export async function mcpDaemonStatus(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        const scopeStr = system ? 'System-level (LaunchDaemon)' : 'User-level (LaunchAgent)'
        if (plistExists) {
          console.log(`✅ MCP Daemon: ${scopeStr} installed at ${paths.targetPath}`)
          try {
            execFileSync('launchctl', ['list', paths.label], { stdio: 'inherit' })
          } catch {
            console.log(`   ⚠️  MCP ${scopeStr} plist exists but is not loaded.`)
          }
        } else {
          console.log(`⬜ MCP Daemon: ${scopeStr} not installed`)
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'linux')
        const scopeStr = system ? 'System-level' : 'User-level'
        const cmdArgs = system ? [] : ['--user']
        try {
          console.log(`\n--- MCP ${scopeStr} Status ---`)
          execFileSync('systemctl', [...cmdArgs, 'status', paths.unitName!], { stdio: 'inherit' })
        } catch {
          console.log(`⬜ MCP Daemon: ${scopeStr} not running`)
        }
      }
      break
    }
  }
}

export async function mcpDaemonStop(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (plistExists) {
          console.log(`\n🛑 Stopping MCP Launch${system ? 'Daemon' : 'Agent'}: ${paths.label}`)
          try {
            execFileSync('launchctl', ['unload', paths.targetPath], { stdio: 'ignore' })
            console.log(`✅ Successfully stopped MCP Launch${system ? 'Daemon' : 'Agent'}.`)
          } catch (e) {
            console.log(`❌ Failed to stop MCP Launch${system ? 'Daemon' : 'Agent'}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'linux')
        const unitExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (unitExists) {
          try {
            const cmdArgs = system ? [] : ['--user']
            execFileSync('systemctl', [...cmdArgs, 'stop', paths.unitName!], { stdio: 'ignore' })
            console.log(`✅ Successfully stopped MCP ${system ? 'system' : 'user'} unit.`)
          } catch (e) {
            console.log(`❌ Failed to stop MCP ${system ? 'system' : 'user'} unit: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
  }
}

export async function mcpDaemonStart(): Promise<void> {
  switch (process.platform) {
    case 'darwin': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'darwin')
        const plistExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (plistExists) {
          try {
            execFileSync('launchctl', ['load', '-w', paths.targetPath], { stdio: 'ignore' })
            console.log(`✅ Successfully started MCP Launch${system ? 'Daemon' : 'Agent'}.`)
          } catch (e) {
            console.log(`❌ Failed to start MCP Launch${system ? 'Daemon' : 'Agent'}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
    case 'linux': {
      for (const system of [false, true]) {
        const paths = getPaths(system, true, 'linux')
        const unitExists = await fs.access(paths.targetPath).then(() => true).catch(() => false)
        if (unitExists) {
          try {
            const cmdArgs = system ? [] : ['--user']
            execFileSync('systemctl', [...cmdArgs, 'start', paths.unitName!], { stdio: 'ignore' })
            console.log(`✅ Successfully started MCP ${system ? 'system' : 'user'} unit.`)
          } catch (e) {
            console.log(`❌ Failed to start MCP ${system ? 'system' : 'user'} unit: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      break
    }
  }
}
