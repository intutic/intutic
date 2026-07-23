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
import { log } from '../lib/logger.js'
import pc from 'picocolors'

/**
 * Build the proxy environment variables for a child process.
 *
 * @param apiKey   - Intutic API key (intk_...)
 * @param devMode  - If true, use localhost:4000; otherwise use remote proxy
 * @returns Record of env vars to inject
 */
export function buildProxyEnv(apiKey: string, devMode: boolean): Record<string, string> {
  const proxyUrl = devMode
    ? 'http://localhost:4000/v1'
    : 'https://proxy.intutic.ai/v1'

  // Host-only URL (no /v1) — used by Claude Code and Goose
  const proxyHost = devMode
    ? 'http://localhost:4000'
    : 'https://proxy.intutic.ai'

  return {
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
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }

  // Load config for dev mode
  const config = loadConfig()
  const devMode = config?.devMode ?? process.env.INTUTIC_DEV === '1'

  // Build env
  const proxyEnv = buildProxyEnv(creds.apiKey, devMode)
  const childEnv = { ...process.env, ...proxyEnv }

  const [exe, ...args] = commandAndArgs

  // Print info
  log.info(`Launching: ${pc.bold(exe)} ${args.join(' ')}`)
  log.dim(`Proxy: ${proxyEnv.OPENAI_API_BASE}`)
  log.dim(`API Key: ${creds.apiKey.slice(0, 8)}...${creds.apiKey.slice(-4)}`)
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
