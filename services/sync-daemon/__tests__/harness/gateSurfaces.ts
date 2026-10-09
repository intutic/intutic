/**
 * Every file that installs, loads or configures each hook-gated harness's
 * gate: the surface an agent would edit to switch its own gate off.
 *
 * Test-only, like `gateRegistry.ts`. `harnessProtectedPaths.test.ts` holds
 * every path here to `UNIVERSAL_PROTECTED_PATHS`, and `settingsGuardGates.test.ts`
 * holds `gate` and `loaders` to the settings guard's watch list. Its keys are
 * held to `GATE_ARTIFACTS` (plus dsh, whose gate files are named per profile),
 * so a new hook harness cannot ship until its row says what loads its gate.
 *
 * A path starting `~/` is under the home directory; any other relative path
 * is under the workspace; an absolute one is fixed.
 *
 * @module
 */

import { join } from 'node:path'

export interface GateSurface {
  /** The gate files: `GATE_ARTIFACTS` for the harness. */
  gate: readonly string[]
  /** Registrations and configs that load the gate, which the settings guard watches. */
  loaders: readonly string[]
  /**
   * Files that can turn the gate off but which the guard cannot put back,
   * because Intutic does not write what matters in them: refused to the
   * agent, not watched.
   */
  refusedOnly?: readonly string[]
}

export const GATE_SURFACES: Readonly<Record<string, GateSurface>> = {
  'claude-code': {
    gate: ['.intutic/hooks/claude-code-check.js'],
    loaders: ['.claude/settings.json', '~/.claude/settings.json'],
    // Loads above settings.json; `disableAllHooks` there turns the gate off.
    refusedOnly: ['.claude/settings.local.json', '~/.claude/settings.local.json'],
  },
  'cursor': {
    gate: ['.intutic/hooks/cursor-check.js'],
    loaders: ['.cursor/hooks.json', '~/.cursor/hooks.json'],
    // Machine-wide, root-owned. The guard watches this platform's copy.
    refusedOnly: ['/etc/cursor/hooks.json', '/Library/Application Support/Cursor/hooks.json'],
  },
  'windsurf': {
    gate: ['.intutic/hooks/windsurf-check.js'],
    loaders: ['~/.codeium/windsurf/hooks.json', '~/.codeium/hooks.json', '.windsurf/hooks.json'],
  },
  'codex': {
    gate: ['.intutic/hooks/codex-check.js'],
    loaders: ['.codex/hooks.json', '~/.codex/hooks.json'],
    // `[features] hooks = false` turns every hook off.
    refusedOnly: ['.codex/config.toml', '~/.codex/config.toml'],
  },
  'antigravity': {
    gate: ['.intutic/hooks/antigravity-check.sh', '.intutic/hooks/antigravity-cli-check.js'],
    loaders: ['~/.gemini/settings.json', '~/.gemini/config/hooks.json'],
    // Antigravity runs the project's hooks too, before the gate.
    refusedOnly: ['.agents/hooks.json'],
  },
  'openhands': {
    gate: ['.intutic/hooks/openhands-check.sh'],
    loaders: ['.openhands/hooks.json'],
  },
  'hermes': {
    gate: ['~/.intutic/hooks/hermes-check.sh'],
    loaders: ['~/.hermes/config.yaml'],
  },
  'pi': {
    // Pi loads every file in the directory; nothing registers the gate.
    gate: ['~/.pi/agent/extensions/intutic-governance.js'],
    loaders: [],
    // In-process beside the gate: a trusted project's extensions.
    refusedOnly: ['~/.pi/agent/extensions/another-extension.ts', '.pi/extensions/another-extension.ts'],
  },
  'openclaw': {
    gate: ['~/.intutic/hooks/openclaw/intutic-governance.cjs'],
    loaders: ['~/.openclaw/openclaw.json'],
  },
  'muse-code': {
    gate: ['.intutic/hooks/muse-check.js'],
    loaders: ['.muse/hooks.json', '~/.config/muse/settings.json', '~/.config/muse/intutic-managed-hooks.json'],
  },
  'github-copilot': {
    gate: ['.intutic/hooks/github-copilot-check.js'],
    loaders: ['.github/hooks/intutic-governance.json', '~/.copilot/hooks/intutic-governance.json'],
  },
  'grok': {
    gate: ['.intutic/hooks/grok-check.js'],
    loaders: [
      '.grok/hooks/intutic-governance.json',
      '~/.grok/hooks/intutic-governance.json',
      '.grok/config.toml',
      '~/.grok/config.toml',
      '.grok/trusted_folders.toml',
      '~/.grok/trusted_folders.toml',
    ],
  },
  'cline': {
    // Cline runs the executable file; nothing registers it.
    gate: ['.clinerules/hooks/PreToolUse'],
    loaders: [],
  },
  'goose': {
    gate: ['~/.agents/plugins/intutic-governance/scripts/intutic-check.sh'],
    loaders: [
      '~/.agents/plugins/intutic-governance/plugin.json',
      '~/.agents/plugins/intutic-governance/hooks/hooks.json',
      '~/.config/goose/config.yaml',
    ],
  },
  'opencode': {
    // OpenCode globs the plugin directories; nothing registers the gate.
    gate: ['.opencode/plugins/intutic-governance.js', '.opencode/plugins/intutic-governance/index.js'],
    loaders: [],
    refusedOnly: ['.opencode/plugin/another-plugin.js', '~/.config/opencode/plugins/another-plugin.js'],
  },
  'n8n': {
    // Loaded by `EXTERNAL_HOOK_FILES` in the n8n deployment's environment.
    gate: ['~/.intutic/hooks/n8n-governance-hook.js'],
    loaders: [],
  },
  'open-webui': {
    // The source an administrator pastes into Open WebUI's Functions.
    gate: ['~/.open-webui/intutic-governance-filter.py'],
    loaders: [],
  },
  'dsh': {
    gate: ['~/.dsh/profiles/test/cordis.patch.yml'],
    loaders: ['~/.dsh/profiles/test/package.json'],
    // The home-level patch outranks every profile's, and dsh still imports a
    // leftover settings.yaml.
    refusedOnly: ['~/.dsh/cordis.patch.yml', '~/.dsh/settings.yaml'],
  },
}

/**
 * Read by every gate, whatever the harness: the policy snapshot and approved
 * bypasses (under `.intutic/hooks`), and the workspace id in `runtime.env`,
 * which invalidates the snapshot when it does not match.
 */
export const SHARED_GATE_INPUTS: readonly string[] = [
  '~/.intutic/hooks/policy-snapshot.rules',
  '~/.intutic/hooks/approved-bypasses.jsonl',
  '~/.intutic/env/runtime.env',
]

/** `rel` resolved against the workspace and the home directory, as the header describes. */
export function resolveSurface(rel: string, workspaceRoot: string, home: string): string {
  if (rel.startsWith('~/')) return join(home, rel.slice(2))
  if (rel.startsWith('/')) return rel
  return join(workspaceRoot, rel)
}
