/**
 * wasm/referencedFiles.ts — The MCP-side resolver behind the
 * `read_referenced_file` host import (TD-441). A 1:1 port of
 * `packages/proxy/src/wasm/referenced_files.rs`: same constants, same error
 * codes, same candidate-token rules, same six guards, same realpath
 * confinement. Where the two differ it is stated at the site.
 *
 * ## The design, in one paragraph
 *
 * A rule never names a file. The proxy derives the candidate paths from the
 * CURRENT tool call's arguments (structured path keys and the shell words of
 * a command), keeps the manifest-shaped ones, resolves each under the
 * operator-configured root with every symlink followed, and reads the ones
 * that survive — all BEFORE the sandbox exists. The guest then passes a path
 * as a lookup key into that fixed table. There is no code path from a guest
 * string to `open(2)`.
 *
 * ## Guards (numbered as in the Rust module)
 *
 * 1. Only paths the tool call literally named (no glob expansion).
 * 2. Only manifest extensions.
 * 3. No `..` component; no platform prefix.
 * 4. Realpath must stay under the realpath'd root (symlink escape covered).
 * 5. Regular files only.
 * 6. Size-capped, checked on the stat AND on the read.
 *
 * ## Divergence from the Rust module
 *
 * Reads are `fs/promises` (async) rather than a blocking pool — the runner
 * awaits them once per evaluation, before any rule runs, so the per-rule
 * deadline still covers only guest execution. The residual TOCTOU between
 * `realpath` and `open` is the same one `referenced_files.rs` documents;
 * closing it needs `openat2(RESOLVE_BENEATH)`, which Node does not expose.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStderrLogger as createLogger } from '../stderrLog.js'

const log = createLogger('mcp-proxy-wasm-referenced-files')

/** Largest file the host will hand to a rule. `referenced_files.rs`: 256 KiB. */
export const MAX_REFERENCED_FILE_BYTES = 256 * 1024
/** Candidate paths considered per evaluation. */
export const MAX_REFERENCED_FILES = 8
/** Longest path a guest may ask for. */
export const MAX_GUEST_PATH_BYTES = 4096
/** How much of a shell command is scanned for operands. */
const MAX_COMMAND_SCAN_BYTES = 64 * 1024

// Error codes, verbatim from `referenced_files.rs`. Negative so a guest can
// tell a length from a refusal with one comparison.
export const ERR_BAD_ARGS = -1
export const ERR_REFUSED = -2
export const ERR_NOT_FOUND = -3
export const ERR_TOO_LARGE = -4
export const ERR_BUFFER_TOO_SMALL = -5
export const ERR_BUDGET = -6

/** Host calls one evaluation may make, charged before argument validation. */
export const MAX_READS_PER_EVALUATION = 64

/** The operator-configured root. Unset means the capability is off. */
export const MANIFEST_ROOT_ENV = 'INTUTIC_WASM_MANIFEST_ROOT'

const MANIFEST_EXTENSIONS = new Set(['yaml', 'yml', 'json', 'tf', 'tfvars', 'hcl', 'toml'])

const PATH_ARG_KEYS = ['file_path', 'filepath', 'path', 'filename', 'target_file', 'notebook_path', 'manifest'] as const
const COMMAND_ARG_KEYS = ['command', 'cmd', 'script'] as const

/** One candidate's fate. `content` carries bytes; everything else a code. */
export type Outcome =
  | { kind: 'content'; bytes: Uint8Array }
  | { kind: 'refused'; why: string }
  | { kind: 'not_found' }
  | { kind: 'too_large'; size: number }

/** The structured-clone-safe wire form the runner posts to the worker. */
export type ReferencedFilesTable = Array<[string, Outcome]>

export interface ToolCallLike {
  name: string
  arguments: unknown
}

/**
 * The pre-read table one evaluation sees. Immutable after construction; the
 * worker rebuilds it from `toTable()` on its side of `postMessage`.
 */
export class ReferencedFiles {
  private constructor(private readonly entries: ReferencedFilesTable) {}

  static empty(): ReferencedFiles {
    return new ReferencedFiles([])
  }

  static fromTable(table: ReferencedFilesTable | undefined): ReferencedFiles {
    return new ReferencedFiles(table ? table.map(([t, o]) => [t, o]) : [])
  }

  toTable(): ReferencedFilesTable {
    return this.entries.map(([t, o]) => [t, o])
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }

  readableCount(): number {
    return this.entries.filter(([, o]) => o.kind === 'content').length
  }

