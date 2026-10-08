/**
 * dshHooks.ts — DeepSeek "dsh" (developer preview, `@deepseek-ai/dsh`) Cordis
 * plugin registration + LLM egress routing.
 *
 * dsh has no `hooks.json`/shell-script gate surface at all — it is
 * plugin-first ("Cordis", DeepSeek's own extensibility framework), and the
 * blocking gate for this harness ships as a real TypeScript module,
 * `@intutic/gate/dsh` (`packages/gate-js/src/dsh.ts`), not a generated
 * string of shell/JS this writer assembles the way `grokHooks.ts`/
 * `museHooks.ts` do. This writer's job is narrower than theirs: merge-write
 * the ROW that tells dsh's own Cordis loader to load that module, into every
 * dsh profile this machine has, plus the LLM egress override.
 *
 * # What this phase confirmed against a REAL install — not the plan's guess
 *
 * `@deepseek-ai/dsh` and its Cordis framework packages (`@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-base`,
 * `@deepseek-ai/dsh-llm-pi-ai`, `@deepseek-ai/dsh-home-paths`, ...) are public
 * on the npm registry (first published 2026-08-13, ~161 KB unpacked for the
 * `dsh` package itself) — reachable and installable from this sandbox, unlike
 * Muse Code/Grok Build in Wave 1. This writer was authored against a real
 * `npm pack` + read of those packages' shipped `.d.ts`/README files, not
 * solely the phase brief's prior research (see the TD entry this phase filed
 * for exactly what was checked). In 0.1 three packages (dsh-permission,
 * dsh-settings-local, dsh-fs-policy) 404'd as restricted; 0.2.0-rc.2 no
 * longer depends on them — their roles moved to the public `dsh-settings`,
 * `dsh-config-editor`, `dsh-sandbox-policy`, `dsh-permission-presets` and
 * `dsh-user-approval`, all read directly for the 0.2 re-verification.
 *
 * Confirmed facts this writer relies on:
 *
 *   - `$DSH_HOME` resolution (`dsh-home-paths`): an explicit configured path,
 *     then `$DSH_HOME`, then `~/.dsh` — {@link resolveDshHome} below mirrors
 *     the env-var half (this writer has no "explicit configured path" input).
 *   - A **profile** is `$DSH_HOME/profiles/<name>/` holding a `package.json`
 *     (the profile manifest) and a `cordis.patch.yml` (`PROFILE_PATCH_FILENAME`
 *     — "the user patch layer inside a profile directory, hot-reloaded") —
 *     confirmed from `@deepseek-ai/dsh-app-boot`'s shipped `profile.d.ts`.
 *   - The patch-list format (`@deepseek-ai/cordis-plugin-include`'s
 *     `applyEntryPatches`, read from its shipped `lib/index.js`): a top-level
 *     YAML array of patch operations. `{ insert: [...] }` with no `id`
 *     appends the listed rows to the array; `{ id, insert: [...] }` inserts
 *     into an existing GROUP row's own `config` array; `{ id, name?,
 *     config?, ... }` (no `insert`) looks up the row by `id` and overwrites
 *     the named fields in place. This writer only ever emits the first shape
 *     (a fresh, self-contained `insert:` block naming this row by `id`), so
 *     its own writes are always recognizable on a later sync regardless of
 *     which shape a human or an older version of this writer left.
 *   - Plugin resolution (`@deepseek-ai/cordis-plugin-loader`'s shipped
 *     `lib/index.js`): a patch row's `name` is resolved via a plain dynamic
 *     `import(name)` when it is not a relative path — a bare specifier like
 *     `@intutic/gate/dsh` resolves exactly the way any other bundle package
 *     name in `dsh-base`'s own `cordis.patch.yml` does, subpath exports
 *     included. Node resolves it from the profile directory's own
 *     `node_modules` (the "two-anchor" resolution `profile.d.ts` documents
 *     for out-of-tree plugins) — which means `@intutic/gate` must actually be
 *     installed there; see {@link mergeProfileDependency} and the TD entry
 *     for why this writer cannot run `pnpm install` on the user's behalf.
 *   - **LLM egress, re-verified against dsh 0.2.0-rc.2 (TD-370, 2026-10-03).**
 *     0.2 removed the harness-home `settings.yaml` document this writer used
 *     to merge into: `@deepseek-ai/dsh-settings` now imports a leftover
 *     `$DSH_HOME/settings.yaml` ONCE into whichever profile boots first
 *     (renaming it to `settings.yaml.imported`), and live configuration
 *     lives in each profile's `cordis.patch.yml` as an id-targeted override
 *     row (`dsh-config-editor` persists Models-page edits the same way). The
 *     default route is still the entry id `llm-deepseek` — in 0.2 that id
 *     mounts `@deepseek-ai/dsh-llm-deepseek-api-key`, which registers the
 *     `deepseek-official` provider `dsh-base`'s `agent-default-model` row
 *     selects (`provider: deepseek-official, model: deepseek-flash`) — and
 *     `dsh-llm-deepseek`'s README confirms its endpoint resolves "explicit
 *     value, then `$DEEPSEEK_BASE_URL`, then the official root"
 *     (`https://api.deepseek.com/anthropic`, Messages wire format; requests
 *     go to `<baseURL>/v1/messages`). {@link mergeProfileLlmRoute} therefore
 *     sets `config.baseURL` on that entry's override row in every profile
 *     patch. Observed live (uat/evidence/live-verify/dsh-0.2.md): a headless
 *     0.2.0-rc.2 session sent every model request to the configured base URL.
 *     Two routes are deliberately NOT redirected: `llm-pi-ai` (0.2 refuses a
 *     hand-declared route without a non-empty `models` list, so the old
 *     `providers.intutic` route is now invalid config — dropped), and
 *     `llm-deepseek-account` (`deepseek-account` provider; its token is only
 *     released to `inferenceOrigin`, which accepts an alternate origin only
 *     with a grant from DeepSeek's platform — an opt-in, signed-in route this
 *     writer cannot point at a proxy). See the TD entry.
 *   - The `@intutic/gate/dsh` veto contract itself (`tools/pre-execute`,
 *     `PreToolDecision`'s real `'deny'`/`'allow'`/`'ask'` shape, Cordis's
 *     `waterfall` `next()` semantics) is confirmed from `dsh-tools`'s shipped
 *     `.d.ts` — see `packages/gate-js/src/dsh.ts`'s own module doc for the
 *     full record, including where the phase brief's prior guess
 *     (`agent/pre-step`, `{kind:'reject'}`) was wrong.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import * as fs from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { isSeq, parseDocument } from 'yaml'
import { createLogger } from '@intutic/logger'
import { keepOriginal, noteWritten } from '../disconnect/originals.js'
import { anthropicBaseUrl } from '@intutic/shared-types'

const log = createLogger('sync-dsh-hooks')

/** Mirrors `dsh-home-paths`' `DSH_HOME_ENV`/`DSH_HOME_DIR_NAME` constants. */
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_HOME_DIR_NAME = '.dsh'
/** Mirrors `dsh-app-boot`'s `PROFILES_DIR`/`PROFILE_PATCH_FILENAME`. */
const PROFILES_DIR = 'profiles'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Stable row id — recognized on every later sync regardless of which of the
 *  patch-op shapes (see module doc) a prior write or a human left. */
