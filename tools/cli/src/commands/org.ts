/**
 * `intutic org create` — create a real org from an already-authenticated
 * session (tenancy phase 4/7, LLD #65).
 *
 * Real org creation now requires DNS domain-ownership verification (LLD #71
 * follow-up): creating an org auto-provisions a real managed gateway cell,
 * so an org's claimed domain must be proven before `POST /api/v1/orgs` will
 * create it. There's no anonymous-compatible verification flow (no session
 * exists yet to own a verification attempt against), so the old anonymous
 * `POST /api/v1/auth/signup/org` this command used to call is now closed by
 * default in production (`INTUTIC_PUBLIC_ORG_SIGNUP`, off unless a
 * deployment has built its own anonymous verification story) — this command
 * requires `intutic login` first and drives the same flow the dashboard's
 * "Create Organization" modal does: start verification, publish the TXT
 * record it's given, confirm it resolves, then create the org.
 *
 * Server side: services/control-plane/src/services/domainVerificationService.ts,
 * services/control-plane/src/routes/orgs.ts.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials, saveCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { newIso } from '@intutic/id'
import { createInterface } from 'node:readline'

const NOT_AUTHENTICATED = 'Not authenticated. Run `intutic login` first.'

interface StartVerificationResponse {
  verificationId: string
  domain: string
  txtRecordName: string
  txtRecordValue: string
  expiresAt: string
}

interface CheckVerificationResponse {
  verificationId: string
  domain: string
  status: 'pending' | 'verified' | 'consumed' | 'expired'
  txtRecordName: string
  txtRecordValue: string
  verifiedAt: string | null
}

interface CreateOrgResponse {
  orgId: string
  teamId: string
  workspaceId: string
  name: string
  planTier: string
  region?: string
}

interface SessionSwitchResponse {
  memberId: string
  workspaceId: string
  email: string
  role: string
  refreshToken: string
}

interface RefreshResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

interface OrgCreateOpts {
  dev?: boolean
  domain?: string
  orgName?: string
  region?: string
}

/**
 * Switches the CLI's stored session to a newly created org's default
 * workspace. `GET /api/v1/auth/session?X-Workspace-Id` mints a new
 * refresh token scoped to the target workspace but returns its paired
 * access token only via an httpOnly cookie (browser-only) — this exchanges
 * that refresh token for a JSON-returned access token via the normal
 * refresh endpoint, the same two-step dance a browser reload does
 * implicitly through its cookie jar.
 */
async function switchStoredSessionToWorkspace(
  controlPlaneUrl: string,
  apiKey: string,
  targetWorkspaceId: string,
): Promise<SessionSwitchResponse & { accessToken: string }> {
  const sessionRes = await fetch(`${controlPlaneUrl}/api/v1/auth/session`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'X-Workspace-Id': targetWorkspaceId,
    },
  })
  if (!sessionRes.ok) {
    const body = await sessionRes.json().catch(() => ({}))
    throw new Error(body.error || `Failed to switch to the new workspace (HTTP ${sessionRes.status})`)
  }
  const session = (await sessionRes.json()) as SessionSwitchResponse

  const refreshRes = await fetch(`${controlPlaneUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  if (!refreshRes.ok) {
    const body = await refreshRes.json().catch(() => ({}))
    throw new Error(body.error || `Failed to mint a token for the new workspace (HTTP ${refreshRes.status})`)
  }
  const refreshed = (await refreshRes.json()) as RefreshResponse

  return { ...session, accessToken: refreshed.accessToken }
}

/** `intutic org create` */
export async function runOrgCreate(opts: OrgCreateOpts): Promise<void> {
  log.header('Intutic — Create Organization')

  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  log.dim(`Control plane: ${controlPlaneUrl}`)

  const orgName = opts.orgName ?? (await prompt('Organization name: '))
  const domain = opts.domain ?? (await prompt('Domain (e.g. acme.com): '))

  if (!orgName.trim() || !domain.trim()) {
    log.error('Organization name and domain are both required.')
    process.exit(1)
  }

  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  let verification: StartVerificationResponse
  try {
    verification = await client.post<StartVerificationResponse>('/api/v1/domain-verification/start', {
      domain: domain.trim(),
    })
  } catch (err) {
    log.error(`Failed to start domain verification: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  log.success('Verification started. Add this DNS TXT record to prove you own the domain:')
  log.field('Record name', verification.txtRecordName)
  log.field('Record value', verification.txtRecordValue)
  log.dim('  DNS changes can take a few minutes to propagate.')

  let checked: CheckVerificationResponse
  while (true) {
    const answer = await prompt('\nPress Enter to check DNS now (or type "q" to abort): ')
    if (answer.trim().toLowerCase() === 'q') {
      log.warn('Aborted. Nothing was created.')
      process.exit(1)
    }

    try {
      checked = await client.get<CheckVerificationResponse>(`/api/v1/domain-verification/${verification.verificationId}`)
    } catch (err) {
      log.error(`Failed to check verification status: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    if (checked.status === 'verified') {
      log.success('Domain verified.')
      break
    }
    if (checked.status === 'expired') {
      log.error('This verification has expired. Run this command again to start a new one.')
      process.exit(1)
    }
    log.warn('TXT record not seen yet — still pending.')
  }

  try {
    const org = await client.post<CreateOrgResponse>('/api/v1/orgs', {
      orgName: orgName.trim(),
      domain: checked.domain,
      verificationId: verification.verificationId,
      // Omitted entirely when not passed -- the server defaults to its home
      // region and validates against its configured cell regions.
      ...(opts.region ? { region: opts.region.trim().toLowerCase() } : {}),
    })

    log.success(`Org "${org.name}" created.`)
    log.field('Org ID', org.orgId)
    log.field('Org plan', org.planTier)
    if (org.region) log.field('Gateway region', org.region)
    log.field('Default workspace', org.workspaceId)

    const switched = await switchStoredSessionToWorkspace(controlPlaneUrl, creds.apiKey, org.workspaceId)
    await saveCredentials({
      apiKey: switched.accessToken,
      workspaceId: switched.workspaceId,
      controlPlaneUrl,
      email: switched.email,
      storedAt: newIso(),
    })
    log.dim(
      `  Switched your CLI session into the new org's default workspace. Run \`intutic team list --org ${org.orgId}\` ` +
        'to see it, or `intutic team create --org <org_id> --name <name>` to add another team.',
    )
  } catch (err) {
    log.error(`Org creation failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
