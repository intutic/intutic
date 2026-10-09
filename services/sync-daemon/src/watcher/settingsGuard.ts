/**
 * settingsGuard.ts — Multi-harness governance config tamper detection & restoration.
 *
 * Expanded from Claude Code-only to cover all 18 Intutic-supported harnesses.
 * Called by the drift watcher whenever any protected governance config file changes.
 *
 * Behaviour per path type:
 *   - Gate files (`GATE_ARTIFACTS`): restored by their writer when deleted or
 *     no longer the generated gate.
 *   - JSON hook files (Cursor, Windsurf, OpenHands, Muse, Grok): validate marker presence, restore.
 *   - Registrations that name the gate script (Codex, GitHub Copilot, Hermes,
 *     the Goose config, OpenClaw's openclaw.json): restored while the gate is installed.
 *   - Immutable files (Goose plugin): log governance_override_attempt incident instead of restoring.
 *   - VS Code settings: `chat.useHooks` or a `chat.hookFilesLocations` entry that switches
 *     off the GitHub Copilot gate is set back, and nothing else in the file is touched.
 *   - The policy snapshot: restored from the last copy the daemon verified when it differs.
 *   - Other settings files (claude_desktop_config.json, Grok's TOML): a deletion is logged as drift.
 *   - Gemini CLI's ~/.gemini/settings.json and Antigravity's
 *     ~/.gemini/config/hooks.json: restore when the gate registration is gone.
 *
 * LLD #14 — settingsGuard.ts
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { createLogger } from '@intutic/logger'
import type { SyncSopEntry } from '@intutic/shared-types'
import { updatePreToolUseHooks, parseSopConstraints } from '../harness/claudeCodeHooks.js'
import { writeClineHooks } from '../harness/clineHooks.js'
import { writeCursorHooks, systemHooksDirFor } from '../harness/cursorHooks.js'
import { writeOpenHandsHooks } from '../harness/openhandsHooks.js'
import { writeGooseHooks } from '../harness/gooseHooks.js'
import { writeWindsurfHooks, windsurfSettingsPath } from '../harness/windsurfHooks.js'
import { writeMuseHooks } from '../harness/museHooks.js'
import { writeOpenCodeHooks } from '../harness/openCodeHooks.js'
import { writeGrokHooks } from '../harness/grokHooks.js'
import { writePiHooks } from '../harness/piHooks.js'
import { writeOpenclawHooks, OPENCLAW_PLUGIN_FILE } from '../harness/openclawHooks.js'
import { writeDshHooks, resolveDshHome, detectDshCoverageGap } from '../harness/dshHooks.js'
import { writeAntigravityHooks } from '../harness/antigravityHooks.js'
import { writeAntigravityCliHooks, antigravityHooksPath, ANTIGRAVITY_HOOK_NAME, ANTIGRAVITY_CLI_GATE } from '../harness/antigravityCliHooks.js'
import { writeCodexHooks, codexUserDir } from '../harness/codexHooks.js'
import { writeGithubCopilotHooks } from '../harness/githubCopilotHooks.js'
import { writeHermesHooks } from '../harness/hermesHooks.js'
import { writeN8nHooks } from '../harness/n8nHooks.js'
import { writeOpenWebuiHooks } from '../harness/openWebuiHooks.js'
import { GATE_ARTIFACTS } from '../harness/gateArtifacts.js'
import { isImmutable } from '../harness/gooseHardener.js'
import { readOriginal } from '../disconnect/originals.js'
import { DEFAULT_SNAPSHOT_DIR, SNAPSHOT_JSON, SNAPSHOT_RULES, restoreVerifiedSnapshot } from '../lib/policySnapshot.js'
import { repairHookSettings } from './vscodeHookSettings.js'

const log = createLogger('sync-settings-guard')

/** Marker embedded in every Intutic-generated hook command. */
const HOOK_MARKER = '.intutic/hooks/'

/** Stamped into every gate gateBody.ts emits, whatever its language. */
const GATE_BODY_MARKER = 'Intutic gate body'

const home = os.homedir()

/** Goose's plugin directory, whose files are hardened rather than restored. */
const GOOSE_PLUGIN_DIR = path.join(home, '.agents', 'plugins', 'intutic-governance')
const GOOSE_GATE_SCRIPT = path.join(GOOSE_PLUGIN_DIR, 'scripts', 'intutic-check.sh')

/** Cursor's machine-wide hooks.json, written by `intutic enterprise install`. */
const cursorSystemHooks = (): string => path.join(systemHooksDirFor(process.platform), 'hooks.json')

/** Harnesses whose writer installs the gate in the home directory rather than the workspace. */
const PER_USER_GATES: ReadonlySet<string> = new Set(['goose', 'hermes', 'n8n', 'open-webui', 'openclaw', 'pi'])

