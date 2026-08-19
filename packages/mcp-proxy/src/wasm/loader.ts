/**
 * wasm/loader.ts — `~/.intutic/wasm/` directory loader.
 *
 * Direct TypeScript port of `packages/proxy/src/wasm/local_loader.rs`'s
 * directory-resolution order, `NN_name.wasm` priority parsing, the 10MB
 * per-file size cap, and mtime+size-based change detection — confirmed by
 * reading that file, not guessed. Compilation and import validation
 * themselves happen in the worker (`worker.ts`); this module owns file
 * discovery, diffing, and the fail-open-per-file bookkeeping (a corrupt or
 * oversized file is skipped and logged; if a previous good rule was loaded
 * from that same file, it is retained rather than dropped).
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { createStderrLogger as createLogger } from '../stderrLog.js'

const log = createLogger('mcp-proxy-wasm-loader')

/** Ported from `local_loader.rs`'s `MAX_RULE_FILE_BYTES`. */
export const MAX_RULE_FILE_BYTES = 10 * 1024 * 1024

/** Ported from `local_loader.rs`'s `DEFAULT_PRIORITY`. */
export const DEFAULT_PRIORITY = 100

/**
 * Resolve the local rules directory: `INTUTIC_WASM_DIR` env var, then the
 * caller-supplied config override, then `~/.intutic/wasm` — same precedence
 * order as `local_loader.rs`'s `resolve_local_dir` (confirmed by its own
 * `resolve_dir_precedence` test: env wins over config, config wins over the
 * home default).
 */
export function resolveWasmDir(configOverride?: string): string {
  const envDir = process.env['INTUTIC_WASM_DIR']
  if (envDir) return expandHome(envDir)
  if (configOverride) return expandHome(configOverride)
  return node_path.join(node_os.homedir(), '.intutic', 'wasm')
}

function expandHome(raw: string): string {
  if (raw.startsWith('~/')) return node_path.join(node_os.homedir(), raw.slice(2))
  return raw
}

/**
 * Parse `NN_name.wasm` into `{ priority, name }`. Ported from
 * `local_loader.rs`'s `parse_priority`, including its edge cases:
 * `10_block-prod-db.wasm` -> `{10, "block-prod-db"}`; `my-rule.wasm` ->
 * `{100, "my-rule"}`; a non-numeric or empty prefix (`block_prod.wasm`,
 * `_hidden.wasm`) also defaults to priority 100 with the whole stem as the name.
 */
export function parsePriority(fileName: string): { priority: number; name: string } {
  const stem = fileName.endsWith('.wasm') ? fileName.slice(0, -'.wasm'.length) : fileName
  const idx = stem.indexOf('_')
  if (idx > 0 && idx < stem.length - 1) {
    const prefix = stem.slice(0, idx)
    const rest = stem.slice(idx + 1)
    if (/^\d+$/.test(prefix)) {
      return { priority: Number.parseInt(prefix, 10), name: rest }
    }
  }
  return { priority: DEFAULT_PRIORITY, name: stem }
}

export interface FileSignature {
  mtimeMs: number
  size: number
}

/**
 * `(mtime, size)` signature of every `*.wasm` file in `dir`, keyed by full
 * path. A missing directory returns an empty map (first-run UX, ported from
 * `scan_signatures`'s own `NotFound` handling) — any other I/O error
 * propagates so the caller can retain the previously loaded rules instead of
 * mistaking a transient EACCES/EIO for "every rule was deleted."
 */
