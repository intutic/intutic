/**
 * mcp.ts — undoes the MCP wrapping `mcpAutoWrite.ts` does in every harness.
 *
 * Three kinds of entry are Intutic's, and only these are touched:
 *
 * - a wrapped server (`__intutic_wrapped: true`), put back as it was: from
 *   `__intutic_original`, which holds the whole pre-wrap entry, or, for a
 *   stdio server wrapped before that was recorded, from the wrapped entry
 *   itself, whose argv carries the original command after `--`;
 * - the `intutic` server added beside them, recognised by its command (node
 *   running the governance proxy);
 * - a Claude Code local-scope copy of a project server
 *   (`__intutic_shadow_of: 'project'`), deleted, which hands the name back to
 *   `.mcp.json`.
 *
 * OpenCode's schema has no room for markers, so its wrapped entries are
 * recognised by command shape and rebuilt from the argv; when the file's
 * original was kept, an entry rebuilt that way is swapped for the original
 * entry, which also carries the keys the wrap did not keep.
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util'
import { isMap, type Document } from 'yaml'
import { PROXY_BIN_PATTERN } from '../harness/mcpAutoWrite.js'
import { isObject, pruneEmpty, type JsonObject } from './plan.js'

/** The env keys a wrap adds; everything else in a wrapped entry's env was the server's. */
const WRAP_ENV_KEYS = ['INTUTIC_WORKSPACE_ID', 'INTUTIC_REMOTE_HEADERS']

function stripWrapEnv(env: unknown): JsonObject | undefined {
  if (!isObject(env)) return undefined
  const rest: JsonObject = { ...env }
  for (const key of WRAP_ENV_KEYS) delete rest[key]
  return Object.keys(rest).length > 0 ? rest : undefined
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((a) => typeof a === 'string') ? (v as string[]) : null
}

/** The pre-wrap shape read back from a wrapped proxy argv (everything after the proxy binary). */
function fromProxyArgv(argv: string[], env: unknown): JsonObject | null {
  const sep = argv.indexOf('--')
  if (sep >= 0) {
    const [command, ...args] = argv.slice(sep + 1)
    if (command === undefined) return null
    const out: JsonObject = { command, args }
    const kept = stripWrapEnv(env)
    if (kept) out.env = kept
    return out
  }
  const urlAt = argv.indexOf('--remote-url')
  if (urlAt >= 0 && typeof argv[urlAt + 1] === 'string') {
    const out: JsonObject = { url: argv[urlAt + 1] }
    const transport = argv[argv.indexOf('--remote-transport') + 1]
    if (transport === 'sse') out.type = 'sse'
    if (isObject(env) && typeof env.INTUTIC_REMOTE_HEADERS === 'string') {
      try {
        out.headers = JSON.parse(env.INTUTIC_REMOTE_HEADERS) as unknown
      } catch {
        // Unreadable headers stay out rather than being guessed at.
      }
    }
    const kept = stripWrapEnv(env)
    if (kept) out.env = kept
    return out
  }
  return null
}

/** Whether a recorded original still describes what the wrapped entry runs. */
function originalMatches(original: JsonObject, derived: JsonObject | null): boolean {
  if (derived === null) return true
  if (typeof derived.command === 'string') {
    return original.command === derived.command && isDeepStrictEqual(original.args ?? [], derived.args)
  }
  return original.url === derived.url
}

/**
 * What a wrapped entry was, or `undefined` when `entry` is not one Intutic
 * wrapped. A recorded original wins unless the user has since changed the
 * command or url inside the wrap, in which case the wrap's own argv is the
 * truth.
 */
export function unwrapEntry(entry: unknown): JsonObject | undefined {
  if (!isObject(entry) || entry.__intutic_wrapped !== true) return undefined
  const argv = stringArray(entry.args)
  const derived = argv && argv.length > 0 && PROXY_BIN_PATTERN.test(argv[0]!) ? fromProxyArgv(argv.slice(1), entry.env) : null
  const original = entry.__intutic_original
  if (isObject(original) && (typeof original.command === 'string' || typeof original.url === 'string') && originalMatches(original, derived)) {
    return structuredClone(original)
  }
  return derived ?? undefined
}

/** The `intutic` server mcpAutoWrite adds: node running the governance proxy. */
export function isIntuticServer(entry: unknown): boolean {
  if (!isObject(entry)) return false
  if (entry.command === 'node') {
    const argv = stringArray(entry.args)
    return argv !== null && argv.length > 0 && PROXY_BIN_PATTERN.test(argv[0]!)
  }
  const argv = stringArray(entry.command)
  return argv !== null && argv[0] === 'node' && typeof argv[1] === 'string' && PROXY_BIN_PATTERN.test(argv[1]) && !argv.includes('--server-name')
}