/** Every gate file in {@link GATE_ARTIFACTS}, where its writer puts it. */
function gateArtifactPaths(workspaceRoot: string): Array<{ harness: string; file: string }> {
  return Object.entries(GATE_ARTIFACTS).flatMap(([harness, rels]) =>
    (rels ?? []).map((rel) => ({ harness, file: path.join(PER_USER_GATES.has(harness) ? home : workspaceRoot, rel) })))
}

// ─── All protected paths, grouped by harness ─────────────────────────

/** The live policy snapshot every gate reads, both artifacts. */
function policySnapshotFiles(snapshotDir: string = DEFAULT_SNAPSHOT_DIR): string[] {
  return [path.join(snapshotDir, SNAPSHOT_RULES), path.join(snapshotDir, SNAPSHOT_JSON)]
}

/** VS Code's user settings (both platforms' locations) and the workspace's. */
function vscodeSettingsFiles(workspaceRoot: string): string[] {
  return [
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(workspaceRoot, '.vscode', 'settings.json'),
  ]
}

/** Returns the full list of protected paths to watch. */
export function buildProtectedPaths(workspaceRoot: string): string[] {
  return [
    // ── Every harness's gate file ────────────────────────────────────
    ...gateArtifactPaths(workspaceRoot).map((g) => g.file),
    // ── The policy snapshot every gate reads ─────────────────────────
    ...policySnapshotFiles(),
    // ── Claude Code ──────────────────────────────────────────────────
    path.join(home, '.claude', 'settings.json'),
    path.join(workspaceRoot, '.claude', 'settings.json'),
    // ── Cursor (3 levels) ────────────────────────────────────────────
    cursorSystemHooks(),
    path.join(home, '.cursor', 'hooks.json'),
    path.join(workspaceRoot, '.cursor', 'hooks.json'),
    // ── Windsurf ─────────────────────────────────────────────────────
    path.join(home, '.codeium', 'windsurf', 'hooks.json'),
    windsurfSettingsPath(),
    // JetBrains plugin's separate user-level path (no `windsurf`
    // subdirectory) — see windsurfHooks.ts's module doc comment.
    path.join(home, '.codeium', 'hooks.json'),
    path.join(workspaceRoot, '.windsurf', 'hooks.json'),
    // ── OpenHands ────────────────────────────────────────────────────
    path.join(workspaceRoot, '.openhands', 'hooks.json'),
    // ── Goose (immutable — incident on tamper, not silent restore) ───
    // The script is a gate artifact, listed above. The config names it
    // too, as `hooks.pre_tool_use`.
    path.join(GOOSE_PLUGIN_DIR, 'plugin.json'),
    path.join(GOOSE_PLUGIN_DIR, 'hooks', 'hooks.json'),
    path.join(home, '.config', 'goose', 'config.yaml'),
    // ── Codex: the gate's registration at both levels ───────────────
    path.join(workspaceRoot, '.codex', 'hooks.json'),
    path.join(codexUserDir(), 'hooks.json'),
    // ── GitHub Copilot: the hook file at both levels ────────────────
    path.join(workspaceRoot, '.github', 'hooks', 'intutic-governance.json'),
    path.join(home, '.copilot', 'hooks', 'intutic-governance.json'),
    // ── Hermes: `hooks.pre_tool_call` registers the gate ────────────
    path.join(home, '.hermes', 'config.yaml'),
    // ── VS Code settings (Cline, Roo Code, the GitHub Copilot hooks) ──
    ...vscodeSettingsFiles(workspaceRoot),
    // ── Claude Desktop ────────────────────────────────────────────────
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    // ── Antigravity and Gemini CLI ────────────────────────────────────
    // The gates are registered at user level: Gemini CLI's in
    // ~/.gemini/settings.json, Antigravity's in ~/.gemini/config/hooks.json.
    // The rules are in the workspace's GEMINI.md, which the drift watcher
    // watches as the harness's rules file.
    path.join(home, '.gemini', 'settings.json'),
    path.join(home, '.gemini', 'config', 'hooks.json'),
    // ── Muse Code ────────────────────────────────────────────────────
    path.join(home, '.config', 'muse', 'settings.json'),
    path.join(home, '.config', 'muse', 'intutic-managed-hooks.json'),
    path.join(workspaceRoot, '.muse', 'hooks.json'),
    // ── OpenClaw: the config that lists the plugin ──────────────────
    path.join(home, '.openclaw', 'openclaw.json'),
    // ── Grok Build ───────────────────────────────────────────────────
    path.join(home, '.grok', 'hooks', 'intutic-governance.json'),
    path.join(workspaceRoot, '.grok', 'hooks', 'intutic-governance.json'),
    path.join(home, '.grok', 'config.toml'),
    path.join(workspaceRoot, '.grok', 'config.toml'),
    path.join(home, '.grok', 'trusted_folders.toml'),
    path.join(workspaceRoot, '.grok', 'trusted_folders.toml'),
    // ── DeepSeek "dsh" ───────────────────────────────────────────────
    // `profiles` is the whole directory (every profile's cordis.patch.yml,
    // not one file) — same directory-level watch `.agents/plugins/
    // intutic-governance` above uses for Goose's plugin dir. This function
    // is synchronous (no I/O), so it cannot enumerate which profile
    // directories actually exist the way `dshHooks.ts`'s own writer does;
    // watching the parent directory catches every profile's file without
    // needing to know their names in advance.
    path.join(resolveDshHome(), 'profiles'),
  ]
}

