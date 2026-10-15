/**
 * `intutic tasks` — task-management connections (Jira Cloud, Linear,
 * PagerDuty) Intutic reads tickets and incidents through to attach task
 * context to sessions.
 *
 * Subcommands:
 *   - `intutic tasks list [--json]`
 *   - `intutic tasks add --provider <jira|linear|pagerduty> --base-url <url> --project-key <key> [--account-email <email>] (--token <token> | --token-file <path>) [--json]`
 *   - `intutic tasks test <connectionId> [--json]`
 *   - `intutic tasks remove <connectionId> [--json]`
 *
 * Server side: services/control-plane/src/routes/taskManagement.ts. Writes
 * need OWNER or ADMIN. The API token is read the way `intutic guardrails
 * sources add` reads its credential and is never echoed; the server tests it
 * with the provider before saving, encrypts it, and never returns it.
 *
 * @module
 */

import type { TaskConnectionDeleteResponse, TaskConnectionListResponse, TaskConnectionResponse, TaskConnectionTestResponse } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, readTokenFlag, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

const PROVIDERS = ['jira', 'linear', 'pagerduty'] as const
const BASE = '/api/v1/task-management/connections'

function printConnection(c: TaskConnectionResponse): void {
  log.field(c.connectionId, `${c.provider} — ${c.projectKey} at ${c.baseUrl}, ${c.status}${c.lastSyncAt ? `, last synced ${c.lastSyncAt}` : ''}`)
}

/** `intutic tasks list` */
export async function runTasksList(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list task connections',
    (client) => client.get<TaskConnectionListResponse>(BASE),
    (res) => {
      log.header('Intutic — Task Connections')
      if (res.items.length === 0) {
        log.dim('  No task connections. Add one with `intutic tasks add`.')
        return
      }
      for (const c of res.items) printConnection(c)
    },
  )
}

export interface TasksAddOpts extends ApiCommandOpts {
  provider?: string
  baseUrl?: string
  projectKey?: string
  accountEmail?: string
  token?: string
  tokenFile?: string
}

/** `intutic tasks add` */
export async function runTasksAdd(opts: TasksAddOpts): Promise<void> {
  const provider = opts.provider as (typeof PROVIDERS)[number]
  if (!PROVIDERS.includes(provider)) fail(`--provider must be one of ${PROVIDERS.join(', ')}.`)
  if (!opts.baseUrl) fail('--base-url is required.')
  if (!opts.projectKey) fail('--project-key is required.')
  // Jira Cloud signs an API token in as the account it belongs to.
  if (provider === 'jira' && !opts.accountEmail?.trim()) fail('A Jira connection needs --account-email: the Atlassian account the API token belongs to.')
  if (provider !== 'jira' && opts.accountEmail !== undefined) fail('--account-email applies only to a Jira connection.')
  const authToken = readTokenFlag(opts)
  await runApiCommand(
    opts,
    'Failed to add task connection',
    (client) =>
      client.post<TaskConnectionResponse>(BASE, {
        provider,
        baseUrl: opts.baseUrl,
        authToken,
        projectKey: opts.projectKey,
        ...(provider === 'jira' ? { metadata: { accountEmail: opts.accountEmail?.trim() } } : {}),
      }),
    (c) => log.success(`Connected ${c.provider} (${c.connectionId}) for ${c.projectKey}. Check it any time with \`intutic tasks test ${c.connectionId}\`.`),
  )
}

/** `intutic tasks test <connectionId>`: exits 1 when the provider no longer accepts the stored credentials. */
export async function runTasksTest(connectionId: string, opts: ApiCommandOpts): Promise<void> {
  let result: TaskConnectionTestResponse | undefined
  await runApiCommand(
    opts,
    `Failed to test task connection ${connectionId}`,
    async (client) => (result = await client.post<TaskConnectionTestResponse>(`${BASE}/${encodeURIComponent(connectionId)}/test`)),
    (res) => (res.success ? log.success(`${connectionId}: ${res.message}`) : log.error(`${connectionId}: ${res.message}`)),
  )
  if (result && !result.success) process.exit(1)
}

/** `intutic tasks remove <connectionId>`: exits 1 when the workspace has no such connection. */
export async function runTasksRemove(connectionId: string, opts: ApiCommandOpts): Promise<void> {
  let result: TaskConnectionDeleteResponse | undefined
  await runApiCommand(
    opts,
    `Failed to remove task connection ${connectionId}`,
    async (client) => (result = await client.del<TaskConnectionDeleteResponse>(`${BASE}/${encodeURIComponent(connectionId)}`)),
    (res) => (res.deleted ? log.success(`Removed task connection ${connectionId}.`) : log.error(`No task connection ${connectionId} in this workspace.`)),
  )
  if (result && !result.deleted) process.exit(1)
}
