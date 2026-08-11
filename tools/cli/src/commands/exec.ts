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
import { loadCredentials, loadConfig } from '../config/store.js'
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
    await runSandboxed(commandAndArgs, creds.apiKey, devMode, identity, sandbox)
    return
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
  apiKey: string,
  devMode: boolean,
  identity: GraphIdentity,
  opts: SandboxExecOptions,
): Promise<void> {
  const port = proxyPortFromEnv()
  const proxyUrlOverride = `http://${PROXY_HOST_ALIAS}:${port}`
  const proxyEnv = buildProxyEnv(apiKey, devMode, identity, proxyUrlOverride)

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

  const code = await backend.run(spec)
  process.exit(code)
}
