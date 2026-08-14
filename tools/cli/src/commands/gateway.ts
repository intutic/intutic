/**
 * `intutic gateway` — manage self-hosted gateway registrations (LLD #66)
 * and routing assignment (LLD #68 §2).
 *
 * Subcommands:
 *   - `intutic gateway register --name <name> --target <docker|kubernetes|bare_metal>`
 *   - `intutic gateway list [--json]`
 *   - `intutic gateway status <gateway_id> [--json]`
 *   - `intutic gateway rotate <gateway_id>`
 *   - `intutic gateway revoke <gateway_id> [--reason <text>]`
 *   - `intutic gateway config set <gateway_id> [--require-vk <bool>] [--require-provisioned-key <bool>]`
 *   - `intutic gateway assign --gateway <gateway_id>|--clear [--org <org_id>]`
 *   - `intutic gateway resolve [--json]`
 *
 * Server side: services/control-plane/src/routes/gateways.ts,
 * routes/gatewayHeartbeat.ts, routes/orgs.ts (`PATCH .../gateway`). A
 * gateway token (`gwk_...`) is a distinct credential from the `vk_`/JWT
 * this command authenticates with — it is printed exactly once, on
 * `register` and `rotate`, and never retrievable again, matching the
 * server's own one-shot design.
 *
 * `assign`/`resolve` are client-side discovery, not traffic routing:
 * there is no proxy-in-front-of-proxies in this architecture, so
 * `resolve` tells you which gateway a client SHOULD point at; actually
 * pointing one there (`CONTROL_PLANE_URL=...`) is still a manual step.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'

const NOT_AUTHENTICATED =
  'Not authenticated. Run `intutic login` first — gateway registration is an org-scoped control plane feature.'

const DEPLOYMENT_TARGETS = ['docker', 'kubernetes', 'bare_metal'] as const

interface GatewayCliOpts {
  json?: boolean
  dev?: boolean
}

interface GatewayRegisterResponse {
  gatewayId: string
  name: string
  deploymentTarget: string
  status: string
  token: string
  instructions: string
}

interface GatewayListRow {
  gatewayId: string
  name: string
  deploymentTarget: string
  status: string
  keyPrefix: string
  lastHeartbeatAt: string | null
  proxyVersion: string | null
  createdAt: string
  revokedAt: string | null
}

interface GatewayRotateResponse {
  gatewayId: string
  token: string
  previousTokenValidUntil: string
  instructions: string
}

interface GatewayStatusResponse {
  status: 'online' | 'degraded' | 'unreachable' | 'pending'
  proxyVersion: string | null
  uptimeSeconds: number | null
  activeWorkspaces: number | null
  litellmReachable: boolean | null
  lastError: string | null
  reportedAt: string | null
}

async function getClient(opts: GatewayCliOpts) {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

function colorStatus(status: string): string {
  switch (status) {
    case 'online':
      return pc.green(status)
    case 'degraded':
      return pc.yellow(status)
    case 'unreachable':
    case 'revoked':
      return pc.red(status)
    default:
      return pc.dim(status)
  }
}

/** `intutic gateway register` */
export async function runGatewayRegister(
  opts: GatewayCliOpts & { name?: string; target?: string },
): Promise<void> {
  if (!opts.name || !opts.name.trim()) {
    log.error('--name is required')
    process.exit(1)
  }
  if (!opts.target || !(DEPLOYMENT_TARGETS as readonly string[]).includes(opts.target)) {
    log.error(`--target must be one of: ${DEPLOYMENT_TARGETS.join(', ')}`)
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.post<GatewayRegisterResponse>('/api/v1/gateways', {
      name: opts.name.trim(),
      deploymentTarget: opts.target,
    })

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Gateway Registered')
    log.field('Gateway ID', res.gatewayId)
    log.field('Name', res.name)
    log.field('Deployment target', res.deploymentTarget)
    log.field('Status', colorStatus(res.status))
    console.log('')
    log.warn('This token is shown ONCE and cannot be retrieved again:')
    console.log(`  ${pc.bold(res.token)}`)
    console.log('')
    log.dim(`  ${res.instructions}`)
  } catch (err) {
    log.error(`Failed to register gateway: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway list` */
export async function runGatewayList(opts: GatewayCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.get<{ data: GatewayListRow[] }>('/api/v1/gateways')
    const rows = res.data ?? []

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Gateways')

    if (rows.length === 0) {
      log.dim('  No gateways registered for this org yet. Run `intutic gateway register` to add one.')
      return
    }

    for (const g of rows) {
      console.log('')
      log.field('Gateway ID', g.gatewayId)
      log.field('Name', g.name)
      log.field('Target', g.deploymentTarget)
      log.field('Status', colorStatus(g.status))
      log.field('Token prefix', g.keyPrefix)
      log.field('Last heartbeat', g.lastHeartbeatAt ?? '— (never)')
      log.field('Proxy version', g.proxyVersion ?? '—')
    }
  } catch (err) {
    log.error(`Failed to list gateways: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway status <gateway_id>` */
export async function runGatewayStatus(gatewayId: string, opts: GatewayCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.get<GatewayStatusResponse>(
      `/api/v1/gateways/${encodeURIComponent(gatewayId)}/status`,
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Gateway Status')
    log.field('Status', colorStatus(res.status))
    log.field('Proxy version', res.proxyVersion ?? '—')
    log.field('Uptime (s)', res.uptimeSeconds !== null ? String(res.uptimeSeconds) : '—')
    log.field('Active workspaces', res.activeWorkspaces !== null ? String(res.activeWorkspaces) : '—')
    log.field(
      'LiteLLM reachable',
      res.litellmReachable === null ? '— (not reported by this proxy version)' : String(res.litellmReachable),
    )
    log.field('Last error', res.lastError ?? '—')
    log.field('Reported at', res.reportedAt ?? '— (no heartbeat received within the TTL window)')
  } catch (err) {
    log.error(`Failed to fetch gateway status: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway rotate <gateway_id>` */
export async function runGatewayRotate(gatewayId: string, opts: GatewayCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.post<GatewayRotateResponse>(
      `/api/v1/gateways/${encodeURIComponent(gatewayId)}/rotate`,
      {},
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Gateway Token Rotated')
    log.warn('This new token is shown ONCE and cannot be retrieved again:')
    console.log(`  ${pc.bold(res.token)}`)
    console.log('')
    log.dim(`  ${res.instructions}`)
  } catch (err) {
    log.error(`Failed to rotate gateway token: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway revoke <gateway_id>` */
export async function runGatewayRevoke(
  gatewayId: string,
  opts: GatewayCliOpts & { reason?: string },
): Promise<void> {
  const client = await getClient(opts)

  try {
    await client.del(`/api/v1/gateways/${encodeURIComponent(gatewayId)}`, {
      reason: opts.reason,
    })
    log.success(`Gateway ${gatewayId} revoked.`)
    if (!opts.reason) {
      log.dim('  Tip: pass --reason "<text>" next time — it is recorded in the audit log.')
    }
  } catch (err) {
    log.error(`Failed to revoke gateway: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway config set <gateway_id>` */
export async function runGatewayConfigSet(
  gatewayId: string,
  opts: GatewayCliOpts & { requireVk?: string; requireProvisionedKey?: string },
): Promise<void> {
  const body: Record<string, boolean> = {}
  if (opts.requireVk !== undefined) {
    if (opts.requireVk !== 'true' && opts.requireVk !== 'false') {
      log.error('--require-vk must be "true" or "false"')
      process.exit(1)
    }
    body.requireVk = opts.requireVk === 'true'
  }
  if (opts.requireProvisionedKey !== undefined) {
    if (opts.requireProvisionedKey !== 'true' && opts.requireProvisionedKey !== 'false') {
      log.error('--require-provisioned-key must be "true" or "false"')
      process.exit(1)
    }
    body.requireProvisionedKey = opts.requireProvisionedKey === 'true'
  }
  if (Object.keys(body).length === 0) {
    log.error('At least one of --require-vk, --require-provisioned-key is required')
    process.exit(1)
  }

  const client = await getClient(opts)

  try {
    const res = await client.patch<{ config: Record<string, unknown>; configVersion: number }>(
      `/api/v1/gateways/${encodeURIComponent(gatewayId)}/config`,
      body,
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.success(`Gateway config updated (version ${res.configVersion}).`)
    log.dim(
      '  A daemon-supervised gateway (packages/gateway-daemon) applies this on its next poll. ' +
        'Docker/Kubernetes deployments require a manual redeploy to pick up config changes.',
    )
  } catch (err) {
    log.error(`Failed to update gateway config: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/** `intutic gateway assign` — LLD #68 §2. */
export async function runGatewayAssign(
  opts: GatewayCliOpts & { gateway?: string; clear?: boolean; org?: string },
): Promise<void> {
  if (!opts.clear && !opts.gateway) {
    log.error('Either --gateway <gateway_id> or --clear is required')
    process.exit(1)
  }
  if (opts.clear && opts.gateway) {
    log.error('--gateway and --clear are mutually exclusive')
    process.exit(1)
  }

  const gatewayId = opts.clear ? null : (opts.gateway as string)
  const client = await getClient(opts)
  const path = opts.org
    ? `/api/v1/orgs/${encodeURIComponent(opts.org)}/gateway`
    : '/api/v1/workspace/gateway'

  try {
    const res = await client.patch<{ workspaceId?: string; orgId?: string; gatewayId: string | null }>(
      path,
      { gatewayId },
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    if (res.gatewayId) {
      log.success(`${opts.org ? `Org ${opts.org}` : 'This workspace'} now defaults to gateway ${res.gatewayId}.`)
    } else {
      log.success(`${opts.org ? `Org ${opts.org}'s` : "This workspace's"} gateway override cleared.`)
    }
  } catch (err) {
    log.error(`Failed to update gateway assignment: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

interface GatewayResolutionResponse {
  source: 'workspace' | 'org' | 'default'
  gateway: {
    gatewayId: string
    name: string
    deploymentTarget: string
    status: string
    registeredEndpoint: string | null
  } | null
  staleAssignment?: string
}

/** `intutic gateway resolve` — LLD #68 §2. */
export async function runGatewayResolve(opts: GatewayCliOpts): Promise<void> {
  const client = await getClient(opts)

  try {
    const res = await client.get<GatewayResolutionResponse>('/api/v1/workspace/gateway-resolution')

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.header('Intutic — Gateway Resolution')
    if (res.staleAssignment) {
      log.warn(
        `This ${res.source} points at gateway ${res.staleAssignment}, which no longer exists or was revoked.`,
      )
      log.dim('  Falling back to the shared gateway.intutic.ai until this is reassigned or cleared.')
      return
    }
    if (!res.gateway) {
      log.dim('  No override assigned — this workspace uses the shared gateway.intutic.ai.')
      return
    }

    log.field('Source', res.source === 'workspace' ? 'This workspace\'s own override' : "This org's default")
    log.field('Gateway ID', res.gateway.gatewayId)
    log.field('Name', res.gateway.name)
    log.field('Target', res.gateway.deploymentTarget)
    log.field('Status', colorStatus(res.gateway.status))
    console.log('')

    if (res.gateway.registeredEndpoint && res.gateway.status === 'online') {
      log.field('Endpoint', res.gateway.registeredEndpoint)
      log.dim("  intutic connect uses this automatically once no proxyUrl override is set on the workspace.")
    } else if (res.gateway.registeredEndpoint) {
      log.dim(
        `  Endpoint ${res.gateway.registeredEndpoint} is registered but the gateway isn't online yet ` +
          `(status: ${res.gateway.status}) — traffic stays on the shared gateway until it heartbeats.`,
      )
    } else {
      log.dim(
        '  Pointing a client here is still manual — set CONTROL_PLANE_URL (or the proxy target) ' +
          "to this gateway's own reachable address.",
      )
    }
  } catch (err) {
    log.error(`Failed to resolve gateway: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
