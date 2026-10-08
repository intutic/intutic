/**
 * originals.ts — what a file looked like before Intutic first wrote to it.
 *
 * `intutic disconnect` puts every file `intutic connect` touched back the way
 * it was. For an entry Intutic adds to a file the user owns (a hook
 * registration, a wrapped MCP server) the entry itself says it is Intutic's.
 * But some writes replace what was there: a rules file (`CLAUDE.md`,
 * `AGENTS.md`, ...) is written whole, a proxy base URL overwrites the user's
 * own, a deny list is replaced. Those can only be undone if the original was
 * kept, so every such writer calls {@link keepOriginal} before it writes, and
 * {@link noteWritten} after a write of a file it owns whole.
 *
 * One record per file, under `<root>/.intutic/originals/`, where `<root>` is
 * the workspace for files inside it and the home directory for the rest:
 *
 * - `existed: false` — Intutic created the file (and `createdDirs`, the
 *   directories it had to make for it); disconnect deletes them.
 * - `existed: true` — the bytes as they were, in a copy next to the record.
 * - `writtenSha256` — what Intutic last wrote to a file it owns whole. A file
 *   that no longer matches was edited since, and disconnect leaves it alone
 *   rather than throw the edit away.
 *
 * Only the first record for a path is kept (created with O_EXCL, so two
 * writers racing on one file cannot both claim it): the original is the file
 * before Intutic's FIRST write, not before its latest one. A record per file,
 * rather than one index, is what lets the MCP writers, which run in parallel,
 * record without a lock.
 *
 * Best-effort by design: a failure to record must never stop the write it
 * precedes. The cost is that disconnect then treats the file as one written
 * by an earlier version, which kept no record.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import * as node_crypto from 'node:crypto'

export interface OriginalRecord {
  /** Absolute path of the file this record is for. */
  path: string
  /** Whether the file existed before Intutic first wrote it. */
  existed: boolean
  /** Its permission bits then, so a restore keeps them. */
  mode?: number
  /** Directories Intutic created to hold the file, outermost first. */
  createdDirs?: string[]
  /** SHA-256 of what Intutic last wrote, for files it owns whole. */
  writtenSha256?: string
  /** Writer-specific detail disconnect needs, e.g. the deny rules Intutic added. */
  meta?: Record<string, unknown>
  recordedAt: string
}

export function sha256(content: string | Buffer): string {
  return node_crypto.createHash('sha256').update(content).digest('hex')
}

/** The directory whose `.intutic/originals` holds `filePath`'s record. */
export function ledgerRootFor(filePath: string, workspaceRoot: string): string {
  const rel = node_path.relative(node_path.resolve(workspaceRoot), node_path.resolve(filePath))
  return rel && !rel.startsWith('..') && !node_path.isAbsolute(rel) ? node_path.resolve(workspaceRoot) : node_os.homedir()
}

export function ledgerDir(root: string): string {
  return node_path.join(root, '.intutic', 'originals')
}

function recordBase(filePath: string, workspaceRoot: string): string {
  const abs = node_path.resolve(filePath)
  return node_path.join(ledgerDir(ledgerRootFor(abs, workspaceRoot)), sha256(abs).slice(0, 32))
}

async function ensureLedgerDir(dir: string): Promise<void> {
  await node_fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // A workspace's `.intutic/` may be committed; the copies here can hold
  // whatever the user's config held, credentials included.
  const ignore = node_path.join(dir, '.gitignore')
  await node_fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined)
}

async function readRecord(base: string): Promise<OriginalRecord | null> {
  try {
    return JSON.parse(await node_fs.readFile(`${base}.json`, 'utf-8')) as OriginalRecord
  } catch {
    return null
  }
}

/** The directories between `root` and `filePath` that do not exist yet, outermost first. */
async function missingDirs(filePath: string, root: string): Promise<string[]> {
  const out: string[] = []
  let dir = node_path.dirname(filePath)
  while (dir !== root && dir.startsWith(root + node_path.sep)) {
    try {
      await node_fs.access(dir)
      break
    } catch {
      out.unshift(dir)
      dir = node_path.dirname(dir)
    }
  }
  return out
}

/**
 * Keeps `filePath` as it is now, unless an earlier call already did. Call it
 * immediately before Intutic's write.
 */
