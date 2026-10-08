/**
 * plan.ts — the changes `intutic disconnect` will make, computed before any is
 * made, so `--dry-run` prints exactly what a real run does.
 *
 * Every reverser adds to one {@link DisconnectPlan}. A change is either a
 * file restored, rewritten or deleted, or a command run; a note is something
 * left alone on purpose, with the reason. The helpers here cover the two
 * shapes nearly every Intutic write takes:
 *
 * - {@link reverseOwnedFile}: a file Intutic writes whole (a rules file, a
 *   gate script, a hook definition it owns).
 * - {@link reverseStructuredFile}: a JSON, YAML or TOML file the user owns
 *   that Intutic merges entries into.
 *
 * Both consult the record `originals.ts` kept, and both end the same way: a
 * file that comes out semantically equal to its original gets the original
 * bytes back, so an untouched file is restored exactly even where Intutic's
 * write had reformatted it.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument, isMap, isNode, isScalar, type Document } from 'yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { forgetOriginal, readOriginal, sha256, type OriginalRecord } from './originals.js'

export interface PlannedChange {
  path: string
  /** What happens, in the words `--dry-run` prints. */
  describe: string
  /** Housekeeping (forgetting a record) that is not worth printing. */
  quiet?: boolean
  apply: () => Promise<void>
}

export interface PlanNote {
  path: string
  message: string
}

export class DisconnectPlan {
  readonly changes: PlannedChange[] = []
  readonly notes: PlanNote[] = []

  change(path: string, describe: string, apply: () => Promise<void>): void {
    this.changes.push({ path, describe, apply })
  }

  quiet(path: string, apply: () => Promise<void>): void {
    this.changes.push({ path, describe: '', quiet: true, apply })
  }

  note(path: string, message: string): void {
    this.notes.push({ path, message })
  }

  private readonly claimed = new Set<string>()

  /**
   * Claims `path` for one reverser. A file several writers touch is reversed
   * in one pass; a second claim (another harness listing the same file)
   * gets false and must leave it to the first.
   */
  claim(path: string): boolean {
    if (this.claimed.has(path)) return false
    this.claimed.add(path)
    return true
  }

  /** The changes a user should see, without the housekeeping. */
  visible(): PlannedChange[] {
    return this.changes.filter((c) => !c.quiet)
  }

  private readonly emptyDirs: string[] = []

  /**
   * Removes `dir` after every change has run, if nothing is left in it. Only
   * for directories named for Intutic (`.intutic/hooks`, a plugin directory
   * called `intutic-governance`) and ones a record says Intutic created: a
   * directory created for one file may hold another Intutic file deleted
   * later in the run, so it is retried at the end.
   */
  removeIfEmpty(dir: string): void {
    if (!this.emptyDirs.includes(dir)) this.emptyDirs.push(dir)
  }

  /** Runs every change in order, then the directory clean-up, deepest directory first. */
  async apply(): Promise<void> {
    for (const change of this.changes) await change.apply()
    const dirs = [...this.emptyDirs].sort((a, b) => b.length - a.length)
    for (const dir of dirs) {
      try {
        await node_fs.rmdir(dir)
      } catch {
        // Not empty, or not there.
      }
    }
  }
}

// ─── File operations ─────────────────────────────────────────────────────────