/**
 * Unwraps every Intutic entry in one name → entry map, in place. Returns
 * whether anything changed.
 */
export function unwrapServerMap(map: JsonObject): boolean {
  let changed = false
  for (const [name, entry] of Object.entries(map)) {
    if (isObject(entry) && entry.__intutic_shadow_of === 'project') {
      delete map[name]
      changed = true
    } else if (name === 'intutic' && isIntuticServer(entry)) {
      delete map[name]
      changed = true
    } else {
      const original = unwrapEntry(entry)
      if (original !== undefined) {
        map[name] = original
        changed = true
      }
    }
  }
  return changed
}

/**
 * Unwraps the map at `path` of `doc`, removing it when it is left empty and
 * the original did not have it.
 */
export function unwrapServersAt(doc: JsonObject, path: string[], original: JsonObject | null): boolean {
  let parent: unknown = doc
  for (const k of path.slice(0, -1)) parent = isObject(parent) ? parent[k] : undefined
  const map = isObject(parent) ? parent[path[path.length - 1]!] : undefined
  if (!isObject(map) || !unwrapServerMap(map)) return false
  pruneEmpty(doc, path, original)
  return true
}

/**
 * `~/.claude.json`: the user-scope map and every project's local-scope map.
 * Empty maps stay: Claude Code keeps `mcpServers: {}` in its own entries.
 */
export function unwrapClaudeState(doc: JsonObject): boolean {
  let changed = false
  if (isObject(doc.mcpServers)) changed = unwrapServerMap(doc.mcpServers) || changed
  if (isObject(doc.projects)) {
    for (const project of Object.values(doc.projects)) {
      if (isObject(project) && isObject(project.mcpServers)) changed = unwrapServerMap(project.mcpServers) || changed
    }
  }
  return changed
}

/** Continue's `~/.continue/config.json`, whose `mcpServers` is an array of `{ name, ... }`. */
export function unwrapContinueServers(doc: JsonObject, original: JsonObject | null): boolean {
  if (!Array.isArray(doc.mcpServers)) return false
  let changed = false
  const next: unknown[] = []
  for (const entry of doc.mcpServers as unknown[]) {
    if (!isObject(entry)) {
      next.push(entry)
      continue
    }
    const { name, ...rest } = entry
    if (name === 'intutic' && isIntuticServer(rest)) {
      changed = true
      continue
    }
    const unwrapped = unwrapEntry(rest)
    if (unwrapped === undefined) {
      next.push(entry)
    } else {
      next.push({ name, ...unwrapped })
      changed = true
    }
  }
  if (!changed) return false
  doc.mcpServers = next
  pruneEmpty(doc, ['mcpServers'], original)
  return true
}

/** Goose's `config.yaml` `mcp:` block, edited through the YAML document so comments survive. */
export function unwrapGooseServers(doc: Document, original: Document | null): boolean {
  if (!isMap(doc.get('mcp'))) return false
  const servers = (doc.toJS() as { mcp?: JsonObject }).mcp ?? {}
  let changed = false
  for (const [name, entry] of Object.entries(servers)) {
    if (name === 'intutic' && isIntuticServer(entry)) {
      doc.deleteIn(['mcp', name])
      changed = true
      continue
    }
    const unwrapped = unwrapEntry(entry)
    if (unwrapped !== undefined) {
      doc.setIn(['mcp', name], unwrapped)
      changed = true
    }
  }
  const after = doc.get('mcp')
  const originalHadMcp = original !== null && isObject(original.toJS()) && (original.toJS() as JsonObject).mcp !== undefined
  if (changed && isMap(after) && after.items.length === 0 && !originalHadMcp) doc.delete('mcp')
  return changed
}

// ─── OpenCode ────────────────────────────────────────────────────────────────

/** An OpenCode entry rebuilt from a wrapped one's argv; undefined when it is not a wrapped one. */
export function unwrapOpenCodeEntry(entry: unknown): JsonObject | undefined {
  if (!isObject(entry)) return undefined
  const argv = stringArray(entry.command)
  if (!argv || argv[0] !== 'node' || typeof argv[1] !== 'string' || !PROXY_BIN_PATTERN.test(argv[1]) || !argv.includes('--server-name')) {
    return undefined
  }
  const derived = fromProxyArgv(argv.slice(2), entry.environment)
  if (derived === null) return undefined
  const rest: JsonObject = { ...entry }
  delete rest.type
  delete rest.command
  delete rest.environment
  if (typeof derived.command === 'string') {
    return {
      type: 'local',
      command: [derived.command, ...((derived.args as string[]) ?? [])],
      ...(derived.env ? { environment: derived.env } : {}),
      ...rest,
    }
  }
  return {
    type: 'remote',
    url: derived.url,
    ...(derived.headers ? { headers: derived.headers } : {}),
    ...rest,
  }
}

