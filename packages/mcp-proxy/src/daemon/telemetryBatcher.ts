/**
 * Telemetry Batcher — ring buffer + 1s flush to control-plane
 *
 * Accumulates hook events and batches them for upload.
 * Fallback: Valkey event buffer, followed by disk buffer at ~/.intutic/telemetry-buffer.ndjson on flush failure.
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 * @module
 */
import https from 'node:https'
import http  from 'node:http'
import fs    from 'node:fs'
import path  from 'node:path'
import os    from 'node:os'
import { Redis } from 'ioredis'
import { createLogger } from '@intutic/logger'

const logger = createLogger('mcp-proxy.telemetryBatcher')

const CP_URL          = process.env['CONTROL_PLANE_URL']              ?? 'http://localhost:3001'
const DAEMON_API_KEY  = process.env['INTUTIC_API_KEY']                ?? ''
const FLUSH_MS        = parseInt(process.env['MCP_DAEMON_TELEMETRY_FLUSH_MS'] ?? '1000', 10)
const RING_CAPACITY   = 200
const DISK_BUFFER     = path.join(os.homedir(), '.intutic', 'telemetry-buffer.ndjson')

const VALKEY_URL = process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const valkey = new Redis(VALKEY_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
})

/**
 * Renders a connection error as one line. Not just `err.message`: Node's
 * dual-stack connect reports a refused Valkey as an AggregateError holding one
 * child error per address family, and an AggregateError's own `.message` is the
 * empty string — so the most common outage there is logged `"err":""` and told
 * an operator nothing. Message text only, so a credentialed VALKEY_URL cannot
 * reach the log through an error property bag.
 */
function describeConnectionError(err: Error): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('; ')
  }
  return err.message || err.name
}

valkey.on('error', (err: Error) => {
  logger.warn({ err: describeConnectionError(err) }, 'telemetryBatcher Valkey connection error')
})

const daemonId = process.pid.toString()

export interface HookEvent {
  event:       string
  toolName:    string
  workspaceId: string
  harnessType: string
  timestamp:   string
  [key: string]: unknown
}

const ring: HookEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let isFlushing = false

/** Enqueues a hook event. Evicts oldest on overflow. */
export function enqueueEvent(event: HookEvent): void {
  if (ring.length >= RING_CAPACITY) ring.shift()
  ring.push(event)
}

/** Events awaiting the next flush. Reported upstream by the status reporter. */
export function pendingCount(): number {
  return ring.length
}

async function flush(): Promise<void> {
  if (isFlushing || ring.length === 0) return
  isFlushing = true
  try {
    await flushBatch(ring.splice(0, ring.length))
  } finally {
    // Held in a finally because `isFlushing` is a latch, not a flag: the one
    // path that can still throw past the handlers below is `new URL(CP_URL)`
    // on a CONTROL_PLANE_URL with no scheme, and leaving the latch set there
    // would silently retire the flush timer for the life of the daemon.
    isFlushing = false
  }
}

async function flushBatch(batch: HookEvent[]): Promise<void> {
  const body   = JSON.stringify({ events: batch })
  const url    = new URL('/api/v1/hook-events', CP_URL)
  const isHttps = url.protocol === 'https:'
  const lib    = isHttps ? https : http

  const tryUpload = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                   'Authorization': `Bearer ${DAEMON_API_KEY}` } },
      (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 400) resolve()
        else reject(new Error(`HTTP ${res.statusCode}`))
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })

  let success = false
  for (let i = 0; i < 3; i++) {
    try { await tryUpload(); success = true; break }
    catch { await new Promise(r => setTimeout(r, 500 * (i + 1))) }
  }

  if (!success) {
    // Persist to Valkey first
    try {
      const key = `mcp_daemon:event_buffer:${daemonId}`
      await valkey.rpush(key, ...batch.map(e => JSON.stringify(e)))
      await valkey.expire(key, 600) // 10 min TTL
      logger.warn({ count: batch.length }, 'telemetry.flush_failed_buffered_to_valkey')
    } catch (valkeyErr: unknown) {
      // Fallback: local disk buffer. The Valkey failure is reported on the
      // disk-fallback line rather than dropped — it is the reason this branch
      // ran at all, and without it the log says only "wrote to disk".
      const valkeyError = valkeyErr instanceof Error
        ? describeConnectionError(valkeyErr)
        : String(valkeyErr)
      try {
        fs.mkdirSync(path.dirname(DISK_BUFFER), { recursive: true, mode: 0o700 })
        fs.appendFileSync(DISK_BUFFER, batch.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
        logger.warn({ valkeyError, count: batch.length }, 'telemetry.flush_failed_buffered_to_disk')
      } catch (diskErr) {
        logger.error({ diskErr, count: batch.length }, 'telemetry.disk_buffer_failed')
      }
    }
  } else {
    logger.debug({ count: batch.length }, 'telemetry.flushed')
  }
}

/** Drains any Valkey or disk buffer from a previous crash, then starts the flush timer. */
export function startBatcher(): void {
  // Drain Valkey buffer
  const key = `mcp_daemon:event_buffer:${daemonId}`
  valkey.lrange(key, 0, -1).then(async (lines: string[]) => {
    if (lines && lines.length > 0) {
      for (const line of lines) {
        try {
          enqueueEvent(JSON.parse(line) as HookEvent)
        } catch {
          // Unparseable buffer entry (truncated by a crash mid-rpush, or
          // written by an older event schema). Drop the single bad line rather
          // than lose the rest of the recovered batch — telemetry is
          // best-effort and the buffer is deleted below regardless.
        }
      }
      await valkey.del(key)
      logger.info({ count: lines.length }, 'telemetry.valkey_buffer_drained')
    }
  }).catch(() => {})

  // Drain disk buffer
  try {
    if (fs.existsSync(DISK_BUFFER)) {
      const lines = fs.readFileSync(DISK_BUFFER, 'utf8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          enqueueEvent(JSON.parse(line) as HookEvent)
        } catch {
          // Unparseable NDJSON line — the last record is routinely truncated
          // when the daemon was killed mid-append. Drop the bad line and keep
          // draining the rest of the file.
        }
      }
      fs.unlinkSync(DISK_BUFFER)
      logger.info({ count: lines.length }, 'telemetry.disk_buffer_drained')
    }
  } catch (err) {
    // The buffer file vanished between existsSync and readFileSync, or is
    // unreadable, or the unlink failed. Startup must not fail over recovery of
    // best-effort telemetry, so the daemon carries on either way. Note the
    // unlink case leaves the file behind, so those events are re-enqueued (and
    // re-delivered) on the next start; duplicate hook events are tolerable,
    // blocking daemon startup is not.
    logger.warn({ err }, 'telemetry.disk_buffer_drain_failed')
  }

  flushTimer = setInterval(() => {
    // Nothing awaits this tick, so an escaping rejection is an unhandled one
    // every FLUSH_MS. Telemetry is best-effort; log and keep the timer alive.
    void flush().catch((err: unknown) => logger.error({ err }, 'telemetry.flush_failed'))
  }, FLUSH_MS)
  flushTimer.unref()
}

/** Flushes remaining events and stops the timer. Never rejects. */
export async function stopBatcher(): Promise<void> {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  // Shutdown must not be blocked by a final flush that throws: the caller is a
  // signal handler that has to reach process.exit().
  await flush().catch((err: unknown) => logger.error({ err }, 'telemetry.final_flush_failed'))
}
