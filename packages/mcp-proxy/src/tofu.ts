/**
 * tofu.ts — Server-level trust-on-first-use (TOFU) pinning of MCP tool
 * definitions.
 *
 * Direct TypeScript port of `packages/proxy/src/tool_pin.rs`'s canonicalization
 * and hashing rule, extended from "one fingerprint per request's tool array"
 * to "one fingerprint per {workspace, server} pair" — the shape this proxy
 * needs, since each `McpGovernanceProxy` process fronts exactly one real MCP
 * server (identified by `--server-name`, see config.ts) rather than a
 * multi-provider gateway request.
 *
 * ## What this catches, and what it does not
 *
 * A tool-providing server declares its tools, and those declarations enter
 * the model's context as instructions it will follow. Nothing in the MCP
 * specification requires re-approval when a declaration changes, so a server
 * can ship benign tools, wait to be trusted, and later serve altered ones —
 * the "rug pull". The first tool list a workspace sees from a given server is
 * pinned locally; every later `tools/list` response is compared against it.
 *
 * Straight from `tool_pin.rs`'s own doc comment, because it is still exactly
 * true here: **TOFU is change-detection, not content-detection.** A server
 * that is malicious from the very first `tools/list` response has its payload
 * adopted as the trusted baseline — this module cannot help with that. It
 * only catches a LATER definition change.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'

/** The subset of a `tools/list` tool entry this module hashes. */
export interface ToolDefinition {
  name?: unknown
  description?: unknown
  inputSchema?: unknown
}

/**
 * Serialise with object keys sorted, so a re-serialised schema with the same
 * content hashes identically regardless of property insertion order. Array
 * order IS preserved — `required`/`enum` are ordered lists, and a rule that
 * treated them as sets would let a real change (reordered enum values,
 * different required-field order) hide from the pin. Direct port of
 * `tool_pin.rs`'s `canonical_json`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    const inner = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    return `{${inner.join(',')}}`
  }
  // Scalars (string/number/boolean/null) and undefined: JSON.stringify(undefined)
  // is the string 'undefined' has no JSON form; normalise it to 'null' so a
  // missing optional field never produces an unparseable canonical fragment.
  const serialised = JSON.stringify(value)
  return serialised === undefined ? 'null' : serialised
}

/**
 * Canonical signature of one server's tool list — SHA-256 over the sorted,
 * canonicalised `{name, description, inputSchema}` triple of every tool.
 *
 * Empty string when the server declares no tools, which the caller uses to
 * skip TOFU entirely rather than pinning an absence (mirrors `tool_pin.rs`'s
 * `signature`: "no tools yields no signature").
 *
 * Sorted by the full canonical per-tool string (name first, so this sorts by
 * name in practice) so that a server reordering its list does not read as a
 * change — reordering is not an attack, and a false positive here interrupts
 * real work for nothing.
 */
export function computeToolsFingerprint(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0) return ''

  const UNIT_SEP = String.fromCharCode(0x1f)
  const RECORD_SEP = String.fromCharCode(0x1e)

  const canonical = tools.map((t) => {
    const name = typeof t.name === 'string' ? t.name : ''
    const description = typeof t.description === 'string' ? t.description : ''
    const schema = t.inputSchema === undefined ? '' : canonicalJson(t.inputSchema)
    return name + UNIT_SEP + description + UNIT_SEP + schema
  })
  canonical.sort()

  const hash = node_crypto.createHash('sha256')
  hash.update(canonical.join(RECORD_SEP))
  return hash.digest('hex')
}

// ─── Local pin storage ──────────────────────────────────────────────────────

interface PinRecord {
  fingerprint: string
  pinnedAt: string
}

function pinsDir(): string {
  return node_path.join(node_os.homedir(), '.intutic', 'mcp-pins')
}

/** Filenames are flat, one per {workspace, server} pair — the same flat,
 *  id-keyed convention `~/.intutic/wasm/<ruleId>.wasm` and
 *  `<workspaceRoot>/.intutic/sops/<sopId>.md` already use, not a nested
 *  per-workspace directory tree. Unsafe filename characters (anything but
 *  alphanumerics, dot, dash, underscore) are replaced so a server name
 *  containing e.g. `/` cannot escape the pins directory. */
function sanitizeForFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function pinFilePath(workspaceId: string, serverName: string): string {
  const fileName = `${sanitizeForFilename(workspaceId)}__${sanitizeForFilename(serverName)}.json`
  return node_path.join(pinsDir(), fileName)
}

/** Reads the stored pin for a {workspace, server} pair, or `null` if none exists. */
export async function loadPin(workspaceId: string, serverName: string): Promise<PinRecord | null> {
  try {
    const raw = await node_fs.readFile(pinFilePath(workspaceId, serverName), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PinRecord).fingerprint === 'string'
    ) {
      return parsed as PinRecord
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persists a pin. Called once, on first contact — a pin is never silently
 * overwritten by a later mismatch (that would defeat the point: the whole
 * mechanism exists to keep comparing against the FIRST trusted definition,
 * the same "SET NX, first definition wins" rule `tool_pin.rs` documents).
 */
export async function savePin(workspaceId: string, serverName: string, fingerprint: string): Promise<void> {
  const dir = pinsDir()
  await node_fs.mkdir(dir, { recursive: true })
  const record: PinRecord = { fingerprint, pinnedAt: new Date().toISOString() }
  await node_fs.writeFile(pinFilePath(workspaceId, serverName), JSON.stringify(record, null, 2) + '\n', 'utf-8')
}

// ─── TOFU decision ──────────────────────────────────────────────────────────

export type TofuOutcome =
  | { status: 'skipped' } // no tools declared — nothing to pin
  | { status: 'first_contact'; fingerprint: string }
  | { status: 'match'; fingerprint: string }
  | { status: 'mismatch'; fingerprint: string; previousFingerprint: string }

/**
 * Runs the full TOFU check for one server's `tools/list` response: compute
 * the fingerprint, load any existing pin, and report first-contact / match /
 * mismatch. Does not itself decide whether a mismatch blocks the request —
 * that is `mcpProxyFailBehavior`'s call, made by the caller (proxy.ts), the
 * same fail-open/fail-closed mechanism `config.ts`/`interceptor.ts` already
 * use elsewhere in this package.
 */
export async function checkTofu(
  workspaceId: string,
  serverName: string,
  tools: readonly ToolDefinition[],
): Promise<TofuOutcome> {
  const fingerprint = computeToolsFingerprint(tools)
  if (fingerprint === '') return { status: 'skipped' }

  const existing = await loadPin(workspaceId, serverName)
  if (!existing) {
    await savePin(workspaceId, serverName, fingerprint)
    return { status: 'first_contact', fingerprint }
  }

  if (existing.fingerprint === fingerprint) {
    return { status: 'match', fingerprint }
  }

  return { status: 'mismatch', fingerprint, previousFingerprint: existing.fingerprint }
}

/**
 * Decides whether a `TofuOutcome` should block the `tools/list` request that
 * produced it, given the workspace's `mcpProxyFailBehavior` — the SAME
 * `failOpen` boolean `config.ts`/`interceptor.ts` already thread through for
 * every other governance check in this package, not a new mechanism.
 *
 * A pure function, deliberately separated from `checkTofu`'s file I/O and
 * from `proxy.ts`'s stdout-writing caller, so the fail-open/fail-closed
 * branching itself — the part with real behavioural consequences — can be
 * tested without spawning a child process or touching disk.
 *
 * Only `'mismatch'` can ever block: `'skipped'` (no tools declared) and
 * `'first_contact'`/`'match'` are never a reason to refuse a request.
 */
export function decideTofuAction(
  outcome: TofuOutcome,
  serverName: string,
  failOpen: boolean,
): { block: boolean; reason?: string } {
  if (outcome.status !== 'mismatch') return { block: false }

  const reason =
    `MCP server "${serverName}"'s tool definitions changed since they were first pinned ` +
    `(possible supply-chain "rug pull"). TOFU detects the change; it cannot tell whether ` +
    `the new definitions are malicious. An operator can review the server and, if the ` +
    `change is legitimate, remove its stale pin file under ~/.intutic/mcp-pins/ to re-pin.`

  if (failOpen) return { block: false, reason }

  return {
    block: true,
    reason:
      `${reason} Blocked by workspace policy (fail-closed mode). Contact your ` +
      `administrator or update mcpProxyFailBehavior to open.`,
  }
}
