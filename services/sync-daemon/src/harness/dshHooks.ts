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
 * for exactly what was checked and what is still genuinely unconfirmed —
 * dsh-permission, dsh-settings-local, and dsh-fs-policy 404'd as
 * `publishConfig.access: restricted`, so the exact settings.yaml schema
 * dsh-settings-local enforces was not directly inspected, only inferred from
 * `dsh-base`'s own `cordis.patch.yml` comments and `dsh-llm-pi-ai`'s README).
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
 *   - `settings.yaml`'s `llm-pi-ai.providers.<id>.baseURL` path — CONFIRMED,
 *     not merely the plan's assumption: `dsh-llm-pi-ai`'s shipped README shows
 *     exactly this shape overriding an EXISTING catalog route's endpoint
 *     (`providers.openai.baseURL: https://proxy.example.com:8443`), the same
 *     "override base_url on what already resolves, don't invent a model
 *     picker entry" shape `grokHooks.ts`'s `[model.*]` merge uses. See the TD
 *     entry for the one gap this surfaced that the plan brief did not
 *     anticipate: `llm-pi-ai` is NOT dsh's default LLM route (`llm-deepseek`,
 *     the native DeepSeek adapter, is — see `dsh-base`'s own
 *     `agent-default-model` row) and mounts **dormant** until a
 *     `llm-pi-ai:` settings section exists at all, so this override alone
 *     does not redirect a fresh profile's default egress.
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
import { isMap, isSeq, parseDocument } from 'yaml'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-dsh-hooks')

/** Mirrors `dsh-home-paths`' `DSH_HOME_ENV`/`DSH_HOME_DIR_NAME` constants. */
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_HOME_DIR_NAME = '.dsh'
/** Mirrors `dsh-app-boot`'s `PROFILES_DIR`/`PROFILE_PATCH_FILENAME`. */
const PROFILES_DIR = 'profiles'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const SETTINGS_FILENAME = 'settings.yaml'

/** Stable row id — recognized on every later sync regardless of which of the
 *  patch-op shapes (see module doc) a prior write or a human left. */
const PLUGIN_ROW_ID = 'intutic-governance'
/** Resolved via a bare `import()` from the profile's own `node_modules` — see
 *  {@link mergeProfileDependency}. */
const PLUGIN_MODULE_NAME = '@intutic/gate/dsh'
/** The pinned `@intutic/gate` version range written into a profile's
 *  `package.json` dependency — dsh's own preview-software stance (stated
 *  breaking-changes policy) is matched here the same way Muse Code/Grok Build
 *  pin themselves against a *tested* version rather than `latest`. Bump this
 *  alongside `packages/gate-js/package.json`'s own `version` field. */
const INTUTIC_GATE_VERSION_RANGE = '^0.1.0'

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
 * MISSING module and dsh's own loader reports that row's activation failed
 * (`assertEntriesActivated`, confirmed from `dsh-app-boot`'s exports) rather
 * than silently no-op — a fail-LOUD gap, not a fail-open one, but a real
 * manual step nonetheless. See the TD entry and `apps/docs/integrations/dsh.md`.
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

  if (deps['@intutic/gate'] === INTUTIC_GATE_VERSION_RANGE) return

  manifest.dependencies = { ...deps, '@intutic/gate': INTUTIC_GATE_VERSION_RANGE }

  const tmp = manifestPath + '.intutic-tmp'
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, manifestPath)
  log.info({ action: 'dsh_dependency_written', path: manifestPath }, 'dsh profile package.json dependency updated')
}

// ─── settings.yaml: llm-pi-ai provider baseURL ────────────────────────────

async function mergeSettingsYamlAppendOnly(settingsPath: string, existingYaml: string, proxyUrl: string): Promise<void> {
  if (existingYaml.includes('llm-pi-ai:')) return
  const block = [
    '',
    '# Intutic proxy route — auto-appended (fallback: this file did not parse as YAML).',
    'llm-pi-ai:',
    '  providers:',
    '    intutic:',
    '      displayName: Intutic Governance Proxy',
    '      api: openai-completions',
    `      baseURL: ${JSON.stringify(proxyUrl)}`,
  ].join('\n')
  const text = existingYaml.trimEnd() + '\n' + block + '\n'
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  const tmp = settingsPath + '.intutic-tmp'
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, settingsPath)
  log.info({ action: 'dsh_settings_written', path: settingsPath, mode: 'append_only_fallback' }, 'dsh settings.yaml updated (append-only fallback)')
}

