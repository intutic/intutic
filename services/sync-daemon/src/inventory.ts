/**
 * inventory.ts — this machine's AI inventory, for the org-wide view.
 *
 * Which AI coding harnesses the machine has, whether Intutic's gate is
 * installed and live for each, the MCP servers their configs declare (wrapped
 * by the MCP governance proxy or not), the skill bundles on disk, and the
 * local proxy's guard-probe result. `intutic connect` runs it every few
 * minutes and sends it as the `inventory` facet of
 * `POST /api/v1/agents/report`, the path the agent facets already use, with
 * the device fingerprint `intutic enforce` reports under.
 *
 * Harness detection is the CLI's (its adapters hold the detection rules), so
 * the caller passes in what it detected; everything else is read here.
 *
 * What leaves the machine is names, home-relative paths, hashes and
 * timestamps only (see `@intutic/shared-types`'s `devInventory.ts`): never a
 * file's contents, an environment value, an MCP server's command line, or a
 * URL's credentials and query string.
 *
 * @module
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  DEVICE_INVENTORY_SCHEMA_VERSION,
  gateIdentitiesOf,
  gateKindForHarness,
  homeRelativePath,
  type DeviceInventory,
  type HarnessType,
  type InventoryDeviceIdentity,
  type InventoryHarness,
  type InventorySkill,
} from '@intutic/shared-types'
import { newIso } from '@intutic/id'
import { collectSkillsIn, fetchGuardProbes } from './agentReporter.js'
import { discoverMcpServers } from './harness/mcpAutoWrite.js'
import { findGateFile, findIdentityGateFile } from './harness/gateArtifacts.js'
import { mergeSightings, readGateSightings, sideLogSightings } from './harness/gateSightings.js'
import { antigravityGateIdentities } from './harness/antigravityProducts.js'

/** One harness the CLI's detection rules found on this machine. */
export interface DetectedHarness {
  type: string
  version?: string
}

/**
 * Collects this machine's inventory. Never throws for a missing or unreadable
 * file: an absent config is an absent item, not an error.
 *
 * @param opts.detected   - Harnesses the CLI's detection rules found.
 * @param opts.configured - This machine's `intutic connect` harnesses; listed even when detection misses them.
 * @param opts.home       - The home directory; defaults to the current user's.
 */
export async function collectDeviceInventory(opts: {
  workspaceRoot: string
  detected: readonly DetectedHarness[]
  configured: readonly string[]
  /** Harnesses `intutic disconnect --harness` removed Intutic from on this machine. */
  disconnected?: readonly string[]
  home?: string
  /** The PATH the product probes search (antigravityProducts.ts); defaults to this process's. */
  path?: string
}): Promise<DeviceInventory> {
  const home = opts.home ?? homedir()
  const versions = new Map(opts.detected.map((d) => [d.type, d.version]))
  const configured = new Set(opts.configured)
  const disconnected = new Set(opts.disconnected ?? [])
  const types = [...new Set([...opts.configured, ...opts.detected.map((d) => d.type)])].sort()

  const [sightings, sideSightings, mcp, skillSets, probes] = await Promise.all([
    readGateSightings(opts.workspaceRoot),
    sideLogSightings(home),
    discoverMcpServers(opts.workspaceRoot),
    Promise.all([
      collectSkillsIn(join(opts.workspaceRoot, '.agents', 'skills'), '.agents/skills'),
      collectSkillsIn(join(opts.workspaceRoot, '.claude', 'skills'), '.claude/skills'),
      collectSkillsIn(join(home, '.claude', 'skills'), '~/.claude/skills'),
    ]),
    fetchGuardProbes(),
  ])

  const harnesses: InventoryHarness[] = []
  for (const type of types) {
    const gateKind = gateKindForHarness(type as HarnessType)
    // The antigravity harness is listed once per product found, each under
    // its own gate id with its own gate file and events (gateIdentity.ts in
    // @intutic/shared-types); with neither found, once under its own id.
    const gateIds = type === 'antigravity' ? await antigravityGateIdentities(opts.workspaceRoot, { home, path: opts.path }) : []
    const split = gateIds.length > 0
    for (const id of split ? gateIds : [type]) {
      const gateFile =
        gateKind !== 'hook' ? null : split ? await findIdentityGateFile(id, opts.workspaceRoot, home) : await findGateFile(type, opts.workspaceRoot, home)
      // Listed under the harness id, it carries the events of every gate the harness has.
      const sighting = (split ? [id] : gateIdentitiesOf(type))
        .map((g) => mergeSightings(sightings[g], sideSightings[g]))
        .reduce<ReturnType<typeof mergeSightings>>((acc, g) => mergeSightings(acc, g), undefined)
      const version = versions.get(type)
      harnesses.push({
        type: id,
        ...(version ? { version } : {}),
        configured: configured.has(type),
        ...(disconnected.has(type) ? { disconnected: true } : {}),
        gateKind,
        gateInstalled: gateKind === 'hook' ? gateFile !== null : null,
        ...(gateFile ? { gateFile: homeRelativePath(gateFile, home) } : {}),
        lastHookEventAt: sighting?.lastEventAt ?? null,
        guardsDisabledAt: sighting?.guardsDisabledAt ?? null,
      })
    }
  }

  const skills: InventorySkill[] = skillSets.flat().map((s) => ({
    name: s.name,
    source: s.source,
    ...(s.sha256 ? { sha256: s.sha256 } : {}),
    scanned: s.scanned,
    clean: s.clean,
    findingsCount: s.findingsCount,
    scriptCount: s.scripts?.total ?? 0,
  }))

  return {
    schemaVersion: DEVICE_INVENTORY_SCHEMA_VERSION,
    collectedAt: newIso(),
    workspace: homeRelativePath(opts.workspaceRoot, home),
    harnesses,
    mcpServers: mcp.map((s) => ({
      server: s.server,
      harness: s.harness,
      transport: s.transport,
      wrapped: s.wrapped,
      ...(s.endpoint ? { endpoint: s.endpoint } : {}),
      ...(s.ungovernedReason ? { ungovernedReason: s.ungovernedReason } : {}),
    })),
    skills,
    ...(probes ? { guardProbes: { total: probes.total, failed: probes.failed, ranAt: probes.ranAt } } : {}),
  }
}

/**
 * Sends the inventory to `POST /api/v1/agents/report` as an inventory-only
 * report: the device and an `inventory` facet, no agent. Returns whether the
 * control plane accepted it. Never throws: a failed report is retried on the
 * next inventory cycle.
 */
export async function reportDeviceInventory(
  controlPlaneUrl: string,
  apiKey: string,
  device: InventoryDeviceIdentity,
  inventory: DeviceInventory,
): Promise<boolean> {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/v1/agents/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ device, facets: { inventory }, reportedAt: newIso() }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) console.warn(`[sync-daemon] inventory report failed: ${res.status}`)
    return res.ok
  } catch (err) {
    console.warn('[sync-daemon] inventory report error:', err instanceof Error ? err.message : err)
    return false
  }
}