  /** The bytes for `requested`, or the error code the guest gets. */
  lookup(requested: string): { ok: true; bytes: Uint8Array } | { ok: false; code: number } {
    const hit = this.entries.find(([t]) => t === requested)
    if (!hit) return { ok: false, code: ERR_REFUSED }
    const o = hit[1]
    switch (o.kind) {
      case 'content':
        return { ok: true, bytes: o.bytes }
      case 'not_found':
        return { ok: false, code: ERR_NOT_FOUND }
      case 'too_large':
        return { ok: false, code: ERR_TOO_LARGE }
      case 'refused':
        return { ok: false, code: ERR_REFUSED }
    }
  }

  /** Operator-facing reason. Never handed to the guest. */
  refusalReason(requested: string): string {
    const hit = this.entries.find(([t]) => t === requested)
    if (!hit) return "not referenced by this request's tool calls"
    const o = hit[1]
    switch (o.kind) {
      case 'refused':
        return o.why
      case 'not_found':
        return 'does not exist'
      case 'too_large':
        return 'exceeds the size cap'
      case 'content':
        return 'readable'
    }
  }

  /** Debug rendering: states, never contents. */
  describe(): string {
    return this.entries
      .map(([t, o]) => {
        switch (o.kind) {
          case 'content':
            return `${t} => readable(${o.bytes.length} bytes)`
          case 'refused':
            return `${t} => refused(${o.why})`
          case 'not_found':
            return `${t} => not_found`
          case 'too_large':
            return `${t} => too_large(${o.size} bytes)`
        }
      })
      .join(', ')
  }
}

/** The configured root, `~/` expanded. `undefined` keeps the capability off. */
export function resolveRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[MANIFEST_ROOT_ENV]
  if (!raw) return undefined
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/**
 * Guard 1 and 2: every manifest-shaped path the tool calls literally name,
 * deduped, capped at `MAX_REFERENCED_FILES`, in first-seen order.
 */
export function candidateTokens(toolCalls: readonly ToolCallLike[]): string[] {
  const out: string[] = []
  for (const call of toolCalls) {
    const args = call.arguments
    if (typeof args !== 'object' || args === null || Array.isArray(args)) continue
    const map = args as Record<string, unknown>
    for (const key of PATH_ARG_KEYS) {
      const value = map[key]
      if (typeof value === 'string') consider(value, out)
    }
    for (const key of COMMAND_ARG_KEYS) {
      const value = map[key]
      if (typeof value === 'string') {
        const scanned = value.length > MAX_COMMAND_SCAN_BYTES ? value.slice(0, MAX_COMMAND_SCAN_BYTES) : value
        for (const token of shellTokens(scanned)) consider(token, out)
      }
    }
    if (out.length >= MAX_REFERENCED_FILES) break
  }
  return out
}

function consider(raw: string, out: string[]): void {
  if (out.length >= MAX_REFERENCED_FILES) return
  const trimmed = raw.replace(/^["']+|["']+$/g, '')
  // `--values=charts/prod.yaml` is one shell word carrying one path. Only
  // option-shaped words are split, so a filename that legitimately contains
  // `=` is passed through rather than silently rewritten.
  let candidate = trimmed
  const eq = trimmed.indexOf('=')
  if (eq > 0 && trimmed.startsWith('-')) candidate = trimmed.slice(eq + 1)
  if (candidate.length === 0 || Buffer.byteLength(candidate) > MAX_GUEST_PATH_BYTES || !hasManifestExtension(candidate)) return
  if (out.includes(candidate)) return
  out.push(candidate)
}

function hasManifestExtension(token: string): boolean {
  const ext = path.extname(token)
  if (!ext) return false
  return MANIFEST_EXTENSIONS.has(ext.slice(1).toLowerCase())
}

/**
 * Split a command into shell words. Quotes group; whitespace and the
 * metacharacters that end a word separate. Deliberately does NOT expand
 * globs, variables or command substitution — an unexpanded `*.yaml` simply
 * fails to resolve and the guest is told so.
 */
export function shellTokens(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = () => {
    if (current.length > 0) {
      out.push(current)
      current = ''
    }
  }
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
    } else if (';|&<>()`'.includes(ch) || /\s/.test(ch)) {
      flush()
    } else {
      current += ch
    }
  }
  flush()
  return out
}

