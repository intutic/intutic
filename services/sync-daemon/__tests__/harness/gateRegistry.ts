/**
 * Every gate this repo generates, in one list, with the facts a test needs to
 * run it.
 *
 * # Why a registry rather than a test per harness
 *
 * `harnessProtectedPaths.test.ts` had a structural bug that this shape exists to
 * make impossible. Its coverage was keyed on *finding* a `const PROTECTED_PATHS`
 * in a writer's source, so **not declaring one was indistinguishable from not
 * being a harness**. That is exactly how `clineHooks` — which hand-rolled
 * `PROTECTED_PATH_FRAGMENTS` with four of the twelve paths missing — stayed
 * invisible to the test written to catch that. Its `.endsWith('Hooks.ts')`
 * filter separately excluded `gooseHooksWriter.ts` and `openhandsHooksWriter.ts`,
 * so both halves of the double-gate defect were unobservable too.
 *
 * A registry inverts the default: a harness is covered because it is listed, and
 * an unlisted harness fails the completeness check in
 * `generatedGateBehaviour.test.ts`. Adding a writer without adding a row is the
 * thing that goes red.
 *
 * # Blocking contracts are a column, not a fork
 *
 * Three different mechanisms are in use, and picking the wrong one is invisible
 * in review:
 *
 * - `exit2` — the process exits 2. **Exit 1 is a hook *error*** in every one of
 *   these harnesses, and the call proceeds. Two shipped defects here turned a
 *   block into an error exit.
 * - `stdout-cancel` — the exit code is ignored; a `{"cancel":true}` object on
 *   stdout is what refuses the call.
 * - `none` — the gate cannot refuse at all. Recorded rather than omitted, so
 *   "we know it cannot block" is distinguishable from "nobody checked".
 *
 * @module
 */

/**
 * A dynamically imported harness writer module.
 *
 * Typed as a bag of functions rather than `any` because the writers genuinely
 * differ in arity and argument order — `writeGooseHooks` alone is
 * `(proxyUrl, workspaceRoot, workspaceId)` where every other writer takes the
 * root first. The registry's `invoke` closure is where that difference is
 * recorded per writer; this type just says "a module of functions".
 */
export type HarnessModule = Record<string, (...args: unknown[]) => Promise<void>>

/** How a gate refuses a call. See the module note — this is not cosmetic.
 *  `js-throw` is the workflow-level contract: the gate is an in-process module
 *  whose preExecute function THROWS to abort — no exit code, no stdout. Its
 *  unit is a whole workflow, so like `python-raise` it is exercised by its own
 *  describe block rather than the per-tool matrix. */
export type GateContract = 'exit2' | 'stdout-cancel' | 'python-raise' | 'js-throw'

/** What runs the emitted artifact. */
export type GateRunner = 'bash' | 'node' | 'python3'

export interface GateEntry {
  /** Harness id used in test names. */
  name: string
  /** Module under `src/harness/` that emits the gate. */
  module: string
  /** Invokes the writer against a root. Argument order is NOT uniform across
   *  writers — see the note in `generatedShellIntegrity.test.ts`. */
  invoke: (mod: HarnessModule, root: string) => Promise<void>
  /** Path of the emitted gate, relative to the writer's root. */
  artifact: string
  runner: GateRunner
  contract: GateContract
  /**
   * Whether this gate has been rolled onto the shared evaluator in
   * `harness/gateBody.ts`.
   *
   * Rows that are still `false` register as `it.todo` with the reason below, so
   * the gap is visible in test output from the first run rather than being
   * absent from it.
   */
  migrated: boolean
  /** Why a row is not migrated, or what is known not to work. Shown in output. */
  note?: string
}

const PROXY_URL = 'http://127.0.0.1:4000'

