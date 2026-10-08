/**
 * continueConfigMerger.ts — point Continue's OpenAI and Anthropic models at
 * the proxy.
 *
 * Continue reads its models from `~/.continue/config.yaml`. This sets
 * `apiBase` on each model whose `provider` is `openai` or `anthropic` — the two
 * wire protocols the proxy serves — and leaves every other model, and every
 * other key, alone. Pointing an Ollama or Gemini model at the proxy would break
 * it, so those are not touched.
 *
 * Continue joins its request path onto `apiBase` with URL resolution
 * (`chat/completions` for OpenAI, `messages` for Anthropic), so the value is
 * the proxy's `/v1/` with the trailing slash: without it the last path segment
 * would be replaced instead of extended.
 *
 * The file is edited through the `yaml` library's document model, so comments,
 * ordering and formatting survive. A file that does not parse, or has no
 * `models` list, is left alone: inventing a model entry would give Continue a
 * model with no provider or name, which it rejects.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseDocument, isMap, isSeq } from 'yaml'
import { createLogger } from '@intutic/logger'
import { keepOriginal } from '../disconnect/originals.js'

const log = createLogger('sync-continue-config')

/** Providers whose wire protocol the proxy serves. */
const PROXIED_PROVIDERS = new Set(['openai', 'anthropic'])

/** Result of merging the proxy URL into Continue's config.yaml text. */
export interface ContinueMergeResult {
  /** New file content, or `null` when the file must be left untouched. */
  content: string | null
  /** Number of models now pointing at the proxy. */
  routed: number
  /** Why the file was left untouched, when `content` is `null`. */
  skipped?: 'unparseable' | 'no-models'
}

/**
 * Set `apiBase` on every OpenAI/Anthropic model in a Continue config.yaml.
 *
 * @param raw     - Current file content.
 * @param apiBase - The proxy's OpenAI-style base URL (host + `/v1`).
 */
export function setContinueApiBase(raw: string, apiBase: string): ContinueMergeResult {
  const value = apiBase.endsWith('/') ? apiBase : `${apiBase}/`
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) return { content: null, routed: 0, skipped: 'unparseable' }

  const models = isMap(doc.contents) ? doc.contents.get('models', true) : undefined
  if (!isSeq(models)) return { content: null, routed: 0, skipped: 'no-models' }

  let routed = 0
  for (const model of models.items) {
    if (!isMap(model)) continue
    const provider = model.get('provider')
    if (typeof provider !== 'string' || !PROXIED_PROVIDERS.has(provider)) continue
    model.set('apiBase', value)
    routed++
  }
  if (routed === 0) return { content: null, routed: 0, skipped: 'no-models' }
  return { content: doc.toString(), routed }
}

/**
 * Merge the proxy URL into Continue's config.yaml at `configPath`.
 *
 * @returns the number of models routed through the proxy; 0 when the file was
 *          missing, unparseable or had no OpenAI/Anthropic model (logged).
 */
export async function mergeContinueConfig(configPath: string, apiBase: string): Promise<number> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }

  const result = setContinueApiBase(raw, apiBase)
  if (result.content === null) {
    log.warn(
      { action: 'continue_config_merge_skipped', path: configPath, reason: result.skipped },
      result.skipped === 'unparseable'
        ? `${configPath} is not valid YAML — left untouched`
        : `${configPath} has no openai or anthropic model to route — left untouched`,
    )
    return 0
  }
  if (result.content !== raw) {
    // A user-level file: its record lives under the home directory.
    await keepOriginal(configPath, os.homedir())
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    const tmp = configPath + '.intutic-tmp'
    await fs.writeFile(tmp, result.content, 'utf-8')
    await fs.rename(tmp, configPath)
  }
  log.info({ action: 'continue_config_merged', path: configPath, routed: result.routed }, 'Continue models routed through the Intutic proxy')
  return result.routed
}
