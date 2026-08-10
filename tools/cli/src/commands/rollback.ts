/**
 * `intutic rollback` — the restore half of the rollback enforcement rung (TD-328).
 *
 * The gate captures a pre-image when a guard FLAGS a call and lets it proceed
 * (see `emitPreImageCapture` in the sync daemon). This restores one. Without
 * this command the capture would be storage nobody can act on — the exact
 * shape of a control that looks live and reaches nothing, which is what the
 * rung exists to close rather than reproduce.
 *
 * ## Properties that are not negotiable
 *
 * - **Nothing is restored without being named.** No `--all`, no implicit
 *   "latest". Rolling back the wrong file is itself a destructive act, and an
 *   undo that guesses is a second incident.
 * - **The restore is itself an audited event.** It appends to the same hook
 *   event log the gate writes, so the trail reads
 *   "flagged → allowed → reverted" rather than showing an edit that silently
 *   un-happened. An unlogged undo is indistinguishable from tampering.
 * - **The current state is captured before it is replaced.** Restoring is an
 *   edit like any other; without this, `rollback` would be the one file
 *   operation in the product with no way back.
 * - **A missing blob refuses.** A manifest row whose blob was evicted can
 *   describe a restore it cannot perform, and performing three-quarters of it
 *   would leave the file in a state it was never in.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { log } from '../lib/logger.js'

// Declared once, in shared-types, and imported by both the CLI reader and the
// daemon test that pins the emitted writer against it.
import type { PreImageEntry } from '@intutic/shared-types'


const ROLLBACK_DIR = () => path.join(process.cwd(), '.intutic', 'rollback')
const MANIFEST = () => path.join(ROLLBACK_DIR(), 'manifest.jsonl')

function readManifest(): PreImageEntry[] {
  try {
    return fs
      .readFileSync(MANIFEST(), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PreImageEntry)
  } catch {
    return []
  }
}

/** Appends to the same log the gate writes, so the undo is in the same trail. */
function recordRestore(entry: PreImageEntry, note: string): void {
  try {
    const eventsDir = path.join(process.cwd(), '.intutic', 'events')
    fs.mkdirSync(eventsDir, { recursive: true })
    const ts = new Date().toISOString()
    fs.appendFileSync(
      path.join(eventsDir, 'hook-events.jsonl'),
      JSON.stringify({
        event: 'tool_reverted',
        toolName: entry.tool,
        reason: `rolled back pre-image ${entry.id} (${note}) target=${path.basename(entry.target)}`,
        workspaceId: entry.workspaceId,
        harnessType: 'cli',
        timestamp: ts,
        incidentId: crypto.createHash('sha1').update(ts + entry.id).digest('hex').slice(0, 16),
      }) + '\n',
      { flag: 'a' },
    )
  } catch {
    // A trail that cannot be written must not stop a restore the user asked
    // for — but it is worth saying so, because an unlogged undo is exactly
    // what this property exists to prevent.
    log.warn('Could not append the revert to the hook event log; the restore still happened.')
  }
}

export async function runRollback(opts: {
  list?: boolean
  id?: string
}): Promise<void> {
  const entries = readManifest()

  if (opts.list || !opts.id) {
    if (entries.length === 0) {
      log.info('No pre-images captured.')
      log.dim(
        'Capture is opt-in: set `"captureRollbackPreImages": true` in .intutic/config.json. ' +
          'It stores copies of flagged files locally, which is why it is not on by default.',
      )
      return
    }
    log.info(`${entries.length} captured pre-image(s), newest last:\n`)
    for (const e of entries) {
      const state = e.existed ? `${e.bytes} bytes` : 'file did not exist (restore = delete)'
      log.info(`  ${e.id}  ${e.capturedAt}  ${e.tool}`)
      log.dim(`      ${e.target}`)
      log.dim(`      ${state}${e.ruleId ? `  rule=${e.ruleId}` : ''}`)
    }
    log.info('\nRestore one with: intutic rollback --id <id>')
    return
  }

  const entry = entries.find((e) => e.id === opts.id)
  if (!entry) {
    log.error(`No captured pre-image with id ${opts.id}. Run \`intutic rollback\` to list them.`)
    process.exitCode = 1
    return
  }

  const blob = path.join(ROLLBACK_DIR(), `${entry.id}.blob`)
  if (entry.existed && !fs.existsSync(blob)) {
    // Evicted by the retention ceiling. Refusing is the only honest answer:
    // a partial restore leaves the file in a state it was never in.
    log.error(
      `Pre-image ${entry.id} is listed but its stored contents are gone (evicted by the ` +
        `retention ceiling). Refusing rather than restoring part of it.`,
    )
    process.exitCode = 1
    return
  }

  // Restoring is an edit. Capture what is there now, or this is the one file
  // operation in the product with no way back.
  try {
    if (fs.existsSync(entry.target)) {
      const undoId = crypto.randomBytes(8).toString('hex')
      fs.copyFileSync(entry.target, path.join(ROLLBACK_DIR(), `${undoId}.blob`))
      fs.appendFileSync(
        MANIFEST(),
        JSON.stringify({
          ...entry,
          id: undoId,
          capturedAt: new Date().toISOString(),
          tool: 'intutic rollback',
          ruleId: `undo-of-${entry.id}`,
          bytes: fs.statSync(entry.target).size,
          existed: true,
        }) + '\n',
        { flag: 'a' },
      )
    }
  } catch (err) {
    log.error(
      `Could not capture the current contents before restoring: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing, so the restore cannot be the one edit with no way back.`,
    )
    process.exitCode = 1
    return
  }

  try {
    if (entry.existed) {
      fs.copyFileSync(blob, entry.target)
      log.info(`Restored ${entry.target} from pre-image ${entry.id} (${entry.capturedAt}).`)
      recordRestore(entry, 'restored prior contents')
    } else {
      // The pre-image records that the file did not exist. Undoing a creation
      // is a deletion, and it is stated plainly rather than performed quietly.
      fs.unlinkSync(entry.target)
      log.info(`Removed ${entry.target} — it did not exist when the flagged call ran.`)
      recordRestore(entry, 'removed a file the flagged call created')
    }
  } catch (err) {
    log.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
