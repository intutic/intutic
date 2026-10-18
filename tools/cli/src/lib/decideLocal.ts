/**
 * Where `intutic decide` keeps its machine state, under `~/.intutic/decide/`:
 *
 * - `engine.json` (0600): the engine's url, adapter, model, timeoutMs,
 *   parallel and structured, and the per-call p95 `doctor` measured
 *   (`q95Ms`). Never the key: `INTUTIC_DECIDE_API_KEY` is read from the
 *   environment only, and never written or logged.
 * - `evals/<ruleHash>/<digest>.json`: a pin a passing `decide eval` earned,
 *   which the snapshot writer reads; `evals/<ruleHash>/runs/<id>.json`, each
 *   run's report; `evals/<ruleHash>/candidates/<digest>.json`, what
 *   `decide calibrate` fitted.
 * - `canary.json`, the canary cache; `stats/<ruleHash>.json`, the drift
 *   stats; `disabled`, the `decide disable` marker.
 *
 * The decide log is `~/.intutic/logs/decide-YYYY-MM-DD.jsonl`.
 *
 * Every path is computed at call time from the home directory, so a test's
 * HOME applies. Nothing here imports the sync daemon: `decide check` runs
 * on every gated call and its start-up time is the gate's budget.
 *
 * @module
 */

import * as node_fs from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createDecideEngine,
  DecideEngineError,
  decideStoredQ95Ms,
  resolveDecideEngineConfig,
  type DecideEngine,
  type DecideEngineConfig,
  type DecideEvalRunBaseline,
} from '@intutic/shared-types'

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function decideDir(): string {
  return join(homedir(), '.intutic', 'decide')
}
export function engineFile(): string {
  return join(decideDir(), 'engine.json')
}
export function evalsDir(ruleHash: string): string {
  return join(decideDir(), 'evals', ruleHash)
}
export function runsDir(ruleHash: string): string {
  return join(evalsDir(ruleHash), 'runs')
}
export function candidatesDir(ruleHash: string): string {
  return join(evalsDir(ruleHash), 'candidates')
}
export function statsDir(): string {
  return join(decideDir(), 'stats')
}
export function canaryFile(): string {
  return join(decideDir(), 'canary.json')
}
export function disabledFile(): string {
  return join(decideDir(), 'disabled')
}
export function logsDir(): string {
  return join(homedir(), '.intutic', 'logs')
}

/** A model digest as a file name: anything but `[A-Za-z0-9._-]` becomes `-`. */
export function digestFileName(modelDigest: string): string {
  return `${modelDigest.replace(/[^A-Za-z0-9._-]/g, '-')}.json`
}

/** The fields `engine.json` may hold. The key is never one of them. */
export const ENGINE_FILE_FIELDS = ['url', 'adapter', 'model', 'timeoutMs', 'parallel', 'structured', 'ollama', 'q95Ms', 'q95MeasuredAt'] as const

