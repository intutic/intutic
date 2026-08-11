/**
 * `intutic exec` — Subprocess wrapper with proxy env var injection.
 *
 * Spawns a child process with all Intutic proxy environment variables
 * pre-injected, routing LLM traffic through the local governance proxy.
 *
 * Covers competing SDK env var conventions:
 * - OPENAI_API_BASE    (LiteLLM, LangChain, CrewAI, ADK, Aider)
 * - OPENAI_BASE_URL    (OpenAI Python SDK v1+, Pydantic-AI, Agent SDK)
 * - OPENAI_API_BASE_URL (OpenWebUI)
 * - OPENAI_HOST         (Goose)
 * - ANTHROPIC_BASE_URL  (Claude Code, Anthropic SDK — host only)
 * - ANTHROPIC_API_KEY   (Claude Code)
 * - OPENAI_API_KEY      (all OpenAI-compatible tools)
 * - INTUTIC_API_KEY     (Intutic-native tools)
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadCredentials, loadConfig } from '../config/store.js'
import type { IntuticCredentials } from '@intutic/shared-types'
import { getIntuticDir } from '../config/paths.js'
import {
  deriveIdentity,
  identityEnv,
  identityHeaders,
  identityPathPrefix,
  type GraphIdentity,
} from '../lib/graphIdentity.js'
import { log } from '../lib/logger.js'
import { selectBackend, type SandboxKind, type SandboxSpec } from '../lib/sandbox/index.js'
import pc from 'picocolors'

/** Workspace requirement for whether agents must run sandboxed (LLD #63 §6). */
export type SandboxRequirement = 'off' | 'warn' | 'require'

/**
 * Resolve this workspace's sandbox requirement, resiliently. A best-effort
 * control-plane fetch (short timeout) refreshes a local cache; if the control
 * plane is unreachable we fall back to the cache, and if there is none we
 * default to `off`. This keeps an offline developer working and keeps open core
 * — which has no control plane to read this from — entirely unaffected.
 *
 * This is a client-side, advisory layer (a determined user can bypass by not
 * using `intutic exec` at all); server-side attestation is the stronger
 * follow-on. So failing open toward `off` on an unreachable, never-cached
 * control plane is the honest behaviour for what this layer is.
 */
export async function resolveSandboxRequirement(
  creds: IntuticCredentials,
): Promise<SandboxRequirement> {
  const cachePath = path.join(getIntuticDir(), 'exec-policy.json')
  const coerce = (v: unknown): SandboxRequirement =>
    v === 'warn' || v === 'require' ? v : 'off'

  const base = trimTrailingSlashes(creds.controlPlaneUrl ?? 'https://api.intutic.ai')
  try {
    const res = await fetch(`${base}/api/v1/workspace/settings`, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'x-workspace-id': creds.workspaceId ?? '',
      },
      signal: AbortSignal.timeout(2500),
    })
    if (res.ok) {
      const body = (await res.json()) as { settings?: { sandboxRequirement?: unknown } }
      const val = coerce(body?.settings?.sandboxRequirement)
      try {
        await fs.writeFile(cachePath, JSON.stringify({ sandboxRequirement: val, cachedAt: new Date().toISOString() }))
      } catch {
        /* cache write is best-effort */
      }
      return val
    }
  } catch {
    /* fall through to the cache */
  }

  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as { sandboxRequirement?: unknown }
    return coerce(cached?.sandboxRequirement)
  } catch {
    return 'off'
  }
}

/** The hostname a container reaches the host (and so the proxy) at. */
const PROXY_HOST_ALIAS = 'host.docker.internal'

/** Options for a sandboxed `intutic exec`. */
export interface SandboxExecOptions {
  kind: SandboxKind
  image: string
  memory: string
  cpus: string
  pidsLimit: number
  /** Extra destination CIDRs the sandbox may reach beyond the proxy + DNS. */
  allow: string[]
}

/** The proxy port the host listens on, from INTUTIC_PROXY_URL (default 4000). */
export function proxyPortFromEnv(): string {
  const raw = process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000'
  try {
    return new URL(raw).port || '4000'
  } catch {
    return '4000'
  }
}

/**
 * Trims trailing `/` characters without a regex.
 *
 * `INTUTIC_PROXY_URL` is a local environment variable, not remotely
 * attacker-controlled — but CodeQL's static analysis flags `/\/+$/` as a
 * polynomial-time pattern on external input regardless, and a loop is O(n)
 * and cannot be mis-classified as a ReDoS shape by any static analyzer.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/**
 * Build the proxy environment variables for a child process.
 *
 * @param apiKey   - Intutic API key (intk_...)
 * @param devMode  - retained for call-site compatibility; the proxy is always local
 * @returns Record of env vars to inject
 */
