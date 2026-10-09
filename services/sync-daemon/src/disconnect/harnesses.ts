/**
 * harnesses.ts — the reverse of every file `intutic connect` writes, harness
 * by harness.
 *
 * Each entry names the files one harness's writers touch (its rules file,
 * its gate script and hook registrations, its proxy routing, its MCP
 * config) and how each is undone. The writers themselves are the source:
 * `tools/cli/src/harness/*.ts` (the connect adapters),
 * `services/sync-daemon/src/harness/*Hooks.ts` and `mcpAutoWrite.ts`.
 *
 * Workspace files are undone in every workspace in the context; user-level
 * files once. A file two harnesses share (`AGENTS.md`, `.env.intutic`) is
 * undone only when none of the harnesses that write it stays connected.
 *
 * @module
 */

import * as node_path from 'node:path'
import * as node_os from 'node:os'
import * as node_fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { harnessesReading } from '@intutic/shared-types'
import { isSeq, parseDocument, type Document } from 'yaml'
import { parse as parseToml } from 'smol-toml'
import {
  antigravityMcpConfigPath,
  claudeDesktopConfigPath,
  continueConfigPath,
  cursorGlobalConfigPath,
  geminiSettingsPath,
  gooseConfigPath,
  grokUserConfigPath,
  museConfigPath,
  openCodeGlobalConfigPath,
  windsurfConfigPath,
} from '../harness/mcpAutoWrite.js'
import { jetbrainsConfigRoot } from '../harness/windsurfJetBrainsProxy.js'
import { windsurfSettingsPath } from '../harness/windsurfHooks.js'
import { ANTIGRAVITY_CLI_GATE, ANTIGRAVITY_HOOK_NAME, antigravityHooksPath } from '../harness/antigravityCliHooks.js'
import { DECISIONS_MARKERS, removeRulesSection, rulesSectionOf, RULES_SECTION_END } from '../harness/rulesSection.js'
import { DECISIONS_FILE_HEADER } from '../lib/decisionsDigest.js'
import { parseComponentOptions, serializeComponentOptions, type ComponentOptionsFile } from '../harness/jetbrainsXmlConfig.js'
import { resolveDshHome, listDshProfileDirs } from '../harness/dshHooks.js'
import { stripOwnHeader as stripAiderHeader, AIDER_DECISIONS_FILE, AIDER_SOPS_FILE, isAiderIntuticEntry } from '../harness/aiderConfigMerger.js'
import {
  OPENCLAW_PLUGIN_FILE,
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_MARKER,
  openclawAgentWorkspace,
  parseJson5Like,
} from '../harness/openclawHooks.js'
import { PI_AGENT_DIR, PI_EXTENSION_FILE, PI_EXTENSION_MARKER } from '../harness/piHooks.js'
import { unharden } from '../harness/gooseHardener.js'
import { pruneLedger, readOriginal, sha256 } from './originals.js'
import { ENV_INTUTIC_WRITERS } from '../configWriter.js'
import {
  allEdits,
  deleteFile,
  deletePath,
  getPath,
  isObject,
  jsonFormat,
  orderLike,
  pruneEmpty,
  readText,
  removeFromArray,
  restoreKey,
  restoreMatchingValues,
  reverseOwnedFile,
  reverseStructuredFile,
  reverseTextFile,
  setPath,
  tomlFormat,
  yamlFormat,
  type DisconnectPlan,
  type JsonObject,
  type ReverseContext,
  type StructuredFormat,
} from './plan.js'
import {
  antigravityRemoteShape,
  geminiRemoteShape,
  unwrapClaudeState,
  unwrapContinueServers,
  unwrapOpenCodeServers,
  unwrapServersAt,
  unwrapUnmarkedServersAt,
} from './mcp.js'
import { contains, isGateCommandEntry, isGateEntry, runsGate, RULES_HEADER, startsWithRulesHeader } from './recognise.js'
import { lineValue, removeEmptyTable, removeTable, restoreKeyLine, tomlSections } from './tomlLines.js'

export interface DisconnectContext {
  /** Workspaces to undo connect in. */
  workspaceRoots: readonly string[]
  /** Recognises a URL on the Intutic proxy. */
  isProxyUrl: (value: unknown) => boolean
  /** Harnesses that stay connected after this run. */
  remaining: ReadonlySet<string>
}

export type HarnessReverser = (plan: DisconnectPlan, ctx: DisconnectContext) => Promise<void>

const home = () => node_os.homedir()
const join = node_path.join

// ─── Shared shapes ───────────────────────────────────────────────────────────

/** Deletes a file in one of Intutic's own directories (`.intutic/`, `~/.intutic/`). */
async function intuticFile(plan: DisconnectPlan, file: string): Promise<void> {
  if (!plan.claim(file)) return
  try {
    await node_fs.access(file)
  } catch {
    return
  }
  plan.change(file, 'delete (Intutic file)', () => deleteFile(file))
}

/** Deletes gate scripts from a workspace's (or the home) `.intutic/hooks/`. */
async function gateScripts(plan: DisconnectPlan, root: string, names: readonly string[]): Promise<void> {
  for (const name of names) await intuticFile(plan, join(root, '.intutic', 'hooks', name))
  plan.removeIfEmpty(join(root, '.intutic', 'hooks'))
}

/** A rules file Intutic writes whole, with the generated header first. */
async function rulesFile(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  await reverseOwnedFile(plan, file, workspaceRoot, startsWithRulesHeader)
}

/** A rules file of Intutic's own that may open with the product's front matter (`alwaysApply: true`, ...). */
async function ownRulesFile(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  await reverseOwnedFile(plan, file, workspaceRoot, contains(RULES_HEADER))
}

/**
 * An instructions file the user also writes (`CLAUDE.md`, `AGENTS.md`, ...):
 * the marked rules section comes out, or, in a file an earlier version wrote
 * whole, the whole file is undone.
 */
async function instructionsFile(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  const text = await readText(file)
  if (text !== null && (rulesSectionOf(text) !== null || rulesSectionOf(text, DECISIONS_MARKERS) !== null)) await rulesSection(plan, file, workspaceRoot)
  else await rulesFile(plan, file, workspaceRoot)
}