/** Whether a rebuilt OpenCode entry and an original one name the same server. */
function sameOpenCodeServer(a: JsonObject, b: JsonObject): boolean {
  return a.type === b.type && isDeepStrictEqual(a.command, b.command) && a.url === b.url
}

/**
 * OpenCode's `opencode.json` `mcp` block. A rebuilt entry is swapped for the
 * original file's entry of the same name when both name the same server.
 */
export function unwrapOpenCodeServers(doc: JsonObject, original: JsonObject | null): boolean {
  const mcp = doc.mcp
  if (!isObject(mcp)) return false
  const originalMcp = original && isObject(original.mcp) ? original.mcp : {}
  let changed = false
  for (const [name, entry] of Object.entries(mcp)) {
    if (name === 'intutic' && isIntuticServer(entry)) {
      delete mcp[name]
      changed = true
      continue
    }
    const rebuilt = unwrapOpenCodeEntry(entry)
    if (rebuilt === undefined) continue
    const was = originalMcp[name]
    mcp[name] = isObject(was) && sameOpenCodeServer(rebuilt, was) ? structuredClone(was) : rebuilt
    changed = true
  }
  if (changed) pruneEmpty(doc, ['mcp'], original)
  return changed
}

// ─── Gemini CLI, Antigravity ─────────────────────────────────────────────────

/**
 * How a product writes a remote server, from the URL and transport a wrapped
 * entry's argv carries: Gemini CLI as `url` (with `type: "sse"` for SSE),
 * Antigravity as `serverUrl`.
 */
export type RemoteShape = (url: string, transport: 'sse' | 'http') => JsonObject

export const geminiRemoteShape: RemoteShape = (url, transport) => (transport === 'sse' ? { url, type: 'sse' } : { url })
export const antigravityRemoteShape: RemoteShape = (url) => ({ serverUrl: url })

/**
 * A Gemini CLI or Antigravity entry rebuilt from a wrapped one, which carries
 * no marker (mcpAutoWrite.ts's `isProxyFronted`); undefined when it is not a
 * wrapped one. The keys the wrap kept (`cwd`, `trust`, `includeTools`, …) stay.
 */
export function unwrapUnmarkedEntry(entry: unknown, remoteShape: RemoteShape): JsonObject | undefined {
  if (!isObject(entry) || entry.command !== 'node') return undefined
  const argv = stringArray(entry.args)
  if (!argv || argv.length === 0 || !PROXY_BIN_PATTERN.test(argv[0]!) || !argv.includes('--server-name')) return undefined
  const derived = fromProxyArgv(argv.slice(1), entry.env)
  if (derived === null) return undefined
  const rest: JsonObject = { ...entry }
  delete rest.command
  delete rest.args
  delete rest.env
  if (typeof derived.command === 'string') {
    return { command: derived.command, args: derived.args, ...(derived.env ? { env: derived.env } : {}), ...rest }
  }
  return {
    ...remoteShape(derived.url as string, derived.type === 'sse' ? 'sse' : 'http'),
    ...(derived.headers ? { headers: derived.headers } : {}),
    ...(derived.env ? { env: derived.env } : {}),
    ...rest,
  }
}

/** Whether two entries run the same server: the same command line, or the same URL. */
function sameServer(a: JsonObject, b: JsonObject): boolean {
  if (typeof a.command === 'string') return a.command === b.command && isDeepStrictEqual(a.args ?? [], b.args ?? [])
  const url = (e: JsonObject) => e.url ?? e.httpUrl ?? e.serverUrl
  return url(a) !== undefined && url(a) === url(b)
}

/**
 * The `mcpServers` map at `path` of a Gemini CLI or Antigravity file. A
 * rebuilt entry is swapped for the original file's entry of the same name
 * when both run the same server, which also brings back what the rebuild
 * cannot know (Gemini CLI's `httpUrl` spelling, a `type: "http"`).
 */
export function unwrapUnmarkedServersAt(doc: JsonObject, path: string[], original: JsonObject | null, remoteShape: RemoteShape): boolean {
  let map: unknown = doc
  let was: unknown = original
  for (const k of path) {
    map = isObject(map) ? map[k] : undefined
    was = isObject(was) ? was[k] : undefined
  }
  if (!isObject(map)) return false
  const originals = isObject(was) ? was : {}
  let changed = false
  for (const [name, entry] of Object.entries(map)) {
    if (name === 'intutic' && isIntuticServer(entry)) {
      delete map[name]
      changed = true
      continue
    }
    const rebuilt = unwrapUnmarkedEntry(entry, remoteShape)
    if (rebuilt === undefined) continue
    const before = originals[name]
    map[name] = isObject(before) && sameServer(rebuilt, before) ? structuredClone(before) : rebuilt
    changed = true
  }
  if (changed) pruneEmpty(doc, path, original)
  return changed
}
