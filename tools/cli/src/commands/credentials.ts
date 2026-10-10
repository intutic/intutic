/**
 * `intutic credentials` — provision a workspace's own upstream provider
 * keys (LLD #64 §4 Enforced BYO-key, LLD #67 multi-provider wizard).
 *
 * Subcommands:
 *   - `intutic credentials list [--json]`
 *   - `intutic credentials set <provider> --field key=value [--field-file key=path ...]`
 *   - `intutic credentials unset <provider>`
 *   - `intutic credentials models <provider> [--json]`
 *
 * Server side: services/control-plane/src/routes/providerCredentials.ts.
 * `list` reports every provider in the shared registry
 * (@intutic/shared-types PROVIDER_REGISTRY), including ones the proxy does
 * not route to yet (`routingLive: false`) — this command surfaces that
 * distinction rather than implying every listed provider is live.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import { readFileSync } from 'node:fs'
import { PROVIDER_REGISTRY, checkCloudCredentialFields, getProviderDefinition } from '@intutic/shared-types'
import pc from 'picocolors'

const NOT_AUTHENTICATED = 'Not authenticated. Run `intutic login` first.'

interface CredentialsCliOpts {
  json?: boolean
  dev?: boolean
}

/** POST /api/v1/workspace/provider-credentials/:provider/verify */
interface VerifyResult {
  status: 'valid' | 'invalid' | 'unknown' | 'unsupported' | 'not_provisioned'
  httpStatus?: number
  detail: string
  /** The model ids the provider listed for this key; only on `valid`, and only for providers with a list-models probe. */
  models?: string[]
}

/** GET /api/v1/workspace/provider-credentials/:provider/models */
interface ProviderModelList {
  provider: string
  models: string[] | null
  checkedAt: string | null
}

interface CredentialStatusRow {
  provider: string
  routingLive: boolean
  provisioned: boolean
  lastFour: string | null
  updatedAt: string | null
}

function requireProvider(provider: string) {
  const def = getProviderDefinition(provider)
  if (!def) {
    log.error(`Unknown provider "${provider}". Must be one of: ${PROVIDER_REGISTRY.map((p) => p.id).join(', ')}`)
    process.exit(1)
  }
  return def
}

async function getClient(opts: CredentialsCliOpts) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

