/**
 * Intutic CLI — DCT Token Attenuation commands.
 *
 * "CLI mints, dashboard audits" — the decided split for this feature (see
 * `docs/BACKLOG.md`'s `attenuationService` entry and `AttenuationChainPanel`'s
 * module doc on the dashboard side). This command is the mint/inspect half:
 *
 * - `intutic attenuate --parent-key <keyId> --caps <a,b,c> [--ttl <seconds>]`
 *   — `POST /api/v1/attenuate`, narrowing a parent `vk_*` key to a child key
 *   scoped to a capability subset (`requestedCaps ⊆ parent.scopes`, enforced
 *   server-side).
 * - `intutic attenuate chain <chainId>` — `GET /api/v1/attenuate/chain/:chainId`,
 *   resolving the full delegation lineage for audit purposes.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { getClient } from './skill.js'

/** `POST /api/v1/attenuate`'s response shape (LLD #19 §2.1). */
interface AttenuationResult {
  /** Plaintext `vk_*` child key — returned ONCE and never stored. */
  childKey: string
  childKeyId: string
  attenuationChainId: string
  grantedCaps: string[]
  expiresAt: string
}

/** A single link in `GET /api/v1/attenuate/chain/:chainId`'s lineage response. */
interface AttenuationChainLink {
  chainId: string
  parentKeyId: string
  childKeyId: string
  workspaceId: string
  grantedCaps: string[]
  expiresAt: string
  createdAt: string
}

/**
 * `intutic attenuate --parent-key <keyId> --caps <a,b,c> [--ttl <seconds>]`
 * — mints a child key narrowed to a subset of the parent key's capabilities.
 *
 * `--caps` is a comma-separated list, split and trimmed client-side; the
 * server does the actual `requestedCaps ⊆ parent.scopes` subset check and
 * returns `E_ATTENUATION_CAP_VIOLATION` (403) naming exactly which requested
 * capability was not in the parent's scopes.
 */
export async function runAttenuate(opts: {
  parentKey?: string
  caps?: string
  ttl?: string
  dev?: boolean
}): Promise<void> {
  log.header('Intutic — Attenuate API Key')

  if (!opts.parentKey) {
    log.error('--parent-key is required')
    process.exit(1)
  }

  const requestedCaps = (opts.caps ?? '')
    .split(',')
    .map((cap) => cap.trim())
    .filter(Boolean)
  if (requestedCaps.length === 0) {
    log.error('--caps is required and must list at least one capability')
    process.exit(1)
  }

  let ttlSeconds: number | undefined
  if (opts.ttl !== undefined) {
    ttlSeconds = Number(opts.ttl)
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      log.error('--ttl must be a positive number of seconds')
      process.exit(1)
    }
  }

  const client = await getClient(opts.dev)

  try {
    const result = await client.post<AttenuationResult>('/api/v1/attenuate', {
      parentKeyId: opts.parentKey,
      requestedCaps,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    })
    log.success('Child key minted.')
    log.field('Child Key', result.childKey)
    log.field('Child Key ID', result.childKeyId)
    log.field('Chain ID', result.attenuationChainId)
    log.field('Granted Capabilities', result.grantedCaps.join(', '))
    log.field('Expires At', result.expiresAt)
    log.dim('The child key is shown once and never stored — save it now.')
  } catch (err) {
    log.error(`Failed to attenuate key: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic attenuate chain <chainId>` — resolves the full delegation
 * lineage for an attenuation chain, OWNER/ADMIN only server-side.
 */
export async function runAttenuateChain(
  chainId: string,
  opts: { dev?: boolean },
): Promise<void> {
  log.header(`Intutic — Attenuation Chain: ${chainId}`)

  const client = await getClient(opts.dev)

  try {
    const res = await client.get<{ chain: AttenuationChainLink[] }>(
      `/api/v1/attenuate/chain/${chainId}`,
    )
    const chain = res.chain ?? []
    if (chain.length === 0) {
      log.info('No lineage found for this chain.')
      return
    }
    for (const link of chain) {
      log.field('Chain ID', link.chainId)
      log.field('Parent Key', link.parentKeyId)
      log.field('Child Key', link.childKeyId)
      log.field('Granted Capabilities', link.grantedCaps.join(', '))
      log.field('Expires At', link.expiresAt)
      log.field('Minted At', link.createdAt)
    }
  } catch (err) {
    log.error(`Failed to resolve attenuation chain: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
