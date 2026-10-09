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
import { createShutdownHandler, terminateChild } from '../lib/gracefulShutdown.js'
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
import { writeEnforcementState } from '../lib/enforcementState.js'
import { reportDeviceState } from '../lib/deviceReport.js'
import { reportMachineInventory, shouldReportInventoryThisIteration } from '../lib/inventory.js'
import { parseChecksums, verifyChecksum } from '../lib/binaryChecksum.js'
import { newIso } from '@intutic/id'
import { HarnessType, rulesFileOf } from '@intutic/shared-types'
import type { SopFileHash, SyncConfigPayload, SyncSopEntry } from '@intutic/shared-types'
import pc from 'picocolors'

import { SyncWsClient,
  startWatcher,
  updatePreToolUseHooks,
  injectMcpServer,
  noteProxyUrl,
  guardSettingsFile,
  isGuardedPath,
  warnIfDshCoverageGap,
  writeRuntimeEnv,
  refreshPolicySnapshot,
  refreshGateCaches,
  localHoldTokensFor,
  runComplianceProbes,
  drainHookEvents,
  drainReviewRequests,
  REVIEW_REQUESTS_LOG,
  syncOfflineTraces,
  TrajectoryMonitor,
  fetchLocalProxyInstanceId,
  endAllOpenSessions,
  applySkillOptEdits,
  reportHarnessAgents,
  captureAndUpload,
  shouldCaptureThisIteration,
  refreshDecisionsDigest,
  retireClaudeMdDigest,
  claudeCodeReadsAgentsMd,
  writeBundledSkills,
  clearImmutable,
  setImmutable,
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
import { localProxyPort } from '../lib/localProxy.js'

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
 * Applies a synced configuration to each configured harness.
 *
 * The gate is installed whatever rule sets the workspace has: it enforces the
 * built-in protections, the destructive-command tier, group rules and holds,
 * none of which need a rule set. Gating it on rule sets left a workspace with
 * none, or with none targeting a harness, with that harness ungoverned. The
 * rules file is written only when a rule set targets the harness, or on a
 * forced sync.
 *
 * Harnesses that read the same file (Codex, Grok Build, OpenCode, Muse Code
 * and others all read `AGENTS.md`) each get every rule set aimed at any of
 * them that is configured here: one section, the same for every writer, so
 * the last writer no longer replaces the others' rules.
 *
 * Claude Code reads its own `.claude/rules/` file at every launch, and also
 * the workspace's `AGENTS.md` when there is no `CLAUDE.md` on the path (or
 * the user chose `claude-md-and-agents-md`; see claudeAgentsMd.ts). When it
 * does, a rule set aimed at both Claude Code and an `AGENTS.md` reader
 * reaches it through `AGENTS.md`, so its own file leaves that rule set out
 * rather than load it twice.
 *
 * @returns how many rule sets were written into rules files.
 */
export async function writeHarnessConfigs(
  harnesses: readonly string[],
  workspaceRoot: string,
  sops: readonly SyncSopEntry[],
  proxyUrl: string,
  force: boolean,
): Promise<number> {
  let written = 0
  const writtenFiles = new Set<string>()
  const agentsMdReaders = harnesses.filter((h) => rulesFileOf(h as HarnessType) === 'AGENTS.md')
  const claudeFromAgentsMd =
    harnesses.includes(HarnessType.CLAUDE_CODE) && agentsMdReaders.length > 0 && (await claudeCodeReadsAgentsMd(workspaceRoot))
  for (const harnessType of harnesses) {
    const adapter = getAdapter(harnessType)
    if (!adapter) continue

    await adapter.installGate?.(workspaceRoot, proxyUrl)

    const file = rulesFileOf(harnessType as HarnessType)
    const readers = file === null ? [harnessType] : harnesses.filter((h) => rulesFileOf(h as HarnessType) === file)
    const aimed = sops.filter((sop) => sop.harnessTargets.some((t) => readers.includes(t)))
    const viaAgentsMd = harnessType === HarnessType.CLAUDE_CODE && claudeFromAgentsMd
    const targetSops = viaAgentsMd ? aimed.filter((sop) => !sop.harnessTargets.some((t) => agentsMdReaders.includes(t))) : aimed
    // Claude Code's own file is rewritten even when every rule set aimed at
    // it now comes through AGENTS.md, so it stops carrying them.
    if (aimed.length === 0 && !force) continue
    if (!(await adapter.writeConfig(workspaceRoot, targetSops, proxyUrl))) continue
    // A shared file counts once, however many of its readers wrote it.
    if (file === null || !writtenFiles.has(file)) written += targetSops.length
    if (file !== null) writtenFiles.add(file)
  }
  return written
}

