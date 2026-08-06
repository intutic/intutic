/**
 * `intutic connect` — Start the sync daemon.
 *
 * Runs a persistent WebSocket client for real-time config updates,
 * a real-time filesystem watcher for configuration drift detection,
 * and a 30-second HTTP polling loop as a secondary fallback.
 *
 * LLD #14 — connect.ts
 * HLD §3.14 — Real-Time State Mirroring
 *
 * @module
 */

import * as node_path from 'node:path'
import { createRequire } from 'node:module'

const { version: cliPkgVersion } = createRequire(import.meta.url)('../../package.json') as {
  version: string
}
import * as node_fs from 'node:fs/promises'
import { log } from '../lib/logger.js'
import { ensureValkey, valkeyRemediation, isValkeyRunning } from '../lib/ensureValkey.js'
import {
  loadCredentials,
  loadConfig,
  saveConfig,
  loadIntegrity,
  saveIntegrity,
} from '../config/store.js'
import { resolveControlPlaneUrl, getIntuticDir } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { getActiveAgentProcesses } from '../lib/process.js'
import { getAdapter } from '../harness/detector.js'
import { printOnboardingGuide } from '../lib/onboarding.js'
import { newIso } from '@intutic/id'
import type { SopFileHash, HarnessType, SyncConfigPayload, SyncSopEntry } from '@intutic/shared-types'
import pc from 'picocolors'

import { SyncWsClient,
  startWatcher,
  updatePreToolUseHooks,
  injectMcpServer,
  guardSettingsFile,
  writeRuntimeEnv,
  refreshPolicySnapshot,
  runComplianceProbes,
  drainHookEvents,
  syncOfflineTraces,
  TrajectoryMonitor,
  collectAgentReport,
  reportAgent,
  startHarnessSession,
  endAllOpenSessions,
} from '@intutic/sync-daemon'
import { watch } from 'chokidar'
// Named, not default: under `module: Node16` TypeScript resolves ioredis's
// default export to the module namespace rather than the class, so `new
// Redis(...)` is not constructable and `Redis` is not a type. That is what the
// `new (Redis as any)(...)` below was working around, at the cost of also
// giving up the client's type. `packages/mcp-proxy` already imports it this
// way; both forms are the same class at run time.
import { Redis } from 'ioredis'
import * as net from 'node:net'
import { spawn, execSync, ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const DEFAULT_POLL_INTERVAL = 30_000

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true)
      } else {
        resolve(false)
      }
    })
    server.once('listening', () => {
      server.close()
      resolve(false)
    })
    server.listen(port, '127.0.0.1')
  })
}




/**
 * Is this a path the tamper guard should inspect?
 *
 * Deliberately broad: `guardSettingsFile` already branches per harness, so the only
 * job here is to stop filtering out paths it knows how to handle.
 */
function isGovernedConfigPath(changedPath: string, filename: string): boolean {
  if (filename === 'settings.json' || filename === 'settings.local.json') return true
  if (filename === 'hooks.json') return true
  // Goose's immutable governance plugin.
  if (changedPath.includes('intutic-governance')) return true
  return false
}

async function downloadProxyBinary(destPath: string): Promise<string> {
  const platform = process.platform
  const arch = process.arch
  
  let assetName = ''
  if (platform === 'darwin') {
    if (arch === 'arm64') assetName = 'intutic-proxy-darwin-arm64'
    else if (arch === 'x64') assetName = 'intutic-proxy-darwin-x64'
  } else if (platform === 'linux') {
    if (arch === 'x64') assetName = 'intutic-proxy-linux-x64'
    else if (arch === 'arm64') assetName = 'intutic-proxy-linux-arm64'
  } else if (platform === 'win32') {
    if (arch === 'x64') assetName = 'intutic-proxy-win32-x64.exe'
  }

  if (!assetName) {
    throw new Error(`Unsupported platform/architecture: ${platform}-${arch}`)
  }

  // Binaries are published as GitHub Release assets by .github/workflows/publish.yml
  // (the github-release job uploads every build-rust-proxy artifact under the vX.Y.Z
  // tag). Asset names here MUST match that workflow's matrix `artifact_name` values.
  //
  // Read the version from package.json rather than repeating it here. This was
  // pinned to a literal '1.6.0', so every release after that shipped a CLI that
  // downloaded a proxy several versions behind itself — a 1.7.0 user got the
  // 1.6.0 proxy, which still required Valkey and had none of the standalone
  // work. Same bug, same fix, as `intutic --version` in cli.ts.
  const url = `https://github.com/intutic/intutic/releases/download/v${cliPkgVersion}/${assetName}`

  log.info(`Downloading precompiled Intutic proxy from ${url}...`)
  
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download binary from release server: HTTP ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const destDir = node_path.dirname(destPath)
  await node_fs.mkdir(destDir, { recursive: true })
  await node_fs.writeFile(destPath, buffer)

  if (platform !== 'win32') {
    await node_fs.chmod(destPath, 0o755)
  }

  log.success(`Successfully downloaded and installed proxy binary to ${destPath}`)
  return destPath
}

