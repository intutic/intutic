/**
 * `intutic team` — manage teams and workspaces under an org (tenancy
 * phase 5, LLD #65).
 *
 * Subcommands:
 *   - `intutic team list --org <org_id> [--json]`
 *   - `intutic team create --org <org_id> --name <name>`
 *   - `intutic team workspaces <team_id> [--json]`
 *   - `intutic team create-workspace <team_id> --name <name>`
 *
 * Server side: services/control-plane/src/routes/teams.ts. Authorization
 * has no org-level session to check — any member holding OWNER/ADMIN on
 * any active workspace under the org counts as an org admin
 * (`hasOrgAdminAccess`), matching the RBAC decision recorded in LLD #65.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'

const NOT_AUTHENTICATED = 'Not authenticated. Run `intutic login` first.'

interface TeamCliOpts {
  json?: boolean
  dev?: boolean
}

interface TeamRow {
  teamId: string
  orgId: string
  name: string
  slug: string
  createdAt: string
}

interface WorkspaceRow {
  workspaceId: string
  name: string
  slug: string
  planTier: string
  createdAt: string
}

async function getClient(opts: TeamCliOpts) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

/** `intutic team list --org <org_id>` */
export async function runTeamList(opts: TeamCliOpts & { org?: string }): Promise<void> {
  if (!opts.org) {
    log.error('--org <org_id> is required')
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.get<{ data: TeamRow[] }>(
      `/api/v1/orgs/${encodeURIComponent(opts.org)}/teams`,
    )
    const rows = res.data ?? []

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Teams')
    if (rows.length === 0) {
      log.dim('  No teams found.')
      return
    }
    for (const t of rows) {
      console.log('')
      log.field('Team ID', t.teamId)
      log.field('Name', t.name)
      log.field('Slug', t.slug)
      log.field('Created', t.createdAt)
    }
  } catch (err) {
    log.error(`Failed to list teams: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic team create --org <org_id> --name <name>` */
export async function runTeamCreate(
  opts: TeamCliOpts & { org?: string; name?: string },
): Promise<void> {
  if (!opts.org) {
    log.error('--org <org_id> is required')
    process.exit(1)
  }
  if (!opts.name || !opts.name.trim()) {
    log.error('--name is required')
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.post<{ teamId: string; orgId: string; name: string }>(
      `/api/v1/orgs/${encodeURIComponent(opts.org)}/teams`,
      { name: opts.name.trim() },
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.success(`Team "${res.name}" created.`)
    log.field('Team ID', res.teamId)
  } catch (err) {
    log.error(`Failed to create team: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic team workspaces <team_id>` */
export async function runTeamWorkspaces(teamId: string, opts: TeamCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.get<{ data: WorkspaceRow[] }>(
      `/api/v1/teams/${encodeURIComponent(teamId)}/workspaces`,
    )
    const rows = res.data ?? []

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Team Workspaces')
    if (rows.length === 0) {
      log.dim('  No workspaces found under this team.')
      return
    }
    for (const w of rows) {
      console.log('')
      log.field('Workspace ID', w.workspaceId)
      log.field('Name', w.name)
      log.field('Plan', w.planTier)
      log.field('Created', w.createdAt)
    }
  } catch (err) {
    log.error(`Failed to list team workspaces: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic team create-workspace <team_id> --name <name>` */
export async function runTeamCreateWorkspace(
  teamId: string,
  opts: TeamCliOpts & { name?: string },
): Promise<void> {
  if (!opts.name || !opts.name.trim()) {
    log.error('--name is required')
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.post<{ workspaceId: string; teamId: string; orgId: string; name: string }>(
      `/api/v1/teams/${encodeURIComponent(teamId)}/workspaces`,
      { name: opts.name.trim() },
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.success(`Workspace "${res.name}" created under team ${res.teamId}.`)
    log.field('Workspace ID', res.workspaceId)
    log.dim(
      '  You were added as OWNER of this workspace. Use `intutic login` again to switch to it ' +
        'if your session is still on a different workspace.',
    )
  } catch (err) {
    log.error(`Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