export async function scanSignatures(dir: string): Promise<Map<string, FileSignature>> {
  const signatures = new Map<string, FileSignature>()
  let entries: import('node:fs').Dirent[]
  try {
    entries = await node_fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return signatures
    throw err
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.wasm')) continue
    const full = node_path.join(dir, entry.name)
    try {
      const stat = await node_fs.stat(full)
      signatures.set(full, { mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      // Vanished between readdir and stat (race with a concurrent
      // write/delete) — skip it this pass; the next rescan sees whatever
      // state settles.
    }
  }
  return signatures
}

function signaturesEqual(a: Map<string, FileSignature>, b: Map<string, FileSignature>): boolean {
  if (a.size !== b.size) return false
  for (const [key, sig] of a) {
    const other = b.get(key)
    if (!other || other.mtimeMs !== sig.mtimeMs || other.size !== sig.size) return false
  }
  return true
}

export interface LoadedRuleMeta {
  /** `local:<file name>` — same convention `local_loader.rs` uses. */
  ruleId: string
  fileName: string
  name: string
  priority: number
  readsReferencedFiles: boolean
  /** Cached raw bytes, so a worker respawn (wasm/runner.ts) can resend every
   *  currently-loaded rule without re-reading the directory from disk. */
  bytes: Uint8Array
}

export type CompileOutcome =
  | { ok: true; readsReferencedFiles: boolean }
  | { ok: false; error: string; unsupportedImports?: string[] }

/** What `WasmLoader` needs from the worker to load/unload a rule — implemented by `WasmRunner`. */
export interface CompileBridge {
  compile(ruleId: string, bytes: Uint8Array): Promise<CompileOutcome>
  remove(ruleId: string): void
}

/**
 * Tracks the local rules directory's current state: which files exist, their
 * change signatures, and the rule metadata successfully compiled from each.
 * Fail-open per file — see this module's doc comment.
 */
export class WasmLoader {
  private signatures = new Map<string, FileSignature>()
  private loaded = new Map<string, LoadedRuleMeta>() // keyed by file path

  constructor(private readonly dir: string) {}

  getDir(): string {
    return this.dir
  }

  /** Currently loaded rules, priority order (lower runs first), ties in file-scan order. */
  getRules(): LoadedRuleMeta[] {
    return [...this.loaded.values()].sort((a, b) => a.priority - b.priority)
  }

  /**
   * Rescans the directory and (re)compiles anything changed via `bridge`.
   * `force` reloads every current file unconditionally (used by the
   * policy-tick hook after a worker respawn, where the worker's own module
   * cache was lost and must be rebuilt even though nothing on disk moved).
   */
  async rescan(bridge: CompileBridge, force = false): Promise<void> {
    let newSignatures: Map<string, FileSignature>
    try {
      newSignatures = await scanSignatures(this.dir)
    } catch (err) {
      log.warn(
        { action: 'wasm_scan_error', dir: this.dir, err: (err as Error).message },
        'local WASM rule directory scan failed — keeping previously loaded rules',
      )
      return
    }

    if (!force && signaturesEqual(newSignatures, this.signatures)) return

    // Removed files.
    for (const filePath of [...this.loaded.keys()]) {
      if (!newSignatures.has(filePath)) {
        const meta = this.loaded.get(filePath)
        if (meta) bridge.remove(meta.ruleId)
        this.loaded.delete(filePath)
      }
    }

    // New or changed files.
    for (const [filePath, sig] of newSignatures) {
      const previousSig = this.signatures.get(filePath)
      const changed = force || !previousSig || previousSig.mtimeMs !== sig.mtimeMs || previousSig.size !== sig.size
      if (!changed) continue

      const fileName = node_path.basename(filePath)
      const ruleId = `local:${fileName}`

      if (sig.size > MAX_RULE_FILE_BYTES) {
        log.warn(
          { action: 'wasm_rule_too_large', file: filePath, sizeBytes: sig.size, capBytes: MAX_RULE_FILE_BYTES },
          'local WASM rule exceeds size cap — skipped',
        )
        continue // fail-open-per-file: whatever was in `this.loaded` for this path (if anything) stays
      }

      let bytes: Buffer
      try {
        bytes = await node_fs.readFile(filePath)
      } catch (err) {
        log.warn(
          { action: 'wasm_rule_read_error', file: filePath, err: (err as Error).message },
          'local WASM rule failed to read — retaining previous version if any',
        )
        continue
      }

      const result = await bridge.compile(ruleId, bytes)
      if (result.ok) {
        const { priority, name } = parsePriority(fileName)
        this.loaded.set(filePath, {
          ruleId,
          fileName,
          name,
          priority,
          readsReferencedFiles: result.readsReferencedFiles,
          bytes,
        })
      } else {
        log.warn(
          {
            action: 'wasm_rule_load_error',
            file: filePath,
            error: result.error,
            unsupportedImports: result.unsupportedImports,
          },
          'local WASM rule failed to load — retaining previous version if any',
        )
        // Fail-open-per-file: do NOT touch `this.loaded.get(filePath)` — a
        // previously good module (if any) for this exact path stays active.
      }
    }

    this.signatures = newSignatures
  }
}
