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

valkey.on('error', (err: any) => {
  logger.warn({ err: err.message }, 'telemetryBatcher Valkey connection error')
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

async function flush(): Promise<void> {
  if (isFlushing || ring.length === 0) return
  isFlushing = true
  const batch = ring.splice(0, ring.length)

  const body   = JSON.stringify({ events: batch })
  const url    = new URL('/api/v1/hook-events', CP_URL)
  const isHttps = url.protocol === 'https:'
  const lib    = isHttps ? https : http

  const tryUpload = (attempt: number): Promise<void> => new Promise((resolve, reject) => {
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
    try { await tryUpload(i); success = true; break }
    catch { await new Promise(r => setTimeout(r, 500 * (i + 1))) }
  }

  if (!success) {
    // Persist to Valkey first
    try {
      const key = `mcp_daemon:event_buffer:${daemonId}`
      await valkey.rpush(key, ...batch.map(e => JSON.stringify(e)))
      await valkey.expire(key, 600) // 10 min TTL
      logger.warn({ count: batch.length }, 'telemetry.flush_failed_buffered_to_valkey')
    } catch (valkeyErr: any) {
      // Fallback: local disk buffer
      try {
        fs.mkdirSync(path.dirname(DISK_BUFFER), { recursive: true, mode: 0o700 })
        fs.appendFileSync(DISK_BUFFER, batch.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
        logger.warn({ count: batch.length }, 'telemetry.flush_failed_buffered_to_disk')
      } catch (diskErr) {
        logger.error({ diskErr, count: batch.length }, 'telemetry.disk_buffer_failed')
      }
    }
  } else {
    logger.debug({ count: batch.length }, 'telemetry.flushed')
  }
  isFlushing = false
}

/** Drains any Valkey or disk buffer from a previous crash, then starts the flush timer. */
export function startBatcher(): void {
  // Drain Valkey buffer
  const key = `mcp_daemon:event_buffer:${daemonId}`
  valkey.lrange(key, 0, -1).then(async (lines: string[]) => {
    if (lines && lines.length > 0) {
      for (const line of lines) {
        try { enqueueEvent(JSON.parse(line) as HookEvent) } catch {}
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
        try { enqueueEvent(JSON.parse(line) as HookEvent) } catch {}
      }
      fs.unlinkSync(DISK_BUFFER)
      logger.info({ count: lines.length }, 'telemetry.disk_buffer_drained')
    }
  } catch {}

  flushTimer = setInterval(() => { void flush() }, FLUSH_MS)
  flushTimer.unref()
}

/** Flushes remaining events and stops the timer. */
export async function stopBatcher(): Promise<void> {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  await flush()
}
