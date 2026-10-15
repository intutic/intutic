/**
 * sopFiles.ts — which files under `.intutic/sops/` are SOPs.
 *
 * Two layouts, both read by every reader: `*.md` directly in the directory
 * (what `intutic sops pull` and `intutic guardrails pull` write) and `*.md`
 * one folder down, `<set>/*.md`, a rule set. The proxy reads the same two
 * (`sop_files` in `packages/proxy/src/sops.rs`); before they agreed, the proxy
 * read only the flat files and `intutic connect` only the folders, so a SOP
 * was in force at one layer and missing from the other.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'

/** One SOP file under `.intutic/sops/`. */
export interface SopFile {
  /** Absolute path. */
  path: string
  /** The rule-set folder it is in, or null for a file directly in `.intutic/sops/`. */
  folder: string | null
  /** The file name, `rules.md`. */
  file: string
}

/**
 * The SOP files in `sopsDir`, sorted by folder then name, flat files first.
 * Deeper folders are not read, nor folders whose name starts with `.` (the
 * proxy skips them because a Kubernetes ConfigMap volume keeps its files under
 * `..data/`; the same set is read here).
 *
 * Rejects when `sopsDir` cannot be read (`ENOENT` when there is none), so a
 * caller can tell "no SOPs" from "SOPs it could not read". A folder that
 * cannot be read is skipped, as the proxy skips it, and handed to `onSkipped`.
 */
export async function listSopFiles(
  sopsDir: string,
  onSkipped?: (folder: string, err: unknown) => void,
): Promise<SopFile[]> {
  const entries = await node_fs.readdir(sopsDir, { withFileTypes: true })
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const flat: SopFile[] = []
  const nested: SopFile[] = []
  for (const e of [...entries].sort(byName)) {
    const path = node_path.join(sopsDir, e.name)
    // A symlink is followed, as the proxy's `is_dir` / `is_file` follow it.
    const kind = e.isSymbolicLink() ? await node_fs.stat(path).catch(() => null) : e
    if (kind?.isFile() && e.name.endsWith('.md')) {
      flat.push({ path, folder: null, file: e.name })
    } else if (kind?.isDirectory() && !e.name.startsWith('.')) {
      let inner: import('node:fs').Dirent[]
      try {
        inner = await node_fs.readdir(path, { withFileTypes: true })
      } catch (err) {
        onSkipped?.(path, err)
        continue
      }
      for (const f of [...inner].sort(byName)) {
        const filePath = node_path.join(path, f.name)
        const fileKind = f.isSymbolicLink() ? await node_fs.stat(filePath).catch(() => null) : f
        if (fileKind?.isFile() && f.name.endsWith('.md')) nested.push({ path: filePath, folder: e.name, file: f.name })
      }
    }
  }
  return [...flat, ...nested]
}

/**
 * The `intutic_id:` a SOP file's front matter records — the control-plane SOP
 * `intutic sops pull` / `push` synced it with — or null. Read line by line, no
 * regex over the whole file: the content is whatever an agent wrote.
 */
export function recordedSopId(content: string): string | null {
  const lines = content.trimStart().split('\n')
  if (lines[0]?.trim() !== '---') return null
  for (const line of lines.slice(1)) {
    const t = line.trim()
    if (t === '---') return null
    if (t.startsWith('intutic_id:')) {
      const v = t.slice('intutic_id:'.length).trim().replace(/^["']|["']$/g, '')
      return v || null
    }
  }
  return null
}
