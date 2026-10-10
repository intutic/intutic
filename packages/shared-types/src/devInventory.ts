/**
 * devInventory.ts — the AI inventory a connected developer machine reports.
 *
 * `intutic connect` collects it (the sync daemon's `inventory.ts`): the AI
 * coding harnesses the machine has, whether Intutic's gate runs for each, the
 * MCP servers their configs declare, and the skill bundles on disk. It travels
 * as the `inventory` facet of `POST /api/v1/agents/report`, and the control
 * plane keeps the latest copy per device with first-seen and last-seen times
 * per item.
 *
 * What it may carry is deliberately narrow: names, paths relative to the home
 * directory, content hashes and timestamps. Never file contents, environment
 * values, command lines or URL query strings. {@link homeRelativePath} and
 * {@link sanitizeMcpEndpoint} are where that rule is applied on the machine;
 * the control plane applies {@link sanitizeMcpEndpoint} again on ingest, so a
 * daemon that skipped it still cannot store a credential.
 *
 * @module
 */

import type { GateKind } from './gateKind.js'

/** Bumped when a field's meaning changes; the control plane refuses versions it does not know. */
export const DEVICE_INVENTORY_SCHEMA_VERSION = 1

/** How a harness's tool calls are gated (`gateKind.ts`). */
export type InventoryGateKind = GateKind

/** One harness found on the machine, by detection or because `intutic connect` is configured for it. */
export interface InventoryHarness {
  /**
   * A `HarnessType` value, or for the harness with two gates the gate id of
   * the product found (`antigravity`, `gemini-cli`; see `gateIdentity.ts`).
   */
  type: string
  /** Only where the install records it cheaply, such as a VS Code extension directory name. */
  version?: string
  /** True when it is one of this machine's `intutic connect` harnesses, the ones connect installs a gate for. */
  configured: boolean
  /**
   * True when `intutic disconnect --harness` removed Intutic from it on this
   * machine: ungoverned by the user's choice, so its first appearance as
   * ungoverned is not announced.
   */
  disconnected?: boolean
  gateKind: InventoryGateKind
  /** For a `hook` gate, whether its gate file is on disk; null when the gate is not a file the daemon writes. */
  gateInstalled: boolean | null
  /** Where the gate file was found, relative to the home directory. */
  gateFile?: string
  /** Newest event this machine's gate for the harness wrote, as the daemon drained it. */
  lastHookEventAt: string | null
  /** Newest `guards_disabled` event: the gate ran with `INTUTIC_GUARD_DISABLE=1`. */
  guardsDisabledAt: string | null
}

/** One MCP server a harness config on the machine declares. */
export interface InventoryMcpServer {
  server: string
  harness: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  /** True when the MCP governance proxy fronts it. */
  wrapped: boolean
  /** A remote server's URL after {@link sanitizeMcpEndpoint}; absent for a local (stdio) server. */
  endpoint?: string
  /** Why the harness runs it without the proxy, when the daemon can say. */
  ungovernedReason?: string
}

/** One skill bundle (a directory holding `SKILL.md`). */
export interface InventorySkill {
  name: string
  /** The directory it was found in, relative to the workspace (`.agents/skills`) or the home directory (`~/.claude/skills`). */
  source: string
  /** sha256 of `SKILL.md`; absent when it could not be read. */
  sha256?: string
  scanned: boolean
  clean: boolean
  findingsCount: number
  /** Files bundled next to `SKILL.md`. */
  scriptCount: number
}

/** The local proxy's last scheduled guard-liveness probe run. */
export interface InventoryGuardProbes {
  total: number
  failed: number
  /** Unix seconds. */
  ranAt: number
}

/** The whole snapshot one machine sends. */
export interface DeviceInventory {
  schemaVersion: typeof DEVICE_INVENTORY_SCHEMA_VERSION
  collectedAt: string
  /** The `intutic connect` workspace root, relative to the home directory. */
  workspace: string
  harnesses: InventoryHarness[]
  mcpServers: InventoryMcpServer[]
  skills: InventorySkill[]
  /** Present only when the local proxy answered. */
  guardProbes?: InventoryGuardProbes
}

/** The machine a report comes from: the same fingerprint `intutic enforce` reports to `/api/v1/devices`. */
export interface InventoryDeviceIdentity {
  fingerprint: string
  hostname: string
  platform: string
  cliVersion?: string
}

/** What a path outside the home directory is reported as. */
export const REDACTED_PATH = '[redacted]'

/**
 * `~/...` for a path inside `home`, `~` for `home` itself, and
 * {@link REDACTED_PATH} for anything else: a path outside the home directory
 * names nothing the inventory needs, and may name another user's files.
 */
export function homeRelativePath(absolutePath: string, home: string): string {
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  const base = home.endsWith(sep) ? home.slice(0, -1) : home
  if (base === '') return REDACTED_PATH
  if (absolutePath === base) return '~'
  if (absolutePath.startsWith(base + sep)) return `~/${absolutePath.slice(base.length + 1).split(sep).join('/')}`
  return REDACTED_PATH
}

/** Replaces a URL path segment that looks like a token. */
export const REDACTED_SEGMENT = '[redacted]'

/**
 * A path segment of 16 or more URL-safe characters mixing letters and digits.
 * Some MCP services put the API key in the path (`/mcp/<key>/sse`); a
 * readable route segment (`sse`, `v1`, `mcp-server`) does not look like this.
 */
function looksLikeToken(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9._~%-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment)
}

/**
 * A remote MCP server's URL with what could be a credential removed: the
 * user name and password, the query string, the fragment, and any path
 * segment that looks like a token. `undefined` for anything that is not an
 * http(s) or ws(s) URL, including one still holding `${VAR}` in its host.
 */
export function sanitizeMcpEndpoint(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return undefined
  // A host still templated (`${MCP_HOST}`) names no server yet.
  if (/[${}]/.test(url.hostname)) return undefined
  const path = url.pathname
    .split('/')
    .map((segment) => (looksLikeToken(segment) ? REDACTED_SEGMENT : segment))
    .join('/')
  return `${url.protocol}//${url.host}${path === '/' ? '' : path}`
}
