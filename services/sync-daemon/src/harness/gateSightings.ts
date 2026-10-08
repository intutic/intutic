/**
 * gateSightings.ts — when this machine's gate for each harness last wrote an event.
 *
 * The control plane's silent-gate check (`gateLivenessService.ts`) keys its
 * sightings on workspace and harness, so it can say a harness's gate is alive
 * somewhere in the workspace but not on which machine. The daemon can: every
 * event it drains from `.intutic/events/hook-events.jsonl` was written by a gate
 * on this machine. The drain records the newest event per harness here before
 * it truncates the log, and the AI inventory reports it per device.
 *
 * Kept in `.intutic/events/gate-sightings.json`, next to the log it summarises,
 * so a daemon restart does not make every gate look silent.
 *
 * Two gates never write to that log: Cline's and n8n's post their events to
 * the control plane themselves and keep a local copy in their own file under
 * `~/.intutic/events/`. {@link sideLogSightings} reads the end of those files
 * for the same two facts.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'

export const GATE_SIGHTINGS_RELATIVE_PATH = node_path.join('.intutic', 'events', 'gate-sightings.json')

export interface GateSighting {
  /** Newest event of any kind; `tool_allowed` counts, which is the point. */
  lastEventAt: string
  /** Newest `guards_disabled` event: the gate ran with `INTUTIC_GUARD_DISABLE=1`. */
  guardsDisabledAt?: string
}

/** A gate's clock running ahead must not make it look alive for days. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function eventTime(raw: unknown, now: Date): string {
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (Number.isFinite(ms) && ms <= now.getTime() + MAX_CLOCK_SKEW_MS) return new Date(ms).toISOString()
  }
  return now.toISOString()
}

const later = (a: string | undefined, b: string): string => (a !== undefined && a >= b ? a : b)

/** Every sighting recorded so far, keyed by harness type. Empty when none or unreadable. */
export async function readGateSightings(workspaceRoot: string): Promise<Record<string, GateSighting>> {
  try {
    const parsed: unknown = JSON.parse(
      await node_fs.readFile(node_path.join(workspaceRoot, GATE_SIGHTINGS_RELATIVE_PATH), 'utf-8'),
    )
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, GateSighting> = {}
    for (const [harness, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<GateSighting> | null
      if (typeof v?.lastEventAt !== 'string') continue
      out[harness] = {
        lastEventAt: v.lastEventAt,
        ...(typeof v.guardsDisabledAt === 'string' ? { guardsDisabledAt: v.guardsDisabledAt } : {}),
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Folds a batch of drained hook events into the sightings file, keeping the
 * newest time per harness. Records without a `harnessType` say nothing about
 * a gate and are skipped. Never throws: liveness bookkeeping must not be able
 * to stop a drain.
 */
export async function recordGateSightings(
  workspaceRoot: string,
  records: readonly unknown[],
  now: Date = new Date(),
): Promise<void> {
  const seen = await readGateSightings(workspaceRoot)
  let changed = false
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue
    const r = record as Record<string, unknown>
    if (typeof r.harnessType !== 'string' || r.harnessType === '') continue
    const at = eventTime(r.timestamp, now)
    const prev = seen[r.harnessType]
    const next: GateSighting = {
      lastEventAt: later(prev?.lastEventAt, at),
      ...(prev?.guardsDisabledAt ? { guardsDisabledAt: prev.guardsDisabledAt } : {}),
    }
    if (r.event === 'guards_disabled') next.guardsDisabledAt = later(prev?.guardsDisabledAt, at)
    if (next.lastEventAt !== prev?.lastEventAt || next.guardsDisabledAt !== prev?.guardsDisabledAt) {
      seen[r.harnessType] = next
      changed = true
    }
  }
  if (!changed) return
  try {
    const file = node_path.join(workspaceRoot, GATE_SIGHTINGS_RELATIVE_PATH)
    await node_fs.mkdir(node_path.dirname(file), { recursive: true })
    const tmp = `${file}.intutic-tmp`
    await node_fs.writeFile(tmp, JSON.stringify(seen, null, 2) + '\n', 'utf-8')
    await node_fs.rename(tmp, file)
  } catch {
    // The sighting is late until the gate's next event; the drain itself carries on.
  }
}

/** Gates that keep their own event log instead of the drained one, by harness. */
export const SIDE_EVENT_LOGS: Readonly<Record<string, string>> = {
  cline: node_path.join('.intutic', 'events', 'cline-hook-events.jsonl'),
  n8n: node_path.join('.intutic', 'events', 'n8n-hook-events.jsonl'),
}

/** How much of the end of a side log is read: these files are never truncated. */
const SIDE_LOG_TAIL_BYTES = 64 * 1024

/**
 * The newest event and newest `guards_disabled` event in each side log under
 * `home`, read from the last {@link SIDE_LOG_TAIL_BYTES} only. A missing or
 * unreadable log is no sighting.
 */
export async function sideLogSightings(home: string, now: Date = new Date()): Promise<Record<string, GateSighting>> {
  const out: Record<string, GateSighting> = {}
  for (const [harness, rel] of Object.entries(SIDE_EVENT_LOGS)) {
    let tail: string
    try {
      const handle = await node_fs.open(node_path.join(home, rel), 'r')
      try {
        const { size } = await handle.stat()
        const length = Math.min(size, SIDE_LOG_TAIL_BYTES)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, size - length)
        tail = buffer.toString('utf-8')
      } finally {
        await handle.close()
      }
    } catch {
      continue
    }
    let sighting: GateSighting | undefined
    // The first line may be cut by the tail window; it fails to parse and is skipped.
    for (const line of tail.split('\n')) {
      let record: Record<string, unknown>
      try {
        record = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof record !== 'object' || record === null) continue
      const at = eventTime(record.timestamp, now)
      sighting = { ...sighting, lastEventAt: later(sighting?.lastEventAt, at) }
      if (record.event === 'guards_disabled') sighting.guardsDisabledAt = later(sighting.guardsDisabledAt, at)
    }
    if (sighting) out[harness] = sighting
  }
  return out
}

/** The later of two sightings of the same gate, field by field. */
export function mergeSightings(a: GateSighting | undefined, b: GateSighting | undefined): GateSighting | undefined {
  if (!a || !b) return a ?? b
  const disabled = [a.guardsDisabledAt, b.guardsDisabledAt].filter((t): t is string => t !== undefined).sort().at(-1)
  return { lastEventAt: later(a.lastEventAt, b.lastEventAt), ...(disabled ? { guardsDisabledAt: disabled } : {}) }
}
