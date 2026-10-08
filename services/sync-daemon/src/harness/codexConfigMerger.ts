/**
 * codexConfigMerger.ts — point Codex's built-in OpenAI provider at the proxy.
 *
 * Codex reads its user config from `$CODEX_HOME/config.toml` (`~/.codex` by
 * default). The one key this writer owns is the top-level `openai_base_url`,
 * Codex's documented override for the built-in `openai` provider's base URL.
 * It is user-level only, which is why this writes the user file and not a
 * project `.codex/config.toml`. A `[model_providers.openai]` table cannot do
 * this job: Codex reserves the built-in provider ids (`openai`, `ollama`,
 * `lmstudio`) and does not let `model_providers` override them.
 *
 * Everything else in the file belongs to the user — MCP servers, profiles,
 * model choice, comments — and is kept byte for byte: the key is replaced or
 * inserted as a single line rather than by re-serialising the document, which
 * would drop every comment. The result is parsed before it is written, and an
 * existing file that does not parse is left alone.
 *
 * A file whose first line is the old adapter's header was written whole by
 * that adapter (it replaced the user's config with two provider tables), so it
 * holds nothing of the user's and is regenerated.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse as parseToml } from 'smol-toml'
import { createLogger } from '@intutic/logger'
import { keepOriginal } from '../disconnect/originals.js'

const log = createLogger('sync-codex-config')

/** First line of the file the previous adapter wrote over the user's config. */
const LEGACY_HEADER = '# Intutic proxy config (auto-generated)'

const KEY = 'openai_base_url'

/** Comment written above the key the first time it is inserted. */
const KEY_COMMENT = "# Set by Intutic: routes Codex's built-in OpenAI provider through the Intutic proxy."

function parses(toml: string): Record<string, unknown> | null {
  try {
    return parseToml(toml) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Set the top-level `openai_base_url` in a Codex config.toml's text.
 *
 * @returns the new file content, or `null` when `raw` is not valid TOML (the
 *          caller must leave the file alone).
 */
export function setCodexOpenaiBaseUrl(raw: string, baseUrl: string): string | null {
  const source = raw.startsWith(LEGACY_HEADER) ? '' : raw
  if (parses(source) === null) return null

  const line = `${KEY} = ${JSON.stringify(baseUrl)}`
  const lines = source.split('\n')
  // Top-level keys must come before the first table header; a key of the same
  // name inside a table is a different key and is not touched.
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  const existing = lines.slice(0, topLevelEnd).findIndex((l) => new RegExp(`^\\s*${KEY}\\s*=`).test(l))

  let next: string
  if (existing !== -1) {
    lines[existing] = line
    next = lines.join('\n')
  } else {
    next = `${KEY_COMMENT}\n${line}\n` + (source.trim() === '' ? '' : `\n${source}`)
  }

  const check = parses(next)
  if (check === null || check[KEY] !== baseUrl) return null
  return next
}

/**
 * Merge `openai_base_url` into the Codex user config at `configPath`.
 *
 * @returns `true` when the file now carries the URL, `false` when it was left
 *          untouched because it is not valid TOML (a warning is logged).
 */
export async function mergeCodexConfig(configPath: string, baseUrl: string): Promise<boolean> {
  let raw = ''
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const next = setCodexOpenaiBaseUrl(raw, baseUrl)
  if (next === null) {
    log.warn(
      { action: 'codex_config_merge_skipped', path: configPath },
      `${configPath} is not valid TOML — left untouched; fix it and the next sync will set ${KEY}`,
    )
    return false
  }
  if (next === raw) return true

  // A user-level file: its record lives under the home directory.
  await keepOriginal(configPath, os.homedir())
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmp = configPath + '.intutic-tmp'
  await fs.writeFile(tmp, next, 'utf-8')
  await fs.rename(tmp, configPath)
  log.info({ action: 'codex_config_merged', path: configPath }, `Set ${KEY} in Codex config`)
  return true
}
