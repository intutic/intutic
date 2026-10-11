/**
 * atomicWrite.ts — the one way the daemon replaces a whole file that a
 * harness or a gate reads.
 *
 * A gate script, a hook registration, a harness settings file and the policy
 * snapshot are all read by other processes at moments the daemon does not
 * choose. A plain `writeFile` truncates first and fills after, so a reader in
 * between sees an empty or half-written file: a truncated gate script crashes,
 * and for the exit-code harnesses (Claude Code and most others) a crash with
 * any code other than 2 lets the tool call through, ungoverned. So every such
 * write goes to a temp file beside the target and is renamed over it: a
 * reader opens either the old file or the new one, never a mix.
 *
 * `__tests__/lib/atomicWriteGuard.test.ts` fails when a harness writer calls
 * `writeFile` itself instead of this.
 *
 * @module
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'

export interface AtomicWriteOptions {
  /**
   * The file's permission bits after the write, set on the temp file before
   * the rename so the file is never visible without them (a gate script
   * renamed in and then made executable can be found non-executable). Omitted:
   * the replaced file's own mode, or the default for a new file, which is what
   * a plain `writeFile` leaves.
   */
  mode?: number
  /**
   * When `file` is a symlink, write the file it points to, as a plain
   * `writeFile` does, instead of replacing the link with a regular file. For a
   * person's own settings, which dotfile managers keep as links; never for a
   * file the daemon owns, where following a planted link would let it
   * overwrite whatever the link names.
   */
  followSymlink?: boolean
}

/** Per-process counter, so two writes from one process never share a temp name. */
let sequence = 0

/**
 * Replaces `file` with `content` atomically: a unique temp file in the same
 * directory (a rename is only atomic within one filesystem), written, given
 * its final mode, flushed to disk, then renamed over the target. On any
 * failure the temp file is removed and the error rethrown; the target is then
 * untouched. The parent directory must exist.
 */
export async function writeFileAtomic(
  file: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = options.followSymlink ? await linkTarget(file) : file
  const mode = options.mode ?? (await currentMode(target))
  // pid + counter is unique among live writers; the random part keeps a temp
  // left behind by a crashed process whose pid came round again from
  // colliding. `wx` refuses an existing path, a planted symlink included.
  const tmp = `${target}.${process.pid}-${++sequence}-${randomBytes(4).toString('hex')}.intutic-tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tmp, 'wx', mode ?? 0o666)
    await handle.writeFile(content)
    // `open`'s mode passes through the umask; this does not.
    if (mode !== undefined) await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameOver(tmp, target, content, mode)
  } catch (err) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function linkTarget(file: string): Promise<string> {
  try {
    return await fs.realpath(file)
  } catch {
    // Nothing there yet (or a dangling link): write the path itself.
    return file
  }
}

async function currentMode(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mode & 0o7777
  } catch {
    return undefined
  }
}

const WINDOWS_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const WINDOWS_RENAME_ATTEMPTS = 5

/**
 * POSIX rename replaces the target whatever its mode and whoever has it open.
 * Windows refuses while the target is read-only (the 0444 snapshot) or open
 * without delete sharing (an editor, a virus scanner), usually only for a
 * moment. So there: clear read-only, retry with a short backoff, and as a last
 * resort write the target in place, which is what every one of these writes
 * did before and is better than leaving the old gate or settings in force.
 */
async function renameOver(tmp: string, target: string, content: string | Uint8Array, mode: number | undefined): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !WINDOWS_RENAME_CODES.has(code)) throw err
      if (attempt === 1) await fs.chmod(target, 0o666).catch(() => undefined)
      if (attempt >= WINDOWS_RENAME_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
    }
  }
  await fs.writeFile(target, content)
  if (mode !== undefined) await fs.chmod(target, mode)
  await fs.rm(tmp, { force: true })
}
