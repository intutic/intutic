/**
 * Risk score for a change to an MCP server's tool set.
 *
 * When a server the registry already knows declares a different tool set — a
 * tool added or removed, a description or input schema changed — the control
 * plane scores the change with {@link scoreToolSetChange} and stores the score
 * and its reasons on the registry's change record
 * (`services/control-plane/src/services/mcpRegistryService.ts`).
 *
 * Rules only, no model: the same two tool sets always produce the same score
 * and the same reasons, in the same order, so a score can be reproduced from
 * the stored definitions and argued with. Each rule adds points:
 *
 * | rule                   | points | when                                                         |
 * |------------------------|--------|--------------------------------------------------------------|
 * | `description_poisoned` | 60     | a new or changed description matches a poisoning pattern it did not match before |
 * | `new_tool_capability`  | 20–40  | a new tool's name or description implies write, network, exec or credential access (per capability) |
 * | `capability_gained`    | 20–40  | a changed tool implies a capability it did not before (per capability) |
 * | `confirmation_removed` | 35     | a changed tool lost a confirmation or dry-run argument, or stopped requiring or defaulting it |
 * | `schema_widened`       | 15     | a changed tool accepts more than before: new arguments, fewer required ones, lifted enums, patterns or limits |
 * | `tool_added`           | 5      | a new tool none of the rules above flag                      |
 * | `description_changed`  | 5      | a changed description none of the rules above flag          |
 *
 * Capability points: exec 40, credential 40, network 25, write 20. A removed
 * tool adds nothing: it narrows what an agent can do. The score is the sum,
 * capped at 100; 50 or more is `high`, 20 or more `medium`, anything above 0
 * `low`.
 *
 * @module
 */

import { scanToolDescription } from './toolPoison.js'

/** One tool as a server declares it in `tools/list`. */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

/**
 * How much of a definition the registry keeps. A longer description is cut
 * here (its scanned prefix is what the risk score sees); a larger input
 * schema is left out. Real servers' tools sit far below both.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 8_192
export const MAX_TOOL_SCHEMA_CHARS = 16_384

/**
 * One `tools/list` entry as the registry stores it: the name, the description
 * cut to {@link MAX_TOOL_DESCRIPTION_CHARS}, and the input schema when it is an
 * object no larger than {@link MAX_TOOL_SCHEMA_CHARS} serialised. `null` for an
 * entry without a name.
 */
export function normalizeToolDefinition(raw: unknown): McpToolDefinition | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const name = entry['name']
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return null
  const def: McpToolDefinition = { name }
  if (typeof entry['description'] === 'string') def.description = entry['description'].slice(0, MAX_TOOL_DESCRIPTION_CHARS)
  const schema = entry['inputSchema']
  if (schema !== null && typeof schema === 'object' && !Array.isArray(schema) && JSON.stringify(schema).length <= MAX_TOOL_SCHEMA_CHARS) {
    def.inputSchema = schema
  }
  return def
}

export type McpToolCapability = 'exec' | 'credential' | 'network' | 'write'

export type McpToolRiskRule =
  | 'description_poisoned'
  | 'new_tool_capability'
  | 'capability_gained'
  | 'confirmation_removed'
  | 'schema_widened'
  | 'tool_added'
  | 'description_changed'

export type McpToolRiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface McpToolRiskReason {
  rule: McpToolRiskRule
  tool: string
  points: number
  /** What the rule saw, in words. */
  detail: string
}

export interface McpToolSetChange {
  added: string[]
  removed: string[]
  /** Tools present before and after whose description or input schema differs. */
  changed: string[]
  /** 0–100. */
  score: number
  level: McpToolRiskLevel
  /** Sorted by tool, then rule. */
  reasons: McpToolRiskReason[]
}

export const MCP_TOOL_RISK_HIGH = 50
export const MCP_TOOL_RISK_MEDIUM = 20

export const MCP_TOOL_CAPABILITY_POINTS: Readonly<Record<McpToolCapability, number>> = {
  exec: 40,
  credential: 40,
  network: 25,
  write: 20,
}

const RULE_POINTS = {
  description_poisoned: 60,
  confirmation_removed: 35,
  schema_widened: 15,
  tool_added: 5,
  description_changed: 5,
} as const