export async function readText(file: string): Promise<string | null> {
  try {
    return await node_fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

async function writeAtomic(file: string, content: string | Buffer, mode?: number): Promise<void> {
  let keepMode = mode
  if (keepMode === undefined) {
    try {
      keepMode = (await node_fs.stat(file)).mode & 0o7777
    } catch {
      keepMode = undefined
    }
  }
  const tmp = `${file}.intutic-disconnect-tmp`
  await node_fs.writeFile(tmp, content)
  if (keepMode !== undefined) await node_fs.chmod(tmp, keepMode)
  await node_fs.rename(tmp, file)
}

/** Deletes `file`, then each directory in `dirs` (deepest first) that is left empty. */
export async function deleteFile(file: string, dirs: string[] = []): Promise<void> {
  await node_fs.rm(file, { force: true })
  for (const dir of [...dirs].reverse()) {
    try {
      await node_fs.rmdir(dir)
    } catch {
      // Not empty (the user put something there), or already gone.
      break
    }
  }
}

/**
 * The version of `file` committed at HEAD, when it is tracked in a git
 * repository; null otherwise.
 */
export function committedVersion(file: string): Buffer | null {
  try {
    // git reports the top level as a real path; /tmp and /var are symlinks on macOS.
    const dir = realpathSync(node_path.dirname(file))
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    const rel = node_path.relative(top, node_path.join(dir, node_path.basename(file))).split(node_path.sep).join('/')
    return execFileSync('git', ['-C', top, 'show', `HEAD:${rel}`], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  } catch {
    return null
  }
}

/**
 * A recorded file that is gone already (connect stopped part way, or the
 * user deleted it): nothing to restore, but the directories Intutic made for
 * it still go if empty.
 */
function forgetMissing(plan: DisconnectPlan, file: string, record: OriginalRecord | null, forget: () => Promise<void>): void {
  if (!record) return
  if (!record.existed) record.createdDirs?.forEach((dir) => plan.removeIfEmpty(dir))
  plan.quiet(file, forget)
}

// ─── Owned files ─────────────────────────────────────────────────────────────

/**
 * Plans the reversal of a file Intutic writes whole.
 *
 * With a record: an unedited file gets its original back, or is deleted
 * along with the directories Intutic made for it; an edited one stays, with
 * a note. Without one (an earlier version wrote it): a file `isOurs` does not
 * recognise is not Intutic's and is left alone; one it does is deleted when
 * untracked, or put back to the committed version when git has one that is
 * not Intutic's.
 */
export async function reverseOwnedFile(
  plan: DisconnectPlan,
  file: string,
  workspaceRoot: string,
  isOurs: (text: string) => boolean,
  options: { beforeApply?: () => Promise<void> } = {},
): Promise<void> {
  if (!plan.claim(file)) return
  const current = await readText(file)
  const record = await readOriginal(file, workspaceRoot)
  const forget = () => forgetOriginal(file, workspaceRoot)
  const before = options.beforeApply ?? (async () => undefined)
  if (current === null) {
    forgetMissing(plan, file, record, forget)
    return
  }

  if (record) {
    const edited = record.writtenSha256 !== undefined ? sha256(current) !== record.writtenSha256 : !isOurs(current)
    if (edited) {
      plan.note(file, 'edited since Intutic wrote it, so it was left as it is')
      plan.quiet(file, forget)
      return
    }
    if (record.existed && record.content) {
      const original = record.content
      plan.change(file, 'restore the original', async () => {
        await before()
        await writeAtomic(file, original, record.mode)
        await forget()
      })
    } else {
      record.createdDirs?.forEach((dir) => plan.removeIfEmpty(dir))
      plan.change(file, 'delete (Intutic created it)', async () => {
        await before()
        await deleteFile(file, record.createdDirs)
        await forget()
      })
    }
    return
  }

  if (!isOurs(current)) return
  const committed = committedVersion(file)
  if (committed === null) {
    plan.change(file, 'delete (Intutic generated it)', async () => {
      await before()
      await deleteFile(file)
    })
  } else if (!isOurs(committed.toString('utf-8'))) {
    plan.change(file, 'restore the committed version (Intutic kept no copy of the original)', async () => {
      await before()
      await writeAtomic(file, committed)
    })
  } else {
    plan.note(file, 'Intutic generated it, but this version is committed to the repository, so it was left for you to remove')
  }
}

// ─── Structured files ────────────────────────────────────────────────────────

/**
 * How to read and write one config format. Edits work on the plain-object
 * form (`toJS`); `write` turns the edited object back into text, keeping
 * whatever the format can of the file around the edits.
 */
export interface StructuredFormat<H> {
  parse(raw: string): H
  toJS(handle: H): JsonObject
  /** `original` is the parsed original, when a record was kept: a format can copy its layout back. */
  write(handle: H, next: JsonObject, raw: string, original: H | null): string
}

export type JsonObject = Record<string, unknown>

export const jsonFormat: StructuredFormat<JsonObject> = {
  parse(raw) {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
    if (!isObject(parsed)) throw new Error('not a JSON object')
    return parsed
  },
  toJS: (doc) => structuredClone(doc),
  write(_doc, next, raw) {
    const indent = raw.match(/^([ \t]+)\S/m)?.[1] ?? 2
    return JSON.stringify(next, null, indent) + (raw === '' || raw.endsWith('\n') ? '\n' : '')
  },
}

/**
 * YAML through `yaml`'s Document: the edit is applied to the document node
 * by node, so comments and layout away from the edited keys survive.
 */
export const yamlFormat: StructuredFormat<Document> = {
  parse(raw) {
    const doc = parseDocument(raw)
    if (doc.errors.length > 0) throw doc.errors[0]
    const js: unknown = doc.toJS()
    if (js !== null && js !== undefined && !isObject(js)) throw new Error('not a YAML mapping')
    return doc
  },
  toJS: (doc) => (doc.toJS() as JsonObject | null) ?? {},
  write(doc, next, _raw, original) {
    applyDiff(doc, [], (doc.toJS() as JsonObject | null) ?? {}, next, original)
    // `[a, b]` rather than the library's default `[ a, b ]`: the way people
    // write flow lists by hand, and so the way the user's file most likely had them.
    return doc.toString({ flowCollectionPadding: false })
  },
}

/**
 * Applies the difference between two plain objects to a YAML document, key by
 * key. A key put back is placed where `after` has it, not at the end, and a
 * value put back to what the original held gets the original's node, so its
 * quoting and flow or block layout come back with it.
 */
function applyDiff(doc: Document, path: (string | number)[], before: unknown, after: unknown, original: Document | null): void {
  if (path.length > 0 && original !== null) {
    const was = original.getIn(path, true)
    if (isNode(was) && isDeepStrictEqual(was.toJSON(), after)) {
      doc.setIn(path, was.clone())
      return
    }
  }
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) doc.deleteIn([...path, key])
    }
    let previous: string | undefined
    for (const [key, value] of Object.entries(after)) {
      if (!isDeepStrictEqual(before[key], value)) applyDiff(doc, [...path, key], before[key], value, original)
      if (!(key in before)) placeAfter(doc, path, key, previous)
      previous = key
    }
    return
  }
  if (path.length === 0) return
  doc.setIn(path, after)
}

