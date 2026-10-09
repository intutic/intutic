/**
 * aiderConfigMerger.ts — Safe YAML merge for .aider.conf.yml.
 *
 * Reads any existing .aider.conf.yml, STRIPS dangerous auto-exec keys
 * (test-cmd, lint-cmd, auto-test, auto-lint), merges in the Intutic proxy
 * routing, and writes back atomically. Everything else in the file — lists,
 * nested values, comments — is kept: the file is edited through the `yaml`
 * library's document model, never re-serialised from a flattened copy.
 *
 * Aider rejects any config key that is not one of its command-line options
 * ("unrecognized arguments"), so only real options are written:
 *
 * - `openai-api-base` — the proxy's OpenAI-style base URL (host + `/v1`).
 * - `set-env: ANTHROPIC_BASE_URL=<host>` — Aider has no Anthropic base-URL
 *   option; its model layer (LiteLLM) reads this variable, and wants the bare
 *   host because it appends `/v1/messages` itself. Entries the user set for
 *   other variables are kept.
 * - `read: <workspace>/.intutic/aider-sops.md` — the SOP text, as a
 *   read-only context file (Aider's own mechanism for conventions), written
 *   next to the config. The path is absolute: Aider resolves `read` entries
 *   against the directory it was started in (`Path(fn).expanduser().resolve()`,
 *   https://github.com/Aider-AI/aider/blob/main/aider/main.py), while it finds
 *   this config at the git root from any subdirectory
 *   (https://aider.chat/docs/config/aider_conf.html). A relative entry was
 *   missed whenever Aider ran below the workspace root.
 *
 * Earlier versions wrote `anthropic-api-base` and `extra-instructions`, which
 * are not Aider options and stopped Aider from starting; both are removed.
 *
 * A file that does not parse as YAML, or is not a mapping, is left untouched.
 *
 * Each strip emits a governance_config_sanitized log entry visible in
 * the control plane audit feed.
 *
 * LLD #14 — Phase 3 cross-harness defence
 * HLD §3.14 — Three-Tier Defense Cascade
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseDocument, isMap, isSeq, isScalar, YAMLSeq, type Document } from 'yaml'
import { createLogger } from '@intutic/logger'
import { keepOriginal } from '../disconnect/originals.js'
import { anthropicBaseUrl, openaiBaseUrl } from '@intutic/shared-types'

const log = createLogger('sync-aider-merger')

/**
 * Keys that Aider auto-executes on startup without user confirmation.
 * Stripping these prevents supply-chain persistence attacks.
 */
const SUPPRESSED_KEYS = ['test-cmd', 'lint-cmd', 'auto-test', 'auto-lint', 'test_cmd', 'lint_cmd']

/** Keys earlier versions wrote that Aider rejects as unrecognized arguments. */
const INVALID_LEGACY_KEYS = ['anthropic-api-base', 'extra-instructions']

/** SOP file, relative to the workspace root. */
export const AIDER_SOPS_FILE = '.intutic/aider-sops.md'

/** Header written at the top of the file. Kept short: it sits above the
 *  user's own content, and is replaced, not stacked, on every sync. */
const HEADER = [
  '# Intutic: openai-api-base, the ANTHROPIC_BASE_URL set-env entry and the',
  `# ${AIDER_SOPS_FILE} read entry are managed by intutic connect. test-cmd,`,
  '# lint-cmd, auto-test and auto-lint are removed on every sync.',
]

/** The decisions log's file, relative to the workspace root. */
export const AIDER_DECISIONS_FILE = '.intutic/aider-decisions.md'

/** Whether a `read` entry is the SOP file: the absolute path this version
 *  writes, or the workspace-relative one earlier versions wrote. */
export function isAiderSopsEntry(value: unknown, workspaceRoot: string): boolean {
  return value === AIDER_SOPS_FILE || value === path.join(workspaceRoot, AIDER_SOPS_FILE)
}

/** Whether a `read` entry is one connect added: the SOP file or the decisions log's. */
export function isAiderIntuticEntry(value: unknown, workspaceRoot: string): boolean {
  return isAiderSopsEntry(value, workspaceRoot) || value === path.join(workspaceRoot, AIDER_DECISIONS_FILE)
}

/** Leading lines this product wrote (the header above, or the one earlier
 *  versions wrote), removed before the file is parsed. */
const OWN_HEADER_LINE = /^# (Intutic: |Intutic Governance Rules \(auto-generated|Last sync: |WARNING: test-cmd and lint-cmd keys are suppressed|\.intutic\/aider-sops\.md read entry|lint-cmd, auto-test and auto-lint are removed)/

export function stripOwnHeader(raw: string): string {
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length && OWN_HEADER_LINE.test(lines[i])) i++
  if (i === 0) return raw
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n')
}

/** Result of merging the Intutic keys into an Aider config's text. */
export interface AiderMergeResult {
  /** New file content, or `null` when the file must be left untouched. */
  content: string | null
  /** Suppressed keys that were removed. */
  stripped: string[]
}

/** Turn `key`'s value into a sequence (a scalar becomes a one-item list). */
function ensureSeq(doc: Document, key: string): YAMLSeq {
  const current = doc.get(key, true)
  if (isSeq(current)) return current
  const seq = new YAMLSeq()
  if (isScalar(current) && current.value !== null && current.value !== '') seq.add(current.value)
  doc.set(key, seq)
  return seq
}