const CAPABILITIES: readonly McpToolCapability[] = ['exec', 'credential', 'network', 'write']

/** Words in a tool's name that name a capability. Matched against whole name tokens. */
const NAME_TOKENS: Record<McpToolCapability, ReadonlySet<string>> = {
  exec: new Set(['exec', 'execute', 'run', 'shell', 'bash', 'sh', 'cmd', 'command', 'commands', 'spawn', 'eval', 'script', 'terminal', 'subprocess']),
  credential: new Set(['credential', 'credentials', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'token', 'tokens', 'apikey', 'auth', 'oauth', 'login', 'keychain', 'vault', 'ssh']),
  network: new Set(['http', 'https', 'url', 'fetch', 'request', 'webhook', 'download', 'upload', 'curl', 'wget', 'browse', 'navigate', 'email', 'mail', 'smtp', 'socket', 'send']),
  write: new Set(['write', 'delete', 'remove', 'rm', 'update', 'create', 'modify', 'edit', 'insert', 'drop', 'truncate', 'overwrite', 'move', 'rename', 'push', 'commit', 'deploy', 'publish', 'put', 'patch', 'upsert', 'append', 'merge', 'set']),
}

/**
 * Phrases in a description that name a capability. Narrower than the name
 * tokens on purpose: descriptions are prose, where "update" or "token" turn up
 * in tools that neither write nor touch credentials.
 */
const DESCRIPTION_PATTERNS: Record<McpToolCapability, RegExp> = {
  exec: /\b(execut(e|es|ing)\b|runs? (an? |any |arbitrary )?(shell |system |terminal )?commands?\b|shell commands?\b|spawn(s|ing)? (a |new )?process|arbitrary code\b)/i,
  credential: /\b(read|reads|return|returns|get|gets|list|lists|retriev\w*|fetch\w*|export\w*|dump\w*|access\w*)\b[^.]{0,40}\b(credentials?|passwords?|secrets?|api[ _-]?keys?|access tokens?|private keys?|ssh keys?)\b/i,
  network: /(https?:\/\/|\bhttp requests?\b|\bfetch(es)? (a |the |any )?(url|web ?page)s?\b|\bwebhooks?\b|\bdownloads?\b|\buploads?\b|\bsends? (an? )?(email|e-mail|message|request)s?\b)/i,
  write: /\b(write|writes|delete|deletes|remove|removes|overwrite|overwrites|modif(y|ies)|truncate|truncates|drop|drops)\b[^.]{0,40}\b(files?|director(y|ies)|records?|rows?|tables?|database|repositor(y|ies)|branch(es)?|data)\b/i,
}

/** Argument names that ask for confirmation or a dry run, compared lowercased with `_` and `-` removed. */
const CONFIRMATION_ARGS = new Set([
  'confirm', 'confirmed', 'confirmation', 'requireconfirmation', 'dryrun', 'preview', 'approval', 'approve', 'approved', 'safemode',
])

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function capabilitiesOf(tool: McpToolDefinition): Set<McpToolCapability> {
  const tokens = nameTokens(tool.name)
  const found = new Set<McpToolCapability>()
  for (const cap of CAPABILITIES) {
    if (tokens.some((t) => NAME_TOKENS[cap].has(t))) found.add(cap)
    else if (tool.description && DESCRIPTION_PATTERNS[cap].test(tool.description)) found.add(cap)
  }
  return found
}

function isConfirmationArg(name: string): boolean {
  return CONFIRMATION_ARGS.has(name.toLowerCase().replace(/[_-]/g, ''))
}

/** JSON with object keys sorted, so equal schemas compare equal whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

type Schema = Record<string, unknown>

function asSchema(value: unknown): Schema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : null
}

function propertiesOf(schema: Schema): Record<string, unknown> {
  return asSchema(schema['properties']) ?? {}
}

function requiredOf(schema: Schema): string[] {
  return Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : []
}

function typesOf(schema: Schema): string[] | null {
  const t = schema['type']
  if (typeof t === 'string') return [t]
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string')
  return null
}

/** Upper bounds whose removal or increase accepts more input. */
const UPPER_BOUNDS = ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'] as const
/** Lower bounds whose removal or decrease accepts more input. */
const LOWER_BOUNDS = ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'] as const