export async function runConnect(opts: {
  dev?: boolean
  interval?: string
  workspaceId?: string
  apiKey?: string
  controlPlaneUrl?: string
}): Promise<void> {
  // 1. Load credentials + config
  let creds = await loadCredentials()
  if (opts.workspaceId && opts.apiKey) {
    creds = {
      workspaceId: opts.workspaceId,
      apiKey: opts.apiKey,
      email: 'daemon@intutic.ai',
      controlPlaneUrl: opts.controlPlaneUrl ?? 'https://api.intutic.ai',
      storedAt: newIso(),
    }
  }

  if (!creds) {
    // `connect` starts the sync daemon, which mirrors config with a control
    // plane — so it genuinely needs credentials. But open core ships no control
    // plane, and the documented install ends by telling users to run this. The
    // bare "run `intutic login` first" sent them looking for an account that
    // does not exist for standalone use (issue #1). Say what this command is
    // for and point at the path that does work without one.
    log.error('`intutic connect` needs a control plane, and you are not authenticated.')
    log.info('')
    log.info('This command runs the sync daemon, which mirrors governance config')
    log.info('with a control plane. Open core does not include one.')
    log.info('')
    log.info('To run standalone, with policy enforcement, DLP and WASM rules all local:')
    log.info('')
    log.info('  intutic start')
    log.info('  export ANTHROPIC_BASE_URL=http://localhost:4000')
    log.info('')
    log.info('`intutic start` needs nothing else. It will set up Valkey if Docker is')
    log.info('available, since that makes the response cache shared, but runs without it.')
    log.info('')
    log.info('If you run your own control plane, authenticate with `intutic login`')
    log.info('(add --dev to target http://localhost:3001).')
    process.exit(1)
  }

  let config = loadConfig()
  if (!config && opts.workspaceId && opts.apiKey) {
    // `IntuticConfig`, not `as any`. This literal used to carry a
    // `workspaceId` too, which the type does not declare and nothing reads —
    // `init.ts`, the only other writer of ~/.intutic/config.json, has never
    // written one, and every consumer takes the workspace id from the
    // credentials instead. The cast was there to admit it, so it went with the
    // cast. The workspace id from --workspace-id still reaches everything that
    // needs it, via `creds` above.
    config = {
      harnesses: [],
      configVersion: 0,
      devMode: opts.dev || false,
      // workspaceRoot must be set here: step 2.5 path.join()s it, and
      // path.join(undefined) throws a TypeError that nothing catches. That
      // crash is what made `intutic daemon install` produce a crash-looping
      // service on any machine without ~/.intutic/config.json (the launchd
      // plist runs `connect --workspace-id --api-key` with KeepAlive=true).
      workspaceRoot: process.cwd(),
    }
  }

  if (!config) {
    log.error('Workspace not initialized. Run `intutic init` first.')
    process.exit(1)
  }

  const safeCreds = creds
  const safeConfig = config

  const devMode = opts.dev || process.env.INTUTIC_DEV === '1' || safeConfig.devMode
  const controlPlaneUrl = opts.controlPlaneUrl || resolveControlPlaneUrl(devMode)
  const pollInterval = opts.interval ? parseInt(opts.interval, 10) : DEFAULT_POLL_INTERVAL
  const connectedSince = newIso()

  const client = createApiClient(controlPlaneUrl, safeCreds.apiKey)

  log.header('Intutic — Sync Daemon')
  log.field('Workspace', safeCreds.workspaceId)
  log.field('Control Plane', controlPlaneUrl)
  log.field('Poll Interval', `${pollInterval / 1000}s`)
  log.field('Harnesses', safeConfig.harnesses.join(', ') || '(none)')

  // Print onboarding setup instructions for active harnesses
  printOnboardingGuide(safeConfig.harnesses, safeCreds.apiKey, devMode)

  log.info('Starting sync daemon... (Ctrl+C to stop)')
  console.log('')

  // Start the Trajectory Monitor & Valkey Subscriber
  let trajectoryMonitor: TrajectoryMonitor | null = null
  let trajectorySubscriber: Redis | null = null

  const valkeyUrl = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379'
  trajectoryMonitor = new TrajectoryMonitor({
    valkeyUrl,
    controlPlaneUrl,
    apiKey: safeCreds.apiKey,
    windowMs: 300_000,
    submitIntervalMs: 60_000,
  })

  try {
    await trajectoryMonitor.start()
    trajectorySubscriber = new Redis(valkeyUrl)
    await trajectorySubscriber.psubscribe('trace:live:*')
    
    trajectorySubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      try {
        const event = JSON.parse(message)
        trajectoryMonitor?.handleTraceEvent(event)
      } catch (err) {
        log.warn(`[sync-daemon] Failed to parse trajectory trace event: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    log.info('[sync-daemon] Trajectory monitor & subscriber started successfully')
  } catch (err) {
    log.warn(`[sync-daemon] Could not start trajectory monitor: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. AbortController for clean shutdown
  let proxyProc: ChildProcess | null = null
  const ac = new AbortController()
  const shutdown = () => {
    log.info('Shutting down sync daemon...')
    if (proxyProc) {
      log.info('Stopping managed proxy gateway...')
      proxyProc.kill('SIGTERM')
    }
    trajectoryMonitor?.stop()
    trajectorySubscriber?.disconnect()
    ac.abort()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

    // 2.4. Pre-flight Valkey Validation
    //
    // Shared with `intutic start` (lib/ensureValkey.ts). This ladder used to be
    // inline here, below the credential check — so open-core users, who cannot
    // authenticate, never reached it and were told to install Valkey by hand.
    const valkeyPort = 6379
    const valkeyResult = await ensureValkey(valkeyPort)
    if (!valkeyResult.running) {
      // `connect` attaches to a control plane, so the proxy will refuse to
      // start without Valkey — it holds the auth and budget cache, and running
      // without it would leave requests unauthenticated. This is deliberately
      // NOT the standalone fallback that `intutic start` gets.
      log.error('Valkey is required when connected to a control plane, and could not be started.')
      log.info('It holds the auth and budget cache; the proxy will not run unauthenticated.')
      log.info('')
      for (const line of valkeyRemediation(valkeyPort).split('\n')) log.info(line)
      log.info('')
      log.info('To run without a control plane instead: intutic start')
    }


  // 2.5. Manage LiteLLM-Rust Proxy Gateway Process
  const proxyPort = parseInt(process.env.PORT || '4000', 10)
  let exeCmd = 'cargo'
  let exeArgs = ['run', '--manifest-path', node_path.join(safeConfig.workspaceRoot, 'packages', 'proxy', 'Cargo.toml')]
  // Populated only on the branch that actually spawns the proxy; the DR
  // re-spawn below reuses it and is guarded by `proxyProc`, which is null
  // whenever this is still empty.
  let proxyEnv: NodeJS.ProcessEnv = {}

  try {
    const inUse = await isPortInUse(proxyPort)
    if (inUse) {
      log.info(`Proxy already running on port ${proxyPort} (assuming external instance).`)
    } else {
      log.info(`Port ${proxyPort} is free. Spawning managed proxy gateway...`)
      
      const logDir = node_path.join(safeConfig.workspaceRoot, '.intutic', 'logs')
      await node_fs.mkdir(logDir, { recursive: true })
      const logStream = createWriteStream(node_path.join(logDir, 'proxy-gateway.log'), { flags: 'a' })
      
      // Determine proxy binary or build command
      exeCmd = 'cargo'
      exeArgs = ['run', '--manifest-path', node_path.join(safeConfig.workspaceRoot, 'packages', 'proxy', 'Cargo.toml')]
      
      if (!devMode) {
        // In production, try to resolve precompiled binary path
        const releasePath = node_path.join(safeConfig.workspaceRoot, 'packages', 'proxy', 'target', 'release', 'intutic-proxy')
        const debugPath = node_path.join(safeConfig.workspaceRoot, 'packages', 'proxy', 'target', 'debug', 'intutic-proxy')
        
        try {
          await node_fs.access(releasePath)
          exeCmd = releasePath
          exeArgs = []
        } catch {
          try {
            await node_fs.access(debugPath)
            exeCmd = debugPath
            exeArgs = []
          } catch {
            // Fallback to globally cached binary in ~/.intutic/bin/
            // Version-specific: an unversioned cache entry was never revalidated,
            // so upgrading the CLI left the old binary in place indefinitely.
            const globalBinPath = node_path.join(getIntuticDir(), 'bin', `intutic-proxy-${cliPkgVersion}${process.platform === 'win32' ? '.exe' : ''}`)
            try {
              await node_fs.access(globalBinPath)
              exeCmd = globalBinPath
              exeArgs = []
            } catch {
              log.info('Precompiled proxy binary not found in workspace or cache.')
              try {
                const downloadedPath = await downloadProxyBinary(globalBinPath)
                exeCmd = downloadedPath
                exeArgs = []
              } catch (downloadErr) {
                log.warn(`Auto-download failed: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`)
                log.dim('Falling back to cargo run...')
              }
            }
          }
        }
      }
      
      proxyEnv = {
        ...process.env,
        VALKEY_URL: process.env.VALKEY_URL || 'redis://127.0.0.1:6379',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        INTUTIC_CONTROL_PLANE_URL: controlPlaneUrl,
        CONTROL_PLANE_URL: controlPlaneUrl,
        INTUTIC_WORKSPACE_ID: safeCreds.workspaceId,
        INTUTIC_API_KEY: safeCreds.apiKey,
        CONFIG_PATH: node_path.join(safeConfig.workspaceRoot, 'config.yaml'),
        // Workspace policy: admins can disallow local Obsidian/Logseq/Foam
        // vaults from feeding /fix. Applied at spawn; a policy change takes
        // effect on the next connect. Vault content never leaves the machine
        // under either setting — this only governs whether the search runs.
        ...(safeConfig.settings?.allowLocalMemoryVaults === false
          ? { INTUTIC_LOCAL_VAULTS: 'off' }
          : {}),
      }
      
      proxyProc = spawn(exeCmd, exeArgs, {
        cwd: safeConfig.workspaceRoot,
        env: proxyEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      
      proxyProc.stdout?.pipe(logStream)
      proxyProc.stderr?.pipe(logStream)
      
      proxyProc.on('error', (err) => {
        log.error(`Managed proxy process failed to start: ${err.message}`)
      })
      
      proxyProc.on('exit', (code, signal) => {
        log.info(`Managed proxy process exited: code=${code}, signal=${signal}`)
      })
      
      log.success('Managed proxy gateway process spawned.')

      // Wait for ca.crt to be written by the proxy if it doesn't exist
      const caCertPath = node_path.join(getIntuticDir(), 'ca.crt')
      let certExists = false
      for (let i = 0; i < 20; i++) {
        try {
          await node_fs.access(caCertPath)
          certExists = true
          break
        } catch {
          await new Promise(r => setTimeout(r, 100))
        }
      }
      
      if (certExists) {
        // Run trust check and add to keychain
        try {
          if (process.platform === 'darwin') {
            try {
              execSync(`security verify-cert -c "${caCertPath}" 2>/dev/null`, { timeout: 3000 })
            } catch {
              log.info('Auto-trusting Intutic SSL CA certificate in macOS Login Keychain...')
              execSync(`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caCertPath}"`, { stdio: 'ignore' })
              log.success('Successfully trusted SSL CA certificate.')
            }
          } else if (process.platform === 'win32') {
            try {
              execSync(`certutil -addstore Root "${caCertPath}"`, { stdio: 'ignore' })
              log.success('Successfully trusted SSL CA certificate.')
            } catch (err) {
              log.warn(`Failed to auto-trust SSL certificate on Windows: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        } catch (err) {
          log.warn(`Could not verify or auto-trust CA certificate: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to set up managed proxy gateway: ${err instanceof Error ? err.message : String(err)}`)
  }

  let localConfigVersion = safeConfig.configVersion
  let lastCachedConfig: SyncConfigPayload | null = null

  // 3. Define configuration applier function
  async function applySyncConfig(syncConfig: SyncConfigPayload, force = false): Promise<number> {
    let sopsWritten = 0
    lastCachedConfig = syncConfig

    if (syncConfig.configVersion > localConfigVersion || force) {
      log.info(`Applying configuration v${syncConfig.configVersion}...`)

      // Load and compile local SOP entries
      const localSopEntries: SyncSopEntry[] = []
      try {
        const sessionContextPath = node_path.join(safeConfig.workspaceRoot, '.intutic', 'session-context.json')
        let activeLocalSops: string[] | undefined
        try {
          const raw = await node_fs.readFile(sessionContextPath, 'utf-8')
          const parsed = JSON.parse(raw)
          activeLocalSops = parsed.activeLocalSops
        } catch {
          // not configured yet
        }

        const sopsDir = node_path.join(safeConfig.workspaceRoot, '.intutic', 'sops')
        const entries = await node_fs.readdir(sopsDir, { withFileTypes: true })
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

        const activeDirs = activeLocalSops !== undefined
          ? dirs.filter((d) => activeLocalSops!.includes(d))
          : dirs

        for (const dirName of activeDirs) {
          const dirPath = node_path.join(sopsDir, dirName)
          const files = await node_fs.readdir(dirPath)
          const mdFiles = files.filter((f) => f.endsWith('.md'))
          
          for (const file of mdFiles) {
            const filePath = node_path.join(dirPath, file)
            const content = await node_fs.readFile(filePath, 'utf-8')
            localSopEntries.push({
              sopId: `local:${dirName}:${file}`,
              title: `Local SOP: ${dirName}/${file}`,
              content,
              contentHash: '',
              harnessTargets: safeConfig.harnesses as HarnessType[],
            })
          }
        }
      } catch (err) {
        // Only a missing `.intutic/sops` is unremarkable — most workspaces have
        // none, and `readdir` ENOENTs on the first line of the block.
        //
        // Everything else was being swallowed with it, and the block goes on to
        // read every SOP file: an unreadable file or a permissions error dropped
        // that SOP from `localSopEntries`, and the harness configs written a few
        // lines below were then generated *without* it, silently. Governance
        // content going missing is the failure this whole function exists to
        // prevent, so it does not get to be quiet.
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
        if (code !== 'ENOENT') {
          log.warn(
            `Failed to load local SOPs from .intutic/sops — harness configs will be written without them: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      const combinedSops = [...syncConfig.sops, ...localSopEntries]

      // a. Write configs for all active harnesses
      for (const harnessType of safeConfig.harnesses) {
        const adapter = getAdapter(harnessType)
        if (!adapter) continue

        const targetSops = combinedSops.filter((sop) =>
          sop.harnessTargets.includes(harnessType as HarnessType)
        )
        if (targetSops.length === 0 && !force) continue

        const written = await adapter.writeConfig(
          safeConfig.workspaceRoot,
          targetSops,
          syncConfig.proxyUrl
        )
        if (written) {
          sopsWritten += targetSops.length
        }
      }

      // b. Invalidate/update Claude Code hooks and settings
      if (safeConfig.harnesses.includes('claude-code' as HarnessType)) {
        try {
          await updatePreToolUseHooks(
            safeConfig.workspaceRoot,
            syncConfig.sops,
            syncConfig.settings as unknown as Record<string, unknown>,
          )
        } catch (err) {
          log.warn(`Failed to update Claude Code hooks: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // c. Inject + proxy-wrap MCP servers across all supported harnesses
      try {
        await injectMcpServer(safeConfig.workspaceRoot, safeCreds.workspaceId)
      } catch (err) {
        log.warn(`Failed to inject MCP server configs: ${err instanceof Error ? err.message : String(err)}`)
      }

      localConfigVersion = syncConfig.configVersion
      // Mirror workspace settings locally so spawn-time policies (like
      // allowLocalMemoryVaults) apply on the next connect without a fetch.
      safeConfig.settings = syncConfig.settings
      saveConfig({ ...safeConfig, configVersion: localConfigVersion, settings: syncConfig.settings })
    }

    // c. Compute file hashes + update integrity store
    const fileHashes: SopFileHash[] = []
    const canonicalHashes: Record<string, string> = {}

    // Load current integrity file list
    const integrity = loadIntegrity(safeConfig.workspaceRoot)
    if (integrity) {
      Object.assign(canonicalHashes, integrity.files)
    }

    for (const harnessType of safeConfig.harnesses) {
      const adapter = getAdapter(harnessType)
      if (!adapter || !adapter.configFileName) continue

      const currentHash = await adapter.readCurrentHash(safeConfig.workspaceRoot)
      if (!currentHash) continue

      const canonical = canonicalHashes[adapter.configFileName] ?? currentHash
      fileHashes.push({
        filePath: adapter.configFileName,
        localHash: currentHash,
        canonicalHash: canonical,
        drifted: currentHash !== canonical,
      })

      // Update canonical hash to current
      canonicalHashes[adapter.configFileName] = currentHash
    }

    // Save integrity store
    saveIntegrity(safeConfig.workspaceRoot, {
      lastSyncAt: newIso(),
      configVersion: localConfigVersion,
      files: canonicalHashes,
    })

    // d. Report hashes to control plane
    let driftCount = 0
    if (fileHashes.length > 0) {
      try {
        const hashReport = await client.reportHashes({
          workspaceId: safeCreds.workspaceId,
          harnessType: safeConfig.harnesses[0] as HarnessType,
          files: fileHashes,
          reportedAt: newIso(),
        })
        driftCount = hashReport.driftCount
      } catch (err) {
        log.warn(`Failed to report integrity hashes: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // e. Health Check & Disaster Recovery (DR)
    let valkeyStatus: 'healthy' | 'unhealthy' | 'stopped' = 'healthy'
    let proxyStatus: 'healthy' | 'unhealthy' | 'stopped' = 'healthy'
    let sslTrustStatus: 'trusted' | 'untrusted' = 'trusted'

    // Check & Healing: Valkey
    try {
      const valkeyActive = await isValkeyRunning(6379)
      if (!valkeyActive) {
        valkeyStatus = 'unhealthy'
        log.warn('[DR] Valkey database is offline. Attempting auto-healing restart...')
        // Check if Docker is running
        let dockerActive = false
        try {
          execSync('docker info', { stdio: 'ignore' })
          dockerActive = true
        } catch {
          // Deliberate swallow: `docker info` exiting non-zero IS the answer we
          // asked for — Docker is not installed or its daemon is down. That is a
          // normal state on machines running Valkey natively, not an error to
          // report. dockerActive stays false and we fall through to the native
          // binary / downloaded-static healing paths below.
        }

        if (dockerActive) {
          try {
            execSync('docker start intutic-valkey', { stdio: 'ignore' })
            log.info('[DR] Successfully sent container start command to intutic-valkey.')
          } catch (err) {
            log.warn(`[DR] Docker container start failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          let hasNativeBinary = false
          let nativeCmd = 'valkey-server'
          try {
            execSync('which valkey-server', { stdio: 'ignore' })
            hasNativeBinary = true
          } catch {
            try {
              execSync('which redis-server', { stdio: 'ignore' })
              nativeCmd = 'redis-server'
              hasNativeBinary = true
            } catch {
              // Deliberate swallow: this is the last of three probes (docker,
              // valkey-server, redis-server). `which` failing just means the
              // binary is not on PATH, which is the question we asked.
              // hasNativeBinary stays false and healing falls through to the
              // downloaded static binary under ~/.intutic/bin.
            }
          }

          if (hasNativeBinary) {
            try {
              const proc = spawn(nativeCmd, ['--port', '6379', '--daemonize', 'yes'], { stdio: 'ignore', detached: true })
              proc.unref()
              log.info(`[DR] Successfully spawned native ${nativeCmd} in background.`)
            } catch (err) {
              log.warn(`[DR] Native daemon spawn failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          } else {
            // Downloaded static
            try {
              const globalValkeyBinPath = node_path.join(getIntuticDir(), 'bin', process.platform === 'win32' ? 'valkey-server.exe' : 'valkey-server')
              await node_fs.access(globalValkeyBinPath)
              const proc = spawn(globalValkeyBinPath, ['--port', '6379', '--daemonize', 'yes'], { stdio: 'ignore', detached: true })
              proc.unref()
              log.info('[DR] Successfully spawned downloaded static Valkey server in background.')
            } catch (err) {
              log.warn(`[DR] Static binary spawn failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }
      }
    } catch {
      valkeyStatus = 'unhealthy'
    }

    // Check & Healing: Proxy
    try {
      const proxyActive = await isPortInUse(proxyPort)
      if (!proxyActive) {
        proxyStatus = 'unhealthy'
        if (proxyProc) {
          log.warn('[DR] Managed proxy gateway process has terminated. Auto-healing re-spawn...')
          const logDir = node_path.join(safeConfig.workspaceRoot, '.intutic', 'logs')
          const logStream = createWriteStream(node_path.join(logDir, 'proxy-gateway.log'), { flags: 'a' })
          proxyProc = spawn(exeCmd, exeArgs, {
            cwd: safeConfig.workspaceRoot,
            env: proxyEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          proxyProc.stdout?.pipe(logStream)
          proxyProc.stderr?.pipe(logStream)
          proxyProc.on('exit', (code, signal) => {
            log.info(`Managed proxy process exited: code=${code}, signal=${signal}`)
          })
          log.success('[DR] Successfully re-spawned proxy gateway process.')
        } else {
          proxyStatus = 'stopped'
        }
      }
    } catch {
      proxyStatus = 'unhealthy'
    }

    // Check: CA SSL trust store
    try {
      const caCertPath = node_path.join(getIntuticDir(), 'ca.crt')
      await node_fs.access(caCertPath)
      if (process.platform === 'darwin') {
        execSync(`security verify-cert -c "${caCertPath}" 2>/dev/null`, { timeout: 3000 })
      } else {
        // Windows/Linux simple checks fallback
        sslTrustStatus = 'trusted'
      }
    } catch {
      sslTrustStatus = 'untrusted'
    }

    // f. Report status heartbeat
    try {
      const activeProcs = getActiveAgentProcesses().map((p) => p.name)
      await client.reportStatus({
        workspaceId: safeCreds.workspaceId,
        configVersion: localConfigVersion,
        connectedSince,
        lastSyncAt: newIso(),
        harnesses: safeConfig.harnesses.map((h) => ({
          type: h as HarnessType,
          configPath: getAdapter(h)?.configFileName ?? '',
          detected: true,
          lastWriteAt: sopsWritten > 0 ? newIso() : null,
        })),
        activeProcesses: activeProcs,
        components: {
          proxy: proxyStatus,
          valkey: valkeyStatus,
          sslTrust: sslTrustStatus,
        },
      })
    } catch (err) {
      log.warn(`Failed to send daemon heartbeat: ${err instanceof Error ? err.message : String(err)}`)
    }

    const driftLabel = driftCount > 0 ? pc.yellow(` — ${driftCount} drift(s) detected`) : ''
    log.dim(
      `[sync] Config v${localConfigVersion} — ${sopsWritten} SOPs synced${driftLabel}`
    )

    // Refresh runtime env with resolved settings
    try {
      await writeRuntimeEnv({
        controlPlaneUrl,
        apiKey: safeCreds.apiKey,
        workspaceId: safeCreds.workspaceId,
        mcpProxyFailBehavior: syncConfig.settings?.mcpProxyFailBehavior,
        mcpProxyMode: syncConfig.settings?.mcpProxyMode,
        bypassEnforcementTier: syncConfig.settings?.bypassEnforcementTier,
      })
    } catch (err) {
      log.warn(`Could not write runtime env file (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }

    return sopsWritten
  }

  // Helper to run compliance probes (Phase 6)
  const runProbes = async () => {
    try {
      const hookEventsLog = node_path.join(safeConfig.workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
      await node_fs.mkdir(node_path.dirname(hookEventsLog), { recursive: true })

      const probeResults = await runComplianceProbes(safeCreds.workspaceId)
      let hasBypass = false
      for (const res of probeResults) {
        if (!res.contained && res.incident) {
          const entry = JSON.stringify(res.incident) + '\n'
          await node_fs.appendFile(hookEventsLog, entry, 'utf-8')
          hasBypass = true
        }
      }
      if (hasBypass) {
        log.warn('[Security] Network containment bypass detected! Incident recorded.')
      }
    } catch (err) {
      log.warn(`Compliance probes failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Helper to drain hook events (WS-A)
  const runDrain = async () => {
    try {
      const drained = await drainHookEvents(safeConfig.workspaceRoot, controlPlaneUrl, safeCreds.apiKey)
      if (drained > 0) {
        log.info(`[sync-daemon] Drained ${drained} hook governance events to control plane`)
      }
    } catch (err) {
      log.warn(`[sync-daemon] Hook event drain error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 0: Write runtime env file (hook scripts source this for credentials)
  try {
    await writeRuntimeEnv({
      controlPlaneUrl,
      apiKey: safeCreds.apiKey,
      workspaceId: safeCreds.workspaceId,
    })
  } catch (err) {
    log.warn(`Could not write runtime env file (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Seed the policy snapshot before the first sync cycle rather than after it.
  //
  // Without this, every fresh install runs its first poll interval with no
  // snapshot — the gates enforce the static floor and nothing else. Seeding here
  // narrows that window to "the fetch failed, and we said so" instead of "always,
  // briefly". `refreshPolicySnapshot` never throws.
  const seeded = await refreshPolicySnapshot({
    controlPlaneUrl,
    apiKey: safeCreds.apiKey,
    workspaceId: safeCreds.workspaceId,
  })
  if (!seeded) {
    log.warn(
      'Could not seed the policy snapshot — governance rules from the control plane ' +
        'will not apply until the next successful sync. Built-in protections are unaffected.',
    )
  }

  // Sync offline traces back to PostgreSQL on startup
  try {
    await syncOfflineTraces(controlPlaneUrl, safeCreds.apiKey)
  } catch (err) {
    log.warn(`Could not sync offline traces (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Start WebSocket client
  const wsClient = new SyncWsClient({
    controlPlaneUrl,
    apiKey: safeCreds.apiKey,
    workspaceId: safeCreds.workspaceId,
    onConfigUpdate: async (syncConfig) => {
      try {
        await applySyncConfig(syncConfig)
      } catch (err) {
        log.error(`Failed to apply push configuration: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    onActiveLocalSopsUpdate: async (activeLocalSops) => {
      try {
        const sessionContextPath = node_path.join(safeConfig.workspaceRoot, '.intutic', 'session-context.json')
        await node_fs.writeFile(
          sessionContextPath,
          JSON.stringify({ activeLocalSops }, null, 2) + '\n',
          'utf-8'
        )
        log.info(`Active local SOPs configuration updated: ${activeLocalSops.join(', ') || 'all'}`)
        
        if (lastCachedConfig) {
          await applySyncConfig(lastCachedConfig, true)
        }
      } catch (err) {
        log.error(`Failed to update active local SOPs: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    signal: ac.signal,
  })

  wsClient.connect()

  // Send initial context report on startup
  try {
    const gitContextPath = node_path.join(safeConfig.workspaceRoot, '.intutic', 'git-context.json')
    let gitData = {}
    try {
      const raw = await node_fs.readFile(gitContextPath, 'utf-8')
      const parsed = JSON.parse(raw)
      gitData = parsed.git || {}
    } catch {
      // ignore
    }
    scanLocalSops(safeConfig.workspaceRoot).then((localSops) => {
      setTimeout(() => {
        wsClient.send({
          type: 'context_report',
          git: gitData,
          localSops,
        })
        log.info(`Initial context and ${localSops.length} local SOPs reported to control plane`)
      }, 1000)
    }).catch(() => {})
  } catch (err) {
    // Nothing in the block above is expected to throw — the `readFile` has its
    // own catch and `scanLocalSops` resolves to [] on failure — so this is the
    // outer guard for the one thing that can: `node_path.join` on an undefined
    // workspaceRoot, the TypeError that used to crash-loop the launchd service.
    // Reported rather than swallowed, because reaching it means the startup
    // context report never happened and the dashboard is missing this daemon.
    log.warn(`Failed to send initial context report: ${err instanceof Error ? err.message : String(err)}`)
  }

  // FSEvents-driven hook event drain
  const hookEventsLog = node_path.join(safeConfig.workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  let fsWatcher: ReturnType<typeof watch> | null = null

  try {
    await node_fs.mkdir(node_path.dirname(hookEventsLog), { recursive: true })
    fsWatcher = watch(hookEventsLog, { ignoreInitial: true, persistent: false })
    fsWatcher.on('change', runDrain)
    fsWatcher.on('add', runDrain)
  } catch (err) {
    // A real fallback, not a swallow: `drainSafetyTimer` below drains every 60 s
    // regardless. But losing the FSEvents watcher turns a near-immediate drain
    // into a up-to-60-second one, which is the difference between a hook
    // incident showing up while the agent is still running and after it exited.
    // Say so, at dim, so the degradation is diagnosable.
    log.dim(`Hook-event watcher unavailable, falling back to the 60s drain poll: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 60-second safety-net drain poll
  const drainSafetyTimer = setInterval(runDrain, 60_000)

  // Run initial compliance check on startup
  await runProbes()

  // 5. Start Filesystem Watcher
  const watcher = startWatcher(safeConfig.workspaceRoot, safeConfig.harnesses, async (changedPath) => {
    const filename = node_path.basename(changedPath)

    // A. Handle git-context.json and local sops changes
    const relativePath = node_path.relative(safeConfig.workspaceRoot, changedPath)
    const isSopsDirChange = relativePath.split(node_path.sep).includes('sops')

    if (filename === 'git-context.json' || isSopsDirChange) {
      try {
        let gitData = {}
        const gitContextPath = node_path.join(safeConfig.workspaceRoot, '.intutic', 'git-context.json')
        try {
          const raw = await node_fs.readFile(gitContextPath, 'utf-8')
          const data = JSON.parse(raw)
          gitData = data.git || {}
        } catch {
          // ignore if context file doesn't exist yet
        }
        
        const localSops = await scanLocalSops(safeConfig.workspaceRoot)
        wsClient.send({
          type: 'context_report',
          git: gitData,
          localSops,
        })
        log.info(`Git context and ${localSops.length} local SOPs reported to control plane`)
      } catch (err) {
        log.warn(`Failed to sync Git context metadata: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // B. Tamper detection for every governed config, not just Claude Code's.
    //
    // This used to filter on `filename === 'settings.json'`, which silently disabled
    // five of the six branches inside guardSettingsFile: the Cursor, Windsurf, Cline
    // and OpenHands restores all key off `hooks.json`, and the Goose
    // governance-plugin override incident keys off a path containing
    // `intutic-governance`. None of those basenames could ever reach the guard, so a
    // tampered hooks file on any harness but Claude Code was a no-op — and a tampered
    // Windsurf/VS Code/Gemini settings file passed the basename test only to fall
    // through and log `settings_intact`.
    //
    // Route anything on the governed list to the guard and let it decide.
    if (isGovernedConfigPath(changedPath, filename)) {
      try {
        const sops = lastCachedConfig?.sops ?? []
        const tampered = await guardSettingsFile(changedPath, safeConfig.workspaceRoot, sops)
        if (tampered) {
          log.warn(`[Security] Governance settings tamper detected and restored: ${changedPath}`)
          wsClient.send({
            type: 'drift_report',
            harnessType: 'claude-code',
            filePath: changedPath,
            localHash: '',
            canonicalHash: '',
          })
        }
      } catch (err) {
        log.error(`Settings guard error: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // B. Handle governed harness file drift detection
    const matchingHarness = safeConfig.harnesses.find(
      (h) => getAdapter(h)?.configFileName === filename
    )
    if (!matchingHarness) return

    const adapter = getAdapter(matchingHarness)
    if (!adapter) return

    const currentHash = await adapter.readCurrentHash(safeConfig.workspaceRoot)
    const integrity = loadIntegrity(safeConfig.workspaceRoot)
    if (!integrity) return
    const canonical = integrity.files[adapter.configFileName] ?? ''

    if (currentHash !== canonical) {
      log.warn(
        `Governed config file "${filename}" modification detected! Reverting to approved baseline...`
      )

      // Backup drifted version first
      try {
        const content = await node_fs.readFile(changedPath, 'utf-8')
        const backupPath = changedPath + '.drift-backup'
        await node_fs.writeFile(backupPath, content, 'utf-8')
        log.dim(`Drifted file backed up to: ${backupPath}`)
      } catch {
        // Ignore backup failure
      }

      // Revert from cached config or fetch fresh config
      try {
        let syncConfig = lastCachedConfig
        if (!syncConfig) {
          syncConfig = await client.fetchConfig(safeCreds.workspaceId)
        }
        await applySyncConfig(syncConfig, true)

        // Report incident via WebSocket/HTTP
        wsClient.send({
          type: 'drift_report',
          harnessType: adapter.type,
          filePath: adapter.configFileName,
          localHash: currentHash || '',
          canonicalHash: canonical,
        })
      } catch (err) {
        log.error(`Failed to automatically revert file drift: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  // 6. Secondary fallback HTTP poll loop
  while (!ac.signal.aborted) {
    try {
      const syncConfig = await client.fetchConfig(safeCreds.workspaceId)
      await applySyncConfig(syncConfig)
      // Sync offline traces back on every iteration
      try {
        await syncOfflineTraces(controlPlaneUrl, safeCreds.apiKey)
      } catch (err) {
        // Non-fatal by design: a backlog of offline traces must never stop the
        // sync iteration — the next tick retries the same backlog. But it is not
        // a no-op either, so report it the way the identical startup call above
        // does, at dim level because this runs every poll interval.
        log.dim(`Offline trace sync failed (will retry next poll): ${err instanceof Error ? err.message : String(err)}`)
      }
      // Register agents + open one real session per harness (the reporter
      // dedupes sessions per run). connect's inline loop bypassed both,
      // leaving the dashboard graph empty for the primary user path.
      for (const harnessType of safeConfig.harnesses) {
        try {
          const report = await collectAgentReport({
            workspaceRoot: process.cwd(),
            harnessType,
            configSynced: true,
            dlpEnabled: true,
            policyEnforced: true,
            allowLocalVaults: syncConfig.settings?.allowLocalMemoryVaults,
          })
          await reportAgent(controlPlaneUrl, safeCreds.apiKey, safeCreds.workspaceId, report)
          await startHarnessSession({
            controlPlaneUrl,
            apiKey: safeCreds.apiKey,
            workspaceId: safeCreds.workspaceId,
            harnessType,
            workspaceRoot: process.cwd(),
          })
        } catch (err) {
          // Per-harness isolation is deliberate: one harness failing to register
          // must not stop the others or abort the poll iteration. Silence was
          // not deliberate — fetchConfig already succeeded above, so a failure
          // here means the control plane accepted the config read and rejected
          // the agent report, which is exactly the "dashboard graph is empty"
          // symptom this loop was added to fix. Report it so it is diagnosable.
          log.dim(`Agent report/session for harness '${harnessType}' failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Run compliance probes on each iteration
      await runProbes()
    } catch (err) {
      log.error(
        `Sync iteration failed: ${err instanceof Error ? err.message : String(err)}`
      )
      log.dim(`Retrying in ${pollInterval / 1000}s...`)
    }

    // Sleep until next interval (AbortSignal-aware)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollInterval)
      ac.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  // Cleanup watcher, intervals, and WS connection on exit
  watcher.stop()
  fsWatcher?.close()
  clearInterval(drainSafetyTimer)
  wsClient.close()
  await endAllOpenSessions(controlPlaneUrl, safeCreds.apiKey)

  log.success('Sync daemon stopped.')
}

async function scanLocalSops(workspaceRoot: string): Promise<string[]> {
  const sopsDir = node_path.join(workspaceRoot, '.intutic', 'sops')
  try {
    const entries = await node_fs.readdir(sopsDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}