async function json(
  plan: DisconnectPlan,
  file: string,
  workspaceRoot: string,
  edit: (doc: JsonObject, ctx: ReverseContext) => boolean,
  deleteIfEmptyWithoutRecord = false,
): Promise<void> {
  await reverseStructuredFile(plan, file, workspaceRoot, jsonFormat, edit, { deleteIfEmptyWithoutRecord })
}

/** `{ hooks: { <event>: [{ matcher, hooks: [{ command }] }] } }`, the Claude-Code-style shape. */
function removeGateEntries(doc: JsonObject, ctx: ReverseContext, events: readonly string[], script: string): boolean {
  return allEdits(...events.map((event) => removeFromArray(doc, ['hooks', event], isGateEntry(script), ctx.original)))
}

/** A key Intutic adds when it is missing (a schema version, a format version): removed when the original lacked it. */
function removeAddedKey(doc: JsonObject, path: string[], ctx: ReverseContext): boolean {
  if (ctx.original === null || getPath(ctx.original, path) !== undefined || getPath(doc, path) === undefined) return false
  return deletePath(doc, path)
}

/** Keys Intutic stamps for provenance; never the user's. */
function removeOwnKeys(doc: JsonObject, keys: readonly string[]): boolean {
  return allEdits(...keys.map((k) => deletePath(doc, [k])))
}

const startsWith = (prefix: string) => (v: unknown) => typeof v === 'string' && v.startsWith(prefix)

/** Runs `fn` only when none of `writers` stays connected. */
async function sharedBy(ctx: DisconnectContext, writers: readonly string[], fn: () => Promise<void>): Promise<void> {
  if (writers.some((h) => ctx.remaining.has(h))) return
  await fn()
}

async function forEachWorkspace(ctx: DisconnectContext, fn: (root: string) => Promise<void>): Promise<void> {
  for (const root of ctx.workspaceRoots) await fn(root)
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

const CLAUDE_GATES = ['claude-code-check.js', 'pre-tool-check.js']

function isClaudeGateEntry(entry: unknown): boolean {
  return CLAUDE_GATES.some((script) => isGateEntry(script)(entry))
}

/**
 * Puts `permissions.deny` back. The writer records the rules it added
 * (`intuticDeny`); a rule the user added since stays. In the workspace file
 * the writer replaced the list outright, so the original rules come back; in
 * the user file it only ever added, so an original rule missing now was
 * removed by the user and stays removed.
 */
function restoreDeny(doc: JsonObject, ctx: ReverseContext, replaced: boolean): boolean {
  const deny = getPath(doc, ['permissions', 'deny'])
  if (!Array.isArray(deny)) return false
  const recorded = ctx.record?.meta?.intuticDeny
  if (!Array.isArray(recorded)) {
    if (deny.length > 0) ctx.note('permissions.deny may hold rules an earlier Intutic version added without recording them; review it')
    return false
  }
  const added = new Set(recorded)
  const originalValue = ctx.original ? getPath(ctx.original, ['permissions', 'deny']) : undefined
  const originalDeny = Array.isArray(originalValue) ? originalValue : []
  const kept = replaced ? originalDeny : originalDeny.filter((r) => deny.includes(r))
  const next = [...kept, ...deny.filter((r) => !originalDeny.includes(r) && !added.has(r as string))]
  if (isDeepStrictEqual(next, deny)) return false
  if (next.length === 0 && originalValue === undefined) {
    deletePath(doc, ['permissions', 'deny'])
    pruneEmpty(doc, ['permissions'], ctx.original)
  } else {
    setPath(doc, ['permissions', 'deny'], next)
  }
  return true
}

function claudeSettings(plan: DisconnectPlan, file: string, workspaceRoot: string, replacedDeny: boolean): Promise<void> {
  return json(plan, file, workspaceRoot, (doc, ctx) => {
    const hooks = removeFromArray(doc, ['hooks', 'PreToolUse'], isClaudeGateEntry, ctx.original)
    return allEdits(hooks, (hooks || ctx.record !== null) && restoreDeny(doc, ctx, replacedDeny))
  })
}

const claudeCode: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await ownRulesFile(plan, join(root, '.claude', 'rules', 'intutic-governance.md'), root)
    await decisionsFile(plan, join(root, '.claude', 'rules', 'intutic-decisions.md'), root)
    // Where earlier versions wrote the rules whole and appended the decisions log.
    await legacyClaudeMd(plan, join(root, 'CLAUDE.md'), root)
    await claudeSettings(plan, join(root, '.claude', 'settings.json'), root, true)
    await gateScripts(plan, root, ['claude-code-check.js'])
    await sharedBy(ctx, ['claude-code', 'cursor'], () => gateScripts(plan, root, ['pre-tool-check.js']))
  })
  await claudeSettings(plan, join(home(), '.claude', 'settings.json'), home(), false)
  // Claude Code's own state file: only the MCP maps are Intutic's, and it is never restored whole.
  await json(plan, join(home(), '.claude.json'), home(), (doc) => unwrapClaudeState(doc))
}

// ─── Claude Desktop ──────────────────────────────────────────────────────────

const claudeDesktop: HarnessReverser = async (plan) => {
  await json(plan, claudeDesktopConfigPath(), home(), (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original))
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

const CURSOR_EVENTS = ['beforeShellExecution', 'beforeMCPExecution', 'preToolUse']

function cursorHooks(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  return json(
    plan,
    file,
    workspaceRoot,
    (doc, c) => {
      const removed = allEdits(
        ...CURSOR_EVENTS.map((e) => removeFromArray(doc, ['hooks', e], isGateCommandEntry('cursor-check.js'), c.original)),
      )
      if (!removed) return false
      // The writer adds `version: 1` when the file has none.
      if (c.original !== null) removeAddedKey(doc, ['version'], c)
      else if (Object.keys(doc).length === 1 && doc.version === 1) delete doc.version
      return true
    },
    true,
  )
}

const cursor: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await ownRulesFile(plan, join(root, '.cursor', 'rules', 'intutic-governance.mdc'), root)
    await decisionsFile(plan, join(root, '.cursor', 'rules', 'intutic-decisions.mdc'), root)
    await rulesFile(plan, join(root, '.cursorrules'), root)
    await gateScripts(plan, root, ['cursor-check.js'])
    await cursorHooks(plan, join(root, '.cursor', 'hooks.json'), root)
    await json(plan, join(root, '.cursor', 'mcp.json'), root, (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original), true)
    await sharedBy(ctx, ['claude-code', 'cursor'], () => gateScripts(plan, root, ['pre-tool-check.js']))
  })
  await cursorHooks(plan, join(home(), '.cursor', 'hooks.json'), home())
  await json(plan, cursorGlobalConfigPath(), home(), (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original))
}