/** engine.json, parsed, or null when there is none. Throws when it does not parse. */
export function readEngineFile(): Record<string, unknown> | null {
  let text: string
  try {
    text = node_fs.readFileSync(engineFile(), 'utf8')
  } catch {
    return null
  }
  const v = JSON.parse(text) as unknown
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${engineFile()} must hold a JSON object`)
  return v as Record<string, unknown>
}

/** Writes engine.json (0600 in a 0700 directory), keeping only the known fields: a key passed in by mistake is dropped. */
export function writeEngineFile(values: Record<string, unknown>): void {
  const kept: Record<string, unknown> = {}
  for (const k of ENGINE_FILE_FIELDS) if (values[k] !== undefined) kept[k] = values[k]
  writeJson(engineFile(), kept)
}

/** Writes JSON whole by a rename, mode 0600, its directory 0700. */
export function writeJson(file: string, value: unknown): void {
  const dir = file.replace(/[\\/][^\\/]*$/, '')
  node_fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  node_fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  node_fs.renameSync(tmp, file)
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(node_fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

export interface LoadedEngine {
  /** The resolved configuration, or null when it does not resolve. */
  cfg: DecideEngineConfig | null
  /** The engine, or the error making it raised (`not_configured`, `host_refused`). */
  engine: DecideEngine | DecideEngineError
  /** The per-call p95 `doctor` stored, if any. */
  q95Ms: number | null
}

/** The environment variables the engine configuration reads, and only those. */
export function decideEnv(): Record<string, string | undefined> {
  return {
    INTUTIC_DECIDE_ENGINE_URL: process.env.INTUTIC_DECIDE_ENGINE_URL,
    INTUTIC_DECIDE_ADAPTER: process.env.INTUTIC_DECIDE_ADAPTER,
    INTUTIC_DECIDE_MODEL: process.env.INTUTIC_DECIDE_MODEL,
    INTUTIC_DECIDE_TIMEOUT_MS: process.env.INTUTIC_DECIDE_TIMEOUT_MS,
    INTUTIC_DECIDE_PARALLEL: process.env.INTUTIC_DECIDE_PARALLEL,
    INTUTIC_DECIDE_API_KEY: process.env.INTUTIC_DECIDE_API_KEY,
    INTUTIC_DECIDE_MODEL_DIGEST: process.env.INTUTIC_DECIDE_MODEL_DIGEST,
    INTUTIC_SELF_HOSTED_DECISION_HOSTS: process.env.INTUTIC_SELF_HOSTED_DECISION_HOSTS,
    INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES: process.env.INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES,
  }
}

/** The engine engine.json and the environment describe. Never throws. */
export function loadEngine(env: Record<string, string | undefined> = decideEnv()): LoadedEngine {
  let file: Record<string, unknown> | null
  try {
    file = readEngineFile()
  } catch (err) {
    return { cfg: null, engine: new DecideEngineError('not_configured', err instanceof Error ? err.message : String(err)), q95Ms: null }
  }
  // Read as every gate's decide tier reads it.
  const q95 = decideStoredQ95Ms(file)
  let cfg: DecideEngineConfig
  try {
    cfg = resolveDecideEngineConfig(file, env)
  } catch (err) {
    return { cfg: null, engine: err instanceof DecideEngineError ? err : new DecideEngineError('not_configured', String(err)), q95Ms: q95 }
  }
  try {
    return { cfg, engine: createDecideEngine(cfg), q95Ms: q95 }
  } catch (err) {
    return { cfg, engine: err instanceof DecideEngineError ? err : new DecideEngineError('not_configured', String(err)), q95Ms: q95 }
  }
}

/** `host:port` of an engine URL, for logs; never its path, query or credentials. */
export function engineHost(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return ''
  }
}

/**
 * What 3.0 does not do with a readable rule as written, one sentence each,
 * for `decide lint`, `gates install` and `doctor`:
 *
 * - `on: response`: read and validated everywhere, evaluated nowhere. No
 *   gate sees a response, and the gateway evaluates only the rule it
 *   synthesises for its local judge.
 * - `context: ["last_user_turn"]`: reserved. No gate supplies the user's last
 *   turn, so the rule is asked without one, and `decide test` and
 *   `decide eval` ask it the same way so the eval measures what a gate asks.
 */
export function decideRuleNotes(rule: { id: string; on: string; context?: readonly string[] }): string[] {
  const out: string[] = []
  if (rule.on === 'response') {
    out.push(`decide rule ${rule.id} is on: response, which is not enforced in 3.0: it is read and validated, and no gate or gateway evaluates it`)
  }
  if ((rule.context ?? []).includes('last_user_turn')) {
    out.push(
      `decide rule ${rule.id} declares context: ["last_user_turn"], which is reserved and not supplied in 3.0: ` +
        'no gate passes the user\'s last turn, so the rule is asked without it (in `decide test` and `decide eval` too)',
    )
  }
  return out
}

/** What a stored eval run report holds for drift. */
export interface StoredEvalRun {
  v: 1
  evalRunId: string
  baseline: DecideEvalRunBaseline
  [k: string]: unknown
}

/** The drift baseline of a stored eval run, or null. */
export function readEvalRunBaseline(ruleHash: string, evalRunId: string): DecideEvalRunBaseline | null {
  if (!/^[A-Za-z0-9._-]+$/.test(evalRunId)) return null
  const run = readJson<StoredEvalRun>(join(runsDir(ruleHash), `${evalRunId}.json`))
  const b = run?.baseline
  if (!b || typeof b.escalationRate !== 'number' || typeof b.questions !== 'object' || b.questions === null) return null
  return b
}