/**
 * The dsh profiles ROOT directory (`$DSH_HOME/profiles`) — watched at the
 * directory level (see {@link buildProtectedPaths} above) precisely so its
 * own CREATION is observable, not just an edit to a file already inside it.
 * chokidar watches a path that does not exist yet and still emits `addDir`
 * once dsh creates it; `driftWatcher.ts` needs to know to react to `addDir`
 * for this ONE path — every other protected path only reacts to
 * `change`/`unlink` (see that module's own comment) — so this predicate is
 * exported for it to check against. TD-370.
 */
export function isDshProfilesRoot(changedPath: string): boolean {
  return changedPath === path.join(resolveDshHome(), 'profiles')
}

/**
 * Whether a change to `changedPath` is one {@link guardSettingsFile} judges:
 * a path {@link buildProtectedPaths} lists, or a file under one it lists as a
 * directory (dsh's profiles). The watcher's callback routes on this, so a
 * path added to that list reaches the guard without a second edit there.
 */
export function isGuardedPath(changedPath: string, workspaceRoot: string): boolean {
  return buildProtectedPaths(workspaceRoot).some((p) => changedPath === p || changedPath.startsWith(p + path.sep))
}

/**
 * Resolves the workspace id for an incident or a restore.
 *
 * Reads `~/.intutic/env/runtime.env` — the file `runtimeEnv.ts` actually writes.
 * The previous inline version looked in `<workspaceRoot>/.intutic/runtime-env`,
 * which nothing has ever written, so the fallback could not succeed and every
 * tamper incident on a machine without `INTUTIC_WORKSPACE_ID` exported was filed
 * against an empty or 'unknown' workspace.
 */