const PLUGIN_ROW_ID = 'intutic-governance'
/** Resolved via a bare `import()` from the profile's own `node_modules` — see
 *  {@link mergeProfileDependency}. */
const PLUGIN_MODULE_NAME = '@intutic/gate/dsh'
/** The `@intutic/gate` range declared in a profile's `package.json` when the
 *  profile declares none yet. Must name a version that exists on npm with a
 *  `./dsh` export — this was `^0.1.0` until 2026-10-03, which no published
 *  `@intutic/gate` satisfies (npm has 1.10.1 and 2.0.0), so a `pnpm install`
 *  in the profile could never resolve it. Bump with
 *  `packages/gate-js/package.json`'s major version. */
const INTUTIC_GATE_VERSION_RANGE = '^2.0.0'

/** `$DSH_HOME` resolution: an explicit env override, else `~/.dsh` — mirrors
 *  `dsh-home-paths`' `resolveDshHome()` (this writer has no "explicit
 *  configured path" input the way a booted dsh process might). An
 *  empty/whitespace-only `$DSH_HOME` is treated as unset, matching that
 *  package's own documented behaviour. */
export function resolveDshHome(): string {
  const configured = process.env[DSH_HOME_ENV]
  if (configured && configured.trim()) return configured.trim()
  return path.join(os.homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Every EXISTING dsh profile directory on this machine — one containing its
 * own `package.json` (the profile manifest `dsh-app-boot` requires; a bare
 * directory, such as the flat `profiles/node_modules` fallback dsh itself
 * maintains, is not a profile).
 *
 * Deliberately does not invent a profile: dsh's own CLI requires `--profile
 * <name>` on every invocation (confirmed from `dsh`'s shipped `bin.js` — there
 * is no bare "default" profile dsh falls back to), so this writer has no name
 * to seed one under that a user did not already choose. A machine with no
 * profile initialized yet gets governed on the next sync after the user's
 * first `dsh --profile <name>` run creates one — see the TD entry.
 */
export async function listDshProfileDirs(dshHome: string): Promise<string[]> {
  const profilesRoot = path.join(dshHome, PROFILES_DIR)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(profilesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (existsSync(path.join(profilesRoot, entry.name, 'package.json'))) {
      out.push(path.join(profilesRoot, entry.name))
    }
  }
  return out
}

// ─── Coverage-gap detection (TD-370: the silent no-profile window) ────────

/** Markers dsh leaves under `$DSH_HOME` even before any profile exists —
 *  mirrors `tools/cli/src/harness/dsh.ts`'s own `detect()` list, minus the
 *  `profiles` marker itself (which is what "zero profiles" already answers
 *  for {@link detectDshCoverageGap} below). */
const DSH_HOME_PRESENCE_MARKERS = ['settings.yaml', '.credentials.yaml']

/** Is `dsh` (the binary) reachable on `$PATH`? Best-effort, synchronous —
 *  same PATH-scan convention `dsh.ts`'s adapter `detect()` uses. */
function isDshOnPath(): boolean {
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of pathDirs) {
    if (dir && existsSync(path.join(dir, 'dsh'))) return true
  }
  return false
}

export interface DshCoverageGap {
  /** dsh appears to be installed/used on this machine (a `$DSH_HOME` marker
   *  exists, or `dsh` is on `$PATH`) — independent of whether it is governed. */
  dshDetected: boolean
  /** Number of EXISTING dsh profiles — see {@link listDshProfileDirs}. */
  profileCount: number
  /** `dshDetected && profileCount === 0`: dsh is present but nothing is
   *  governed yet — TD-370's "silent no-profile window". */
  gap: boolean
}

/**
 * Detects TD-370's "silent no-profile window": the stretch between `intutic
 * connect` and the user's first `dsh --profile <name>` run, during which dsh
 * is entirely ungoverned — {@link writeDshHooks} is a documented no-op with
 * nothing to register into yet — and, before this function existed, nothing
 * made that visible.
 *
 * A pure detector, deliberately: no logging, no side effect, so it stays
 * trivially unit-testable. `watcher/settingsGuard.ts`'s `warnIfDshCoverageGap`
 * is the side-effecting caller that actually logs the gap.
 */
export async function detectDshCoverageGap(dshHome = resolveDshHome()): Promise<DshCoverageGap> {
  const profileCount = (await listDshProfileDirs(dshHome)).length
  if (profileCount > 0) return { dshDetected: true, profileCount, gap: false }

  const dshDetected =
    DSH_HOME_PRESENCE_MARKERS.some((marker) => existsSync(path.join(dshHome, marker))) || isDshOnPath()

  return { dshDetected, profileCount: 0, gap: dshDetected }
}

// ─── cordis.patch.yml: plugin row registration ────────────────────────────

function buildDesiredRow(workspaceRoot: string, workspaceId: string): Record<string, unknown> {
  return {
    id: PLUGIN_ROW_ID,
    name: PLUGIN_MODULE_NAME,
    config: { workspaceId, repoRoot: workspaceRoot },
  }
}

/** Finds this writer's own row wherever it lives in a parsed patch-list
 *  (either an `insert:`-wrapped block it wrote itself, or a bare `{id, ...}`
 *  update-in-place row a human or an older writer left) — see module doc. */
function findOwnRow(patchList: unknown[]): { index: number; row: unknown } | null {
  for (let i = 0; i < patchList.length; i++) {
    const item = patchList[i]
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (Array.isArray(obj.insert)) {
      const inner = obj.insert.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).id === PLUGIN_ROW_ID)
      if (inner) return { index: i, row: inner }
      continue
    }
    if (obj.id === PLUGIN_ROW_ID) return { index: i, row: obj }
  }
  return null
}

/**
 * Append-only fallback for a `cordis.patch.yml` that does not parse as YAML
 * at all. Mirrors `injectGooseAppendOnly`'s exact reasoning: a parser that
 * cannot safely represent a malformed file cannot safely round-trip it
 * either, so this never touches (or even parses) anything else in the file.
 * Best-effort de-dup on the literal row id substring — a false "already
 * present" here just means the fallback path stays a fallback for one more
 * sync cycle rather than double-inserting; it does not corrupt anything.
 */
async function mergeProfilePatchAppendOnly(
  patchPath: string,
  existingYaml: string,
  desiredRow: Record<string, unknown>,
): Promise<void> {
  if (existingYaml.includes(`id: ${PLUGIN_ROW_ID}`)) return

  const config = desiredRow.config as Record<string, unknown>
  const block = [
    '',
    '# Intutic governance plugin — auto-appended (fallback: this file did not parse as YAML).',
    '- insert:',
    `    - id: ${PLUGIN_ROW_ID}`,
    `      name: ${JSON.stringify(desiredRow.name)}`,
    '      config:',
    `        workspaceId: ${JSON.stringify(config.workspaceId ?? '')}`,
    `        repoRoot: ${JSON.stringify(config.repoRoot ?? '')}`,
  ].join('\n')

  const text = (existingYaml || '[]').trimEnd() + '\n' + block + '\n'
  await fs.mkdir(path.dirname(patchPath), { recursive: true })
  const tmp = patchPath + '.intutic-tmp'
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, patchPath)
  log.info({ action: 'dsh_patch_written', path: patchPath, mode: 'append_only_fallback' }, 'dsh cordis.patch.yml updated (append-only fallback)')
}

/**
 * Structurally merges the Intutic governance plugin row into one profile's
 * `cordis.patch.yml`, via the `yaml` package's `parseDocument`/`setIn` — the
 * same "parse structurally, write-if-changed, preserve unrelated content,
 * fall back to append-only on unparseable input" discipline `injectGoose`
 * (`mcpAutoWrite.ts`) established for YAML in this codebase, reusing the same
 * dependency rather than inventing a second approach.
 */
export async function mergeProfilePatch(profileDir: string, workspaceRoot: string, workspaceId: string): Promise<void> {
  const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME)
  let existingYaml = ''
  try {
    existingYaml = await fs.readFile(patchPath, 'utf-8')
  } catch {
    // No cordis.patch.yml yet — `initProfile()` always seeds an empty `[]`
    // one, but a profile this writer discovered some other way might not
    // have it. Falls through with '' so a fresh file is written below.
  }

  const desiredRow = buildDesiredRow(workspaceRoot, workspaceId)

  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(existingYaml.trim() ? existingYaml : '[]')
    if (doc.errors.length > 0) throw doc.errors[0]
  } catch (err) {
    log.warn(
      { action: 'dsh_patch_unparseable', path: patchPath, err: (err as Error).message },
      'dsh cordis.patch.yml did not parse as YAML — falling back to append-only text injection',
    )
    await mergeProfilePatchAppendOnly(patchPath, existingYaml, desiredRow)
    return
  }

  if (doc.contents == null || !isSeq(doc.contents)) {
    // `cordis.patch.yml` exists but its root isn't a sequence (e.g. `null`,
    // a bare scalar, a mapping) — nothing safe to preserve there; the
    // documented shape (PROFILE_PATCH_TEMPLATE, confirmed from
    // dsh-app-boot's shipped source) is "a top-level YAML array", so this
    // replaces the root with a fresh empty one, same as injectGoose's
    // `mcp: null` handling.
    doc.contents = doc.createNode([])
  }

  const patchList = doc.toJS() as unknown[]
  const found = findOwnRow(patchList)
  const desiredNode = doc.createNode({ insert: [desiredRow] })

  let changed = false
  if (found === null) {
    doc.addIn([], desiredNode)
    changed = true
  } else if (!isDeepStrictEqual(found.row, desiredRow)) {
    // Replace the WHOLE item at that index with our own self-contained
    // `insert:` block, regardless of which shape the existing row was in —
    // this writer only ever emits the `insert:`-wrapped shape, so a later
    // sync always finds (and safely replaces) exactly this shape.
    doc.setIn([found.index], desiredNode)
    changed = true
  }

  if (!changed) return

  await fs.mkdir(profileDir, { recursive: true })
  const tmp = patchPath + '.intutic-tmp'
  await fs.writeFile(tmp, doc.toString(), 'utf-8')
  await fs.rename(tmp, patchPath)
  log.info({ action: 'dsh_patch_written', path: patchPath, mode: 'yaml' }, 'dsh cordis.patch.yml updated (structural YAML edit)')
}

// ─── profile package.json: @intutic/gate dependency ───────────────────────

/**
 * Ensures `@intutic/gate` is declared in the profile's own `package.json`
 * `dependencies` — the "out-of-tree plugin" mechanism `dsh-app-boot`'s
 * `profile.d.ts` documents (a profile's `node_modules` is pnpm-managed).
 *
 * This writer declares the dependency but does NOT run `pnpm install` in the
 * profile directory — the daemon has no general "run an arbitrary package
 * manager in a directory it does not own" capability, and every other
 * writer in this codebase only ever writes config, never invokes a package
 * manager on the user's behalf. Until the user (or their own tooling) runs
 * one, the `cordis.patch.yml` row this module also writes resolves to a
 * MISSING module. Observed live against dsh 0.2.0-rc.2: the loader prints
 * `dsh: warning: 1 entry did not activate` / `intutic-governance
 * (@intutic/gate/dsh): failed to import` on stderr and the session then runs
 * UNGOVERNED — loud, but fail-OPEN (dsh's hard-fail list is global to the
 * launcher; a profile row cannot mark itself required). See the TD entry and
 * `apps/docs/integrations/dsh.md`.
 *
 * Adds the declaration only when the profile has none: an existing one was
 * written by `dsh plugin --profile <name> add @intutic/gate` (pnpm records
 * the installed range, e.g. `^2.0.0`) or by the user, and rewriting it to this
 * writer's range on every sync would drift the manifest away from what is
 * actually installed — observed live against dsh 0.2.0-rc.2, where the old
 * `^0.1.0` overwrote pnpm's `^2.0.0`.
 */
export async function mergeProfileDependency(profileDir: string): Promise<void> {
  const manifestPath = path.join(profileDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>
  } catch {
    // No manifest — an existing profile always has one (dsh-app-boot
    // requires it), so this is defensive only; nothing to merge into yet.
    return
  }

  const deps = (manifest.dependencies && typeof manifest.dependencies === 'object'
    ? manifest.dependencies
    : {}) as Record<string, string>

  if (typeof deps['@intutic/gate'] === 'string' && deps['@intutic/gate'].trim()) return

  manifest.dependencies = { ...deps, '@intutic/gate': INTUTIC_GATE_VERSION_RANGE }

  const tmp = manifestPath + '.intutic-tmp'
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, manifestPath)
  log.info({ action: 'dsh_dependency_written', path: manifestPath }, 'dsh profile package.json dependency updated')
}

// ─── cordis.patch.yml: llm-deepseek egress override (dsh's default route) ──

/** The profile entry id of dsh's DEFAULT LLM route. In 0.2 it mounts
 *  `@deepseek-ai/dsh-llm-deepseek-api-key` (provider `deepseek-official`, the
 *  one `dsh-base`'s `agent-default-model` row selects). No module-name
 *  assertion is written alongside it: an id-targeted row without `name`
 *  survives DeepSeek renaming the module again (0.1 named it
 *  `dsh-llm-deepseek`), where a stale assertion would fail profile boot. */
const DEFAULT_LLM_ENTRY_ID = 'llm-deepseek'

/** Index of the LAST bare (not `insert:`-wrapped) row targeting
 *  {@link DEFAULT_LLM_ENTRY_ID} — the loader applies patch rows in order, so
 *  the last one is the override that takes effect, and it is also the one
 *  `dsh-config-editor` edits when the user saves the Models page. */
function findLastLlmOverride(patchList: unknown[]): number {
  for (let i = patchList.length - 1; i >= 0; i--) {
    const item = patchList[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    if (obj.id === DEFAULT_LLM_ENTRY_ID && !('insert' in obj)) return i
  }
  return -1
}

/**
 * Points dsh's DEFAULT LLM route at the Intutic proxy by setting
 * `config.baseURL` on the profile's `llm-deepseek` override row.
 *
 * A Cordis id-targeted patch REPLACES the entry's whole `config`
 * (`dsh-app-boot`'s README: "an id-targeted patch does not deep-merge"), so
 * when the profile already overrides this entry (a Models-page save, a hand
 * edit, or dsh 0.2's one-time import of a legacy `settings.yaml`), only
 * `baseURL` is set on THAT row and every other field it restates
 * (`apiKeyEnv`, `reasoningEffort`, `models`, ...) round-trips untouched.
 * Otherwise a fresh `{ id, config: { baseURL } }` row is appended — the
 * base bundle's row carries no config, so nothing is lost by replacing it.
 *
 * Same parse-structurally / write-if-changed / append-only-on-unparseable
 * discipline as {@link mergeProfilePatch}, on the same file.
 */
export async function mergeProfileLlmRoute(profileDir: string, proxyUrl: string): Promise<void> {
  const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME)
  let existingYaml = ''
  try {
    existingYaml = await fs.readFile(patchPath, 'utf-8')
  } catch {
    // No cordis.patch.yml yet — written fresh below.
  }

  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(existingYaml.trim() ? existingYaml : '[]')
    if (doc.errors.length > 0) throw doc.errors[0]
  } catch {
    // mergeProfilePatch already logged this file as unparseable this cycle.
    // Append only when no row for this id exists at all: a row we cannot
    // parse is a row we cannot safely edit, and a second, later row would
    // silently replace whatever config the user gave it.
    if (existingYaml.includes(`id: ${DEFAULT_LLM_ENTRY_ID}`)) return
    const block = [
      '',
      '# Intutic proxy route — auto-appended (fallback: this file did not parse as YAML).',
      `- id: ${DEFAULT_LLM_ENTRY_ID}`,
      '  config:',
      `    baseURL: ${JSON.stringify(proxyUrl)}`,
    ].join('\n')
    const tmp = patchPath + '.intutic-tmp'
    await fs.writeFile(tmp, (existingYaml || '[]').trimEnd() + '\n' + block + '\n', 'utf-8')
    await fs.rename(tmp, patchPath)
    log.info({ action: 'dsh_llm_route_written', path: patchPath, mode: 'append_only_fallback' }, 'dsh llm-deepseek route updated (append-only fallback)')
    return
  }

  if (doc.contents == null || !isSeq(doc.contents)) doc.contents = doc.createNode([])

  const patchList = doc.toJS() as unknown[]
  const index = findLastLlmOverride(patchList)
  if (index === -1) {
    doc.addIn([], doc.createNode({ id: DEFAULT_LLM_ENTRY_ID, config: { baseURL: proxyUrl } }))
  } else {
    const config = (patchList[index] as Record<string, unknown>).config
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      if ((config as Record<string, unknown>).baseURL === proxyUrl) return
      doc.setIn([index, 'config', 'baseURL'], proxyUrl)
    } else {
      // `config` absent, null, or a scalar — setIn cannot descend into it.
      doc.setIn([index, 'config'], doc.createNode({ baseURL: proxyUrl }))
    }
  }

  await fs.mkdir(profileDir, { recursive: true })
  const tmp = patchPath + '.intutic-tmp'
  await fs.writeFile(tmp, doc.toString(), 'utf-8')
  await fs.rename(tmp, patchPath)
  log.info({ action: 'dsh_llm_route_written', path: patchPath, mode: 'yaml' }, 'dsh llm-deepseek route updated (structural YAML edit)')
}

// ─── INSTALL.md: the manual pnpm-install / `dsh plugin add` step ──────────

/**
 * `$DSH_HOME/INSTALL.md` — same purpose and shape as `n8nHooks.ts`'s
 * `buildInstallMd`: this writer declares `@intutic/gate` in each profile's
 * `package.json` (see {@link mergeProfileDependency}) but cannot run a
 * package manager in a directory it does not own, so the row it also writes
 * into `cordis.patch.yml` resolves to a MISSING module until a human — or
 * dsh's own forwarding command — installs it. See the TD entry.
 */
function buildDshInstallMd(profileNames: string[]): string {
  const profileLines =
    profileNames.length > 0
      ? profileNames.map((name) => `- \`${name}\` — run: \`dsh plugin --profile ${name} add @intutic/gate\``).join('\n')
      : '(no dsh profiles are registered yet)'

  return `# Intutic governance for dsh — installation

Auto-generated by the Intutic sync-daemon. One artifact, one manual step.

## The blocking gate is registered, but not yet activated

Every sync writes the \`intutic-governance\` row into each profile's
\`cordis.patch.yml\` (naming \`@intutic/gate/dsh\`) and declares
\`@intutic/gate\` in that profile's \`package.json\` \`dependencies\` — but this
daemon has no general capability to run a package manager in a directory it
does not own, so the dependency itself is never installed by this writer.
Until it is, dsh's loader cannot import the row's module and prints a
labelled plugin-activation warning on every start (dsh 0.2 keeps booting
without it — the row is not a required entry), so nothing is governed yet.

Finish activation with dsh's own forwarding command, once per profile:

${profileLines}

dsh 0.2 installs it as a plain profile dependency (it warns that the package
declares no \`dsh.bundle\` — expected: the row above is what loads it).
\`cd $DSH_HOME/profiles/<name> && pnpm add @intutic/gate\` is equivalent.

## Default LLM egress needs no manual step

Every sync also sets \`config.baseURL\` on the \`llm-deepseek\` row of each
profile's \`cordis.patch.yml\` (dsh's default \`deepseek-official\` route) to
the Intutic proxy. A signed-in DeepSeek *account* route (\`deepseek-account\`)
is not redirected: dsh only releases its token to DeepSeek's own origin.
`
}

