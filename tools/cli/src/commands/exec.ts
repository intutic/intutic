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
import pc from 'picocolors'

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
): Record<string, string> {
  // The local proxy is the default, and for open core it is the only proxy
  // there is. This used to point at a remote host unless --dev was passed, so
  // `intutic exec` sent both the agent's traffic and OPENAI_API_KEY off the
  // machine -- to a host that does not resolve, so the command could not work
  // either. `intutic start` binds :4000; that is what these should reach.
  //
  // Set INTUTIC_PROXY_URL to point at a proxy you run somewhere else.
  const rawHost = (process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000').replace(/\/+$/, '')
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
 */
export async function runExec(commandAndArgs: string[]): Promise<void> {
  if (commandAndArgs.length === 0) {
    log.error('No command specified.')
    log.dim('Usage: intutic exec -- <command> [args...]')
    log.dim('Example: intutic exec -- claude')
    log.dim('Example: intutic exec -- aider --model openai/gpt-4o')
    log.dim('Example: intutic exec -- python my_agent.py')
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