function placeAfter(doc: Document, path: (string | number)[], key: string, previous: string | undefined): void {
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true)
  if (!isMap(node)) return
  const keyOf = (pair: (typeof node.items)[number]) => (isScalar(pair.key) ? pair.key.value : pair.key)
  const at = node.items.findIndex((pair) => keyOf(pair) === key)
  if (at === -1) return
  const [pair] = node.items.splice(at, 1)
  const to = previous === undefined ? 0 : node.items.findIndex((p) => keyOf(p) === previous) + 1
  node.items.splice(to, 0, pair!)
}

/** Rebuilds `doc`'s top-level keys in `original`'s order, the rest after them as they were. */
export function orderLike(doc: JsonObject, original: JsonObject): void {
  const entries = [
    ...Object.keys(original).filter((k) => k in doc),
    ...Object.keys(doc).filter((k) => !(k in original)),
  ].map((k) => [k, doc[k]] as const)
  for (const key of Object.keys(doc)) delete doc[key]
  for (const [key, value] of entries) doc[key] = value
}

/** TOML through smol-toml. Comments are lost on a rewrite, as they were on Intutic's own write. */
export const tomlFormat: StructuredFormat<JsonObject> = {
  parse: (raw) => (raw.trim() === '' ? {} : (parseToml(raw) as JsonObject)),
  toJS: (doc) => structuredClone(doc),
  write: (_doc, next) => stringifyToml(next),
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Whether `js` holds nothing: no keys, or only empty objects and arrays. */
export function isEmptyValue(js: unknown): boolean {
  if (Array.isArray(js)) return js.length === 0
  if (isObject(js)) return Object.values(js).every(isEmptyValue)
  return js === undefined || js === null
}

export interface ReverseContext {
  /** The file as it was before Intutic first wrote it, when a record was kept. */
  original: JsonObject | null
  record: OriginalRecord | null
  /** The format's parsed form, for an edit that works on it directly (a YAML list). */
  handle: unknown
  note(message: string): void
}

/**
 * Plans the reversal of Intutic's entries in a JSON, YAML or TOML file the
 * user owns. `edit` removes them from `doc` in place and reports whether it
 * changed anything.
 *
 * The result is written only if `edit` changed something. A result equal to
 * the original gets the original bytes; a file Intutic created that ends up
 * empty is deleted; a file with no record that ends up empty is deleted only
 * when `deleteIfEmptyWithoutRecord` says an earlier version created it.
 */
export async function reverseStructuredFile<H>(
  plan: DisconnectPlan,
  file: string,
  workspaceRoot: string,
  format: StructuredFormat<H>,
  edit: (doc: JsonObject, ctx: ReverseContext) => boolean,
  options: { deleteIfEmptyWithoutRecord?: boolean } = {},
): Promise<void> {
  if (!plan.claim(file)) return
  const raw = await readText(file)
  const record = await readOriginal(file, workspaceRoot)
  const forget = () => forgetOriginal(file, workspaceRoot)
  if (raw === null) {
    forgetMissing(plan, file, record, forget)
    return
  }

  let handle: H
  try {
    handle = format.parse(raw)
  } catch {
    plan.note(file, 'does not parse, so Intutic could not remove its entries; remove them by hand')
    if (record) plan.quiet(file, forget)
    return
  }
  let originalHandle: H | null = null
  if (record?.existed && record.content) {
    try {
      originalHandle = format.parse(record.content.toString('utf-8'))
    } catch {
      originalHandle = null
    }
  }
  const original = originalHandle === null ? null : format.toJS(originalHandle)

  const doc = format.toJS(handle)
  const changed = edit(doc, { original, record, handle, note: (message) => plan.note(file, message) })
  if (!changed) {
    if (record) plan.quiet(file, forget)
    return
  }

  if (record && !record.existed && isEmptyValue(doc)) {
    record.createdDirs?.forEach((dir) => plan.removeIfEmpty(dir))
    plan.change(file, 'delete (Intutic created it)', async () => {
      await deleteFile(file, record.createdDirs)
      await forget()
    })
  } else if (!record && options.deleteIfEmptyWithoutRecord && isEmptyValue(doc)) {
    plan.change(file, 'delete (only Intutic entries were in it)', () => deleteFile(file))
  } else if (record?.existed && record.content && original !== null && isDeepStrictEqual(doc, original)) {
    const bytes = record.content
    plan.change(file, 'restore the original', async () => {
      await writeAtomic(file, bytes, record.mode)
      await forget()
    })
  } else {
    const next = format.write(handle, doc, raw, originalHandle)
    plan.change(file, 'remove the Intutic entries', async () => {
      await writeAtomic(file, next)
      if (record) await forget()
    })
  }
}

/**
 * Plans the reversal of Intutic's lines in a text config edited line by line
 * (Codex's and OpenHands' TOML, where a rewrite through a parser would drop
 * the user's comments). `edit` returns the new text, or null for no change;
 * `parse` is only used to compare: a result that means the same as the
 * original gets the original bytes back.
 */
export async function reverseTextFile(
  plan: DisconnectPlan,
  file: string,
  workspaceRoot: string,
  parse: (text: string) => unknown,
  edit: (text: string, ctx: { originalText: string | null; note(message: string): void }) => string | null,
): Promise<void> {
  if (!plan.claim(file)) return
  const raw = await readText(file)
  const record = await readOriginal(file, workspaceRoot)
  const forget = () => forgetOriginal(file, workspaceRoot)
  if (raw === null) {
    forgetMissing(plan, file, record, forget)
    return
  }
  const originalText = record?.existed && record.content ? record.content.toString('utf-8') : null
  const next = edit(raw, { originalText, note: (message) => plan.note(file, message) })
  if (next === null || next === raw) {
    if (record) plan.quiet(file, forget)
    return
  }
  const same = (a: string, b: string) => {
    try {
      return isDeepStrictEqual(parse(a), parse(b))
    } catch {
      return false
    }
  }
  if (record && !record.existed && next.trim() === '') {
    record.createdDirs?.forEach((dir) => plan.removeIfEmpty(dir))
    plan.change(file, 'delete (Intutic created it)', async () => {
      await deleteFile(file, record.createdDirs)
      await forget()
    })
  } else if (record?.existed && record.content && originalText !== null && same(next, originalText)) {
    const bytes = record.content
    plan.change(file, 'restore the original', async () => {
      await writeAtomic(file, bytes, record.mode)
      await forget()
    })
  } else {
    plan.change(file, 'remove the Intutic entries', async () => {
      await writeAtomic(file, next)
      if (record) await forget()
    })
  }
}

// ─── Editing helpers ─────────────────────────────────────────────────────────

type Container = JsonObject | unknown[]

function child(cur: unknown, key: string): unknown {
  if (Array.isArray(cur)) return /^\d+$/.test(key) ? cur[Number(key)] : undefined
  return isObject(cur) ? cur[key] : undefined
}

/** Reads the value at `path`; array elements are addressed by their index. */
export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj
  for (const key of path) cur = child(cur, key)
  return cur
}