// ─── Windsurf ────────────────────────────────────────────────────────────────

const CASCADE_EVENTS = ['pre_run_command', 'pre_write_code', 'pre_mcp_tool_use']

function cascadeHooks(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  return json(
    plan,
    file,
    workspaceRoot,
    (doc, c) => allEdits(...CASCADE_EVENTS.map((e) => removeFromArray(doc, ['hooks', e], isGateCommandEntry('windsurf-check.js'), c.original))),
    true,
  )
}

/**
 * Desktop's `settings.json`: the two proxy keys, and the TLS check the writer
 * switched off with them. Both keys naming the same loopback listener with
 * the check off is the writer's signature, recognised even when connect
 * predates the recorded proxy URLs; the listener is then passed on, for the
 * JetBrains settings it also pointed there. Both the settings file Windsurf
 * reads and `~/.codeium/windsurf/settings.json`, where earlier versions wrote
 * the keys.
 */
async function windsurfProxySettings(plan: DisconnectPlan, ctx: DisconnectContext): Promise<string | null> {
  let listener: string | null = null
  for (const file of [windsurfSettingsPath(), join(home(), '.codeium', 'windsurf', 'settings.json')]) {
    listener = (await windsurfProxySettingsFile(plan, ctx, file)) ?? listener
  }
  return listener
}

async function windsurfProxySettingsFile(plan: DisconnectPlan, ctx: DisconnectContext, file: string): Promise<string | null> {
  let listener: string | null = null
  await json(plan, file, home(), (doc, c) => {
    const proxy = doc['http.proxy']
    const signature =
      typeof proxy === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(proxy) && doc['codeium.proxy'] === proxy && doc['http.proxyStrictSSL'] === false
    if (signature) listener = proxy as string
    const isOurs = (v: unknown) => ctx.isProxyUrl(v) || (signature && v === proxy)
    const proxied = allEdits(restoreKey(doc, ['http.proxy'], c, isOurs), restoreKey(doc, ['codeium.proxy'], c, isOurs))
    if (!proxied) return false
    restoreKey(doc, ['http.proxyStrictSSL'], c, (v) => v === false)
    return true
  })
  return listener
}

/** A JetBrains `options/*.xml` settings file, as one component's options. */
function xmlComponentFormat(component: string): StructuredFormat<ComponentOptionsFile> {
  return {
    parse(raw) {
      const parsed = parseComponentOptions(raw, component)
      if (parsed === null) throw new Error('not a JetBrains settings file')
      return parsed
    },
    toJS: (file) => structuredClone(file) as unknown as JsonObject,
    write: (_file, next) => serializeComponentOptions(next as unknown as ComponentOptionsFile, component),
  }
}

const JETBRAINS_PROXY_OPTIONS = ['USE_HTTP_PROXY', 'USE_PROXY_PAC', 'PROXY_TYPE_IS_SOCKS', 'PROXY_HOST', 'PROXY_PORT']

/**
 * The JetBrains platform proxy the writer pointed at the Intutic proxy, and
 * the Windsurf plugin's "Detect proxy" toggle it switched on, in every IDE
 * where it did.
 */
async function jetbrainsProxy(plan: DisconnectPlan, ctx: DisconnectContext, listener: string | null): Promise<void> {
  const root = jetbrainsConfigRoot()
  if (!root) return
  let products: string[]
  try {
    products = await node_fs.readdir(root)
  } catch {
    return
  }
  for (const product of products) {
    const options = join(root, product, 'options')
    let reverted = false
    await reverseStructuredFile(plan, join(options, 'proxy.settings.xml'), home(), xmlComponentFormat('HttpConfigurable'), (doc, c) => {
      const host = getPath(doc, ['options', 'PROXY_HOST'])
      const port = getPath(doc, ['options', 'PROXY_PORT'])
      const url = `http://${host}:${port}`
      if (typeof host !== 'string' || typeof port !== 'string' || !(ctx.isProxyUrl(url) || url === listener)) return false
      for (const key of JETBRAINS_PROXY_OPTIONS) {
        const was = c.original ? getPath(c.original, ['options', key]) : undefined
        if (was === undefined) deletePath(doc, ['options', key])
        else setPath(doc, ['options', key], was)
      }
      if (c.original === null) c.note('the IDE proxy was switched off rather than restored: an earlier Intutic version set it without keeping the previous setting')
      reverted = true
      return true
    }, { deleteIfEmptyWithoutRecord: true })
    if (!reverted) continue
    await reverseStructuredFile(
      plan,
      join(options, 'CodeiumSettings.xml'),
      home(),
      xmlComponentFormat('com.codeium.intellij.settings.AppSettingsState'),
      (doc, c) => {
        if (c.original === null || getPath(doc, ['options', 'detectProxy']) !== 'true') return false
        const was = getPath(c.original, ['options', 'detectProxy'])
        if (was === 'true') return false
        if (was === undefined) deletePath(doc, ['options', 'detectProxy'])
        else setPath(doc, ['options', 'detectProxy'], was)
        return true
      },
    )
  }
}

