/**
 * `intutic github webhook` — the GitHub pull-request webhook that feeds cost
 * per pull request without a GitHub token.
 *
 * Subcommands:
 *   - `intutic github webhook show [--json]` — the payload URL and when the secret was made
 *   - `intutic github webhook rotate-secret [--json]` — make the webhook, or replace its secret; prints the secret once
 *
 * Server side: `GET /api/v1/integrations/github/webhook` and
 * `POST /api/v1/integrations/github/webhook/secret`, OWNER and ADMIN on a plan
 * with fleet analytics.
 *
 * @module
 */

import type { GitHubWebhookInfo, GitHubWebhookSecret } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { printSigningSecret, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

const STEPS =
  'In GitHub: Settings › Webhooks › Add webhook. Paste the payload URL, choose application/json, paste the secret, and select the "Pull requests" event only.'

/** `intutic github webhook show` */
export async function runGithubWebhookShow(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to read the GitHub webhook',
    (client) => client.get<GitHubWebhookInfo>('/api/v1/integrations/github/webhook'),
    (info) => {
      log.header('Intutic — GitHub pull-request webhook')
      if (!info.configured || !info.url) {
        log.dim('  Not set up. `intutic github webhook rotate-secret` makes it and prints its secret.')
        return
      }
      log.field('Payload URL', info.url)
      log.field('Secret made', info.secretRotatedAt ?? '—')
      log.field('Last delivery', info.lastDeliveryAt ?? 'never')
      log.dim(`  ${STEPS}`)
    },
  )
}

/** `intutic github webhook rotate-secret` */
export async function runGithubWebhookRotateSecret(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to make the GitHub webhook secret',
    (client) => client.post<GitHubWebhookSecret>('/api/v1/integrations/github/webhook/secret'),
    (made) => {
      log.success('GitHub webhook secret made; deliveries signed with any earlier secret are refused from now on.')
      log.field('Payload URL', made.url)
      printSigningSecret(made.secret)
      log.dim(`  ${STEPS}`)
    },
  )
}