/** Sets `path` to `value`, creating objects on the way. */
export function setPath(doc: JsonObject, path: readonly string[], value: unknown): void {
  let cur: Container = doc
  for (const key of path.slice(0, -1)) {
    let next = child(cur, key)
    if (!isObject(next) && !Array.isArray(next)) {
      next = {}
      ;(cur as JsonObject)[key] = next
    }
    cur = next as Container
  }
  ;(cur as JsonObject)[path[path.length - 1]!] = value
}

/** Removes the key at `path`. Array elements are never removed this way: it would renumber their siblings. */
export function deletePath(doc: JsonObject, path: readonly string[]): boolean {
  const parent = getPath(doc, path.slice(0, -1))
  const key = path[path.length - 1]!
  if (!isObject(parent) || !(key in parent)) return false
  delete parent[key]
  return true
}

/**
 * Walks up from `path`, removing each empty object or array that the
 * original did not have (with no original, every empty one: Intutic made it).
 */
export function pruneEmpty(doc: JsonObject, path: readonly string[], original: JsonObject | null): void {
  for (let depth = path.length; depth > 0; depth--) {
    const p = path.slice(0, depth)
    const value = getPath(doc, p)
    if (value === undefined) continue
    if (!(Array.isArray(value) || isObject(value)) || !isEmptyValue(value)) return
    if (original !== null && getPath(original, p) !== undefined) return
    if (!deletePath(doc, p)) return
  }
}