export function buildProxyEnv(
  apiKey: string,
  devMode: boolean,
  identity?: GraphIdentity,
  proxyUrlOverride?: string,
): Record<string, string> {
  // The local proxy is the default, and for open core it is the only proxy
  // there is. This used to point at a remote host unless --dev was passed, so
  // `intutic exec` sent both the agent's traffic and OPENAI_API_KEY off the
  // machine -- to a host that does not resolve, so the command could not work
  // either. `intutic start` binds :4000; that is what these should reach.
  //
  // Set INTUTIC_PROXY_URL to point at a proxy you run somewhere else. A sandbox
  // launch overrides it with the host-gateway alias, because inside the sandbox
  // `localhost` is the sandbox, not the host the proxy runs on.
  const rawHost = trimTrailingSlashes(
    proxyUrlOverride ?? process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000',
  )
  void devMode

  // Graph identity rides in the base URL. Harnesses append their own path to
  // whatever host they are given, so a prefix here reaches the proxy from every
  // one of them — including the many that offer no way to set a header. The
  // proxy strips it before routing, so upstream sees the path the harness meant.
  const proxyHost = identity ? `${rawHost}${identityPathPrefix(identity)}` : rawHost
  const proxyUrl = `${proxyHost}/v1`

  const env: Record<string, string> = {
    // OpenAI-compatible (covers LiteLLM, LangChain, CrewAI, ADK, Aider)
    OPENAI_API_BASE: proxyUrl,
    // OpenAI SDK v1+ (covers Python SDK, Pydantic-AI, Agent SDK)
    OPENAI_BASE_URL: proxyUrl,
    // OpenWebUI (uses its own unique env var name)
    OPENAI_API_BASE_URL: proxyUrl,
    // Goose (uses OPENAI_HOST, not OPENAI_API_BASE)
    OPENAI_HOST: proxyHost,
    // All OpenAI-compatible API keys
    OPENAI_API_KEY: apiKey,
    // Anthropic SDK / Claude Code (host only — appends /v1/messages itself)
    ANTHROPIC_BASE_URL: proxyHost,
    ANTHROPIC_API_KEY: apiKey,
    // Intutic-native
    INTUTIC_API_KEY: apiKey,
  }

  if (identity) {
    // Passed down so a nested `intutic exec` — an agent spawning an agent —
    // derives itself as this node's child without anything tracking the graph
    // centrally.
    Object.assign(env, identityEnv(identity))

    // Claude Code is the one harness that can send arbitrary headers, and the
    // proxy prefers headers over the path. Anything already configured is kept:
    // clobbering a user's own headers to add telemetry would be a poor trade.
    const existing = process.env.ANTHROPIC_CUSTOM_HEADERS
    const ours = Object.entries(identityHeaders(identity))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    env.ANTHROPIC_CUSTOM_HEADERS = existing ? `${existing}\n${ours}` : ours
  }

  return env
}

/**
 * Execute a command with Intutic proxy environment variables injected.
 *
 * @param commandAndArgs - Array of command + arguments (e.g. ['claude'] or ['python', 'main.py'])
 * @param sandbox - when set, run the command inside an isolated runtime whose
 *   only egress is the proxy (LLD #63 §6) instead of directly on the host.
 */
export async function runExec(
  commandAndArgs: string[],
  sandbox?: SandboxExecOptions,
): Promise<void> {
  if (commandAndArgs.length === 0) {
    log.error('No command specified.')
    log.dim('Usage: intutic exec -- <command> [args...]')
    log.dim('Example: intutic exec -- claude')
    log.dim('Example: intutic exec -- aider --model openai/gpt-4o')
    log.dim('Example: intutic exec --sandbox -- python my_agent.py')
    process.exit(1)
  }

  // Load credentials
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. This command needs an Intutic control plane, which open core does not include. To run the proxy without one: `intutic start`.')
    process.exit(1)
  }

  // Load config for dev mode
  const config = loadConfig()
  const devMode = config?.devMode ?? process.env.INTUTIC_DEV === '1'

  // Build env. A nested `intutic exec` inherits identity from its parent and
  // becomes a child node; a top-level one starts a new graph.
  const identity = deriveIdentity()

  if (sandbox) {
    await runSandboxed(commandAndArgs, creds, devMode, identity, sandbox)
    return
  }

  // Not sandboxed — honour the workspace's sandbox requirement (LLD #63 §6).
  const requirement = await resolveSandboxRequirement(creds)
  if (requirement === 'require') {
    log.error('This workspace requires agents to run inside a sandbox.')
    log.dim(`Re-run with the sandbox:  intutic exec --sandbox -- ${commandAndArgs.join(' ')}`)
    process.exit(1)
  }
  if (requirement === 'warn') {
    log.warn('This workspace recommends running agents in a sandbox — add --sandbox.')
  }

  const proxyEnv = buildProxyEnv(creds.apiKey, devMode, identity)
  const childEnv = { ...process.env, ...proxyEnv }

  const [exe, ...args] = commandAndArgs

  // Print info
  log.info(`Launching: ${pc.bold(exe)} ${args.join(' ')}`)
  log.dim(`Proxy: ${proxyEnv.OPENAI_API_BASE}`)
  log.dim(`API Key: ${creds.apiKey.slice(0, 8)}...${creds.apiKey.slice(-4)}`)
  log.dim(
    identity.depth === 0
      ? `Graph: ${identity.graphId} (root)`
      : `Graph: ${identity.graphId} · node ${identity.nodeId} · depth ${identity.depth}`,
  )
  console.log('')

  // Spawn the child process with inherited stdio (full interactivity)
  const child = spawn(exe, args, {
    stdio: 'inherit',
    env: childEnv,
    shell: process.platform === 'win32', // Use shell on Windows for PATH resolution
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      log.error(`Command not found: ${exe}`)
      log.dim('Make sure the command is installed and in your PATH.')
    } else {
      log.error(`Failed to start: ${err.message}`)
    }
    process.exit(127)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 0)
    }
  })
}