export const GATES: readonly GateEntry[] = [
  // ── bash ────────────────────────────────────────────────────────────────
  {
    name: 'goose',
    module: '../../src/harness/gooseHooks.js',
    // `(proxyUrl, workspaceRoot, workspaceId)` — the one writer whose first two
    // arguments are reversed relative to every other. Handing it a URL where it
    // wants a root is silent: it creates `./http:/…` under the process cwd.
    invoke: (m, root) => m.writeGooseHooks(PROXY_URL, root, 'ws_test'),
    artifact: '.agents/plugins/intutic-governance/scripts/intutic-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'openhands',
    module: '../../src/harness/openhandsHooks.js',
    invoke: (m, root) => m.writeOpenHandsHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/openhands-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
    note: 'never extracted a command — has no shell-bypass guard at all',
  },
  {
    name: 'hermes',
    module: '../../src/harness/hermesHooks.js',
    invoke: (m, root) => m.writeHermesHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/hermes-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'antigravity',
    module: '../../src/harness/antigravityHooks.js',
    invoke: (m, root) => m.writeAntigravityHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/antigravity-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'pi',
    module: '../../src/harness/piHooks.js',
    invoke: (m, root) => m.writePiHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/pi-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
  },

  // ── JavaScript, exit-code contract ──────────────────────────────────────
  {
    name: 'claudeCode',
    module: '../../src/harness/claudeCodeHooks.js',
    // `(workspaceRoot, sops, settings?, controlPlaneUrl?, workspaceId?)`.
    invoke: (m, root) => m.updatePreToolUseHooks(root, [], {}, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/claude-code-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note: 'the primary harness; shipped a ReferenceError that disabled it entirely',
  },
  {
    name: 'claudeDesktop',
    module: '../../src/harness/claudeDesktopHooks.js',
    invoke: (m, root) => m.writeClaudeDesktopHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/claude-desktop-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'cursor',
    module: '../../src/harness/cursorHooks.js',
    invoke: (m, root) => m.writeCursorHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/cursor-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'windsurf',
    module: '../../src/harness/windsurfHooks.js',
    invoke: (m, root) => m.writeWindsurfHooks(root, PROXY_URL, 8877, 'ws_test'),
    artifact: '.intutic/hooks/windsurf-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
  },
  {
    name: 'openclaw',
    module: '../../src/harness/openclawHooks.js',
    invoke: (m, root) => m.writeOpenclawHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/openclaw-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note: 'its writer shells out to an installed `openclaw` binary if present',
  },
  {
    name: 'codex',
    module: '../../src/harness/codexHooks.js',
    invoke: (m, root) => m.writeCodexHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/codex-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note:
      'registered in ~/.codex/hooks.json and <repo>/.codex/hooks.json; the stdin ' +
      'shape and exit-2 contract are Claude-Code-compatible, so the shared gate is a drop-in',
  },
  {
    name: 'githubCopilot',
    module: '../../src/harness/githubCopilotHooks.js',
    invoke: (m, root) => m.writeGithubCopilotHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/github-copilot-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note:
      'VS Code agent hooks are a PREVIEW feature (.github/hooks/*.json + ~/.copilot/hooks). ' +
      'The gate refuses payloads it does not recognise, so a format change fails closed',
  },
  {
    name: 'continue',
    module: '../../src/harness/continueHooks.js',
    invoke: (m, root) => m.writeContinueHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/continue-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note:
      'Continue CLI (cn) only — the IDE extension has no hook system. The CLI also ' +
      'reads .claude/settings.json, so claude-code users may already run that gate; ' +
      'the dedicated registration in .continue/settings.json covers users without it. ' +
      'LIVE-VERIFIED LIMITS (cn 1.5.47): headless -p mode does not execute PreToolUse ' +
      'hooks at all (marker-hook probe: tool ran, hook never fired) — interactive TUI ' +
      'sessions are what this gate covers, headless runs are proxy-governed only; and ' +
      "cn's dispatcher fails OPEN on hook errors ({blocked:false}) by its own design",
  },

  // ── JavaScript, stdout contract ─────────────────────────────────────────
  {
    name: 'cline',
    module: '../../src/harness/clineHooks.js',
    invoke: (m, root) => m.writeClineHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.cline/hooks/intutic-check.js',
    runner: 'node',
    contract: 'stdout-cancel',
    migrated: true,
    note: 'hand-rolled PROTECTED_PATH_FRAGMENTS, missing 4 of 12 paths',
  },
  {
    name: 'rooCode',
    module: '../../src/harness/rooCodeHooks.js',
    invoke: (m, root) => m.writeRooCodeHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/roo-check.js',
    runner: 'node',
    contract: 'stdout-cancel',
    migrated: true,
  },

  // ── refuses by throwing, at workflow granularity ────────────────────────
  {
    name: 'n8n',
    module: '../../src/harness/n8nHooks.js',
    invoke: (m, root) => m.writeN8nHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/n8n-governance-hook.js',
    runner: 'node',
    contract: 'js-throw',
    migrated: true,
    note:
      'workflow-level, not per-tool: an EXTERNAL_HOOK_FILES workflow.preExecute module ' +
      'that receives the full Workflow and throws to abort. Node type stands in for the ' +
      'tool name; serialized node parameters are what argPattern matches. Installation ' +
      'is MANUAL and deployment-side (the daemon cannot set another process’s env) — ' +
      'see the INSTALL.md the writer emits. Exercised by its own describe block.',
  },

  // ── refuses by raising, and refuses less on purpose ─────────────────────
  {
    name: 'openWebui',
    module: '../../src/harness/openWebuiHooks.js',
    invoke: (m, root) => m.writeOpenWebuiHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.open-webui/intutic-governance-filter.py',
    runner: 'python3',
    contract: 'python-raise',
    migrated: true,
    note:
      'Open WebUI filters see a prompt, not a tool call — no tool name, no path ' +
      'argument, no command. It can refuse now (it could not before), but the ' +
      'compiled floor only *flags* here: a prompt mentioning .claude/settings.json ' +
      'is someone asking about a file. Only a snapshot rule marked block refuses. ' +
      'Exercised by its own describe block, not the tool-call matrix.',
  },
]

/**
 * Writers that generate no gate at all, with the reason.
 *
 * The completeness check asserts `GATES ∪ NO_GATE` covers every writer file in
 * `src/harness/`, so a harness cannot be forgotten — only *deliberately*
 * excluded, in writing, here.
 *
 * A file-derived check alone has a blind spot: a harness with **no writer file
 * at all** (as codex and github-copilot were before they gained writers, and
 * langgraph still is) appears in neither list and stays invisible.
 * So each entry also names the `harness` it accounts for (`null` for shared
 * infrastructure that is not a harness), and a second completeness check
 * asserts `GATES ∪ NO_GATE` covers every `HarnessType` enum member — a new
 * adapter without a hook file goes red until someone decides about it here.
 * Entries with `file: null` are exactly those enum-only rows.
 */
export const NO_GATE: ReadonlyArray<{
  file: string | null
  harness: string | null
  why: string
}> = [
  {
    file: 'aiderConfigMerger.ts',
    harness: 'aider',
    why:
      'no pre-edit hook exists. The only native mechanism is the opt-in ' +
      '--git-commit-verify pre-commit hook — post-edit (the file is already written ' +
      'when it runs) and blind to /run, so a gate built on it would imply more than ' +
      'it delivers. Proxy routing and the config merger remain the coverage.',
  },
  { file: 'gooseHardener.ts', harness: 'goose', why: 'applies immutable flags to gooseHooks’ output; emits no gate' },
  { file: 'mcpAutoWrite.ts', harness: null, why: 'registers MCP servers; not a tool-call gate' },
  {
    file: 'holdRedaction.ts',
    harness: null,
    why: 'redaction serialised into claude-code’s gate; writes no harness config of its own',
  },
  {
    file: null,
    harness: 'langgraph',
    why:
      'no on-disk config/hook file exists to write a gate into — tools are plain ' +
      'Python callables in the agent’s own process. The blocking gate ships ' +
      'SDK-side in intutic-clawde (intutic_clawde.gate, python-raise), evaluating ' +
      'the policy snapshot + A3 argPattern rules in-process before the tool body runs',
  },
]