async function resolveWorkspaceId(workspaceRoot: string): Promise<string> {
  const fromEnv = process.env.INTUTIC_WORKSPACE_ID || ''
  if (fromEnv) return fromEnv
  for (const envPath of [
    path.join(os.homedir(), '.intutic', 'env', 'runtime.env'),
    path.join(workspaceRoot, '.intutic', 'env', 'runtime.env'),
  ]) {
    try {
      const content = await fs.readFile(envPath, 'utf8')
      const match = content.match(/^INTUTIC_WORKSPACE_ID=(.*)$/m)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch {
      // Try the next location; absence is normal before the first sync.
    }
  }
  return 'unknown'
}

/**
 * Appends a `config_tamper` event to the workspace's hook-events log, the file
 * the daemon drains to `POST /api/v1/hook-events`: the control plane files it
 * as an incident (on the audit timeline) and exports it to SIEM as a
 * `TAMPER` gate decision. Never throws.
 */
async function reportTamper(
  workspaceRoot: string,
  event: { toolName: string; reason: string; filePath: string; harnessType?: string },
): Promise<void> {
  try {
    const line = JSON.stringify({
      event: 'config_tamper',
      ...event,
      workspaceId: await resolveWorkspaceId(workspaceRoot),
      timestamp: new Date().toISOString(),
      incidentId: crypto.createHash('sha1').update(event.filePath + Date.now()).digest('hex').slice(0, 16),
      // Made once and resent with this line: processed once however often the drain retries.
      eventId: crypto.randomBytes(16).toString('hex'),
    }) + '\n'
    const file = path.join(workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, line)
  } catch (err) {
    log.warn({ err, filePath: event.filePath }, 'Failed to write a tamper event to the hook-events log')
  }
}

/**
 * The policy snapshot's self-heal. When the live snapshot differs from the
 * last one the daemon verified, the verified copy goes back in force at once;
 * when there is no verified copy and the live one fails its digest, `resync`
 * fetches a fresh one. Either way the tamper is reported. A gate reading the
 * damaged snapshot in between refuses every MCP call
 * (`POLICY_SNAPSHOT_UNVERIFIED`) and drops its other dynamic rules. Returns
 * whether it found tampering.
 */
export async function guardPolicySnapshot(
  workspaceRoot: string,
  resync: () => Promise<unknown>,
  snapshotDir: string = DEFAULT_SNAPSHOT_DIR,
): Promise<boolean> {
  const outcome = await restoreVerifiedSnapshot(snapshotDir)
  if (outcome === 'intact') return false
  if (outcome === 'unverifiable') {
    try {
      await resync()
    } catch (err) {
      log.error({ action: 'policy_snapshot_resync_failed', err }, 'Could not fetch a fresh policy snapshot')
    }
  }
  await reportTamper(workspaceRoot, {
    toolName: 'policy_snapshot',
    filePath: path.join(snapshotDir, SNAPSHOT_RULES),
    reason:
      outcome === 'restored'
        ? 'The policy snapshot was changed outside the sync daemon; the last verified snapshot was restored.'
        : 'The policy snapshot failed its digest check and no verified copy was kept; a fresh one was fetched.',
  })
  return true
}

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Inspect any protected governance config file and restore if tampered.
 *
 * @param changedPath  - Absolute path of the file that changed.
 * @param workspaceRoot - Workspace root for restoration helpers.
 * @param sops          - Current SOP list.
 * @param proxyUrl      - Current proxy URL.
 * @param settings      - Optional passthrough settings.
 * @param skip          - Harnesses `intutic disconnect --harness` took out:
 *                        their files are no longer governed, so a change to
 *                        one is not tampering and is not restored.
 * @param resyncPolicy  - Fetches a fresh policy snapshot, for a damaged one
 *                        with no verified copy to restore.
 * @returns true if tampering was detected.
 */
export async function guardSettingsFile(
  changedPath: string,
  workspaceRoot: string,
  sops: SyncSopEntry[],
  proxyUrl = '',
  settings?: Record<string, unknown>,
  skip: ReadonlySet<string> = new Set(),
  resyncPolicy: () => Promise<unknown> = async () => {},
): Promise<boolean> {
  // ── The policy snapshot: the last verified copy, back in force ────
  if (policySnapshotFiles().includes(changedPath)) {
    return guardPolicySnapshot(workspaceRoot, resyncPolicy)
  }

  // ── VS Code settings: the keys that switch off the Copilot gate ───
  // Only while the gate is installed, and only those keys; anything else in
  // the file is the person's own. A deletion falls through to drift below.
  if (vscodeSettingsFiles(workspaceRoot).includes(changedPath) && !skip.has('github-copilot')) {
    const repaired = await guardVsCodeHookSettings(changedPath, workspaceRoot)
    if (repaired !== null) return repaired
  }

  // ── Goose plugin: immutable file tamper → incident, not restore ───
  // The plugin directory, not the bare name: the OpenCode, Pi and OpenClaw
  // gate files are called intutic-governance too, and a name match sent
  // their tampering here, to the Goose writer.
  if (changedPath.includes(path.join('.agents', 'plugins', 'intutic-governance'))) {
    if (skip.has('goose')) return false
    if (await isImmutable(changedPath)) {
      log.error(
        { action: 'governance_override_attempt', path: changedPath },
        'SECURITY: Immutable Goose governance file was modified — OS immutable flag bypassed. Emitting incident.',
      )
      
      // The workspace's log, which the daemon drains; one under the home
      // directory was never read unless the workspace was the home directory.
      await reportTamper(workspaceRoot, {
        toolName: 'goose_plugin',
        harnessType: 'goose',
        reason: 'SECURITY: Immutable Goose governance file was modified — OS immutable flag bypassed.',
        filePath: changedPath,
      })

      return true
    }
    // Not immutable (install in progress or first write) — restore normally.
    //
    // All three arguments, not just the URL. `writeGooseHooks` is
    // `(proxyUrl, workspaceRoot, workspaceId)` and the last two default to
    // `os.homedir()` and `''`, so calling it with the URL alone rebuilt the
    // plugin with its events log pointing at the home directory instead of the
    // workspace, stamped with an empty workspace id. Every goose
    // restore-after-tamper — the moment the audit trail matters most — wrote its
    // record where nothing drains it.
    await writeGooseHooks(proxyUrl, workspaceRoot, await resolveWorkspaceId(workspaceRoot))
    return true
  }

  // ── A gate file: restored by the writer that generates it ─────────
  const gate = gateArtifactPaths(workspaceRoot).find((g) => g.file === changedPath)
  if (gate) {
    if (skip.has(gate.harness)) return false
    // Cline's writer leaves a PreToolUse it did not write alone, as the
    // user's own hook; the ledger says whether it wrote this one.
    if (gate.harness === 'cline' && !(await readOriginal(changedPath, workspaceRoot))?.writtenSha256) return false
    return guardGateFile(changedPath, gate.harness, async () =>
      GATE_WRITERS[gate.harness]!({ workspaceRoot, proxyUrl, sops, settings, workspaceId: await resolveWorkspaceId(workspaceRoot), file: changedPath }))
  }

  // ── Claude Code settings.json ─────────────────────────────────────
  if (changedPath.includes('.claude') && changedPath.endsWith('settings.json')) {
    if (skip.has('claude-code')) return false
    return guardClaudeCodeSettings(changedPath, workspaceRoot, sops, settings)
  }

  // ── Gemini CLI and Antigravity: the user-level gate registrations ──
  // Restored whatever the hand-edit setting says, like every gate file:
  // they are the gates, not the user's config.
  if (changedPath === path.join(os.homedir(), '.gemini', 'settings.json')) {
    if (skip.has('antigravity')) return false
    return guardParsedFile(changedPath, 'antigravity', hasGeminiGate, async () => {
      await writeAntigravityHooks(workspaceRoot, proxyUrl, await resolveWorkspaceId(workspaceRoot))
    })
  }
  if (changedPath === antigravityHooksPath()) {
    if (skip.has('antigravity')) return false
    return guardParsedFile(changedPath, 'antigravity', hasAntigravityGate, async () => {
      await writeAntigravityCliHooks(workspaceRoot, proxyUrl, await resolveWorkspaceId(workspaceRoot))
    })
  }

  // ── Cursor hooks.json ─────────────────────────────────────────────
  // The machine-wide file is in no `.cursor` directory (`systemHooksDirFor`).
  const systemLevel = changedPath === cursorSystemHooks()
  if ((changedPath.includes('.cursor') || systemLevel) && changedPath.endsWith('hooks.json')) {
    if (skip.has('cursor')) return false
    return guardJsonHookFile(changedPath, 'cursor', async () => {
      await writeCursorHooks(workspaceRoot, proxyUrl, '', systemLevel)
    })
  }

  // ── Windsurf hooks.json ───────────────────────────────────────────
  if ((changedPath.includes('.codeium') || changedPath.includes('.windsurf')) && changedPath.endsWith('hooks.json')) {
    if (skip.has('windsurf')) return false
    return guardJsonHookFile(changedPath, 'windsurf', async () => {
      await writeWindsurfHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── OpenHands hooks.json ──────────────────────────────────────────
  if (changedPath.includes('.openhands') && changedPath.endsWith('hooks.json')) {
    if (skip.has('openhands')) return false
    return guardJsonHookFile(changedPath, 'openhands', async () => {
      await writeOpenHandsHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── Muse Code: project hooks.json, the managed-hooks file, and the
  //    settings.json carrying managed_hooks_path — all three restored by
  //    re-running the same writer, which merge-writes all three tiers.
  if (
    (changedPath.includes(path.join('.muse', 'hooks.json'))) ||
    (changedPath.includes(path.join('.config', 'muse')) &&
      (changedPath.endsWith('settings.json') || changedPath.endsWith('intutic-managed-hooks.json')))
  ) {
    if (skip.has('muse-code')) return false
    return guardJsonHookFile(changedPath, 'muse-code', async () => {
      await writeMuseHooks(workspaceRoot, proxyUrl, await resolveWorkspaceId(workspaceRoot))
    })
  }

  // ── Grok Build hook registration ──────────────────────────────────
  // config.toml / trusted_folders.toml are watched (UNIVERSAL_PROTECTED_PATHS
  // + buildProtectedPaths above) but not actively restored here — same tier
  // of coverage OpenHands' config.toml and Goose's config.yaml already get:
  // a tamper there falls through to the generic drift-log path below rather
  // than a targeted restore.
  if (changedPath.includes('.grok') && changedPath.endsWith('intutic-governance.json')) {
    if (skip.has('grok')) return false
    return guardJsonHookFile(changedPath, 'grok', async () => {
      await writeGrokHooks(workspaceRoot, proxyUrl)
    })
  }

  // ── dsh: the profiles ROOT directory was just created (first `dsh
  // --profile <name>` run on this machine) ──────────────────────────────
  // driftWatcher.ts forwards this here on chokidar's `addDir` event (see
  // isDshProfilesRoot) — register governance into whichever profile(s) now
  // exist immediately, closing TD-370's silent window at the moment it
  // closes itself, rather than waiting for an unrelated file change or the
  // next poll cycle to notice.
  if (isDshProfilesRoot(changedPath)) {
    if (skip.has('dsh')) return false
    await safeRestore('dsh', () => writeDshHooks(workspaceRoot, proxyUrl, ''))
    return true
  }

  // ── dsh: any profile's cordis.patch.yml ──────────────────────────
  // Re-running the writer re-merges into EVERY existing profile (not just
  // the one whose file changed) — cheap (write-if-changed per file) and
  // avoids threading "which profile" through this generic path-triggered
  // callback. YAML content, so `guardJsonHookFile`'s `JSON.parse` marker
  // check does not apply; a plain substring check for the plugin row id and
  // the proxy URL (the `llm-deepseek` egress row's `baseURL`, which lives in
  // this same file since dsh 0.2) is enough to decide "does this look
  // tampered". `$DSH_HOME/settings.yaml` is no longer watched: dsh 0.2
  // renames it to `settings.yaml.imported` on boot, and this writer no
  // longer writes it.
  if (
    changedPath.startsWith(path.join(resolveDshHome(), 'profiles') + path.sep) &&
    changedPath.endsWith('cordis.patch.yml')
  ) {
    if (skip.has('dsh')) return false
    return guardDshFile(changedPath, ['intutic-governance', proxyUrl], workspaceRoot, proxyUrl)
  }

  // ── Configs that name the gate ────────────────────────────────────
  // Each is the user's file as much as ours, and exists whether or not the
  // harness is connected: only while the gate is installed is a config that
  // no longer names it tampered with. Its marker is the gate's file name.
  const registration = gateRegistrations(workspaceRoot).find((r) => r.file === changedPath)
  if (registration) {
    if (skip.has(registration.harness) || !(await fileExists(registration.gate))) return false
    return guardMarkedFile(changedPath, registration.marker, registration.harness, async () =>
      GATE_WRITERS[registration.harness]!({ workspaceRoot, proxyUrl, sops, settings, workspaceId: await resolveWorkspaceId(workspaceRoot), file: changedPath }))
  }

  // ── All other paths: file deleted or corrupted → log drift incident
  const exists = await fileExists(changedPath)
  if (!exists) {
    log.warn({ action: 'governance_drift', path: changedPath }, `Governance config deleted: ${changedPath}`)
    // Emit drift event — restoration depends on harness type (handled above for active harnesses)
    return true
  }

  log.debug({ action: 'settings_intact', path: changedPath }, 'Protected file changed but no action required')
  return false
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Sets `chat.useHooks`, and any `chat.hookFilesLocations` entry that drops the
 * Copilot gate's location, back to `true` (vscodeHookSettings.ts). Null when
 * this is not the guard's to judge: the Copilot gate is not installed, or the
 * file is gone or not a settings object.
 */
async function guardVsCodeHookSettings(filePath: string, workspaceRoot: string): Promise<boolean | null> {
  const copilotGate = path.join(workspaceRoot, '.intutic', 'hooks', 'github-copilot-check.js')
  if (!(await fileExists(copilotGate))) return null
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  const repaired = repairHookSettings(raw, workspaceRoot)
  if (!repaired) return false
  try {
    await fs.writeFile(filePath, repaired.text, 'utf-8')
  } catch (err) {
    log.error({ action: 'vscode_hook_settings_restore_failed', path: filePath, err }, 'Could not restore the VS Code hook settings')
  }
  log.warn(
    { action: 'vscode_hook_settings_restored', path: filePath, keys: repaired.keys },
    'A VS Code setting switched off the GitHub Copilot gate — set back',
  )
  await reportTamper(workspaceRoot, {
    toolName: 'vscode_settings',
    harnessType: 'github-copilot',
    filePath,
    reason: `VS Code setting ${repaired.keys.join(', ')} switched off the GitHub Copilot governance hook; set back to true.`,
  })
  return true
}

interface RestoreContext {
  workspaceRoot: string
  proxyUrl: string
  sops: SyncSopEntry[]
  settings?: Record<string, unknown>
  workspaceId: string
  /** The file whose change asked for the restore. */
  file: string
}

/** The writer that regenerates each harness's gate and its registrations. */
const GATE_WRITERS: Readonly<Record<string, (c: RestoreContext) => Promise<unknown>>> = {
  'claude-code': (c) => updatePreToolUseHooks(c.workspaceRoot, c.sops, c.settings),
  'cursor': (c) => writeCursorHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'windsurf': (c) => writeWindsurfHooks(c.workspaceRoot, c.proxyUrl, undefined, c.workspaceId),
  'codex': (c) => writeCodexHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'antigravity': async (c) => {
    await writeAntigravityHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId)
    await writeAntigravityCliHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId)
  },
  'openhands': (c) => writeOpenHandsHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'hermes': (c) => writeHermesHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'pi': (c) => writePiHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'openclaw': (c) => writeOpenclawHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'muse-code': (c) => writeMuseHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'github-copilot': (c) => writeGithubCopilotHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'grok': (c) => writeGrokHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'cline': async (c) => {
    // Only a PreToolUse Intutic wrote is restored (see the gate branch), so
    // whatever is there now replaced the gate. The writer would keep it as
    // the user's own hook.
    await fs.rm(c.file, { force: true })
    await writeClineHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId)
  },
  'goose': (c) => writeGooseHooks(c.proxyUrl, c.workspaceRoot, c.workspaceId),
  'opencode': (c) => writeOpenCodeHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'n8n': (c) => writeN8nHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
  'open-webui': (c) => writeOpenWebuiHooks(c.workspaceRoot, c.proxyUrl, c.workspaceId),
}

/** A config that registers a gate: `marker` must survive in it while `gate` is installed. */
interface GateRegistration {
  harness: string
  file: string
  gate: string
  marker: string
}

function gateRegistrations(workspaceRoot: string): GateRegistration[] {
  const codexGate = path.join(workspaceRoot, '.intutic', 'hooks', 'codex-check.js')
  const copilotGate = path.join(workspaceRoot, '.intutic', 'hooks', 'github-copilot-check.js')
  const openclawPlugin = path.join(home, OPENCLAW_PLUGIN_FILE)
  return [
    { harness: 'codex', file: path.join(workspaceRoot, '.codex', 'hooks.json'), gate: codexGate, marker: 'codex-check.js' },
    { harness: 'codex', file: path.join(codexUserDir(), 'hooks.json'), gate: codexGate, marker: 'codex-check.js' },
    {
      harness: 'github-copilot',
      file: path.join(workspaceRoot, '.github', 'hooks', 'intutic-governance.json'),
      gate: copilotGate,
      marker: 'github-copilot-check.js',
    },
    {
      harness: 'github-copilot',
      file: path.join(home, '.copilot', 'hooks', 'intutic-governance.json'),
      gate: copilotGate,
      marker: 'github-copilot-check.js',
    },
    {
      harness: 'hermes',
      file: path.join(home, '.hermes', 'config.yaml'),
      gate: path.join(home, '.intutic', 'hooks', 'hermes-check.sh'),
      marker: 'hermes-check.sh',
    },
    { harness: 'goose', file: path.join(home, '.config', 'goose', 'config.yaml'), gate: GOOSE_GATE_SCRIPT, marker: GOOSE_GATE_SCRIPT },
    // OpenClaw rewrites its own config; its marker is the listed plugin path.
    { harness: 'openclaw', file: path.join(home, '.openclaw', 'openclaw.json'), gate: openclawPlugin, marker: openclawPlugin },
  ]
}

/**
 * A gate file: deleted, or no longer the generated gate, and its writer runs
 * again. Cline runs its hook only while the file is executable, so for Cline
 * a cleared execute bit is tampering too.
 */
async function guardGateFile(filePath: string, harness: string, restore: () => Promise<unknown>): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    log.warn({ action: 'gate_file_deleted', harness, path: filePath }, `${harness} gate deleted — restoring`)
    await safeRestore(harness, restore)
    return true
  }
  const disabled = harness === 'cline' && ((await fs.stat(filePath)).mode & 0o111) === 0
  if (raw.includes(GATE_BODY_MARKER) && !disabled) return false
  log.warn({ action: 'gate_file_tampered', harness, path: filePath }, `${harness} gate tampered — restoring`)
  await safeRestore(harness, restore)
  return true
}

async function guardClaudeCodeSettings(
  settingsFilePath: string,
  workspaceRoot: string,
  sops: SyncSopEntry[],
  settings?: Record<string, unknown>,
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(settingsFilePath, 'utf-8')
  } catch {
    log.warn({ action: 'settings_deleted', path: settingsFilePath }, 'Claude Code settings.json deleted — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    log.warn({ action: 'settings_corrupted', path: settingsFilePath }, 'Claude Code settings.json corrupted — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  const hooks = (parsed.hooks as Record<string, unknown> | undefined) ?? {}
  const preToolUse = (hooks.PreToolUse as unknown[] | undefined) ?? []
  const hasIntuticHook = preToolUse.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const h = (entry as Record<string, unknown[]>).hooks ?? []
    return h.some((hh) => typeof (hh as Record<string, unknown>).command === 'string'
      && String((hh as Record<string, unknown>).command).includes(HOOK_MARKER))
  })

  if (!hasIntuticHook) {
    log.warn({ action: 'hook_missing', path: settingsFilePath }, 'Claude Code PreToolUse hook missing — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  const deny = ((parsed.permissions as Record<string, unknown>)?.deny as unknown[]) ?? []
  const constraints = parseSopConstraints(sops, settings)
  const expectedDenyCount = constraints.highRiskTools.length + constraints.patterns.length
  if (deny.length < expectedDenyCount) {
    log.warn({ action: 'deny_rules_cleared', path: settingsFilePath }, 'Deny rules cleared — restoring')
    await updatePreToolUseHooks(workspaceRoot, sops, settings)
    return true
  }

  log.debug({ action: 'settings_intact', path: settingsFilePath }, 'Claude Code settings integrity OK')
  return false
}

async function guardJsonHookFile(
  filePath: string,
  harness: string,
  restore: () => Promise<void>,
): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    log.warn({ action: 'hook_file_deleted', harness, path: filePath }, `${harness} hooks.json deleted — restoring`)
    await safeRestore(harness, restore)
    return true
  }

  try {
    const parsed = JSON.parse(raw)
    // Check that the Intutic marker is present in the hooks config
    const hasMarker = JSON.stringify(parsed).includes('intutic')
    if (!hasMarker) {
      log.warn({ action: 'hook_marker_missing', harness, path: filePath }, `${harness} hooks.json tampered — restoring`)
      await safeRestore(harness, restore)
      return true
    }
  } catch {
    log.warn({ action: 'hook_file_corrupted', harness, path: filePath }, `${harness} hooks.json corrupted — restoring`)
    await safeRestore(harness, restore)
    return true
  }

  return false
}

/**
 * dsh's profile YAML files, restored by re-running `writeDshHooks` (which
 * merge-writes into every existing profile — see dshHooks.ts). Every one of
 * `markers` is a literal substring that must survive in the file for it to
 * be considered intact.
 */
/**
 * Generic form of {@link guardDshFile}: a file whose only integrity check is
 * "still carries the marker our writer stamps". Deleted or tampered → the
 * writer re-runs.
 */
async function guardMarkedFile(filePath: string, marker: string, harness: string, restore: () => Promise<unknown>): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    log.warn({ action: `${harness}_file_deleted`, path: filePath }, `${harness} governance file deleted — restoring`)
    await safeRestore(harness, restore)
    return true
  }
  if (!raw.includes(marker)) {
    log.warn({ action: `${harness}_marker_missing`, path: filePath }, `${harness} governance file tampered — restoring`)
    await safeRestore(harness, restore)
    return true
  }
  return false
}