/** Write-if-changed, atomic rename — same discipline every other writer in
 *  this file follows. Regenerated every sync so the profile list here never
 *  goes stale. */
async function writeDshInstallMd(dshHome: string, profileNames: string[]): Promise<void> {
  const installPath = path.join(dshHome, 'INSTALL.md')
  const content = buildDshInstallMd(profileNames)

  let existing = ''
  try {
    existing = await fs.readFile(installPath, 'utf-8')
  } catch {
    // First write.
  }
  if (existing === content) return

  await keepOriginal(installPath, dshHome)
  await fs.mkdir(dshHome, { recursive: true })
  const tmp = installPath + '.intutic-tmp'
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, installPath)
  await noteWritten(installPath, dshHome, content)
  log.info({ action: 'dsh_install_md_written', path: installPath }, 'dsh INSTALL.md updated')
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register the Intutic governance plugin against every existing dsh profile
 * on this machine, and point each profile's `llm-deepseek` (default) LLM
 * route at the Intutic proxy.
 *
 * A no-op (logged, not an error) when `$DSH_HOME/profiles` does not exist
 * yet — dsh has not been run with any `--profile <name>` on this machine, so
 * there is nothing to register into; the next sync cycle picks it up once
 * the user's first `dsh` run creates one. Safe to call every cycle: every
 * merge below is write-if-changed.
 *
 * @param workspaceRoot - Absolute workspace root (stored in the plugin row's
 *   `config.repoRoot`).
 * @param proxyUrl       - Intutic proxy URL, set as the `llm-deepseek` row's `baseURL`.
 * @param workspaceId    - Workspace ID, stored in the plugin row's config.
 */