/**
 * Everything `next` accepts that `prev` did not, as phrases — and, separately,
 * the confirmation arguments `next` weakened. Recurses into nested object
 * properties and array items; `at` is the argument path for the phrases.
 */
function compareSchemas(prev: Schema, next: Schema, at: string, widened: string[], confirmations: string[]): void {
  const label = (name: string) => (at ? `${at}.${name}` : name)
  const here = at ? `\`${at}\`` : 'the input'

  const prevTypes = typesOf(prev)
  const nextTypes = typesOf(next)
  if (prevTypes && (!nextTypes || nextTypes.some((t) => !prevTypes.includes(t)))) {
    widened.push(`${here} accepts ${nextTypes ? nextTypes.filter((t) => !prevTypes.includes(t)).join(', ') : 'any type'} now`)
  }
  if ('enum' in prev) {
    const before = Array.isArray(prev['enum']) ? prev['enum'].map(stableJson) : []
    const after = Array.isArray(next['enum']) ? next['enum'].map(stableJson) : null
    if (!after) widened.push(`${here} lost its list of allowed values`)
    else if (after.some((v) => !before.includes(v))) widened.push(`${here} allows new values`)
  }
  if ('const' in prev && stableJson(prev['const']) !== stableJson(next['const'])) {
    widened.push(`${here} is no longer fixed to ${stableJson(prev['const'])}`)
  }
  if (typeof prev['pattern'] === 'string' && prev['pattern'] !== next['pattern']) {
    widened.push(`${here} ${typeof next['pattern'] === 'string' ? 'has a different' : 'lost its'} pattern`)
  }
  for (const bound of UPPER_BOUNDS) {
    const b = prev[bound]
    if (typeof b === 'number' && !(typeof next[bound] === 'number' && (next[bound] as number) <= b)) {
      widened.push(`${here} ${typeof next[bound] === 'number' ? 'raised' : 'dropped'} its ${bound}`)
    }
  }
  for (const bound of LOWER_BOUNDS) {
    const b = prev[bound]
    if (typeof b === 'number' && !(typeof next[bound] === 'number' && (next[bound] as number) >= b)) {
      widened.push(`${here} ${typeof next[bound] === 'number' ? 'lowered' : 'dropped'} its ${bound}`)
    }
  }
  if (prev['additionalProperties'] === false && next['additionalProperties'] !== false) {
    widened.push(`${here} accepts arguments it does not declare`)
  }

  const prevProps = propertiesOf(prev)
  const nextProps = propertiesOf(next)
  const prevRequired = requiredOf(prev)
  const nextRequired = new Set(requiredOf(next))

  for (const name of Object.keys(nextProps).sort()) {
    if (!(name in prevProps)) widened.push(`new argument \`${label(name)}\``)
  }
  for (const name of Object.keys(prevProps).sort()) {
    const confirmation = isConfirmationArg(name)
    if (!(name in nextProps)) {
      if (confirmation) confirmations.push(`\`${label(name)}\` was removed`)
      continue
    }
    const prevProp = asSchema(prevProps[name])
    const nextProp = asSchema(nextProps[name])
    if (prevRequired.includes(name) && !nextRequired.has(name)) {
      if (confirmation) confirmations.push(`\`${label(name)}\` is no longer required`)
      else widened.push(`\`${label(name)}\` is no longer required`)
    }
    if (confirmation && prevProp?.['default'] === true && nextProp?.['default'] !== true) {
      confirmations.push(`\`${label(name)}\` no longer defaults to true`)
    }
    if (prevProp && nextProp) compareSchemas(prevProp, nextProp, label(name), widened, confirmations)
    else if (prevProp && !nextProp) widened.push(`\`${label(name)}\` lost its schema`)
  }

  const prevItems = asSchema(prev['items'])
  const nextItems = asSchema(next['items'])
  if (prevItems && nextItems) compareSchemas(prevItems, nextItems, at ? `${at}[]` : '[]', widened, confirmations)
  else if (prevItems && !nextItems) widened.push(`${here} lost its item schema`)
}

function capabilityList(caps: Iterable<McpToolCapability>): McpToolCapability[] {
  const set = new Set(caps)
  return CAPABILITIES.filter((c) => set.has(c))
}