const windsurf: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await ownRulesFile(plan, join(root, '.windsurf', 'rules', 'intutic-governance.md'), root)
    await decisionsFile(plan, join(root, '.windsurf', 'rules', 'intutic-decisions.md'), root)
    await rulesFile(plan, join(root, '.windsurfrules'), root)
    await gateScripts(plan, root, ['windsurf-check.js'])
    await cascadeHooks(plan, join(root, '.windsurf', 'hooks.json'), root)
  })
  await cascadeHooks(plan, join(home(), '.codeium', 'windsurf', 'hooks.json'), home())
  await cascadeHooks(plan, join(home(), '.codeium', 'hooks.json'), home())
  const listener = await windsurfProxySettings(plan, ctx)
  await jetbrainsProxy(plan, ctx, listener)
  await json(plan, windsurfConfigPath(), home(), (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original))
}

// ─── GitHub Copilot ──────────────────────────────────────────────────────────

const OWN_HOOK_FILE = contains('Intutic governance hook')

const githubCopilot: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await instructionsFile(plan, join(root, '.github', 'copilot-instructions.md'), root)
    await gateScripts(plan, root, ['github-copilot-check.js'])
    await reverseOwnedFile(plan, join(root, '.github', 'hooks', 'intutic-governance.json'), root, OWN_HOOK_FILE)
  })
  await reverseOwnedFile(plan, join(home(), '.copilot', 'hooks', 'intutic-governance.json'), home(), OWN_HOOK_FILE)
}

// ─── AGENTS.md readers ───────────────────────────────────────────────────────

/** Every harness whose rule sets go into the workspace's `AGENTS.md`. */
const AGENTS_MD_WRITERS = harnessesReading('AGENTS.md')

/** The `AGENTS.md` section, once none of the harnesses that read it stays connected. */
async function agentsMd(plan: DisconnectPlan, ctx: DisconnectContext): Promise<void> {
  await sharedBy(ctx, AGENTS_MD_WRITERS, () => forEachWorkspace(ctx, (root) => instructionsFile(plan, join(root, 'AGENTS.md'), root)))
}

const MUSE_EVENTS = ['PreToolUse', 'PermissionRequest']

const muse: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await forEachWorkspace(ctx, async (root) => {
    await gateScripts(plan, root, ['muse-check.js'])
    await json(
      plan,
      join(root, '.muse', 'hooks.json'),
      root,
      (doc, c) =>
        allEdits(
          removeGateEntries(doc, c, MUSE_EVENTS, 'muse-check.js'),
          restoreKey(doc, ['description'], c, startsWith('Intutic governance hooks')),
        ),
      true,
    )
  })
  const museDir = node_path.dirname(museConfigPath())
  await reverseOwnedFile(plan, join(museDir, 'intutic-managed-hooks.json'), home(), contains('Intutic governance hooks'))
  await json(plan, museConfigPath(), home(), (doc, c) => {
    const changed = allEdits(
      unwrapServersAt(doc, ['mcp_servers'], c.original),
      restoreKey(doc, ['managed_hooks_path'], c, (v) => typeof v === 'string' && v.endsWith('intutic-managed-hooks.json')),
    )
    // Both writers add `schema_version` to a file that has none.
    if (changed) removeAddedKey(doc, ['schema_version'], c)
    return changed
  })
}

function grokConfig(plan: DisconnectPlan, file: string, workspaceRoot: string, ctx: DisconnectContext): Promise<void> {
  return reverseStructuredFile(plan, file, workspaceRoot, tomlFormat, (doc, c) => {
    const models = isObject(doc.model) ? Object.keys(doc.model) : []
    return allEdits(
      unwrapServersAt(doc, ['mcp_servers'], c.original),
      ...models.map((name) => restoreKey(doc, ['model', name, 'base_url'], c, ctx.isProxyUrl)),
    )
  })
}

const grok: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await forEachWorkspace(ctx, async (root) => {
    await gateScripts(plan, root, ['grok-check.js'])
    await reverseOwnedFile(plan, join(root, '.grok', 'hooks', 'intutic-governance.json'), root, OWN_HOOK_FILE)
    await grokConfig(plan, join(root, '.grok', 'config.toml'), root, ctx)
  })
  await reverseOwnedFile(plan, join(home(), '.grok', 'hooks', 'intutic-governance.json'), home(), OWN_HOOK_FILE)
  await grokConfig(plan, grokUserConfigPath(), home(), ctx)
}

const OWN_PLUGIN = contains('Intutic OpenCode governance plugin.')

const opencode: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await forEachWorkspace(ctx, async (root) => {
    const plugins = join(root, '.opencode', 'plugins')
    await reverseOwnedFile(plan, join(plugins, 'intutic-governance.js'), root, OWN_PLUGIN)
    await reverseOwnedFile(plan, join(plugins, 'intutic-governance', 'index.js'), root, OWN_PLUGIN)
    plan.removeIfEmpty(join(plugins, 'intutic-governance'))
    await json(plan, join(root, 'opencode.json'), root, (doc, c) => unwrapOpenCodeServers(doc, c.original))
  })
  await json(plan, openCodeGlobalConfigPath(), home(), (doc, c) => unwrapOpenCodeServers(doc, c.original))
}

// ─── Roo Code, Cline ─────────────────────────────────────────────────────────

const rooCode: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await forEachWorkspace(ctx, (root) => rulesFile(plan, join(root, '.roorules'), root))
}

const cline: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await rulesFile(plan, join(root, '.clinerules', 'intutic-governance.md'), root)
    await decisionsFile(plan, join(root, '.clinerules', 'intutic-decisions.md'), root)
    await reverseOwnedFile(plan, join(root, '.clinerules', 'hooks', 'PreToolUse'), root, contains('Intutic Cline PreToolUse governance gate.'))
    await json(plan, join(root, '.cline', 'mcp.json'), root, (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original), true)
  })
}

// ─── Codex and the SDK adapters (.env.intutic) ───────────────────────────────


async function envIntutic(plan: DisconnectPlan, ctx: DisconnectContext): Promise<void> {
  await sharedBy(ctx, ENV_INTUTIC_WRITERS, () => forEachWorkspace(ctx, (root) => rulesFile(plan, join(root, '.env.intutic'), root)))
}