/**
 * Asset names MUST match publish.yml's build-rust-proxy matrix
 * artifact_name — mirrors packages/proxy/bin/proxy.js's `resolveAssetName`
 * exactly (same five names, same live-release verification: `gh release
 * view` on v1.6.0 through the current release confirmed every one of
 * these). `platform`/`arch` are parameters, not read from `process`
 * directly, so connect.test.ts can exercise every combination without
 * stubbing global process state.
 */
export function resolveProxyAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'intutic-proxy-darwin-arm64'
    if (arch === 'x64') return 'intutic-proxy-darwin-x64'
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'intutic-proxy-linux-x64'
    if (arch === 'arm64') return 'intutic-proxy-linux-arm64'
  } else if (platform === 'win32') {
    if (arch === 'x64') return 'intutic-proxy-win32-x64.exe'
  }
  return null
}

async function downloadProxyBinary(destPath: string): Promise<string> {
  const platform = process.platform
  const arch = process.arch

  const assetName = resolveProxyAssetName(platform, arch)

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

  log.info('Verifying checksum...')
  const checksumsUrl = `https://github.com/intutic/intutic/releases/download/v${cliPkgVersion}/checksums.json`
  const checksumsResponse = await fetch(checksumsUrl)
  if (!checksumsResponse.ok) {
    throw new Error(
      `Failed to download checksums.json (HTTP ${checksumsResponse.status} ${checksumsResponse.statusText}).\n` +
        `  URL: ${checksumsUrl}\n` +
        `Refusing to install an unverified binary.`,
    )
  }
  const checksums = parseChecksums(await checksumsResponse.text())
  verifyChecksum(buffer, checksums, assetName)

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
  const credsFromFlags = Boolean(opts.workspaceId && opts.apiKey)
  if (opts.workspaceId && opts.apiKey) {
    creds = {
      workspaceId: opts.workspaceId,
      apiKey: opts.apiKey,
      email: 'daemon@intutic.ai',
      controlPlaneUrl: resolveControlPlaneUrl(opts.dev, { flagUrl: opts.controlPlaneUrl, useStored: false }),
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
  // Credentials given as flags were never saved, so the URL saved with some
  // other login does not apply to them.
  const controlPlaneUrl = resolveControlPlaneUrl(Boolean(devMode), {
    flagUrl: opts.controlPlaneUrl,
    useStored: !credsFromFlags,
  })
  const pollInterval = opts.interval ? parseInt(opts.interval, 10) : DEFAULT_POLL_INTERVAL
  const connectedSince = newIso()

  const client = createApiClient(controlPlaneUrl, safeCreds.apiKey)

  log.header('Intutic — Sync Daemon')
  log.field('Workspace', safeCreds.workspaceId)
  log.field('Control Plane', controlPlaneUrl)
  log.field('Poll Interval', `${pollInterval / 1000}s`)
  log.field('Harnesses', safeConfig.harnesses.join(', ') || '(none)')

  // Print onboarding setup instructions for active harnesses
  printOnboardingGuide(safeConfig.harnesses, safeCreds.apiKey)

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
  // TD-484: this handler used to abort the loop and hope. The process stayed
  // alive for hours. `createShutdownHandler` adds the exit deadline and the
  // second-signal exit; `terminateChild` escalates to SIGKILL.
  const shutdown = createShutdownHandler({
    onShutdown: () => {
      log.info('Shutting down sync daemon...')
      ac.abort()
      if (proxyProc) {
        log.info('Stopping managed proxy gateway...')
        terminateChild(proxyProc)
      }
      trajectoryMonitor?.stop()
      trajectorySubscriber?.disconnect()
    },
  })
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
  // The same port `budget`, `doctor`, `exec` and `start` use: INTUTIC_PROXY_URL's,
  // else 4000. The daemon-side probes (`fetchEgressStatus`, `fetchGuardProbes`,
  // `fetchLocalProxyInstanceId`) read INTUTIC_PROXY_URL too, so it is set for
  // them when the operator left it unset.
  const proxyPort = localProxyPort()
  if (!process.env.INTUTIC_PROXY_URL) process.env.INTUTIC_PROXY_URL = `http://127.0.0.1:${proxyPort}`
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
        // Explicit, so a PORT in the operator's shell cannot move the proxy
        // away from the port everything else probes.
        PORT: String(proxyPort),
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

  // The three gate-side caches every hook reads — the policy snapshot, the
  // approved review-hold bypasses and the central egress policy. Refreshed on
  // EVERY applySyncConfig (each poll and each pushed config_update), not only
  // when the config version moved: policy changes without the config version
  // changing, and a guardrail promoted, a hold approved or an egress mode
  // flipped mid-session used to reach a connected machine only on restart —
  // this function was called once, at startup (TD-488). None of these throw.
  //
  // The snapshot also carries this workspace's `review_before:` tokens as hold
  // rules (synced SOPs, settings and local `.intutic/sops`), so every gate —
  // not only the Claude Code hook — holds on them (TD-474 item 4).
  async function refreshGateCachesForConnect(): Promise<void> {
    const localHoldTokens = await localHoldTokensFor(
      safeConfig.workspaceRoot,
      lastCachedConfig?.sops ?? [],
      lastCachedConfig?.settings as unknown as Record<string, unknown> | undefined,
      safeConfig.harnesses as HarnessType[],
    )
    const landed = await refreshGateCaches({ controlPlaneUrl, apiKey: safeCreds.apiKey, workspaceId: safeCreds.workspaceId, localHoldTokens })
    if (!landed.snapshot) log.dim('Policy snapshot refresh failed (will retry next sync); built-in protections are unaffected.')
  }

  // The rules files the adapters write, absolute. `configFileName` is
  // relative to the workspace for most harnesses and absolute for the few
  // that keep their config in the home directory.
  const rulesFilePaths = (): string[] =>
    safeConfig.harnesses
      .map((h) => getAdapter(h)?.configFileName)
      .filter((f): f is string => Boolean(f))
      .map((f) => node_path.resolve(safeConfig.workspaceRoot, f))

  // Whether Claude Code read the workspace's AGENTS.md at the last sync. A
  // CLAUDE.md added or removed (or the user's Project instructions setting
  // changed) moves rule sets between AGENTS.md and Claude Code's own file, so
  // a change rewrites the rules files as a new config would.
  let lastClaudeFromAgentsMd: boolean | undefined

  // 3. Define configuration applier function
  async function applySyncConfig(syncConfig: SyncConfigPayload, force = false): Promise<number> {
    let sopsWritten = 0
    lastCachedConfig = syncConfig
    await refreshGateCachesForConnect()

    const claudeFromAgentsMd = safeConfig.harnesses.includes(HarnessType.CLAUDE_CODE)
      ? await claudeCodeReadsAgentsMd(safeConfig.workspaceRoot)
      : false
    const claudeDeliveryMoved = lastClaudeFromAgentsMd !== undefined && claudeFromAgentsMd !== lastClaudeFromAgentsMd
    lastClaudeFromAgentsMd = claudeFromAgentsMd

    // Write-protect (`bypassEnforcementTier: 'immutable'`, macOS): the rules
    // files carry the user-immutable flag between cycles, so it comes off
    // before anything below writes them and goes back on afterwards. It also
    // comes off whenever the config moved, so a workspace that switched away
    // from write-protect is not left with files nothing can rewrite.
    const writeProtect = syncConfig.settings?.bypassEnforcementTier === 'immutable'
    const configMoved = syncConfig.configVersion > localConfigVersion || force || claudeDeliveryMoved
    if (writeProtect || configMoved) {
      for (const file of rulesFilePaths()) await clearImmutable(file)
    }

    if (configMoved) {
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

      // a. Write configs for all active harnesses. The proxy URL is recorded
      // first: `intutic disconnect` recognises the base-URL settings it is
      // written into by it.
      await noteProxyUrl(syncConfig.proxyUrl)
      sopsWritten += await writeHarnessConfigs(
        safeConfig.harnesses,
        safeConfig.workspaceRoot,
        combinedSops,
        syncConfig.proxyUrl,
        force,
      )

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

      localConfigVersion = syncConfig.configVersion
      // Mirror workspace settings locally so spawn-time policies (like
      // allowLocalMemoryVaults) apply on the next connect without a fetch.
      safeConfig.settings = syncConfig.settings
      saveConfig({ ...safeConfig, configVersion: localConfigVersion, settings: syncConfig.settings })
    }

    // c. Inject + proxy-wrap MCP servers across all supported harnesses, on
    // every cycle rather than only when the config moved: a server a user adds
    // to a harness config after `connect` started is wrapped on the next cycle.
    // The writes are write-if-changed, so an unchanged config costs no write.
    try {
      await injectMcpServer(safeConfig.workspaceRoot, safeCreds.workspaceId, { skip: safeConfig.disconnectedHarnesses })
    } catch (err) {
      log.warn(`Failed to inject MCP server configs: ${err instanceof Error ? err.message : String(err)}`)
    }

    // d. SkillOpt edits the control plane queued for this workspace, acked
    // back so a suggestion reaches `applied` only once it is on disk. All of
    // them again when the rules files were just rewritten, which drops every
    // overlay. Before the integrity hashes below, so the drift watcher does
    // not take the edit for tampering.
    await applySkillOptEdits({
      workspaceRoot: safeConfig.workspaceRoot,
      controlPlaneUrl,
      apiKey: safeCreds.apiKey,
      appliedEdits: syncConfig.appliedEdits,
      bypassEnforcementTier: syncConfig.settings?.bypassEnforcementTier,
      reapplyAll: configMoved,
    })

    // e. The governed decisions log, opt-in (`decisionsLogEnabled`, off by
    // default), into each harness's instructions file. Also before the hashes:
    // it writes into shared files such as AGENTS.md, whose rules section they
    // cover. The section earlier versions put in CLAUDE.md comes out whether
    // or not the log is on.
    await retireClaudeMdDigest(safeConfig.workspaceRoot)
    if (syncConfig.settings?.decisionsLogEnabled) {
      await refreshDecisionsDigest({
        controlPlaneUrl,
        apiKey: safeCreds.apiKey,
        workspaceId: safeCreds.workspaceId,
        workspaceRoot: safeConfig.workspaceRoot,
        harnesses: safeConfig.harnesses as HarnessType[],
      })
    }

    if (writeProtect) {
      for (const file of rulesFilePaths()) await setImmutable(file)
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
        if (ac.signal.aborted) {
          // Shutting down: the proxy is gone because we stopped it. Re-spawning
          // it here would leave an orphan holding the port (TD-484).
          proxyStatus = 'stopped'
        } else if (proxyProc) {
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

    // g. Enforcement device visibility (post-strip gap #2, LLD #63
    // hardening) — the "interval" half of "continuous compliance": this
    // loop already runs unprivileged, as the real user, on a timer, and
    // already just computed sslTrustStatus above for its own DR-healing
    // purposes. Recording it as a user-scope CA-trust leg means every
    // `intutic connect` session reports SOMETHING even on a machine that
    // never ran `enforce apply` or `enterprise install` — best-effort,
    // never fails the sync loop over it.
    try {
      await writeEnforcementState(
        {
          caTrust: {
            installed: sslTrustStatus === 'trusted',
            scope: 'user',
            reportedAt: newIso(),
          },
        },
        cliPkgVersion,
      )
      const deviceReport = await reportDeviceState({ dev: devMode })
      if (!deviceReport.reported) {
        log.dim(`[sync] Device report not sent: ${deviceReport.reason}`)
      }
    } catch (err) {
      log.warn(`Failed to record/report device enforcement state: ${err instanceof Error ? err.message : String(err)}`)
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
        // Shared by the MCP proxies for their session window (Wave 5.3, TD-437) — only when it is running.
        valkeyUrl: valkeyResult.running ? valkeyUrl : undefined,
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

  // Drains BOTH logs.
  //
  // This drained hook events only. `intutic connect` runs the daemon in-process,
  // so under the CLI runtime a `review_before` hold still blocked the tool
  // locally and then sat in `.intutic/events/review-requests.jsonl` forever: the
  // developer was stopped, and the decision that was supposed to become a
  // learned rule never reached the control plane. The block working is what made
  // it invisible.
  const drainOnce = async () => {
    try {
      const drained = await drainHookEvents(safeConfig.workspaceRoot, controlPlaneUrl, safeCreds.apiKey)
      if (drained > 0) {
        log.info(`[sync-daemon] Drained ${drained} hook governance events to control plane`)
      }
    } catch (err) {
      log.warn(`[sync-daemon] Hook event drain error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
    // Separate try: the two go to different endpoints, and one being down says
    // nothing about the other.
    try {
      const held = await drainReviewRequests(safeConfig.workspaceRoot, controlPlaneUrl, safeCreds.apiKey)
      if (held > 0) {
        log.info(`[sync-daemon] Drained ${held} review hold(s) to control plane`)
      }
    } catch (err) {
      log.warn(`[sync-daemon] Review hold drain error (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Serialises drains, and coalesces the ones that arrive during one.
   *
   * `runDrain` is bound to `change` and `add` on **two** watched files and to a
   * 60-second timer, and each drain reads a log and then truncates it. Those are
   * separate awaits, so two overlapping runs both read the same lines before
   * either truncates and the same governance events are POSTed twice — a hook
   * incident counted once by the agent and twice by the control plane. A hook
   * writing to both `.intutic/events/` files in the same tick is enough on its
   * own, and that is the ordinary case: a held tool call writes the review
   * request and the event log together.
   *
   * The latch matters as much as the flag. Dropping an overlapping request
   * outright would lose the write that triggered it whenever it landed after
   * this pass had already read the file, so the drain would wait for the next
   * event or the 60s poll — the exact delay the watcher exists to remove.
   */
  let draining = false
  let drainRequestedAgain = false
  const runDrain = async () => {
    if (draining) {
      drainRequestedAgain = true
      return
    }
    draining = true
    try {
      do {
        drainRequestedAgain = false
        await drainOnce()
      } while (drainRequestedAgain)
    } finally {
      draining = false
    }
  }

  // Step 0: Write runtime env file (hook scripts source this for credentials)
  try {
    await writeRuntimeEnv({
      controlPlaneUrl,
      apiKey: safeCreds.apiKey,
      workspaceId: safeCreds.workspaceId,
      // Shared by the MCP proxies for their session window (Wave 5.3, TD-437) — only when it is running.
      valkeyUrl: valkeyResult.running ? valkeyUrl : undefined,
    })
  } catch (err) {
    log.warn(`Could not write runtime env file (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Seed the policy snapshot before the first sync cycle rather than after it.
  //
  // Without this, every fresh install runs its first poll interval with no
  // snapshot — the gates enforce the static floor and nothing else. Seeding here
  // narrows that window to "the fetch failed, and we said so" instead of "always,
  // briefly". `refreshPolicySnapshot` never throws. Every later refresh rides
  // `applySyncConfig` (see `refreshGateCaches`).
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
  await refreshGateCachesForConnect()

  // The bundled rule-author agent skill, written only when absent so a local
  // edit is never overwritten.
  try {
    await writeBundledSkills(safeConfig.workspaceRoot)
  } catch (err) {
    log.dim(`Could not write the bundled agent skill: ${err instanceof Error ? err.message : String(err)}`)
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

  // FSEvents-driven drain, watching BOTH logs.
  //
  // Watching only hook events meant a review hold waited for the 60s safety
  // timer at best — and, before `runDrain` learned to drain holds at all, never.
  const hookEventsLog = node_path.join(safeConfig.workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  const reviewHoldsLog = node_path.join(safeConfig.workspaceRoot, REVIEW_REQUESTS_LOG)
  let fsWatcher: ReturnType<typeof watch> | null = null

  try {
    await node_fs.mkdir(node_path.dirname(hookEventsLog), { recursive: true })
    fsWatcher = watch([hookEventsLog, reviewHoldsLog], { ignoreInitial: true, persistent: false })
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

  // dsh coverage-gap visibility (TD-370): once at startup, not every poll
  // tick — the gap only changes state on the user's first `dsh --profile
  // <name>` run, which the filesystem watcher below reacts to immediately
  // via settingsGuard.ts's isDshProfilesRoot `addDir` handling. Only worth
  // checking when dsh is actually a configured harness for this workspace.
  if (safeConfig.harnesses.includes('dsh' as HarnessType)) {
    try {
      await warnIfDshCoverageGap()
    } catch (err) {
      log.dim(`dsh coverage-gap check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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
    // Routed on the guard's own watch list. A filter on file names here, first
    // `settings.json` and later `settings.json`/`hooks.json`/`intutic-governance`,
    // kept the guard from ever seeing the paths it restores under other names:
    // a gate script, Cline's PreToolUse, OpenClaw's openclaw.json, Muse's
    // managed-hooks file and every dsh profile patch.
    if (isGuardedPath(changedPath, safeConfig.workspaceRoot)) {
      try {
        const sops = lastCachedConfig?.sops ?? []
        // The proxy URL too: the restored gate scripts carry it, and an empty
        // one would be written into them.
        const tampered = await guardSettingsFile(
          changedPath,
          safeConfig.workspaceRoot,
          sops,
          lastCachedConfig?.proxyUrl ?? '',
          undefined,
          new Set(safeConfig.disconnectedHarnesses ?? []),
        )
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

    // B. Handle governed harness file drift detection. By path, not
    // basename: rules files sit in directories (`.cursor/rules/…`).
    const matchingHarness = safeConfig.harnesses.find(
      (h) => getAdapter(h)?.configFileName === relativePath.split(node_path.sep).join('/')
    )
    if (!matchingHarness) return

    const adapter = getAdapter(matchingHarness)
    if (!adapter) return

    const currentHash = await adapter.readCurrentHash(safeConfig.workspaceRoot)
    const integrity = loadIntegrity(safeConfig.workspaceRoot)
    if (!integrity) return
    const canonical = integrity.files[adapter.configFileName] ?? ''

    if (currentHash !== canonical) {
      // Record only (`bypassEnforcementTier: 'alert-only'`): the edit stays,
      // and the drift report below is the record.
      const tier = (lastCachedConfig?.settings ?? safeConfig.settings)?.bypassEnforcementTier
      if (tier === 'alert-only') {
        log.warn(`Governed config file "${filename}" was edited by hand; recording the drift and leaving the edit in place.`)
        wsClient.send({
          type: 'drift_report',
          harnessType: adapter.type,
          filePath: adapter.configFileName,
          localHash: currentHash || '',
          canonicalHash: canonical,
        })
        return
      }

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
  let pollIteration = 0
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
      // Register agents + report one session per harness (the reporter
      // dedupes per run and per proxy process), and turn this cycle's skill
      // scan findings into `skill_flagged` events. The local proxy's instance
      // id is read once per iteration: with it the harness's git/task context
      // lands on the proxy's own session row, the one its traces are filed
      // under.
      const proxyInstanceId = safeConfig.harnesses.length > 0 ? await fetchLocalProxyInstanceId() : null
      const { governanceInputs, failures } = await reportHarnessAgents({
        controlPlaneUrl,
        apiKey: safeCreds.apiKey,
        workspaceId: safeCreds.workspaceId,
        workspaceRoot: safeConfig.workspaceRoot,
        harnesses: safeConfig.harnesses as HarnessType[],
        allowLocalVaults: syncConfig.settings?.allowLocalMemoryVaults,
        proxyInstanceId,
      })
      for (const { harness, error } of failures) {
        log.dim(`Agent report/session for harness '${harness}' failed: ${error}`)
      }
      // Every few minutes, the machine's AI inventory for the org-wide view:
      // every harness the detection rules find, connected or not, with its
      // gate state, and the MCP servers and skill bundles on the machine.
      if (shouldReportInventoryThisIteration(pollIteration)) {
        const inventory = await reportMachineInventory({
          controlPlaneUrl,
          apiKey: safeCreds.apiKey,
          workspaceRoot: safeConfig.workspaceRoot,
          configured: safeConfig.harnesses,
          disconnected: safeConfig.disconnectedHarnesses,
          cliVersion: cliPkgVersion,
        })
        if (!inventory.reported) log.dim(`AI inventory report not sent (will retry): ${inventory.reason}`)
      }
      // Every Nth poll, capture the rules files that changed for the config
      // history. Content goes only when this poll's settings have
      // `configBodyUpload` on; otherwise path, hash, size and time.
      if (shouldCaptureThisIteration(pollIteration)) {
        try {
          await captureAndUpload({
            controlPlaneUrl,
            apiKey: safeCreds.apiKey,
            workspaceId: safeCreds.workspaceId,
            workspaceRoot: safeConfig.workspaceRoot,
            harnesses: safeConfig.harnesses as HarnessType[],
            includeContent: syncConfig.settings?.configBodyUpload === true,
            governanceInputs,
          })
        } catch (err) {
          log.dim(`Config capture failed (will retry): ${err instanceof Error ? err.message : String(err)}`)
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
    pollIteration++

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


