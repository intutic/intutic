/**
 * `intutic org signup` — create a real org (tenancy phase 4, LLD #65),
 * distinct from `intutic login`/the default `intutic init` personal
 * signup: `orgName` is required, the org lands on a paid tier with a
 * 30-day trial (no free-tier fallback), and a default team + workspace
 * are created to start working in immediately.
 *
 * Server side: services/control-plane/src/routes/auth.ts's
 * `POST /api/v1/auth/signup/org`.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { saveCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { newIso } from '@intutic/id'
import { createInterface } from 'node:readline'

interface OrgSignupResponse {
  user: { id: string; email: string; name: string; emailVerified: boolean }
  org: { id: string; name: string; planTier: string; trialExpiresAt: string }
  workspace: { id: string; name: string; planTier: string; trialExpiresAt: string }
  accessToken: string
  refreshToken: string
  cliInstall: string
  isNewUser: boolean
}

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
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
        } else if (c === '') {
          process.exit(0)
        } else if (c === '') {
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

interface OrgSignupOpts {
  dev?: boolean
  email?: string
  password?: string
  name?: string
  orgName?: string
}

/** `intutic org signup` */
export async function runOrgSignup(opts: OrgSignupOpts): Promise<void> {
  log.header('Intutic — Org Signup')

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  log.dim(`Control plane: ${controlPlaneUrl}`)

  const email = opts.email ?? (await prompt('Email: '))
  const password = opts.password ?? (await prompt('Password (min 8 chars): ', true))
  const name = opts.name ?? (await prompt('Your name: '))
  const orgName = opts.orgName ?? (await prompt('Organization name: '))

  if (!email || !password || !name || !orgName) {
    log.error('Email, password, name, and organization name are all required.')
    process.exit(1)
  }
  if (password.length < 8) {
    log.error('Password must be at least 8 characters.')
    process.exit(1)
  }

  const client = createApiClient(controlPlaneUrl, '')

  try {
    const res = await client.post<OrgSignupResponse>('/api/v1/auth/signup/org', {
      email,
      password,
      name,
      orgName,
    })

    await saveCredentials({
      apiKey: res.accessToken,
      workspaceId: res.workspace.id,
      controlPlaneUrl,
      email: res.user.email,
      storedAt: newIso(),
    })

    log.success(`Org "${res.org.name}" created. Authenticated as ${res.user.email}.`)
    log.field('Org ID', res.org.id)
    log.field('Org plan', `${res.org.planTier} (trial until ${res.org.trialExpiresAt})`)
    log.field('Default workspace', res.workspace.id)
    log.dim(
      `  A default team and workspace were created for you. Run \`intutic team list --org ${res.org.id}\` ` +
        'to see them, or `intutic team create --org <org_id> --name <name>` to add another.',
    )
  } catch (err) {
    log.error(`Org signup failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