export async function writeDshHooks(workspaceRoot: string, proxyUrl: string, workspaceId = ''): Promise<void> {
  const dshHome = resolveDshHome()
  const profileDirs = await listDshProfileDirs(dshHome)

  if (profileDirs.length === 0) {
    log.debug({ action: 'dsh_skip', dshHome }, 'No dsh profiles found — skipping (nothing to register into yet)')
    return
  }

  for (const profileDir of profileDirs) {
    // The profile's own files, kept for disconnect before Intutic first edits
    // them. Recorded under $DSH_HOME, which need not be inside the home directory.
    await keepOriginal(path.join(profileDir, PROFILE_PATCH_FILENAME), dshHome)
    await keepOriginal(path.join(profileDir, 'package.json'), dshHome)
    await mergeProfilePatch(profileDir, workspaceRoot, workspaceId)
    // dsh's llm-deepseek route speaks the Anthropic Messages wire and
    // appends /v1/messages to its baseURL, so it gets the bare proxy host.
    await mergeProfileLlmRoute(profileDir, anthropicBaseUrl(proxyUrl))
    await mergeProfileDependency(profileDir)
    log.info({ action: 'dsh_profile_written', profile: path.basename(profileDir) }, 'dsh profile governance plugin registered')
  }

  await writeDshInstallMd(dshHome, profileDirs.map((d) => path.basename(d)))
}