const CAPABILITY_WORDS: Record<McpToolCapability, string> = {
  exec: 'command execution',
  credential: 'credential access',
  network: 'network access',
  write: 'write access',
}

function indexByName(tools: readonly McpToolDefinition[]): Map<string, McpToolDefinition> {
  const map = new Map<string, McpToolDefinition>()
  for (const t of tools) if (typeof t.name === 'string' && t.name && !map.has(t.name)) map.set(t.name, t)
  return map
}

export function riskLevelOf(score: number): McpToolRiskLevel {
  if (score >= MCP_TOOL_RISK_HIGH) return 'high'
  if (score >= MCP_TOOL_RISK_MEDIUM) return 'medium'
  return score > 0 ? 'low' : 'none'
}

/**
 * Compares the tool set a server declared before with the one it declares
 * now. Tools are matched by name; order and duplicate names (the first wins)
 * do not affect the result.
 */
export function scoreToolSetChange(
  previous: readonly McpToolDefinition[],
  next: readonly McpToolDefinition[],
): McpToolSetChange {
  const before = indexByName(previous)
  const after = indexByName(next)
  const added = [...after.keys()].filter((n) => !before.has(n)).sort()
  const removed = [...before.keys()].filter((n) => !after.has(n)).sort()
  const changed: string[] = []
  const reasons: McpToolRiskReason[] = []
  const reason = (rule: McpToolRiskRule, tool: string, points: number, detail: string) =>
    reasons.push({ rule, tool, points, detail })

  for (const name of added) {
    const tool = after.get(name)!
    const start = reasons.length
    const poison = tool.description ? scanToolDescription(tool.description) : []
    if (poison.length > 0) {
      reason('description_poisoned', name, RULE_POINTS.description_poisoned, `new tool's description matches ${poison.join(', ')}`)
    }
    for (const cap of capabilityList(capabilitiesOf(tool))) {
      reason('new_tool_capability', name, MCP_TOOL_CAPABILITY_POINTS[cap], `new tool implies ${CAPABILITY_WORDS[cap]}`)
    }
    if (reasons.length === start) reason('tool_added', name, RULE_POINTS.tool_added, 'new tool')
  }

  for (const name of [...after.keys()].filter((n) => before.has(n)).sort()) {
    const prev = before.get(name)!
    const cur = after.get(name)!
    const descriptionChanged = (prev.description ?? '') !== (cur.description ?? '')
    const schemaChanged = stableJson(prev.inputSchema ?? null) !== stableJson(cur.inputSchema ?? null)
    if (!descriptionChanged && !schemaChanged) continue
    changed.push(name)
    const start = reasons.length

    if (descriptionChanged && cur.description) {
      const was = new Set(prev.description ? scanToolDescription(prev.description) : [])
      const now = scanToolDescription(cur.description).filter((p) => !was.has(p))
      if (now.length > 0) {
        reason('description_poisoned', name, RULE_POINTS.description_poisoned, `description now matches ${now.join(', ')}`)
      }
    }
    const hadCaps = capabilitiesOf(prev)
    for (const cap of capabilityList(capabilitiesOf(cur))) {
      if (!hadCaps.has(cap)) {
        reason('capability_gained', name, MCP_TOOL_CAPABILITY_POINTS[cap], `now implies ${CAPABILITY_WORDS[cap]}`)
      }
    }
    if (schemaChanged) {
      const widened: string[] = []
      const confirmations: string[] = []
      compareSchemas(asSchema(prev.inputSchema) ?? {}, asSchema(cur.inputSchema) ?? {}, '', widened, confirmations)
      if (confirmations.length > 0) {
        reason('confirmation_removed', name, RULE_POINTS.confirmation_removed, confirmations.join('; '))
      }
      if (widened.length > 0) reason('schema_widened', name, RULE_POINTS.schema_widened, widened.join('; '))
    }
    if (reasons.length === start && descriptionChanged) {
      reason('description_changed', name, RULE_POINTS.description_changed, 'description changed')
    }
  }

  const order = (r: McpToolRiskReason) => [r.tool, r.rule, r.detail]
  reasons.sort((a, b) => {
    const [x, y] = [order(a), order(b)]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
    return 0
  })
  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0))
  return { added, removed, changed: changed.sort(), score, level: riskLevelOf(score), reasons }
}