async function guardDshFile(filePath: string, markers: string[], workspaceRoot: string, proxyUrl: string): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    log.warn({ action: 'dsh_file_deleted', path: filePath }, 'dsh governance file deleted — restoring')
    await safeRestore('dsh', () => writeDshHooks(workspaceRoot, proxyUrl, ''))
    return true
  }

  if (!markers.every((marker) => raw.includes(marker))) {
    log.warn({ action: 'dsh_marker_missing', path: filePath }, 'dsh governance file tampered — restoring')
    await safeRestore('dsh', () => writeDshHooks(workspaceRoot, proxyUrl, ''))
    return true
  }

  return false
}

/**
 * Side-effecting wrapper around `dshHooks.ts`'s pure `detectDshCoverageGap` —
 * logs TD-370's "silent no-profile window" as a `dsh_coverage_gap` warning
 * when dsh is present on this machine but has zero profiles, so the window
 * is at least documented in the logs even though there is nothing to
 * restore into yet. Called once at `intutic connect` startup — see
 * connect.ts — not on every poll tick: the underlying fs checks are cheap,
 * but the gap itself only changes state on the user's first `dsh --profile
 * <name>` run, which {@link isDshProfilesRoot}'s `addDir` handling above
 * already reacts to immediately.
 */
export async function warnIfDshCoverageGap(): Promise<boolean> {
  const result = await detectDshCoverageGap()
  if (result.gap) {
    log.warn(
      { action: 'dsh_coverage_gap', dshDetected: result.dshDetected, profileCount: result.profileCount },
      'dsh is present on this machine but has zero profiles yet — nothing is governed until the ' +
        'first `dsh --profile <name>` run creates one (TD-370). The next sync after that run picks ' +
        'it up automatically; this warning is visibility for the window before it, not a fix for it.',
    )
  }
  return result.gap
}

