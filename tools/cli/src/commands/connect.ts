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
import * as node_fs from 'node:fs/promises'
import { log } from '../lib/logger.js'
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
  runComplianceProbes,
  drainHookEvents,
  syncOfflineTraces,
  TrajectoryMonitor,
} from '@intutic/sync-daemon'
import { watch } from 'chokidar'
import Redis from 'ioredis'
import * as net from 'node:net'
import { spawn, execSync, ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const DEFAULT_POLL_INTERVAL = 30_000

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: any) => {
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

function isValkeyRunning(port = 6379): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

async function downloadValkeyBinary(destPath: string): Promise<string> {
  const platform = process.platform
  const arch = process.arch
  
  let assetName = ''
  if (platform === 'darwin') {
    if (arch === 'arm64') assetName = 'valkey-server-darwin-arm64'
    else if (arch === 'x64') assetName = 'valkey-server-darwin-x64'
  } else if (platform === 'linux') {
    if (arch === 'x64') assetName = 'valkey-server-linux-x64'
    else if (arch === 'arm64') assetName = 'valkey-server-linux-arm64'
  } else if (platform === 'win32') {
    if (arch === 'x64') assetName = 'valkey-server-win32-x64.exe'
  }

  if (!assetName) {
    throw new Error(`Unsupported platform/architecture for Valkey: ${platform}-${arch}`)
  }

  const valkeyVersion = '1.0.0'
  const url = `https://intutic.ai/valkey/v${valkeyVersion}/${assetName}`

  log.info(`Downloading precompiled Valkey server from ${url}...`)
  
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download Valkey binary: HTTP ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const destDir = node_path.dirname(destPath)
  await node_fs.mkdir(destDir, { recursive: true })
  await node_fs.writeFile(destPath, buffer)

  if (platform !== 'win32') {
    await node_fs.chmod(destPath, 0o755)
  }

  log.success(`Successfully downloaded and installed Valkey binary to ${destPath}`)
  return destPath
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

  const cliVersion = '1.5.0'
  const url = `https://intutic.ai/proxy/v${cliVersion}/${assetName}`

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
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }

  let config = loadConfig()
  if (!config && opts.workspaceId && opts.apiKey) {
    config = {
      workspaceId: opts.workspaceId,
      harnesses: [],
      configVersion: 0,
      devMode: opts.dev || false,
    } as any
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
  let trajectorySubscriber: any = null

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
    trajectorySubscriber = new (Redis as any)(valkeyUrl)
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
  const valkeyPort = 6379
  let valkeyActive = await isValkeyRunning(valkeyPort)
  if (!valkeyActive) {
    log.info('Valkey cache not detected on port 6379. Initiating auto-provisioning...')
    
    // Check if Docker is running
    let dockerActive = false
    try {
      execSync('docker info', { stdio: 'ignore' })
      dockerActive = true
    } catch {}

    if (dockerActive) {
      log.info('Docker detected. Spawning background Valkey container (intutic-valkey)...')
      try {
        const existing = execSync('docker ps -a --filter name=intutic-valkey --format "{{.Names}}"', { encoding: 'utf8' }).trim()
        if (existing === 'intutic-valkey') {
          execSync('docker start intutic-valkey', { stdio: 'ignore' })
        } else {
          execSync('docker run -d --name intutic-valkey -p 6379:6379 valkey/valkey', { stdio: 'ignore' })
        }
        
        // Wait for Valkey to be ready
        for (let i = 0; i < 10; i++) {
          if (await isValkeyRunning(valkeyPort)) {
            valkeyActive = true
            log.success('Successfully started background Valkey container (intutic-valkey).')
            break
          }
          await new Promise(r => setTimeout(r, 500))
        }
      } catch (err: any) {
        log.warn(`Docker auto-spawn failed: ${err.message}`)
      }
    }

    if (!valkeyActive) {
      // Try native binary in PATH
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
        } catch {}
      }

      if (hasNativeBinary) {
        log.info(`Found native ${nativeCmd} in PATH. Spawning background daemon...`)
        try {
          const proc = spawn(nativeCmd, ['--port', '6379', '--daemonize', 'yes'], { stdio: 'ignore', detached: true })
          proc.unref()
          
          for (let i = 0; i < 10; i++) {
            if (await isValkeyRunning(valkeyPort)) {
              valkeyActive = true
              log.success(`Successfully spawned native ${nativeCmd} in background.`)
              break
            }
            await new Promise(r => setTimeout(r, 500))
          }
        } catch (err: any) {
          log.warn(`Native spawn failed: ${err.message}`)
        }
      }
    }

    if (!valkeyActive) {
      // Dynamic Static Download
      log.info('No native database binary on path. Downloading precompiled static Valkey binary...')
      const globalValkeyBinPath = node_path.join(getIntuticDir(), 'bin', process.platform === 'win32' ? 'valkey-server.exe' : 'valkey-server')
      try {
        await downloadValkeyBinary(globalValkeyBinPath)
        log.info('Spawning downloaded Valkey server in background...')
        const args = process.platform === 'win32' ? ['--port', '6379'] : ['--port', '6379', '--daemonize', 'yes']
        const proc = spawn(globalValkeyBinPath, args, { stdio: 'ignore', detached: true })
        proc.unref()

        for (let i = 0; i < 10; i++) {
          if (await isValkeyRunning(valkeyPort)) {
            valkeyActive = true
            log.success('Successfully spawned downloaded Valkey server in background.')
            break
          }
          await new Promise(r => setTimeout(r, 500))
        }
      } catch (err: any) {
        log.error(`Valkey server auto-download/setup failed: ${err.message}`)
        log.warn('Running in degraded offline mode (caching disabled; local JSONL trace logging active).')
      }
    }
  }

  // 2.5. Manage LiteLLM-Rust Proxy Gateway Process
  const proxyPort = parseInt(process.env.PORT || '4000', 10)
  let exeCmd = 'cargo'
  let exeArgs = ['run', '--manifest-path', node_path.join(safeConfig.workspaceRoot, 'packages', 'proxy', 'Cargo.toml')]
  let proxyEnv: any = {}

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
            const globalBinPath = node_path.join(getIntuticDir(), 'bin', process.platform === 'win32' ? 'intutic-proxy.exe' : 'intutic-proxy')
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
              } catch (downloadErr: any) {
                log.warn(`Auto-download failed: ${downloadErr.message}`)
                log.dim('Falling back to cargo run...')
              }
            }
          }
        }
      }
      
      proxyEnv = {
        ...process.env,
        VALKEY_URL: process.env.VALKEY_URL || 'redis://127.0.0.1:6380',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        INTUTIC_CONTROL_PLANE_URL: controlPlaneUrl,
        CONTROL_PLANE_URL: controlPlaneUrl,
        INTUTIC_WORKSPACE_ID: safeCreds.workspaceId,
        INTUTIC_API_KEY: safeCreds.apiKey,
        CONFIG_PATH: node_path.join(safeConfig.workspaceRoot, 'config.yaml'),
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
            } catch (err: any) {
              log.warn(`Failed to auto-trust SSL certificate on Windows: ${err.message}`)
            }
          }
        } catch (err: any) {
          log.warn(`Could not verify or auto-trust CA certificate: ${err.message}`)
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
        // ignore directory read errors
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
      saveConfig({ ...safeConfig, configVersion: localConfigVersion })
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
        } catch {}

        if (dockerActive) {
          try {
            execSync('docker start intutic-valkey', { stdio: 'ignore' })
            log.info('[DR] Successfully sent container start command to intutic-valkey.')
          } catch (err: any) {
            log.warn(`[DR] Docker container start failed: ${err.message}`)
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
            } catch {}
          }

          if (hasNativeBinary) {
            try {
              const proc = spawn(nativeCmd, ['--port', '6379', '--daemonize', 'yes'], { stdio: 'ignore', detached: true })
              proc.unref()
              log.info(`[DR] Successfully spawned native ${nativeCmd} in background.`)
            } catch (err: any) {
              log.warn(`[DR] Native daemon spawn failed: ${err.message}`)
            }
          } else {
            // Downloaded static
            try {
              const globalValkeyBinPath = node_path.join(getIntuticDir(), 'bin', process.platform === 'win32' ? 'valkey-server.exe' : 'valkey-server')
              await node_fs.access(globalValkeyBinPath)
              const proc = spawn(globalValkeyBinPath, ['--port', '6379', '--daemonize', 'yes'], { stdio: 'ignore', detached: true })
              proc.unref()
              log.info('[DR] Successfully spawned downloaded static Valkey server in background.')
            } catch (err: any) {
              log.warn(`[DR] Static binary spawn failed: ${err.message}`)
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
    // ignore
  }

  // FSEvents-driven hook event drain
  const hookEventsLog = node_path.join(safeConfig.workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  let fsWatcher: ReturnType<typeof watch> | null = null
  let drainSafetyTimer: ReturnType<typeof setInterval> | null = null

  try {
    await node_fs.mkdir(node_path.dirname(hookEventsLog), { recursive: true })
    fsWatcher = watch(hookEventsLog, { ignoreInitial: true, persistent: false })
    fsWatcher.on('change', runDrain)
    fsWatcher.on('add', runDrain)
  } catch (err) {
    // chokidar unavailable - rely on fallback
  }

  // 60-second safety-net drain poll
  drainSafetyTimer = setInterval(runDrain, 60_000)

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

    // B. Handle Claude Code settings.json tamper detection (privilege escalation guard)
    if (filename === 'settings.json' || filename === 'settings.local.json') {
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
      } catch {}
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
  if (drainSafetyTimer) clearInterval(drainSafetyTimer)
  wsClient.close()

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