/** The comment `codexConfigMerger.ts` writes above the key it inserts. */
const CODEX_KEY_COMMENT = "# Set by Intutic: routes Codex's built-in OpenAI provider through the Intutic proxy."

function codexHome(): string {
  return process.env.CODEX_HOME || join(home(), '.codex')
}

function codexConfig(plan: DisconnectPlan, ctx: DisconnectContext): Promise<void> {
  return reverseTextFile(plan, join(codexHome(), 'config.toml'), home(), parseToml, (text, c) => {
    const lines = text.split('\n')
    if (lines[0] === CODEX_KEY_COMMENT && ctx.isProxyUrl(lineValue(lines[1] ?? '', 'openai_base_url'))) {
      // Inserted at the top, with a blank line before the user's content.
      lines.splice(0, lines[2] === '' ? 3 : 2)
      return lines.join('\n')
    }
    const originalLines = c.originalText === null ? null : c.originalText.split('\n')
    if (!restoreKeyLine(lines, null, 'openai_base_url', originalLines, ctx.isProxyUrl)) return null
    if (originalLines === null) c.note('openai_base_url was removed rather than restored: an earlier Intutic version set it without keeping the value it replaced')
    return lines.join('\n')
  })
}

function codexHooks(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  return json(
    plan,
    file,
    workspaceRoot,
    (doc, c) =>
      allEdits(
        removeGateEntries(doc, c, ['PreToolUse'], 'codex-check.js'),
        restoreKey(doc, ['description'], c, startsWith('Intutic governance PreToolUse hook')),
      ),
    true,
  )
}

const codex: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await envIntutic(plan, ctx)
  await forEachWorkspace(ctx, async (root) => {
    await gateScripts(plan, root, ['codex-check.js'])
    await codexHooks(plan, join(root, '.codex', 'hooks.json'), root)
  })
  await codexHooks(plan, join(codexHome(), 'hooks.json'), home())
  await codexConfig(plan, ctx)
}

const sdkAdapter: HarnessReverser = (plan, ctx) => envIntutic(plan, ctx)

// ─── Aider ───────────────────────────────────────────────────────────────────

/** `.aider.conf.yml` without the header the merger writes above the user's content. */
const aiderFormat: StructuredFormat<{ doc: Document; hadHeader: boolean }> = {
  parse(raw) {
    const stripped = stripAiderHeader(raw)
    return { doc: yamlFormat.parse(stripped), hadHeader: stripped !== raw }
  },
  toJS: (h) => yamlFormat.toJS(h.doc),
  write: (h, next, raw, original) => yamlFormat.write(h.doc, next, raw, original?.doc ?? null),
}

/** Keys the merger removes from the user's file while it is connected; put back from the original. */
const AIDER_REMOVED_KEYS = ['test-cmd', 'lint-cmd', 'auto-test', 'auto-lint', 'test_cmd', 'lint_cmd']

function removeFromList(doc: JsonObject, key: string, isOurs: (v: unknown) => boolean, ctx: ReverseContext): boolean {
  const value = doc[key]
  if (!Array.isArray(value)) return false
  const kept = value.filter((v) => !isOurs(v))
  if (kept.length === value.length) return false
  doc[key] = kept
  pruneEmpty(doc, [key], ctx.original)
  return true
}

function aiderConfig(plan: DisconnectPlan, root: string, ctx: DisconnectContext): Promise<void> {
  return reverseStructuredFile(plan, join(root, '.aider.conf.yml'), root, aiderFormat, (doc, c) => {
    const hadHeader = (c.handle as { hadHeader: boolean }).hadHeader
    const envIsOurs = (v: unknown) => typeof v === 'string' && v.startsWith('ANTHROPIC_BASE_URL=') && ctx.isProxyUrl(v.slice('ANTHROPIC_BASE_URL='.length))
    const changed = allEdits(
      hadHeader,
      restoreKey(doc, ['openai-api-base'], c, ctx.isProxyUrl),
      removeFromList(doc, 'set-env', envIsOurs, c),
      removeFromList(doc, 'read', (v) => isAiderIntuticEntry(v, root), c),
    )
    if (!changed || c.original === null) return changed
    // The merger dropped the user's own ANTHROPIC_BASE_URL entry and the
    // auto-run keys, and turned a single `set-env`/`read` value into a list:
    // all of it comes back.
    const original = c.original
    const userEnv = asList(original['set-env']).filter((v) => typeof v === 'string' && v.startsWith('ANTHROPIC_BASE_URL='))
    if (userEnv.length > 0) doc['set-env'] = [...asList(doc['set-env']), ...userEnv]
    for (const key of ['set-env', 'read']) {
      const was = original[key]
      if (was !== undefined && !Array.isArray(was) && isDeepStrictEqual(doc[key], [was])) doc[key] = was
    }
    for (const key of AIDER_REMOVED_KEYS) {
      if (original[key] !== undefined && doc[key] === undefined) doc[key] = structuredClone(original[key])
    }
    orderLike(doc, original)
    return true
  })
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
}

const aider: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await aiderConfig(plan, root, ctx)
    await intuticFile(plan, join(root, AIDER_SOPS_FILE))
    await decisionsFile(plan, join(root, AIDER_DECISIONS_FILE), root)
  })
}

// ─── OpenHands ───────────────────────────────────────────────────────────────

/**
 * An OpenHands `config.toml`: the `[intutic]` table earlier versions
 * appended (it held the rules, which OpenHands never read), and every
 * `base_url` the two writers pointed at the proxy (one of them replaced the
 * first `base_url` line in the file, whichever table held it).
 */