/**
 * A file whose integrity is a fact about its parsed content: deleted,
 * unparseable, or parsed without the gate → restored. A marker-substring
 * check is not enough here: these are the user's own settings files, and
 * the MCP writer adds an `intutic` server to the same settings.json. The
 * writers leave a file that is not a plain JSON object alone, so for one of
 * those the restore is a logged no-op and the drift report surfaces it.
 */
async function guardParsedFile(
  filePath: string,
  harness: string,
  intact: (doc: unknown) => boolean,
  restore: () => Promise<void>,
): Promise<boolean> {
  let doc: unknown
  try {
    doc = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch {
    log.warn({ action: `${harness}_file_unreadable`, path: filePath }, `${harness} governance file deleted or not JSON — restoring`)
    await safeRestore(harness, restore)
    return true
  }
  if (intact(doc)) return false
  log.warn({ action: `${harness}_hook_missing`, path: filePath }, `${harness} governance hook missing — restoring`)
  await safeRestore(harness, restore)
  return true
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Whether a `{matcher, hooks: [{command}]}` list has an entry running `script`. */
function runsScript(entries: unknown, script: string): boolean {
  return Array.isArray(entries) && entries.some((e) =>
    isObj(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isObj(h) && typeof h.command === 'string' && h.command.includes(script)))
}

/** Gemini CLI's settings.json still registers the `BeforeTool` gate. */
function hasGeminiGate(doc: unknown): boolean {
  return isObj(doc) && isObj(doc.hooks) && runsScript(doc.hooks.BeforeTool, 'antigravity-check.sh')
}

/** Antigravity's hooks.json still carries Intutic's entry, enabled, running the gate. */
function hasAntigravityGate(doc: unknown): boolean {
  if (!isObj(doc)) return false
  const entry = doc[ANTIGRAVITY_HOOK_NAME]
  return isObj(entry) && entry.enabled !== false && runsScript(entry.PreToolUse, ANTIGRAVITY_CLI_GATE)
}

async function safeRestore(harness: string, restore: () => Promise<unknown>): Promise<void> {
  try {
    await restore()
    log.info({ action: 'hook_restored', harness }, `${harness} governance hooks restored`)
  } catch (err) {
    log.error({ action: 'hook_restore_failed', harness, err }, `Failed to restore ${harness} governance hooks`)
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}