/** `intutic credentials list` */
export async function runCredentialsList(opts: CredentialsCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.get<{ data: CredentialStatusRow[] }>(
      '/api/v1/workspace/provider-credentials',
    )
    const rows = res.data ?? []

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Provider Credentials')
    for (const r of rows) {
      console.log('')
      log.field('Provider', r.provider)
      log.field(
        'Routing',
        r.routingLive ? pc.green('live — the proxy forwards requests to it') : pc.yellow('not yet routable'),
      )
      log.field(
        'Provisioned',
        r.provisioned ? pc.green(`yes (…${r.lastFour ?? '????'})`) : pc.dim('no'),
      )
      if (r.updatedAt) log.field('Updated', r.updatedAt)
    }
  } catch (err) {
    log.error(`Failed to list provider credentials: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic credentials set <provider>` */
export async function runCredentialsSet(
  provider: string,
  opts: CredentialsCliOpts & { field?: string[]; fieldFile?: string[] },
): Promise<void> {
  // `--field-file key=path` reads the value from a file: a Vertex AI
  // service-account key is a multi-line JSON document no shell quotes well.
  const fromFiles: string[] = []
  for (const f of opts.fieldFile ?? []) {
    const idx = f.indexOf('=')
    if (idx <= 0) {
      log.error(`--field-file "${f}" is not in key=path form`)
      process.exit(1)
    }
    let value: string
    try {
      value = readFileSync(f.slice(idx + 1), 'utf8')
    } catch {
      log.error(`--field-file ${f.slice(0, idx)}: could not read ${f.slice(idx + 1)}`)
      process.exit(1)
    }
    fromFiles.push(`${f.slice(0, idx)}=${value}`)
  }
  const fields = [...(opts.field ?? []), ...fromFiles]
  if (fields.length === 0) {
    log.error(
      'At least one --field key=value is required (e.g. --field apiKey=sk-ant-... for a single-key ' +
        'provider, or multiple --field flags for a multi-field one like Azure OpenAI).',
    )
    process.exit(1)
  }

  // Local pre-check against the registry (@intutic/shared-types
  // PROVIDER_REGISTRY) — this module's own doc comment has promised
  // "registry awareness" without actually validating field keys before this
  // change; a typo'd field key would previously reach the server, get
  // silently ignored there (the server only reads keys it recognizes off
  // `def.fields`), and this command would report success with a credential
  // that has a missing field. The server (`providerCredentials.ts`) remains
  // the authoritative validator (length bounds, etc.) — this is a faster,
  // local UX check, not a replacement for it.
  const def = requireProvider(provider)
  const knownKeys = new Set(def.fields.map((f) => f.key))

  const body: Record<string, string> = {}
  for (const f of fields) {
    const idx = f.indexOf('=')
    if (idx <= 0) {
      log.error(`--field "${f}" is not in key=value form`)
      process.exit(1)
    }
    const key = f.slice(0, idx)
    if (!knownKeys.has(key)) {
      log.error(
        `"${key}" is not a field ${def.displayName} takes. Expected: ${def.fields.map((f2) => f2.key).join(', ')}`,
      )
      process.exit(1)
    }
    body[key] = f.slice(idx + 1)
  }
  for (const field of def.fields) {
    if (field.required && !(field.key in body)) {
      log.error(`${def.displayName} requires --field ${field.key}=<value>`)
      process.exit(1)
    }
  }
  if (def.requiresOneOf && !def.requiresOneOf.some((set) => set.every((k) => body[k]))) {
    log.error(
      `${def.displayName} requires one of: ${def.requiresOneOf.map((set) => set.map((k) => `--field ${k}=<value>`).join(' ')).join('  or  ')}`,
    )
    process.exit(1)
  }
  const trimmed = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v.trim()]))
  const cloudError = checkCloudCredentialFields(def.id, trimmed)
  if (cloudError) {
    log.error(cloudError)
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.put<CredentialStatusRow>(
      `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}`,
      body,
    )

    // Checked against the provider as soon as it is saved, server-side, so
    // the operator learns now — not on the first failed request — whether
    // the credential works. A failed check never undoes the save.
    let verification: VerifyResult | null = null
    try {
      verification = await client.post<VerifyResult>(
        `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}/verify`,
        {},
      )
    } catch {
      verification = null
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...res, verification }, null, 2))
      return
    }

    log.success(`${provider}: provisioned (…${res.lastFour ?? '????'}).`)
    if (verification?.status === 'valid') log.success(`  Verified: ${verification.detail}`)
    else if (verification?.status === 'invalid') {
      log.warn(`  ${verification.detail}. Check the values and run this command again.`)
    } else if (verification) log.dim(`  Not verified: ${verification.detail}`)
    if (verification?.models) {
      log.dim(
        `  The key can reach ${verification.models.length} model${verification.models.length === 1 ? '' : 's'}; ` +
          `\`intutic credentials models ${provider}\` lists them.`,
      )
    }
    if (def.usageHint) log.dim(`  ${def.usageHint}`)
    if (!res.routingLive) {
      log.warn(
        `${provider} is stored but not yet routable — the proxy does not forward requests to it. ` +
          'Its credential is safe to have on file ahead of that support landing.',
      )
    }
  } catch (err) {
    log.error(`Failed to set ${provider} credential: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic credentials unset <provider>` */
export async function runCredentialsUnset(
  provider: string,
  opts: CredentialsCliOpts,
): Promise<void> {
  const client = await getClient(opts)

  try {
    await client.del(`/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}`)
    log.success(`${provider}: credential removed.`)
    log.dim(
      '  If BYO-key enforcement is on for this gateway, requests for this provider will now be ' +
        'refused until a new key is provisioned.',
    )
  } catch (err) {
    log.error(`Failed to remove ${provider} credential: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic credentials models <provider>` */
export async function runCredentialsModels(provider: string, opts: CredentialsCliOpts): Promise<void> {
  const def = requireProvider(provider)
  const client = await getClient(opts)

  try {
    const res = await client.get<ProviderModelList>(
      `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}/models`,
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    // The list is recorded when a saved key is checked against the provider,
    // so `null` means no check has listed models yet, not that the key
    // reaches none.
    if (!res.models) {
      log.dim(`No models discovered for ${def.displayName} yet.`)
      log.dim(
        `  \`intutic credentials set ${provider} --field ...\` checks the key against the provider and records the models it can reach.`,
      )
      return
    }

    log.header(`Intutic — ${def.displayName} models`)
    if (res.checkedAt) log.field('Checked', res.checkedAt)
    log.field('Models', String(res.models.length))
    console.log('')
    for (const model of res.models) console.log(`  ${model}`)
  } catch (err) {
    log.error(`Failed to list ${provider} models: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