export async function keepOriginal(filePath: string, workspaceRoot: string): Promise<void> {
  try {
    const abs = node_path.resolve(filePath)
    const root = ledgerRootFor(abs, workspaceRoot)
    const base = recordBase(abs, workspaceRoot)
    try {
      await node_fs.access(`${base}.json`)
      return
    } catch {
      // No record yet.
    }
    let content: Buffer | null = null
    let mode: number | undefined
    try {
      content = await node_fs.readFile(abs)
      mode = (await node_fs.stat(abs)).mode & 0o7777
    } catch {
      content = null
    }
    const record: OriginalRecord = { path: abs, existed: content !== null, recordedAt: new Date().toISOString() }
    if (content === null) {
      const dirs = await missingDirs(abs, root)
      if (dirs.length > 0) record.createdDirs = dirs
    } else {
      record.mode = mode
    }
    await ensureLedgerDir(ledgerDir(root))
    if (content !== null) await node_fs.writeFile(`${base}.orig`, content, { mode: 0o600 })
    await node_fs.writeFile(`${base}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch {
    // Best-effort; see the module doc.
  }
}

/**
 * Notes what Intutic just wrote to a file it owns whole, so disconnect can
 * tell a later edit apart; `meta` is merged into the record's.
 */
export async function noteWritten(
  filePath: string,
  workspaceRoot: string,
  content: string | Buffer | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const base = recordBase(filePath, workspaceRoot)
    const record = await readRecord(base)
    if (!record) return
    const next: OriginalRecord = { ...record }
    if (content !== null) next.writtenSha256 = sha256(content)
    if (meta) next.meta = { ...(record.meta ?? {}), ...meta }
    if (JSON.stringify(next) === JSON.stringify(record)) return
    const tmp = `${base}.${process.pid}.tmp`
    await node_fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await node_fs.rename(tmp, `${base}.json`)
  } catch {
    // Best-effort; see the module doc.
  }
}

/**
 * Writes a file Intutic owns whole, keeping the original first and noting
 * what was written: the write every rules file, generated hook file and
 * plugin goes through.
 */
export async function writeOwnedFile(filePath: string, workspaceRoot: string, content: string, mode?: number): Promise<void> {
  await keepOriginal(filePath, workspaceRoot)
  await node_fs.mkdir(node_path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.intutic-tmp`
  await node_fs.writeFile(tmp, content, 'utf-8')
  if (mode !== undefined) await node_fs.chmod(tmp, mode)
  await node_fs.rename(tmp, filePath)
  await noteWritten(filePath, workspaceRoot, content)
}

/** The record for `filePath`, with the saved bytes when the file existed. */
export async function readOriginal(
  filePath: string,
  workspaceRoot: string,
): Promise<(OriginalRecord & { content?: Buffer }) | null> {
  const base = recordBase(filePath, workspaceRoot)
  const record = await readRecord(base)
  if (!record) return null
  if (!record.existed) return record
  try {
    return { ...record, content: await node_fs.readFile(`${base}.orig`) }
  } catch {
    // The copy is gone: the record can no longer restore anything.
    return null
  }
}

/** Forgets `filePath` once disconnect has dealt with it. */
export async function forgetOriginal(filePath: string, workspaceRoot: string): Promise<void> {
  const base = recordBase(filePath, workspaceRoot)
  await node_fs.rm(`${base}.json`, { force: true })
  await node_fs.rm(`${base}.orig`, { force: true })
}

/** Every file recorded under `root`. */
export async function recordedFiles(root: string): Promise<OriginalRecord[]> {
  let names: string[]
  try {
    names = await node_fs.readdir(ledgerDir(root))
  } catch {
    return []
  }
  const out: OriginalRecord[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const record = await readRecord(node_path.join(ledgerDir(root), name.slice(0, -'.json'.length)))
    if (record && typeof record.path === 'string') out.push(record)
  }
  return out
}

/** Removes `root`'s ledger directory once it holds no record, and `.intutic/` if that leaves it empty. */
export async function pruneLedger(root: string): Promise<void> {
  const dir = ledgerDir(root)
  try {
    const left = (await node_fs.readdir(dir)).filter((n) => n !== '.gitignore')
    if (left.length > 0) return
    await node_fs.rm(node_path.join(dir, '.gitignore'), { force: true })
    await node_fs.rmdir(dir)
    await node_fs.rmdir(node_path.dirname(dir))
  } catch {
    // Not empty, or already gone.
  }
}

// ─── Proxy URLs ──────────────────────────────────────────────────────────────

function proxyUrlsPath(): string {
  return node_path.join(ledgerDir(node_os.homedir()), 'proxy-urls.json')
}

/**
 * Remembers a proxy URL connect wrote into harness configs. Disconnect uses
 * the list to recognise a base-URL setting as Intutic's when no original was
 * kept for it.
 */
export async function noteProxyUrl(url: string): Promise<void> {
  try {
    const known = await knownProxyUrls()
    if (!url || known.includes(url)) return
    await ensureLedgerDir(ledgerDir(node_os.homedir()))
    const tmp = `${proxyUrlsPath()}.${process.pid}.tmp`
    await node_fs.writeFile(tmp, JSON.stringify([...known, url], null, 2) + '\n', { mode: 0o600 })
    await node_fs.rename(tmp, proxyUrlsPath())
  } catch {
    // Best-effort; see the module doc.
  }
}

export async function knownProxyUrls(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await node_fs.readFile(proxyUrlsPath(), 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

export async function forgetProxyUrls(): Promise<void> {
  await node_fs.rm(proxyUrlsPath(), { force: true })
}