/**
 * Structurally merges an `intutic` route into `settings.yaml`'s
 * `llm-pi-ai.providers` map (CONFIRMED path — see module doc), overriding
 * only that one route's `baseURL`/`api`/`displayName`, preserving every other
 * provider and every other top-level section untouched.
 *
 * KNOWN GAP, stated here and in the TD entry: `llm-pi-ai` mounts dormant
 * until a `llm-pi-ai:` section exists at all, and dsh's actual DEFAULT LLM
 * route is `llm-deepseek` (the native adapter — see `dsh-base`'s
 * `agent-default-model` row), not `llm-pi-ai`. This merge alone does not
 * redirect a fresh profile's default egress; it adds a selectable
 * `llm-pi-ai` route a user (or a future sync) can point a model at. Routing
 * `llm-deepseek`'s own settings section was not independently confirmed
 * (see the TD entry) and is not attempted here.
 */
export async function mergeSettingsYaml(dshHome: string, proxyUrl: string): Promise<void> {
  const settingsPath = path.join(dshHome, SETTINGS_FILENAME)
  let existingYaml = ''
  try {
    existingYaml = await fs.readFile(settingsPath, 'utf-8')
  } catch {
    // No settings.yaml yet — falls through with '' so a fresh file is
    // written below.
  }

  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(existingYaml.trim() ? existingYaml : '{}')
    if (doc.errors.length > 0) throw doc.errors[0]
  } catch (err) {
    log.warn(
      { action: 'dsh_settings_unparseable', path: settingsPath, err: (err as Error).message },
      'dsh settings.yaml did not parse as YAML — falling back to append-only text injection',
    )
    await mergeSettingsYamlAppendOnly(settingsPath, existingYaml, proxyUrl)
    return
  }

  if (doc.contents == null || !isMap(doc.contents)) {
    doc.contents = doc.createNode({})
  }

  // Defensive per-level checks: `setIn` auto-vivifies a MISSING intermediate
  // key as a map, but throws on an EXISTING non-collection value at that key
  // (confirmed empirically against the `yaml` package) — same failure mode
  // `injectGoose` guards for `mcp: null`. Reset only the offending level,
  // never the whole document.
  for (const key of ['llm-pi-ai', 'providers'] as const) {
    const pathSoFar = key === 'llm-pi-ai' ? ['llm-pi-ai'] : ['llm-pi-ai', 'providers']
    const node = doc.getIn(pathSoFar)
    if (node !== undefined && !isMap(node)) {
      doc.setIn(pathSoFar, {})
    }
  }

  const settingsJs = doc.toJS() as Record<string, unknown>
  const llmPiAi = (settingsJs['llm-pi-ai'] as Record<string, unknown> | undefined) ?? {}
  const providers = (llmPiAi.providers as Record<string, unknown> | undefined) ?? {}
  const existingRoute = (providers.intutic as Record<string, unknown> | undefined) ?? {}
  const desiredRoute = {
    ...existingRoute,
    displayName: 'Intutic Governance Proxy',
    api: 'openai-completions',
    baseURL: proxyUrl,
  }

  if (isDeepStrictEqual(existingRoute, desiredRoute)) return

  doc.setIn(['llm-pi-ai', 'providers', 'intutic'], desiredRoute)

  await fs.mkdir(dshHome, { recursive: true })
  const tmp = settingsPath + '.intutic-tmp'
  await fs.writeFile(tmp, doc.toString(), 'utf-8')
  await fs.rename(tmp, settingsPath)
  log.info({ action: 'dsh_settings_written', path: settingsPath, mode: 'yaml' }, 'dsh settings.yaml updated (structural YAML edit)')
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register the Intutic governance plugin against every existing dsh profile
 * on this machine, and merge the Intutic proxy into `settings.yaml`'s
 * `llm-pi-ai` route.
 *
 * A no-op (logged, not an error) when `$DSH_HOME/profiles` does not exist
 * yet — dsh has not been run with any `--profile <name>` on this machine, so
 * there is nothing to register into; the next sync cycle picks it up once
 * the user's first `dsh` run creates one. Safe to call every cycle: every
 * merge below is write-if-changed.
 *
 * @param workspaceRoot - Absolute workspace root (stored in the plugin row's
 *   `config.repoRoot`).
 * @param proxyUrl       - Intutic proxy URL, merged into settings.yaml.
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
    await mergeProfilePatch(profileDir, workspaceRoot, workspaceId)
    await mergeProfileDependency(profileDir)
    log.info({ action: 'dsh_profile_written', profile: path.basename(profileDir) }, 'dsh profile governance plugin registered')
  }

  await mergeSettingsYaml(dshHome, proxyUrl)
}