function openHandsConfig(plan: DisconnectPlan, file: string, workspaceRoot: string, ctx: DisconnectContext): Promise<void> {
  return reverseTextFile(plan, file, workspaceRoot, parseToml, (text, c) => {
    const lines = text.split('\n')
    const originalLines = c.originalText === null ? null : c.originalText.split('\n')
    let changed = removeTable(lines, 'intutic')
    const tables = new Set(tomlSections(lines).map((s) => s.name))
    for (const table of tables) changed = restoreKeyLine(lines, table, 'base_url', originalLines, ctx.isProxyUrl) || changed
    if (!changed) return null
    const originalHadLlm = originalLines !== null && tomlSections(originalLines).some((s) => s.name === 'llm')
    if (!originalHadLlm) removeEmptyTable(lines, 'llm')
    if (originalLines === null) c.note('base_url was removed rather than restored where Intutic had set it: an earlier version kept no record of the value it replaced')
    // The appended table ended the file; its removal must not take the final newline with it.
    const out = lines.join('\n')
    return text.endsWith('\n') && !out.endsWith('\n') ? out + '\n' : out
  })
}

const openhands: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await rulesFile(plan, join(root, '.openhands', 'microagents', 'intutic-governance.md'), root)
    await decisionsFile(plan, join(root, '.openhands', 'microagents', 'intutic-decisions.md'), root)
    await openHandsConfig(plan, join(root, 'config.toml'), root, ctx)
    await gateScripts(plan, root, ['openhands-check.sh'])
    await reverseOwnedFile(plan, join(root, '.openhands', 'hooks.json'), root, OWN_HOOK_FILE)
    await json(plan, join(root, '.openhands', 'mcp.json'), root, (doc, c) => unwrapServersAt(doc, ['mcpServers'], c.original), true)
  })
  await openHandsConfig(plan, join(home(), '.openhands', 'config.toml'), home(), ctx)
}

// ─── Antigravity and Gemini CLI ──────────────────────────────────────────────

/** Antigravity's hooks file keys hooks by name; `intutic-governance` is Intutic's when it only runs the gate. */
function isAntigravityGate(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.PreToolUse) && value.PreToolUse.length > 0 &&
    value.PreToolUse.every(isGateEntry(ANTIGRAVITY_CLI_GATE))
}

/**
 * A user's instructions file holding Intutic's marked rules section: the
 * section goes, and the original bytes come back when nothing else changed.
 * Trailing line breaks are compared loosely, since the section's removal
 * cannot tell them apart; a file that had no final line break gets none back.
 */
function rulesSection(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  return reverseTextFile(plan, file, workspaceRoot, (text) => text.trimEnd(), (text, c) => {
    const withoutRules = removeRulesSection(text) ?? text
    const next = removeRulesSection(withoutRules, DECISIONS_MARKERS) ?? withoutRules
    if (next === text) return null
    if (c.originalText === null || c.originalText.endsWith('\n')) return next
    const tail = text.trimEnd()
    return tail.endsWith(RULES_SECTION_END) || tail.endsWith(DECISIONS_MARKERS.end) ? next.replace(/\r?\n$/, '') : next
  })
}

/**
 * A `CLAUDE.md` earlier versions wrote to: the decisions-log section they
 * appended comes out, and a file they wrote whole underneath it is given
 * back too. Without the section, the whole-file case is {@link rulesFile}.
 */
async function legacyClaudeMd(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  const text = await readText(file)
  if (text === null || rulesSectionOf(text, DECISIONS_MARKERS) === null) return rulesFile(plan, file, workspaceRoot)
  const record = await readOriginal(file, workspaceRoot)
  await reverseTextFile(plan, file, workspaceRoot, (t) => t.trimEnd(), (t, c) => {
    const next = removeRulesSection(t, DECISIONS_MARKERS)
    if (next === null) return null
    if (startsWithRulesHeader(next) && record?.writtenSha256 === sha256(next)) return c.originalText ?? ''
    return next
  })
}

/** The decisions log's own file next to a harness's rules file. */
async function decisionsFile(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  await reverseOwnedFile(plan, file, workspaceRoot, contains(DECISIONS_FILE_HEADER))
}

const antigravity: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await gateScripts(plan, root, ['antigravity-check.sh', ANTIGRAVITY_CLI_GATE])
    await rulesSection(plan, join(root, 'GEMINI.md'), root)
    // Where earlier versions put the rules (a key neither product reads), and
    // the project's Gemini CLI MCP servers.
    await json(plan, join(root, '.gemini', 'settings.json'), root, (doc, c) =>
      allEdits(
        restoreKey(doc, ['customInstructions'], c, (v) => typeof v === 'string' && startsWithRulesHeader(v)),
        unwrapUnmarkedServersAt(doc, ['mcpServers'], c.original, geminiRemoteShape),
      ),
    true)
  })
  await json(plan, geminiSettingsPath(), home(), (doc, c) =>
    allEdits(
      removeGateEntries(doc, c, ['BeforeTool'], 'antigravity-check.sh'),
      unwrapUnmarkedServersAt(doc, ['mcpServers'], c.original, geminiRemoteShape),
    ))
  await json(plan, antigravityHooksPath(), home(), (doc, c) => restoreKey(doc, [ANTIGRAVITY_HOOK_NAME], c, isAntigravityGate), true)
  await json(plan, antigravityMcpConfigPath(), home(), (doc, c) => unwrapUnmarkedServersAt(doc, ['mcpServers'], c.original, antigravityRemoteShape), true)
}

// ─── Continue ────────────────────────────────────────────────────────────────

function continueSettings(plan: DisconnectPlan, file: string, workspaceRoot: string): Promise<void> {
  return json(
    plan,
    file,
    workspaceRoot,
    (doc, c) => allEdits(removeGateEntries(doc, c, ['PreToolUse'], 'continue-check.js'), removeOwnKeys(doc, ['_intutic_comment', '_intutic_last_sync'])),
    true,
  )
}

const continueHarness: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, async (root) => {
    await ownRulesFile(plan, join(root, '.continue', 'rules', 'intutic-governance.md'), root)
    await decisionsFile(plan, join(root, '.continue', 'rules', 'intutic-decisions.md'), root)
    await gateScripts(plan, root, ['continue-check.js'])
    await continueSettings(plan, join(root, '.continue', 'settings.json'), root)
  })
  const dir = join(home(), '.continue')
  await continueSettings(plan, join(dir, 'settings.json'), home())
  await reverseStructuredFile(plan, join(dir, 'config.yaml'), home(), yamlFormat, (doc, c) => restoreMatchingValues(doc, c, ctx.isProxyUrl))
  await json(plan, continueConfigPath(), home(), (doc, c) => unwrapContinueServers(doc, c.original))
}