/**
 * Run the agent inside an isolated sandbox whose only egress is the proxy.
 *
 * Inside the sandbox `localhost` is the sandbox, not the host — so the proxy
 * env is rebuilt against the host-gateway alias, and the sandbox's egress
 * firewall is opened to exactly that address plus DNS (and any `--sandbox-allow`
 * CIDRs). Secrets are passed by env-var *name*, so they never appear in the
 * container runtime's argv.
 */
async function runSandboxed(
  commandAndArgs: string[],
  creds: IntuticCredentials,
  devMode: boolean,
  identity: GraphIdentity,
  opts: SandboxExecOptions,
): Promise<void> {
  const port = proxyPortFromEnv()
  const proxyUrlOverride = `http://${PROXY_HOST_ALIAS}:${port}`
  const proxyEnv = buildProxyEnv(creds.apiKey, devMode, identity, proxyUrlOverride)

  // The values the runtime will read for the `--env NAME` references.
  const env: Record<string, string> = {
    ...proxyEnv,
    INTUTIC_SANDBOX_PROXY_HOST: PROXY_HOST_ALIAS,
    ...(opts.allow.length ? { INTUTIC_SANDBOX_ALLOW: opts.allow.join(',') } : {}),
  }

  const spec: SandboxSpec = {
    command: commandAndArgs,
    workdir: process.cwd(),
    image: opts.image,
    envKeys: Object.keys(env),
    proxyHostAlias: PROXY_HOST_ALIAS,
    allowCidrs: opts.allow,
    memory: opts.memory,
    cpus: opts.cpus,
    pidsLimit: opts.pidsLimit,
    tty: Boolean(process.stdout.isTTY),
  }

  let backend
  try {
    backend = selectBackend(opts.kind, env)
  } catch (err) {
    log.error(`Sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const health = await backend.health()
  if (!health.available) {
    // Honesty rule (LLD #63 §6): never silently fall back to running the agent
    // ungoverned on the host — say what is unavailable and stop.
    log.error(`Sandbox backend '${backend.name}' is not available: ${health.detail}`)
    log.dim('Start Docker (or Podman), or drop --sandbox to run on the host.')
    process.exit(1)
  }

  log.info(`Sandbox: ${backend.name} · image ${opts.image} · egress locked to the proxy`)
  log.dim(`Proxy (from sandbox): ${proxyUrlOverride}`)
  const [exe, ...rest] = commandAndArgs
  log.info(`Launching in sandbox: ${pc.bold(exe)} ${rest.join(' ')}`)
  console.log('')

  // Best-effort telemetry: a SANDBOX-mode session makes "how many runs were
  // sandboxed" answerable (agent_sessions.executionMode already exists as a
  // column with no other writer for this case — reusing it needs no schema
  // change). Never blocks or fails the run: an unreachable control plane costs
  // a debug log line, not a broken `intutic exec --sandbox`.
  const sessionId = await openSandboxSession(creds, identity, backend.name)

  const code = await backend.run(spec)

  if (sessionId) await closeSandboxSession(creds, sessionId)
  process.exit(code)
}

/** Opens a SANDBOX-mode session for telemetry. Returns null on any failure. */
export async function openSandboxSession(
  creds: IntuticCredentials,
  identity: GraphIdentity,
  backendName: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${trimTrailingSlashes(creds.controlPlaneUrl)}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        workspaceId: creds.workspaceId,
        harnessType: 'sandbox',
        executionMode: 'SANDBOX',
        envTaskContext: `sandbox-backend:${backendName};graph:${identity.graphId}`,
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { sessionId?: string }
    return body.sessionId ?? null
  } catch {
    return null
  }
}

/** Ends a session opened by openSandboxSession. Best-effort. */
export async function closeSandboxSession(creds: IntuticCredentials, sessionId: string): Promise<void> {
  try {
    await fetch(
      `${trimTrailingSlashes(creds.controlPlaneUrl)}/api/v1/sessions/${sessionId}/end`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      },
    )
  } catch {
    /* best-effort */
  }
}
