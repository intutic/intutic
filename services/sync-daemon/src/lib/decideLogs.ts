/**
 * Housekeeping for the decide log (`~/.intutic/logs/decide-YYYY-MM-DD.jsonl`).
 *
 * The gates append to it; this module only ages it out and, when the
 * workspace asks, uploads it:
 *
 * - {@link pruneDecideLogs} deletes decide log files (and `--log-state`
 *   files) whose UTC date is more than {@link DECIDE_LOG_RETENTION_DAYS}
 *   days old. The drift alarm needs the history, which is why the log is not
 *   a trace file: the trace upload deletes what it sends (`syncOfflineTraces`
 *   matches `traces-*.jsonl` only).
 * - {@link uploadDecideLogs} sends new lines to the control plane only when
 *   the workspace setting `decideLogUploadEnabled` is true, and the
 *   arguments excerpt only when `decideLogUploadArgs` is too. It reads from a
 *   cursor file and never deletes a log. With both settings off, nothing new
 *   leaves the machine.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLogger } from '@intutic/logger'
import { DECIDE_LOG_RETENTION_DAYS, decideLogFileDate } from '@intutic/shared-types'
import { writeFileAtomic } from './atomicWrite.js'

const log = createLogger('sync-daemon:decide-logs')

/** The cursor the upload resumes from, beside the logs. */
export const DECIDE_UPLOAD_CURSOR = 'decide-upload.cursor'
/** The most rows one upload request carries. */
export const DECIDE_UPLOAD_BATCH = 500

function defaultLogsDir(): string {
  return path.join(os.homedir(), '.intutic', 'logs')
}

/** Deletes decide log files older than the retention window. Returns the names deleted. Never throws. */
export async function pruneDecideLogs(opts: { logsDir?: string; nowMs?: number; days?: number } = {}): Promise<string[]> {
  const dir = opts.logsDir ?? defaultLogsDir()
  const cutoff = (opts.nowMs ?? Date.now()) - (opts.days ?? DECIDE_LOG_RETENTION_DAYS) * 86_400_000
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names) {
    const day = decideLogFileDate(name)
    // A file's day ends at the next midnight; it is old once that end is past the cutoff.
    if (day === null || day + 86_400_000 > cutoff) continue
    try {
      await fs.unlink(path.join(dir, name))
      removed.push(name)
    } catch (err) {
      log.debug({ action: 'decide_log_prune_failed', file: name, err }, 'Could not delete an old decide log')
    }
  }
  if (removed.length > 0) log.debug({ action: 'decide_logs_pruned', files: removed }, 'Deleted decide logs past retention')
  return removed
}

interface Cursor {
  file: string
  offset: number
}

async function readCursor(dir: string): Promise<Cursor | null> {
  try {
    const c = JSON.parse(await fs.readFile(path.join(dir, DECIDE_UPLOAD_CURSOR), 'utf-8')) as Partial<Cursor>
    return typeof c.file === 'string' && typeof c.offset === 'number' && c.offset >= 0 ? { file: c.file, offset: c.offset } : null
  } catch {
    return null
  }
}

export interface DecideUploadOptions {
  controlPlaneUrl: string
  apiKey: string
  /** The workspace settings the last sync carried. */
  settings: Record<string, unknown> | undefined
  logsDir?: string
  fetchImpl?: typeof fetch
}

/**
 * Uploads the decide log lines written since the cursor, in batches of at
 * most {@link DECIDE_UPLOAD_BATCH}, to `POST /api/v1/decide/events`. Returns
 * the rows sent, or null when the workspace has not opted in. Stops at the
 * first failed request, leaving the cursor after the last batch that landed.
 * Never deletes a log; never throws.
 */
export async function uploadDecideLogs(opts: DecideUploadOptions): Promise<number | null> {
  if (opts.settings?.decideLogUploadEnabled !== true) return null
  const withArgs = opts.settings.decideLogUploadArgs === true
  const dir = opts.logsDir ?? defaultLogsDir()
  const doFetch = opts.fetchImpl ?? fetch
  const names = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((n) => /^decide-[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/.test(n))
    .sort()
  const cursor = await readCursor(dir)
  let sent = 0
  for (const name of names) {
    if (cursor && name < cursor.file) continue
    const start = cursor && name === cursor.file ? cursor.offset : 0
    let buf: Buffer
    try {
      buf = await fs.readFile(path.join(dir, name))
    } catch {
      continue
    }
    // Whole lines only: a line a gate is still writing waits for the next cycle.
    const end = buf.lastIndexOf(0x0a) + 1
    if (end <= start) continue
    const lines = buf.subarray(start, end).toString('utf-8').split('\n')
    let offset = start
    let batch: Array<{ row: Record<string, unknown>; next: number }> = []
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true
      try {
        const res = await doFetch(`${trimTrailingSlashes(opts.controlPlaneUrl)}/api/v1/decide/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ events: batch.map((b) => b.row) }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
          log.debug({ action: 'decide_upload_failed', status: res.status }, 'Decide log upload refused; will retry')
          return false
        }
      } catch (err) {
        log.debug({ action: 'decide_upload_failed', err }, 'Decide log upload failed; will retry')
        return false
      }
      sent += batch.length
      try {
        await writeFileAtomic(path.join(dir, DECIDE_UPLOAD_CURSOR), JSON.stringify({ file: name, offset: batch[batch.length - 1]!.next }) + '\n', { mode: 0o600 })
      } catch (err) {
        // The rows landed but the cursor did not move: the next cycle sends them again rather than skipping any.
        log.debug({ action: 'decide_upload_cursor_failed', err }, 'Could not move the decide upload cursor')
        return false
      }
      batch = []
      return true
    }
    for (const line of lines.slice(0, -1)) {
      offset += Buffer.byteLength(line, 'utf-8') + 1
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!withArgs) delete row.argsExcerpt
      batch.push({ row, next: offset })
      if (batch.length >= DECIDE_UPLOAD_BATCH && !(await flush())) return sent
    }
    if (!(await flush())) return sent
  }
  return sent
}

/** Trailing slashes trimmed by a scan, not a `/+$` regex, which is quadratic on a run of slashes. */
function trimTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--
  return url.slice(0, end)
}
