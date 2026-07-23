/**
 * `intutic login` — Authenticate with the control plane.
 *
 * Supports API key (--api-key vk_...) or email+password.
 * Stores credentials at ~/.intutic/credentials.json (mode 0o600).
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { log } from '../lib/logger.js'
import { saveCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { newIso } from '@intutic/id'
import { createInterface } from 'node:readline'

/**
 * Simple readline prompt (no external deps).
 * For password input, uses muted output.
 */
async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      // Mute output for password entry
      process.stdout.write(question)
      let input = ''
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on('data', (char) => {
        const c = char.toString()
        if (c === '\n' || c === '\r') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          console.log('')
          rl.close()
          resolve(input)
        } else if (c === '\u0003') {
          // Ctrl+C
          process.exit(0)
        } else if (c === '\u007f') {
          // Backspace
          input = input.slice(0, -1)
        } else {
          input += c
          process.stdout.write('*')
        }
      })
    } else {
      rl.question(question, (answer) => {
        rl.close()
        resolve(answer)
      })
    }
  })
}

export async function runLogin(opts: { apiKey?: string; dev?: boolean }): Promise<void> {
  log.header('Intutic — Authentication')

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  log.dim(`Control plane: ${controlPlaneUrl}`)

  if (opts.apiKey) {
    // API key flow
    if (!opts.apiKey.startsWith('vk_')) {
      log.error('API key must start with "vk_"')
      process.exit(1)
    }

    log.info('Validating API key...')
    const client = createApiClient(controlPlaneUrl, opts.apiKey)

    try {
      const me = await client.getMe()
      await saveCredentials({
        apiKey: opts.apiKey,
        workspaceId: me.workspaceId,
        controlPlaneUrl,
        email: me.email,
        storedAt: newIso(),
      })
      log.success(`Authenticated as ${me.email}`)
      log.field('Workspace', me.workspaceId)
      log.field('Role', me.role)
    } catch (err) {
      log.error(`API key validation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } else {
    // Email + password flow
    const email = await prompt('Email: ')
    const password = await prompt('Password: ', true)

    if (!email || !password) {
      log.error('Email and password are required.')
      process.exit(1)
    }

    log.info('Authenticating...')
    const client = createApiClient(controlPlaneUrl, '') // No token yet

    try {
      const result = await client.login(email, password)
      await saveCredentials({
        apiKey: result.accessToken,
        workspaceId: result.workspaceId,
        controlPlaneUrl,
        email: result.email,
        storedAt: newIso(),
      })
      log.success(`Authenticated as ${result.email}`)
      log.field('Workspace', result.workspaceId)
    } catch (err) {
      log.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
}