/**
 * Removes the elements of the array at `path` that `isOurs` claims. An array
 * (and each parent object) left empty is removed too, unless the original
 * had it there.
 */
export function removeFromArray(
  doc: JsonObject,
  path: readonly string[],
  isOurs: (entry: unknown) => boolean,
  original: JsonObject | null,
): boolean {
  const arr = getPath(doc, path)
  if (!Array.isArray(arr)) return false
  const kept = arr.filter((e) => !isOurs(e))
  if (kept.length === arr.length) return false
  setPath(doc, path, kept)
  pruneEmpty(doc, path, original)
  return true
}

/**
 * Puts a key Intutic overwrote back. With an original, the key gets the
 * original's value, or is removed when the original had none. Without one,
 * the key is removed (the earlier value is unknown, and the harness's
 * default is closer to it than Intutic's), with a note saying so. Only a key
 * whose current value `isIntutic` recognises is touched: anything else was
 * set since by someone else.
 */
export function restoreKey(
  doc: JsonObject,
  path: readonly string[],
  ctx: Pick<ReverseContext, 'original' | 'note'>,
  isIntutic: (value: unknown) => boolean,
): boolean {
  const current = getPath(doc, path)
  if (current === undefined || !isIntutic(current)) return false
  const { original } = ctx
  if (original !== null) {
    const was = getPath(original, path)
    if (isDeepStrictEqual(was, current)) return false
    if (was === undefined) deletePath(doc, path)
    else setPath(doc, path, structuredClone(was))
    pruneEmpty(doc, path.slice(0, -1), original)
    return true
  }
  deletePath(doc, path)
  pruneEmpty(doc, path.slice(0, -1), null)
  ctx.note(`${path.join('.')} was removed rather than restored: an earlier Intutic version set it without keeping the value it replaced`)
  return true
}

/**
 * Applies {@link restoreKey} to every string value in `doc` that `isIntutic`
 * recognises, wherever it sits — for writers that set a proxy URL on every
 * model, or on whichever key a pattern happened to match.
 */
export function restoreMatchingValues(
  doc: JsonObject,
  ctx: Pick<ReverseContext, 'original' | 'note'>,
  isIntutic: (value: unknown) => boolean,
): boolean {
  const paths: string[][] = []
  const walk = (value: unknown, path: string[]) => {
    if (typeof value === 'string' && isIntutic(value)) paths.push(path)
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, String(i)]))
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, [...path, k])
  }
  walk(doc, [])
  let changed = false
  for (const path of paths) changed = restoreKey(doc, path, ctx, isIntutic) || changed
  return changed
}

/** Runs every edit (none short-circuits the others) and reports whether any changed something. */
export function allEdits(...results: boolean[]): boolean {
  return results.some(Boolean)
}