// ─── Goose ───────────────────────────────────────────────────────────────────

async function goosePlugin(plan: DisconnectPlan): Promise<void> {
  const plugin = join(home(), '.agents', 'plugins', 'intutic-governance')
  for (const file of [join(plugin, 'plugin.json'), join(plugin, 'hooks', 'hooks.json'), join(plugin, 'scripts', 'intutic-check.sh')]) {
    // Hardened read-only and immutable while connected: the flag comes off first.
    await reverseOwnedFile(plan, file, home(), contains('Intutic'), { beforeApply: () => unharden(file) })
    plan.removeIfEmpty(node_path.dirname(file))
  }
  plan.removeIfEmpty(plugin)
}

const goose: HarnessReverser = async (plan, ctx) => {
  await forEachWorkspace(ctx, (root) => rulesSection(plan, join(root, '.goosehints'), root))
  await goosePlugin(plan)
  await reverseStructuredFile(plan, gooseConfigPath(), home(), yamlFormat, (doc, c) =>
    allEdits(
      unwrapServersAt(doc, ['mcp'], c.original),
      restoreMatchingValues(doc, c, ctx.isProxyUrl),
      restoreKey(doc, ['hooks', 'pre_tool_use'], c, (v) => typeof v === 'string' && v.endsWith(join('intutic-governance', 'scripts', 'intutic-check.sh'))),
    ),
  )
}

// ─── Hermes, Pi, OpenClaw, n8n, Open WebUI ───────────────────────────────────

/** A per-harness env snippet in a workspace's `.intutic/env/`. */
async function envSnippet(plan: DisconnectPlan, ctx: DisconnectContext, name: string): Promise<void> {
  await forEachWorkspace(ctx, async (root) => {
    await intuticFile(plan, join(root, '.intutic', 'env', name))
    plan.removeIfEmpty(join(root, '.intutic', 'env'))
  })
}

const hermes: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await gateScripts(plan, home(), ['hermes-check.sh'])
  await reverseStructuredFile(plan, join(home(), '.hermes', 'config.yaml'), home(), yamlFormat, (doc, c) =>
    allEdits(
      removeFromArray(doc, ['hooks', 'pre_tool_call'], (e) => isObject(e) && runsGate(e.command, 'hermes-check.sh'), c.original),
      // Where earlier versions put it.
      restoreKey(doc, ['hooks', 'preToolUse', 'command'], c, (v) => runsGate(v, 'hermes-check.sh')),
    ),
  )
  const skill = join(home(), '.hermes', 'skills', 'intutic-governance')
  await reverseOwnedFile(plan, join(skill, 'SKILL.md'), home(), contains('name: intutic-governance'))
  plan.removeIfEmpty(skill)
  await envSnippet(plan, ctx, 'hermes.env')
}

const pi: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  await reverseOwnedFile(plan, join(home(), PI_EXTENSION_FILE), home(), contains(PI_EXTENSION_MARKER))
  const piModels = (file: string) =>
    json(plan, file, home(), (doc, c) =>
      allEdits(
        restoreKey(doc, ['providers', 'anthropic', 'baseUrl'], c, ctx.isProxyUrl),
        restoreKey(doc, ['providers', 'openai', 'baseUrl'], c, ctx.isProxyUrl),
      ),
    true)
  await piModels(join(home(), PI_AGENT_DIR, 'models.json'))
  // Where earlier versions wrote, and Pi never read: a PreToolUse hook in
  // ~/.pi/hooks.json and the routing in ~/.pi/models.json.
  await gateScripts(plan, home(), ['pi-check.sh'])
  await json(plan, join(home(), '.pi', 'hooks.json'), home(), (doc, c) => removeGateEntries(doc, c, ['PreToolUse'], 'pi-check.sh'), true)
  await piModels(join(home(), '.pi', 'models.json'))
  await envSnippet(plan, ctx, 'pi.env')
}

/** OpenClaw's config is JSON5-like; the writer re-serialises it as JSON, and so does this. */
const json5LikeFormat: StructuredFormat<JsonObject> = { ...jsonFormat, parse: (raw) => (raw.trim() === '' ? {} : parseJson5Like(raw)) }

/** The plugin's `plugins.load.paths` entry, and its id in `plugins.allow` unless the user had listed it before connect. */
function removeOpenclawPlugin(doc: JsonObject, ctx: ReverseContext): boolean {
  const originalAllow = ctx.original ? getPath(ctx.original, ['plugins', 'allow']) : undefined
  const allowedBefore = Array.isArray(originalAllow) && originalAllow.includes(OPENCLAW_PLUGIN_ID)
  return allEdits(
    removeFromArray(doc, ['plugins', 'load', 'paths'], (v) => typeof v === 'string' && v.endsWith(OPENCLAW_PLUGIN_FILE), ctx.original),
    !allowedBefore && removeFromArray(doc, ['plugins', 'allow'], (v) => v === OPENCLAW_PLUGIN_ID, ctx.original),
  )
}

/** Where earlier versions registered the gate: an internal hook entry, which never sees a tool call. */
function removeLegacyOpenclawHook(doc: JsonObject, ctx: ReverseContext): boolean {
  const path = ['hooks', 'internal', 'entries', 'intutic-governance']
  const entry = getPath(doc, path)
  if (!isObject(entry) || !runsGate(entry.command, 'openclaw-check.js')) return false
  deletePath(doc, path)
  pruneEmpty(doc, path.slice(0, -1), ctx.original)
  return true
}

