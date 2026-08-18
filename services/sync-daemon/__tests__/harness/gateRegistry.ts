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
  /**
   * Whether `mcp__<server>__<tool>`-shaped tool calls reach this gate's
   * evaluator at all (M3 — the per-server MCP allowlist / `#mcpservers`
   * header work). Three values, not two, because "the gate script runs for
   * this call" and "this harness's own MCP tool names actually take that
   * shape" are separate facts and conflating them overclaims:
   *
   * - `'yes'` — CONFIRMED both: a matcher/unconditional-evaluation routes the
   *   call into the gate script, AND this harness's own MCP tool-naming
   *   convention produces (or, after M3, this writer composes) the
   *   `mcp__<server>__<tool>` shape the allowlist and SOP rules match against.
   * - `'reachable'` — the gate script runs for every tool call this harness
   *   makes (a `.*` matcher, or bash-family unconditional evaluation), so an
   *   `mcp__<server>__<tool>`-shaped call WOULD be caught if this harness
   *   sends one — but this harness's own MCP tool-naming convention was not
   *   independently verified during M3, so whether it actually sends that
   *   shape is unconfirmed, not denied.
   * - `'no'` — no matcher/dispatch path exists for this call at all, or the
   *   gate's unit of evaluation is not a per-tool-call decision in the first
   *   place (prompt-level, workflow-level).
   */
  mcpCalls: 'yes' | 'reachable' | 'no'
  /** Detail behind `mcpCalls` — what was confirmed, how, and what was not. */
  mcpNote: string
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
    mcpCalls: 'reachable',
    mcpNote: 'bash-family: no matcher concept, the script runs for every tool call unconditionally. Goose’s own MCP tool-naming convention was not independently verified during M3.',
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
    mcpCalls: 'reachable',
    mcpNote: 'bash-family: runs unconditionally. OpenHands’ own MCP tool-naming convention was not independently verified during M3.',
  },
  {
    name: 'hermes',
    module: '../../src/harness/hermesHooks.js',
    invoke: (m, root) => m.writeHermesHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/hermes-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'reachable',
    mcpNote: 'bash-family: runs unconditionally. Hermes’ own MCP tool-naming convention was not independently verified during M3.',
  },
  {
    name: 'antigravity',
    module: '../../src/harness/antigravityHooks.js',
    invoke: (m, root) => m.writeAntigravityHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/antigravity-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'reachable',
    mcpNote: 'bash-family: runs unconditionally. Antigravity (Gemini CLI)’s own MCP tool-naming convention was not independently verified during M3.',
  },
  {
    name: 'pi',
    module: '../../src/harness/piHooks.js',
    invoke: (m, root) => m.writePiHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/pi-check.sh',
    runner: 'bash',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'reachable',
    mcpNote: 'bash-family (also carries its own ‘.*’ hooks.json matcher, belt-and-suspenders). Pi’s own MCP tool-naming convention was not independently verified during M3.',
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
    mcpCalls: 'yes',
    mcpNote: "M3 added an `hookEntry('mcp__.*')` PreToolUse matcher. Claude Code's own MCP tool-naming convention IS `mcp__<server>__<tool>` — this is the scheme every other harness's shape is measured against, not an assumption made for this phase.",
  },
  {
    name: 'claudeDesktop',
    module: '../../src/harness/claudeDesktopHooks.js',
    invoke: (m, root) => m.writeClaudeDesktopHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/claude-desktop-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'yes',
    mcpNote: "M3 added `'mcp__.*'` to HOOK_MATCHERS. This harness shares Claude Code's PreToolUse hook format and MCP tool-naming convention verbatim (see this writer's own module doc).",
  },
  {
    name: 'cursor',
    module: '../../src/harness/cursorHooks.js',
    invoke: (m, root) => m.writeCursorHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/cursor-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'yes',
    mcpNote:
      'M3 fix: the extraction bug flagged for investigation was real in effect, though not ' +
      'literally as described — `tool_name` IS populated on a beforeMCPExecution payload ' +
      '(never the string "beforeMCPExecution"), but it was never composed into the ' +
      '`mcp__<server>__<tool>` shape. Confirmed against Cursor\'s hooks documentation and a ' +
      'live payload example from a Cursor bug-tracker thread (2026-08): ' +
      '`{tool_name, command, hook_event_name: "beforeMCPExecution", ...}` — `command` (or ' +
      '`url` for a remote server) is the server identifier, and the real event-name field is ' +
      '`hook_event_name`, not `event`. Both now read; the composition now happens.',
  },
  {
    name: 'windsurf',
    module: '../../src/harness/windsurfHooks.js',
    invoke: (m, root) => m.writeWindsurfHooks(root, PROXY_URL, 8877, 'ws_test'),
    artifact: '.intutic/hooks/windsurf-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    mcpCalls: 'reachable',
    mcpNote:
      'CONFIRMED, not a guess (2026-08-18 follow-up to M3\'s UNCONFIRMED flag): M3\'s composition ' +
      'fix targeted Cursor\'s event names/payload shape by analogy, and that assumption was wrong — ' +
      'Windsurf/Cascade\'s real hook system (docs.devin.ai/desktop/cascade/hooks, the current ' +
      'authoritative source post-Cognition/Devin acquisition) uses `pre_run_command`/' +
      '`pre_write_code`/`pre_mcp_tool_use` event names and nests payload data under `tool_info` ' +
      '(`tool_info.mcp_server_name`/`tool_info.mcp_tool_name` for MCP calls), never ' +
      '`beforeShellExecution`/`beforeMCPExecution`/`beforeFileEdit`. That naming was ALREADY live ' +
      'when this writer was first authored (2026-06-18) — a March-2026 third-party integration ' +
      'guide already documents it — so the Cursor-shaped registration never worked on any real ' +
      'Windsurf build, not a case of Windsurf changing later. windsurfHooks.ts now registers the ' +
      'real event names (array-wrapped, matching Cascade\'s hooks.json schema) and its extraction ' +
      'reads `agent_action_name`/`tool_info.*` first, with the old Cursor-shaped fields kept only ' +
      'as a lower-priority fallback. See windsurfHooks.ts\'s module doc comment for the full ' +
      'correction record and windsurfHooks.test.ts for coverage against the confirmed real shape.',
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
    mcpCalls: 'reachable',
    mcpNote: 'Its PreToolUse registration carries no matcher (runs for every tool call). Openclaw’s own MCP tool-naming convention was not independently verified during M3.',
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
    mcpCalls: 'reachable',
    mcpNote: "Already a `.*` catch-all matcher — reaches the gate script for any tool name. Its stdin envelope is stated Claude-Code-compatible, which is suggestive but not a confirmation of Codex's own MCP tool-naming convention; not independently verified during M3.",
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
    mcpCalls: 'reachable',
    mcpNote: "Already a `.*` catch-all matcher. GitHub Copilot's own MCP tool-naming convention was not independently verified during M3.",
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
    mcpCalls: 'reachable',
    mcpNote: "Already a `.*` catch-all matcher (when the hook fires at all — see the headless-mode limit above). Continue's own MCP tool-naming convention was not independently verified during M3.",
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
    mcpCalls: 'no',
    mcpNote:
      "M3 added `use_mcp_tool` envelope normalization to the SHARED intuticGate (gateBody.ts), " +
      "which fires for ANY JS harness whose payload happens to carry `toolName === 'use_mcp_tool'` " +
      "with `server_name`/`tool_name` — Cline's own well-documented tool-call schema for MCP " +
      "invocations. Deliberately did NOT add `use_mcp_tool`/`access_mcp_resource` PreToolUse " +
      "matchers to GOVERNED_TOOLS: this writer's `.cline/hooks/hooks.json` mechanism assumes a " +
      "file-based matcher/command hook contract, and Cline's own current SDK documentation " +
      "describes hook lifecycle stages under different terminology (a `tool_call_before` plugin " +
      "stage, not a `hooks.json` PreToolUse entry) with no confirmed schema published for its " +
      "PreToolUse `toolName` values. Whether Cline actually dispatches this writer's hook " +
      "mechanism for `use_mcp_tool` calls at all could not be confirmed during M3 — adding a " +
      "matcher that would silently never fire was rejected in favor of documenting the gap here.",
  },
  {
    name: 'rooCode',
    module: '../../src/harness/rooCodeHooks.js',
    invoke: (m, root) => m.writeRooCodeHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/roo-check.js',
    runner: 'node',
    contract: 'stdout-cancel',
    migrated: true,
    mcpCalls: 'reachable',
    mcpNote:
      "Already a `.*` catch-all matcher. Roo Code is a Cline fork and, to the extent it kept " +
      "Cline's `use_mcp_tool` tool-call vocabulary, would also benefit from the shared " +
      "intuticGate normalization above — but that inheritance was not independently verified " +
      "during M3, so this is 'reachable', not 'yes'.",
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
    mcpCalls: 'no',
    mcpNote:
      "Confirmed by reading emitN8nWorkflowGate (gateBody.ts): this gate's unit of evaluation " +
      "is a workflow NODE TYPE, addressed by n8n's own dot-namespaced convention (e.g. " +
      "`n8n-nodes-base.executeCommand`) — never a `mcp__<server>__<tool>` tool-call name, even " +
      "for n8n's own MCP Client Tool node type. No per-server allowlist check was added here; " +
      "the M1/M2 MCP proxy remains the enforcement point for MCP calls an n8n workflow makes.",
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
    mcpCalls: 'no',
    mcpNote: "Confirmed by reading emitPythonGate (gateBody.ts): this evaluator sees PROMPT TEXT, not a tool call — no tool name of any shape reaches it, so an `mcp__<server>__<tool>` allowlist check does not apply.",
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
    file: 'jetbrainsXmlConfig.ts',
    harness: null,
    why:
      'narrow XML merge utility windsurfJetBrainsProxy.ts uses to write into JetBrains ' +
      'IDE settings files without corrupting unrelated content; writes no harness config ' +
      'or gate of its own',
  },
  {
    file: 'windsurfJetBrainsProxy.ts',
    harness: 'windsurf',
    why:
      'configures the JetBrains Windsurf plugin\'s HTTP-proxy routing (detectProxy + the ' +
      'IDE platform\'s own proxy.settings.xml) — not a hook/gate surface; windsurfHooks.ts ' +
      'covers this harness\'s actual gate',
  },
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