/**
 * Merge the Intutic keys into the text of an `.aider.conf.yml`.
 *
 * @param raw           - Current file content ('' when the file does not exist).
 * @param proxyUrl      - The proxy host (a trailing `/v1` is tolerated).
 * @param workspaceRoot - The directory holding the config.
 * @param hasSops       - Whether the SOP file is to be listed under `read`.
 */
export function mergeAiderYaml(raw: string, proxyUrl: string, workspaceRoot: string, hasSops: boolean): AiderMergeResult {
  const doc: Document = parseDocument(stripOwnHeader(raw))
  if (doc.errors.length > 0) return { content: null, stripped: [] }
  // A missing, empty or comment-only file starts as an empty mapping (its
  // comments stay on the document); anything else that is not a mapping (a
  // list, a bare scalar) is not an Aider config to merge into.
  if (doc.contents === null) doc.contents = doc.createNode({})
  if (!isMap(doc.contents)) return { content: null, stripped: [] }

  const stripped = SUPPRESSED_KEYS.filter((key) => doc.has(key))
  for (const key of [...stripped, ...INVALID_LEGACY_KEYS]) doc.delete(key)

  doc.set('openai-api-base', openaiBaseUrl(proxyUrl))

  const setEnv = ensureSeq(doc, 'set-env')
  setEnv.items = setEnv.items.filter((item) => {
    const value = isScalar(item) ? item.value : item
    return !(typeof value === 'string' && value.startsWith('ANTHROPIC_BASE_URL='))
  })
  setEnv.add(`ANTHROPIC_BASE_URL=${anthropicBaseUrl(proxyUrl)}`)

  const read = ensureSeq(doc, 'read')
  read.items = read.items.filter((item) => !isAiderSopsEntry(isScalar(item) ? item.value : item, workspaceRoot))
  if (hasSops) read.add(path.join(workspaceRoot, AIDER_SOPS_FILE))
  if (read.items.length === 0) doc.delete('read')

  return { content: `${HEADER.join('\n')}\n\n${doc.toString()}`, stripped }
}

/**
 * Merge Intutic governance settings into .aider.conf.yml.
 *
 * Preserves all user keys EXCEPT the suppressed auto-exec keys.
 *
 * @param configPath - Absolute path to .aider.conf.yml
 * @param proxyUrl   - Intutic proxy URL
 * @param sopsText   - Optional SOP instructions, written to the `read` file
 * @returns `true` when the config was written, `false` when it was left
 *          untouched because it is not a YAML mapping (a warning is logged).
 */
export async function mergeAiderConfig(
  configPath: string,
  proxyUrl: string,
  sopsText?: string,
): Promise<boolean> {
  let raw = ''
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const { content, stripped } = mergeAiderYaml(raw, proxyUrl, path.dirname(configPath), Boolean(sopsText))
  if (content === null) {
    log.warn(
      { action: 'aider_config_merge_skipped', path: configPath },
      `${configPath} is not a YAML mapping — left untouched; fix it and the next sync will add the Intutic keys`,
    )
    return false
  }
  if (stripped.length > 0) {
    log.warn(
      { action: 'aider_keys_stripped', keys: stripped, path: configPath },
      `Stripped dangerous auto-exec keys from .aider.conf.yml: ${stripped.join(', ')}`,
    )
  }

  // The SOP file lives next to the config, under the workspace's .intutic/.
  const sopsPath = path.join(path.dirname(configPath), AIDER_SOPS_FILE)
  if (sopsText) {
    await fs.mkdir(path.dirname(sopsPath), { recursive: true })
    const tmpSops = sopsPath + '.intutic-tmp'
    await fs.writeFile(tmpSops, sopsText + '\n', 'utf-8')
    await fs.rename(tmpSops, sopsPath)
  } else {
    await fs.rm(sopsPath, { force: true })
  }

  const tmpPath = configPath + '.intutic-tmp'
  // The config sits at the workspace root, so its directory is the workspace.
  await keepOriginal(configPath, path.dirname(configPath))
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, configPath)

  log.info(
    { action: 'aider_config_written', path: configPath, stripped },
    'Aider config merged with proxy URL and dangerous keys stripped',
  )
  return true
}

/**
 * Lists `entry` (an absolute path) under `read:` in the `.aider.conf.yml` at
 * `configPath`, keeping everything else in it: the decisions log's file,
 * which Aider loads only if listed. A config that does not parse as a YAML
 * mapping is left alone and reported.
 */
export async function ensureAiderReadEntry(configPath: string, entry: string): Promise<void> {
  let raw = ''
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const doc: Document = parseDocument(raw)
  if (doc.contents === null && doc.errors.length === 0) doc.contents = doc.createNode({})
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    log.warn({ action: 'aider_read_entry_skipped', path: configPath }, `${configPath} is not a YAML mapping — left untouched`)
    return
  }
  const read = ensureSeq(doc, 'read')
  if (read.items.some((item) => (isScalar(item) ? item.value : item) === entry)) return
  read.add(entry)
  await keepOriginal(configPath, path.dirname(configPath))
  const tmpPath = configPath + '.intutic-tmp'
  await fs.writeFile(tmpPath, doc.toString(), 'utf-8')
  await fs.rename(tmpPath, configPath)
}