const openclaw: HarnessReverser = async (plan, ctx) => {
  // The rules section of its agent workspace's AGENTS.md.
  await rulesSection(plan, join(await openclawAgentWorkspace(), 'AGENTS.md'), home())
  await reverseOwnedFile(plan, join(home(), OPENCLAW_PLUGIN_FILE), home(), contains(OPENCLAW_PLUGIN_MARKER))
  await gateScripts(plan, home(), ['openclaw-check.js'])
  await reverseStructuredFile(plan, join(home(), '.openclaw', 'openclaw.json'), home(), json5LikeFormat, (doc, c) =>
    allEdits(removeOpenclawPlugin(doc, c), removeLegacyOpenclawHook(doc, c)),
  { deleteIfEmptyWithoutRecord: true })
  await envSnippet(plan, ctx, 'openclaw.env')
}

/** n8n's local files. The workflow variables connect sets over n8n's API are undone by the CLI. */
const n8n: HarnessReverser = async (plan, ctx) => {
  await gateScripts(plan, home(), ['n8n-governance-hook.js'])
  for (const name of ['governance-workflow.json', 'INSTALL.md']) await intuticFile(plan, join(home(), '.intutic', 'n8n', name))
  plan.removeIfEmpty(join(home(), '.intutic', 'n8n'))
  await envSnippet(plan, ctx, 'n8n.env')
}

const openWebui: HarnessReverser = async (plan, ctx) => {
  await reverseOwnedFile(plan, join(home(), '.open-webui', 'intutic-governance-filter.py'), home(), contains('Intutic'))
  await envSnippet(plan, ctx, 'open-webui.env')
}

// ─── dsh ─────────────────────────────────────────────────────────────────────

const DSH_ROW_ID = 'intutic-governance'
const DSH_LLM_ENTRY_ID = 'llm-deepseek'

/** A dsh `cordis.patch.yml`, whose root is a list of patch rows. */
const dshPatchFormat: StructuredFormat<Document> = {
  parse(raw) {
    const doc = parseDocument(raw.trim() === '' ? '[]' : raw)
    if (doc.errors.length > 0) throw doc.errors[0]
    if (doc.contents !== null && !isSeq(doc.contents)) throw new Error('not a patch list')
    return doc
  },
  toJS: (doc) => ({ rows: (doc.toJS() as unknown[] | null) ?? [] }),
  write: (doc) => doc.toString(),
}

/** Whether a patch row is the plugin row the writer inserts (alone, or inside an `insert:` block it wrote). */
function isDshPluginRow(row: unknown): boolean {
  if (!isObject(row)) return false
  if (row.id === DSH_ROW_ID) return true
  return Array.isArray(row.insert) && row.insert.length === 1 && isObject(row.insert[0]) && row.insert[0].id === DSH_ROW_ID
}

function dshPatch(plan: DisconnectPlan, file: string, dshHome: string, ctx: DisconnectContext): Promise<void> {
  return reverseStructuredFile(plan, file, dshHome, dshPatchFormat, (doc, c) => {
    const yaml = c.handle as Document
    const rows = doc.rows as unknown[]
    const originalRows = c.original ? (c.original.rows as unknown[]) : null
    let changed = false
    // Last first, so the indexes of the rows still to visit stay put.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (isDshPluginRow(row)) {
        yaml.deleteIn([i])
        changed = true
        continue
      }
      if (!isObject(row) || row.id !== DSH_LLM_ENTRY_ID || 'insert' in row) continue
      const baseUrl = getPath(row, ['config', 'baseURL'])
      if (!ctx.isProxyUrl(baseUrl)) continue
      const originalRow = originalRows?.find((r) => isObject(r) && r.id === DSH_LLM_ENTRY_ID && !('insert' in r))
      const was = originalRow ? getPath(originalRow, ['config', 'baseURL']) : undefined
      const onlyBaseUrl = isObject(row.config) && Object.keys(row.config).length === 1 && Object.keys(row).length === 2
      if (was !== undefined) yaml.setIn([i, 'config', 'baseURL'], was)
      else if (onlyBaseUrl && originalRow === undefined) yaml.deleteIn([i])
      else yaml.deleteIn([i, 'config', 'baseURL'])
      if (originalRows === null) c.note('the llm-deepseek baseURL was removed rather than restored: an earlier Intutic version kept no record of the value it replaced')
      changed = true
    }
    doc.rows = (yaml.toJS() as unknown[] | null) ?? []
    return changed
  })
}

const DSH_GATE_RANGE = '^2.0.0'

const dsh: HarnessReverser = async (plan, ctx) => {
  await agentsMd(plan, ctx)
  // dsh's files live under $DSH_HOME, and their records with them (see dshHooks.ts).
  const dshHome = resolveDshHome()
  for (const profile of await listDshProfileDirs(dshHome)) {
    await dshPatch(plan, join(profile, 'cordis.patch.yml'), dshHome, ctx)
    await json(plan, join(profile, 'package.json'), dshHome, (doc, c) => {
      // Added only when the profile declared none; with no record, it may be the user's own `dsh plugin add`.
      if (c.original === null || getPath(doc, ['dependencies', '@intutic/gate']) !== DSH_GATE_RANGE) return false
      if (getPath(c.original, ['dependencies', '@intutic/gate']) !== undefined) return false
      deletePath(doc, ['dependencies', '@intutic/gate'])
      pruneEmpty(doc, ['dependencies'], c.original)
      return true
    })
  }
  await reverseOwnedFile(plan, join(dshHome, 'INSTALL.md'), dshHome, startsWith('# Intutic governance for dsh'))
  plan.quiet(join(dshHome, '.intutic', 'originals'), () => pruneLedger(dshHome))
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** The reverser for each harness id; harnesses connect writes nothing for are absent. */
export const HARNESS_REVERSERS: Readonly<Record<string, HarnessReverser>> = {
  'claude-code': claudeCode,
  'claude-desktop': claudeDesktop,
  cursor,
  windsurf,
  'github-copilot': githubCopilot,
  'muse-code': muse,
  grok,
  opencode,
  'roo-code': rooCode,
  cline,
  codex,
  aider,
  openhands,
  antigravity,
  continue: continueHarness,
  goose,
  hermes,
  pi,
  openclaw,
  n8n,
  'open-webui': openWebui,
  dsh,
  ...Object.fromEntries(ENV_INTUTIC_WRITERS.filter((h) => h !== 'codex').map((h) => [h, sdkAdapter])),
}