/** Resolve and read every candidate under `root`. Async, so the runner awaits it once per evaluation. */
export async function readTokens(tokens: readonly string[], root: string): Promise<ReferencedFiles> {
  if (tokens.length === 0) return ReferencedFiles.empty()

  // Canonicalised per batch, not once per process: the root is operator
  // configured and may be created after the proxy starts.
  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(root)
  } catch (err) {
    log.warn(
      { action: 'wasm_manifest_root_unresolvable', root, err: err instanceof Error ? err.message : String(err) },
      `${MANIFEST_ROOT_ENV} does not resolve — every referenced-file read will be refused`,
    )
    return ReferencedFiles.fromTable(
      tokens.map((t) => [t, { kind: 'refused', why: 'the configured manifest root does not resolve' }]),
    )
  }

  const table: ReferencedFilesTable = []
  for (const token of tokens) {
    const outcome = await readOne(canonicalRoot, token)
    if (outcome.kind === 'content') {
      log.debug(
        {
          action: 'wasm_referenced_file_exposed',
          path: token,
          bytes: outcome.bytes.length,
          // A content hash, not the content: enough to explain why a replay
          // produced a different verdict without copying a manifest into
          // telemetry.
          sha256Prefix: createHash('sha256').update(outcome.bytes).digest('hex').slice(0, 16),
        },
        'referenced file exposed to WASM rules',
      )
    } else {
      log.debug(
        { action: 'wasm_referenced_file_withheld', path: token, reason: describeOutcome(outcome) },
        'referenced file withheld from WASM rules',
      )
    }
    table.push([token, outcome])
  }
  return ReferencedFiles.fromTable(table)
}

function describeOutcome(o: Outcome): string {
  switch (o.kind) {
    case 'refused':
      return o.why
    case 'not_found':
      return 'does not exist'
    case 'too_large':
      return 'exceeds the size cap'
    case 'content':
      return 'readable'
  }
}

/** Convenience for callers with tool calls in hand. */
export function prefetch(toolCalls: readonly ToolCallLike[], root: string): Promise<ReferencedFiles> {
  return readTokens(candidateTokens(toolCalls), root)
}

/**
 * Guards 3–6 on one candidate. Ordered so nothing touches the filesystem
 * until the lexical checks pass: a `..` path is refused without a `stat`, so
 * the import cannot probe for files outside the root.
 */
async function readOne(canonicalRoot: string, token: string): Promise<Outcome> {
  if (token.length === 0 || token.includes('\0')) return { kind: 'refused', why: 'is empty or contains a NUL byte' }

  const parts = token.split(/[\\/]+/)
  if (parts.includes('..')) return { kind: 'refused', why: 'contains a `..` component' }
  // Windows drive/UNC prefixes. Refused rather than reasoned about; the
  // proxy's deployment target is Unix.
  if (/^[A-Za-z]:/.test(token) || token.startsWith('\\\\')) return { kind: 'refused', why: 'carries a platform path prefix' }

  const joined = path.isAbsolute(token) ? token : path.join(canonicalRoot, token)

  let resolved: string
  try {
    resolved = await fs.realpath(joined)
  } catch (err) {
    if (isNotFound(err)) return { kind: 'not_found' }
    return { kind: 'refused', why: 'could not be resolved' }
  }

  if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
    return { kind: 'refused', why: 'resolves outside the configured manifest root' }
  }

  let meta: Awaited<ReturnType<typeof fs.lstat>>
  try {
    meta = await fs.lstat(resolved)
  } catch (err) {
    if (isNotFound(err)) return { kind: 'not_found' }
    return { kind: 'refused', why: 'could not be inspected' }
  }
  if (!meta.isFile()) return { kind: 'refused', why: 'is not a regular file' }
  if (meta.size > MAX_REFERENCED_FILE_BYTES) return { kind: 'too_large', size: meta.size }

  // Bounded independently of the stat: the file may have grown between the
  // two, and an unbounded read is how an endless file becomes an OOM.
  let handle: fs.FileHandle
  try {
    handle = await fs.open(resolved, 'r')
  } catch (err) {
    if (isNotFound(err)) return { kind: 'not_found' }
    return { kind: 'refused', why: 'could not be opened' }
  }
  try {
    const buf = new Uint8Array(MAX_REFERENCED_FILE_BYTES + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_REFERENCED_FILE_BYTES) return { kind: 'too_large', size: total }
    return { kind: 'content', bytes: buf.slice(0, total) }
  } catch {
    return { kind: 'refused', why: 'could not be read' }
  } finally {
    await handle.close()
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
