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
 * - `stdout-decision-deny` — also exit-code-ignored, but a DIFFERENT stdout
 *   object: `{"decision":"deny","reason":"..."}`. Grok Build's confirmed
 *   contract — kept distinct from `stdout-cancel` rather than folded into it
 *   because the field names do not overlap: Grok Build does not recognise
 *   `cancel`, and Cline/Roo Code do not recognise `decision`.
 * - `none` — the gate cannot refuse at all. Recorded rather than omitted, so
 *   "we know it cannot block" is distinguishable from "nobody checked".
 * - `waterfall-reject` — dsh's own contract (CONFIRMED against a real
 *   install — see `dshHooks.ts`'s module doc), genuinely novel among the
 *   above: the gate is an in-process Cordis Plugin (`@intutic/gate/dsh`, a
 *   real checked-in TypeScript module with its own test suite, NOT a
 *   per-workspace generated string this registry's shared spawn-and-pipe-JSON
 *   matrix can exercise) subscribed to the `tools/pre-execute` WATERFALL
 *   event. It refuses by RETURNING `{kind:'deny', reason}` without calling
 *   the waterfall's `next()` — no exit code, no stdout, and no thrown
 *   exception at the framework boundary (an internal `IntuticGateRefusal`
 *   throw is caught and mapped to that return value; see
 *   `packages/gate-js/src/dsh.ts`). Distinct from `js-throw`: that contract's
 *   unit is a whole workflow aborted by an uncaught throw propagating out of
 *   `preExecute`; this one's unit is one tool call, and the veto is a
 *   returned value the waterfall's own dispatcher inspects, never a throw
 *   that escapes the listener.
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
export type GateContract = 'exit2' | 'stdout-cancel' | 'stdout-decision-deny' | 'python-raise' | 'js-throw' | 'waterfall-reject'

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
    name: 'museCode',
    module: '../../src/harness/museHooks.js',
    invoke: (m, root) => m.writeMuseHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/muse-check.js',
    runner: 'node',
    contract: 'exit2',
    migrated: true,
    note:
      'registered in <repo>/.muse/hooks.json AND via managed_hooks_path (the pre-approved ' +
      'tier) in ~/.config/muse/settings.json, pointing at an Intutic-owned ' +
      '~/.config/muse/intutic-managed-hooks.json. The exit-2 block/deny contract, and the ' +
      'hooks.json schema itself, are ASSUMED from the Codex-CLI-compatible shape (TD-362) — ' +
      'the `muse` binary was not installable in the environment this writer was authored in, ' +
      'so neither could be confirmed against the real product',
    mcpCalls: 'reachable',
    mcpNote:
      "Already a `.*` catch-all matcher across both PreToolUse and PermissionRequest. Muse " +
      "Code's own MCP tool-naming convention was not independently verified — the binary " +
      "could not be installed to confirm it (see TD-362).",
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

  // ── JavaScript, stdout contract (Grok Build's OWN shape) ────────────────
  {
    name: 'grok',
    module: '../../src/harness/grokHooks.js',
    invoke: (m, root) => m.writeGrokHooks(root, PROXY_URL, 'ws_test'),
    artifact: '.intutic/hooks/grok-check.js',
    runner: 'node',
    contract: 'stdout-decision-deny',
    migrated: true,
    note:
      'registered in .grok/hooks/intutic-governance.json (project) and ' +
      '~/.grok/hooks/intutic-governance.json (user), PreToolUse with no matcher ' +
      '(applies to every tool call). Blocking contract CONFIRMED (not assumed): ' +
      'writes {"decision":"deny","reason":"..."} on stdout and exits 0 — a ' +
      'DIFFERENT stdout shape from Cline/Roo Code\'s {"cancel":true}, hence its ' +
      'own contract value rather than reuse of stdout-cancel. Grok Build ALSO ' +
      'natively reads .claude/settings.json and .cursor/hooks.json if present ' +
      '(a compatibility feature), so a workspace with either of those gates ' +
      'installed double-fires on the same Grok Build tool call — expected, not ' +
      'a bug, same posture as the mcp-proxy + gate double-emission documented ' +
      'in apps/docs/guide/mcp-governance.md; see grokHooks.test.ts for the ' +
      'harmlessness pin. The exact hooks.json-equivalent per-file schema ' +
      '(event/command/timeout fields) is this writer\'s own reasonable design, ' +
      'not independently verified against a live Grok Build install — ' +
      'unavailable in this environment.',
    mcpCalls: 'reachable',
    mcpNote:
      'No matcher on its PreToolUse registration — runs for every tool call, so an ' +
      'mcp__<server>__<tool>-shaped call WOULD be caught if Grok Build sends one. ' +
      'Grok Build\'s own MCP tool-naming convention was not independently verified ' +
      '(not installable in this environment) — hence reachable, not yes.',
  },

  // ── refuses by returning, inside a Cordis waterfall ─────────────────────
  {
    name: 'dsh',
    module: '../../src/harness/dshHooks.js',
    // dshHooks.ts's writer merge-writes into every EXISTING dsh profile — a
    // fresh fixture root has none, so this pre-seeds one (mirroring what a
    // real `dsh --profile test` first run creates: a directory holding a
    // package.json and an empty cordis.patch.yml) before invoking the writer,
    // the same way a real machine always has a profile before this writer
    // ever runs against it. Without this, "every gate produced its declared
    // artifact" (below) would fail for dsh alone — not because the writer is
    // broken, but because the fixture gave it nothing to write into.
    invoke: async (m, root) => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const profileDir = path.join(root, '.dsh', 'profiles', 'test')
      await fs.mkdir(profileDir, { recursive: true })
      await fs.writeFile(
        path.join(profileDir, 'package.json'),
        JSON.stringify({ name: 'test-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
      )
      await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
      await m.writeDshHooks(root, PROXY_URL, 'ws_test')
    },
    artifact: '.dsh/profiles/test/cordis.patch.yml',
    // Neither spawned nor piped JSON on stdin — see the module doc's
    // `waterfall-reject` entry. `runner` has no real meaning here (nothing
    // in this registry ever spawns a YAML file); 'node' is the closest
    // approximation of "the ecosystem this artifact is loaded by".
    runner: 'node',
    contract: 'waterfall-reject',
    migrated: false,
    note:
      'the gate is a real, checked-in TypeScript module (`packages/gate-js/src/dsh.ts`, ' +
      'exported as the `@intutic/gate/dsh` subpath) with its OWN test suite ' +
      '(`packages/gate-js/src/__tests__/dsh.test.ts`, including a real ' +
      '`@deepseek-ai/cordis` Context/waterfall integration test), not a per-workspace ' +
      'generated shell/JS string this registry\'s shared spawn-and-pipe-JSON matrix can ' +
      'exercise — hence `migrated: false` here rather than folding it into that matrix. ' +
      'This row still asserts dshHooks.ts actually WRITES the plugin-registration row ' +
      '(the "every gate produced its declared artifact" check below) and that it does ' +
      'not collide with another writer\'s artifact path; the veto DECISION itself is ' +
      'covered by dsh.test.ts. `@deepseek-ai/dsh` is a developer preview (first published ' +
      '2026-08-13) — real npm packages (`@deepseek-ai/dsh`, `@deepseek-ai/cordis`, ' +
      '`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-base`, ' +
      '`@deepseek-ai/dsh-llm-pi-ai`) were installed and read to confirm the `tools/pre-execute` ' +
      'event, the `PreToolDecision` shape, the profile/cordis.patch.yml structure, and the ' +
      '`llm-pi-ai.providers.<id>.baseURL` settings path — see dshHooks.ts\'s module doc and ' +
      'the TD entry this phase filed for what is still genuinely unconfirmed (chiefly: ' +
      'dsh-permission, dsh-settings-local, and dsh-fs-policy are npm-restricted and could not ' +
      'be inspected directly).',
    mcpCalls: 'reachable',
    mcpNote:
      '`tools/pre-execute` fires for every tool call unconditionally (confirmed from ' +
      '`dsh-tools`\'s shipped `.d.ts` — it is the registry\'s own dispatch point, not an ' +
      'opt-in matcher), so an `mcp__<server>__<tool>`-shaped call WOULD reach this gate if ' +
      'dsh sends one. dsh\'s own MCP tool-naming convention was not independently verified ' +
      '(the packages inspected for this phase govern tool dispatch generically, not MCP ' +
      'specifically) — hence reachable, not yes.',
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
    file: 'gateKind.ts',
    harness: null,
    why:
      'classifies each harness by gate MECHANISM (hook/sdk/none) for agentReporter.ts’s ' +
      'guardrails facet — a lookup table, not itself a harness writer, and it writes no ' +
      'config or gate of its own',
  },
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

  // ── Wave 1: Python-SDK-gated frameworks (same family as langgraph above) ──
  // Each writes .env.intutic (proxy base-URL vars only — see configWriter.ts's
  // SDK_GATED_FRAMEWORKS/formatSdkGatedEnv) via a harness/*.ts adapter under
  // tools/cli, not services/sync-daemon/src/harness — so none of these appear
  // in `writers` above either; `file: null` here is what keeps the second
  // completeness check (every HarnessType enum member) from going red.
  {
    file: null,
    harness: 'langchain',
    why:
      'no on-disk config/hook file exists — tools are plain Python callables/objects ' +
      'in the agent’s own process, same as langgraph. The blocking gate ships SDK-side ' +
      'in intutic-clawde (intutic_clawde.gate.adapters.langchain.IntuticMiddleware, a ' +
      'LangChain v1.x AgentMiddleware.wrap_tool_call, verified live against ' +
      'langchain==1.3.15/langchain-core==1.5.6 — plus guard_tools for pre-1.0 LangChain). ' +
      'Detection (HarnessType.LANGCHAIN) deliberately covers BOTH the Python and JS/TS ' +
      'LangChain ecosystems, but this adapter and its env-writer are Python-only — a ' +
      'JS/TS gate for LangChain.js is a @intutic/gate TypeScript package concern for a ' +
      'different phase, not a NO_GATE decision made here.',
  },
  {
    file: null,
    harness: 'crewai',
    why:
      'no on-disk config/hook file exists — CrewAI tools are plain callables/' +
      'CrewStructuredTool instances in the agent’s own process. The blocking gate ships ' +
      'SDK-side (intutic_clawde.gate.adapters.crewai.install(), registering a ' +
      'before_tool_call hook). CONFIRMED, not assumed: verified live by installing ' +
      'crewai==1.15.16 and reading crewai/hooks/tool_hooks.py + dispatch.py — a hook ' +
      'returning False raises HookAborted internally and blocks the call; True/None ' +
      'allows it. The plan that authored this wave flagged this mechanism as ' +
      'unconfirmed pending a real install; a real install was available in this sandbox ' +
      '(PyPI reachable, Python 3.11 toolchain present) and resolved the question, so no ' +
      'ASSUMED-mechanism TD entry was needed for it.',
  },
  {
    file: null,
    harness: 'autogen',
    why:
      'no on-disk config/hook file exists — AutoGen tools are plain callables, and the ' +
      'blocking gate ships SDK-side (intutic_clawde.gate.adapters.autogen.' +
      'IntuticInterventionHandler, an autogen_core InterventionHandler.on_send, verified ' +
      'live against autogen-core==0.7.5/autogen-agentchat==0.7.5/autogen-ext==0.7.5 by ' +
      'driving a real SingleThreadedAgentRuntime end to end). Load-bearing caveat, ' +
      'documented in that module’s doc: on_send only sees FunctionCall messages ' +
      'explicitly routed through runtime.send_message/publish_message — reading ' +
      'autogen_agentchat.agents._assistant_agent directly confirmed AssistantAgent’s own ' +
      'tool calls (workbench.call_tool_stream/handoff_tool.run_json) never go through ' +
      'the runtime at all, so this handler is blind to the common case. For that case ' +
      'the framework-agnostic @guard/guard_tools helpers (framework.py, now duck-typing ' +
      '.forward too) remain the applicable coverage — same as before this module existed. ' +
      'See TD-374. Detected via any of autogen-agentchat/autogen-core/autogen-ext.',
  },
  {
    file: null,
    harness: 'ag2',
    why:
      'no on-disk config/hook file exists — AG2 tools are plain callables, and the ' +
      'blocking gate ships SDK-side (intutic_clawde.gate.adapters.ag2.IntuticMiddleware, ' +
      'an ag2 BaseMiddleware.on_tool_execution). Verified live against ag2==1.0.2: note ' +
      'that package was found to be a from-scratch rewrite at this version — it no ' +
      'longer imports as `autogen` and shares no API with the ConversableAgent/GroupChat ' +
      'shape most AG2/pyautogen tutorials describe; this adapter targets the current ' +
      'Event/Stream/Middleware architecture, confirmed by reading ' +
      'ag2/middleware/base.py + ag2/tools/executor.py + ag2/tools/final/function_tool.py ' +
      'directly, not by trusting docs written for the old shape. See TD-376 for the ' +
      'unverified exception-propagation caveat this adapter’s doc flags.',
  },
  {
    file: null,
    harness: 'google-adk',
    why:
      'no on-disk config/hook file exists — ADK tools are plain Python callables. The ' +
      'blocking gate ships SDK-side (intutic_clawde.gate.adapters.google_adk.' +
      'IntuticPlugin.before_tool_callback, plus a per-agent before_tool_callback ' +
      'fallback for callers not using App(plugins=[...])). Verified live against ' +
      'google-adk==2.7.1: returning a non-None dict from before_tool_callback skips the ' +
      'real tool call and that dict becomes the (synthetic) tool result — ADK’s own ' +
      'documented veto point, not inferred from docs alone.',
  },
  {
    file: null,
    harness: 'openai-agents',
    why:
      'no on-disk config/hook file exists — tools are plain Python callables. The ' +
      'blocking gate ships SDK-side (intutic_clawde.gate.adapters.openai_agents.' +
      'intutic_tool_guardrail, a @tool_input_guardrail attached via function_tool(' +
      'tool_input_guardrails=[...])). Verified live against openai-agents==0.20.0: ' +
      'ToolGuardrailFunctionOutput.reject_content(message) rejects the call and returns ' +
      'the message to the model in place of the tool result — the SDK’s own documented ' +
      'veto point. ' +
      'DUAL ECOSYSTEM (same enum pattern as langchain, but with BOTH sides gated): the ' +
      'TypeScript SDK (@openai/agents on npm) is covered by @intutic/gate/openai ' +
      '(packages/gate-js) — the same tool-input-guardrail veto point, verified against ' +
      '@openai/agents@0.16.1 by driving the real Runner end to end in that package’s own ' +
      'test suite. Its wrapAgent() also gates mcpServers-derived tools (materialized per ' +
      'run via agent.getAllTools(), never present in agent.tools), and its ' +
      'installOpenAiGate() disables the SDK’s tracing exporter by default — that exporter ' +
      'posts tool inputs/outputs to a HARDCODED api.openai.com/v1/traces/ingest endpoint ' +
      'that ignores OPENAI_BASE_URL, i.e. bypasses the Intutic proxy (a real DLP path, ' +
      'closed by default, opt-out documented). Truly hosted tools (webSearch/fileSearch/' +
      'codeInterpreter/imageGeneration, hosted-environment shellTool) execute server-side ' +
      'at OpenAI with no client-side hook — not gateable by any SDK adapter, stated ' +
      'plainly in apps/docs/integrations/openai-agents.md.',
  },
  {
    file: null,
    harness: 'pydantic-ai',
    why:
      'no on-disk config/hook file exists — Pydantic AI tools are plain callables inside ' +
      'toolsets, and the blocking gate ships SDK-side ' +
      '(intutic_clawde.gate.adapters.pydantic_ai.IntuticWrapperToolset.call_tool, plus a ' +
      'guard_agent(agent) convenience helper that wraps every toolset already on an ' +
      'Agent). Verified live against pydantic-ai-slim==2.31.1 by driving a real ' +
      'Agent.run_sync() through pydantic_ai.models.function.FunctionModel: a blocked ' +
      'call raises ModelRetry (chosen over the SDK’s other veto-adjacent primitive, ' +
      'ApprovalRequired, which defers rather than denies — see that module’s doc for ' +
      'why an unattended run cannot use a deferral-shaped mechanism) and surfaces as a ' +
      'real RetryPromptPart. guard_agent reaches into Agent._user_toolsets/' +
      '_dynamic_toolsets (private attributes — Agent.toolsets is a read-only computed ' +
      'property with no public replacement point on an already-built Agent) and ' +
      'deliberately does not touch _function_toolset (@agent.tool-registered functions); ' +
      'see that module’s doc for the accepted fragility and the alternative for those. ' +
      'Detected via pydantic-ai/pydantic-ai-slim.',
  },
  {
    file: null,
    harness: 'smolagents',
    why:
      'no on-disk config/hook file exists. Different in kind from every other SDK-gated ' +
      'row here: ToolCallingAgent’s tool calls are plain callables (now covered by ' +
      '@guard/guard_tools directly — guard_tools was extended in this same phase to ' +
      'duck-type .forward, since a smolagents Tool is otherwise callable on its own ' +
      '__call__ and guard_tools silently replaced it with a bare function, losing the ' +
      'schema ToolCallingAgent needs — see framework.py’s doc), but CodeAgent has no ' +
      'discrete tool calls to wrap at all: the governed unit is the generated Python ' +
      'CODE STRING itself. intutic_clawde.gate.adapters.smolagents.IntuticPythonExecutor ' +
      'wraps any PythonExecutor (LocalPythonExecutor and friends) and gates the code ' +
      'text as {"command": code_action} before delegating, raising smolagents’ own ' +
      'InterpreterError on block so CodeAgent’s existing step-failure handling applies ' +
      'unchanged — verified live against smolagents==1.26.0 by driving a real ' +
      'CodeAgent.run() end to end, including intutic_step_callback observing the same ' +
      'step lifecycle. This governs the code text before it runs, not what an already-' +
      'running snippet does once started — see that module’s doc (TD-377) for the full ' +
      'honesty note, matched in tone to openWebuiHooks.ts’s inlet() scope note.',
  },
  {
    file: null,
    harness: 'strands',
    why:
      'no on-disk config/hook file exists — Strands tools are plain decorated callables ' +
      '(or MCP-materialised MCPAgentTools) in the agent’s own Python process. The ' +
      'blocking gate ships SDK-side (intutic_clawde.gate.adapters.strands.' +
      'IntuticHookProvider, a strands HookProvider subscribing to the STABLE ' +
      'strands.hooks.BeforeToolCallEvent). Verified live against strands-agents==1.52.0 ' +
      'by reading strands/hooks/events.py + strands/tools/executors/_executor.py ' +
      'directly AND driving a full Agent() event loop: setting event.cancel_tool (the ' +
      'framework’s own documented veto) skips the tool body and returns an error-status ' +
      'ToolResult carrying the refusal to the model. Strands’ dispatcher PROPAGATES a ' +
      'raising hook and aborts the run (fail-CLOSED — the opposite of CrewAI’s ' +
      'swallow-and-allow hazard; confirmed empirically), so unexpected gate errors abort ' +
      'rather than run unguarded. MCP tools flow through the identical event — confirmed ' +
      'with a real stdio FastMCP server. Egress caveat unique in this family: the ' +
      'DEFAULT model provider (Bedrock, SigV4/boto3) is NOT proxyable — only the ' +
      'Anthropic/OpenAI/LiteLLM providers honor .env.intutic’s base-URL vars. See ' +
      'TD-420..423 and apps/docs/integrations/strands.md.',
  },

  // -- T2: JS/TS SDK-gated frameworks (same family as langchain/langgraph
  // above, but the blocking gate ships in @intutic/gate -- packages/gate-js --
  // rather than intutic-clawde). Each writes .env.intutic via a
  // tools/cli/src/harness/*.ts adapter, not services/sync-daemon/src/harness,
  // so neither appears in GATES above either.
  {
    file: null,
    harness: 'mastra',
    why:
      'no on-disk config/hook file exists — Mastra tools run as plain objects/callables in ' +
      'the agent\'s own Node.js process. The blocking gate ships as a TypeScript SDK adapter, ' +
      '@intutic/gate/mastra\'s intuticHooks(), built on @mastra/core\'s documented ' +
      'Agent({ hooks: { beforeToolCall } }) veto point — CONFIRMED against a real install ' +
      '(@mastra/core@1.59.0): returning {proceed:false, output} from beforeToolCall skips the ' +
      'real execute() and hands output back to the model as the tool result; this applies to ' +
      'every tool in the agent\'s assembled tool dictionary, MCP-sourced tools (@mastra/mcp) ' +
      'included, since wrapToolsWithHooks wraps generically over the assembled record with no ' +
      'source-specific branch. ' +
      'KNOWN BYPASS (Mastra\'s own documented behaviour, not an Intutic defect): per-call ' +
      '`hooks` passed to .generate()/.stream() OVERRIDE the agent-level hooks entirely rather ' +
      'than merging with them — confirmed via @mastra/core\'s own ' +
      'Agent.getConfiguredToolHooks() doc comment ("Run-level hooks override these via ' +
      'resolveToolHooks"). A caller who passes ANY hooks option at call time (even {}) ' +
      'silently disables this gate for that call, with no error. See @intutic/gate/mastra\'s ' +
      'module doc and apps/docs/integrations/mastra.md for the same note surfaced to code and ' +
      'operators respectively. See docs/TECH_DEBT.md TD-380.',
  },
  {
    file: null,
    harness: 'vercel-ai-sdk',
    why:
      'no on-disk config/hook file exists — Vercel AI SDK tools run as plain objects in the ' +
      'agent\'s own Node.js process. The blocking gate ships as a TypeScript SDK adapter, ' +
      '@intutic/gate/vercel\'s intuticToolApproval(), built on the `ai` package\'s documented ' +
      '`toolApproval` veto point — CONFIRMED against a real install (ai@7.0.68): resolving to ' +
      '{type:"denied", reason} vetoes the call before execution, and \'not-applicable\' (or ' +
      'undefined) means this gate has no opinion and the call proceeds. ' +
      'DOCUMENTED LIMITATION (not an Intutic defect): unlike almost every other harness here, ' +
      'the Vercel AI SDK has no environment-variable LLM-egress routing (no OPENAI_BASE_URL- ' +
      'equivalent) — routing through the Intutic proxy requires IN-CODE provider construction ' +
      '(createOpenAI({baseURL}), createGateway({baseURL}), etc.), which is why this env-writer ' +
      'documents that requirement rather than claiming zero-code proxy routing the way ' +
      'langchain/langgraph correctly can. @intutic/gate/vercel\'s withIntuticProxy() helper ' +
      'wraps that in-code construction; see its module doc and ' +
      'apps/docs/integrations/vercel-ai-sdk.md.',
  },
  {
    file: null,
    harness: 'eve',
    why:
      'no on-disk config/hook file exists — Vercel\'s "eve" (npm `eve`, PREVIEW, pre-1.0) is ' +
      'filesystem-first: the agent is an `agent/` directory of TypeScript the developer authors, ' +
      'and tools/connections run in the compiled agent\'s own Node.js process. The blocking gate ' +
      'ships as a TypeScript SDK adapter, @intutic/gate/eve\'s intuticApproval() (and ' +
      'intuticConnectionApproval() for MCP/OpenAPI connections), built on eve\'s documented ' +
      'per-tool/per-connection `approval` policy surface — CONFIRMED against a real install ' +
      '(eve@0.39.1, devDependency of packages/gate-js): ApprovalPolicy receives ' +
      '{ toolName, toolInput?, approvedTools, callId } + session context and returns an AI SDK 7 ' +
      'approval status; {type:"denied", reason} vetoes the call before execute() runs, ' +
      '"not-applicable" continues without a prompt, and booleans are back-compat ' +
      '(true=user-approval, false=not-applicable). There is NO agent-level default approval ' +
      'field (agent-definition d.ts carries zero approval fields — verified), so coverage is ' +
      'per-tool/per-connection attachment, eve\'s own documented multi-tenant-approvals pattern. ' +
      'An observe-only audit emitter (intuticAuditHooks(), on eve\'s approval.candidate/' +
      'approval.settled hook events) maps eve\'s human-approval lifecycle onto tool_allowed/' +
      'tool_blocked/tool_flagged — telemetry only, and request-scoped (those events carry no ' +
      'tool name — verified against the shipped protocol types; TD-411). ' +
      'DOCUMENTED LIMITATION (not an Intutic defect): eve routes models through the Vercel AI ' +
      'Gateway by default, whose wire protocol the Intutic proxy does not parse — gateway-routed ' +
      'egress is ungoverned (TD-412); only the in-code direct-provider path ' +
      '(defineAgent({ model }) with withIntuticProxy(...)) routes through the proxy, and like ' +
      'the Vercel AI SDK it is built on, eve has no env-var base-URL override. ' +
      'PREVIEW churn shield per the dsh precedent: pinned verification version, Preview-labelled ' +
      'docs — see TD-410.',
  },

  {
    file: null,
    harness: 'trueforge',
    why:
      'no on-disk config/hook file exists — embedded TrueForge (another team\'s Node process ' +
      'importing @truefoundry/trueforge-core directly, github.com/truefoundry/trueforge, MIT) ' +
      'drives its own SessionHandle/TurnHandle API in-process, same as Mastra/eve above. ' +
      'CONFIRMED against a real published install (@truefoundry/trueforge-core@0.1.4, its ' +
      'shipped .d.ts files read directly, not assumed): there is NO synchronous in-process ' +
      'approval-resolver callback anywhere in the package (every .d.ts grepped for ' +
      'approvalResolver/onApproval/approvalHandler/resolveApproval — zero matches); the ONLY ' +
      'approval mechanism, embedded or not, is the same tool.approval_required / ' +
      'user.tool_approval turn-and-event contract TrueForge\'s standalone server exposes over ' +
      'HTTP. The blocking gate therefore ships as @intutic/gate/trueforge\'s ' +
      'intuticApprovalResponder() — a BATCH function evaluating pending approval requests via ' +
      'Gate.guard() and producing user.tool_approval TurnInputItems for the embedding host\'s ' +
      'next session.createTurn() call, shaped like AI_SDK_HARNESS\'s approval-responder family ' +
      'below rather than Mastra/Vercel AI SDK\'s single-callback shape. Resolving a pending ' +
      'call\'s {id, source_event_id} back to a real tool name + arguments is the embedding ' +
      'host\'s own responsibility (this package imports no TrueForge runtime dependency, same ' +
      'convention as mastra.ts/vercel.ts). This row covers ONLY the embedded-library deployment ' +
      'mode — TrueForge run as its own standalone/hosted server is HarnessType.TRUEFORGE_SERVER, ' +
      'a separate \'bridge\'-kind row immediately below (Phase 2), since nobody embeds a gate ' +
      'into a third-party OSS server process.',
  },

  {
    file: null,
    harness: 'trueforge-server',
    why:
      'no on-disk config/hook file exists, and no SDK gate ships in any process this repo runs ' +
      'either — TrueForge run as its own standalone/hosted server (`npx @truefoundry/trueforge`, ' +
      'Docker Compose, or the Helm chart) is a separate process nobody embeds an Intutic gate ' +
      'into. Its only tool-call governance surface (confirmed against the real trueforge-core ' +
      'and trueforge-sdk source: packages/trueforge-core/src/core/events/schema.ts, ' +
      'packages/trueforge/src/routes/turnRoutes.ts) is the SAME async ' +
      'tool.approval_required/user.tool_approval turn contract the embedded \'trueforge\' row ' +
      'above documents — a turn pauses naming each pending call only as {id, source_event_id} ' +
      '(all snake_case on the wire; the published @truefoundry/trueforge-sdk TS client types ' +
      '(ToolCallRef.sourceEventId, etc.) are camelCase, but that is a client-side naming ' +
      'convenience Fern generates — the actual JSON, and what this bridge speaks directly over ' +
      'plain HTTP without depending on that SDK package, is snake_case per the zod schemas that ' +
      'both validate the request and produce the response). There is no webhook: TrueForge never ' +
      'pushes anything to an external system, so governance requires an Intutic-operated service ' +
      '(services/trueforge-bridge) subscribing to each session\'s turn SSE stream (or polling ' +
      'listTurnEventsRoute as a fallback), resolving a pending call\'s source_event_id back to a ' +
      'real tool name + arguments via the referenced model.message event\'s tool_calls[].function ' +
      'field, evaluating it through the identical packages/gate-js machinery the embedded row ' +
      'above uses (soprules.ts\'s ruleMatches/firstMatch, then GateClient\'s POST /api/v1/hook-gate, ' +
      'fail-closed by GateClient\'s own default), and resuming the turn via ' +
      'POST /{session_id}/turns with previous_turn_id chained and a user.tool_approval input item. ' +
      'GateKind: \'bridge\' — a new fifth kind, not \'sdk\' (no host process of ours runs inside ' +
      'the harness) and not \'delegated\' (it does not wrap another already-gated harness). See ' +
      'gateKind.ts\'s \'bridge\' doc and services/trueforge-bridge\'s README. Also not covered: ' +
      'whether a tool call ever emits tool.approval_required at all is controlled by each ' +
      'registered MCP server\'s own approval-tool-selector config (@all/@write/@destructive/a ' +
      'specific tool name) — a narrow/default selector means some tool calls never pause and are ' +
      'invisible to the bridge, TrueForge\'s own design, not a bridge defect.',
  },

  // -- A3: Vercel platform-agent runtimes (same @intutic/gate family as the
  // T2 rows above — the gate ships in packages/gate-js, one subpath per
  // framework; each writes .env.intutic via a tools/cli/src/harness/*.ts
  // adapter, so neither appears in GATES above either).
  {
    file: null,
    harness: 'ai-sdk-harness',
    why:
      'no on-disk config/hook file exists — and, uniquely in this SDK-gated family, the tools ' +
      'do not even run on the developer\'s machine: `@ai-sdk/harness` (HarnessAgent) executes ' +
      'them server-side in Vercel Sandbox microVMs. The blocking gate ships as ' +
      '@intutic/gate/harness, and its veto surface is the framework\'s tool-approval FLOW, not ' +
      'a callback: CONFIRMED against a real install (@ai-sdk/harness@1.0.75) that ' +
      'HarnessAgentSettings.toolApproval is a STATIC Readonly<Record<string, ToolApprovalStatus>> ' +
      'whose own doc comment says "without callback support" — so intuticStaticApprovals() marks ' +
      'every custom tool \'user-approval\' (pausing each call) and intuticApprovalResponder() ' +
      'answers each pause with a real per-call Gate.guard() verdict, delivered on the portable ' +
      'continuation path (continueGenerate/continueStream\'s toolApprovalContinuations); ' +
      'session.submitToolApproval is an OPTIONAL adapter method used as an optimization when ' +
      'present (harness-claude-code@1.0.78 implements it; harness-grok-build@1.0.12 does not — ' +
      'both confirmed by reading their shipped dist). ' +
      'THREE HONEST SCOPE LIMITS, all confirmed, none hidden: (1) built-in sandbox tools ' +
      '(read/write/edit/bash/glob/grep/...) never consult toolApproval at all — they are governed ' +
      'solely by permissionMode, which DEFAULTS to \'allow-all\' ("preserving the existing ' +
      'bypass-permissions behavior", the shipped doc\'s own words); recommendedHarnessSettings() ' +
      'steers integrators to \'allow-edits\'/\'allow-reads\', but there is no per-call gate for ' +
      'built-ins at any mode. (2) Sandbox egress never crosses the laptop Intutic proxy — the ' +
      'only egress control is the sandbox\'s own HarnessV1NetworkPolicy (coarse host-level ' +
      'allow/deny, no DLP), which recommendedHarnessSettings() also emits. (3) When the wrapped ' +
      'runtime is itself a natively-gated Intutic harness (Claude Code, Grok Build), the ' +
      'sync-daemon\'s hook files do NOT exist inside the sandbox — no worktree propagation ' +
      'reaches a microVM — so the native gate those harnesses have on a laptop is ABSENT there; ' +
      'the env/mcpServers passthrough (env: harness-claude-code only) is a possible config ' +
      'channel but injecting hooks through it was NOT verified against a live sandbox. See ' +
      'apps/docs/integrations/ai-sdk-harness.md and TD-415/TD-416/TD-417.',
  },
  {
    file: null,
    harness: 'ai-sdk-workflow',
    why:
      'no on-disk config/hook file exists — @ai-sdk/workflow (WorkflowAgent) tools are plain ' +
      'objects in the agent\'s own Node.js process, durably orchestrated by the Workflow DevKit. ' +
      'The blocking gate ships as @intutic/gate/workflow. CONFIRMED against a real install ' +
      '(@ai-sdk/workflow@1.0.69): WorkflowAgent/WorkflowAgentOptions carry ZERO approval fields ' +
      '(the string toolApproval appears nowhere in the package\'s shipped .d.ts) — the veto ' +
      'surface is per-tool needsApproval (boolean | async fn), which the compiled agent loop ' +
      'evaluates as needsApproval(input, {toolCallId, messages, context}) and which pauses the ' +
      'run DURABLY (a human can approve hours later). intuticNeedsApproval()/withIntuticApproval() ' +
      'implement it: BLOCK throws, ALLOW resolves false (or true with onAllow:\'human\' to keep ' +
      'the human pause). LOAD-BEARING RETRY SEMANTICS, confirmed against workflow@4.8.3\'s real ' +
      'machinery (not re-derived): the durable runtime\'s retry/abort decision consults ' +
      'FatalError.is(err) (@workflow/core runtime/step-handler.js), which DUCK-TYPES on ' +
      'err.name === \'FatalError\' because workflows execute in a separate vm realm where ' +
      'instanceof fails — a plain IntuticGateRefusal would therefore be RETRIED toward ' +
      'maxAttempts, replaying a governance denial on a timer. This adapter\'s refusals are ' +
      'IntuticWorkflowRefusal (an IntuticGateRefusal subclass with name=\'FatalError\'), pinned ' +
      'by test against the REAL FatalError.is from the workflow package. One tracked wrinkle: ' +
      'ai@7.0.68 marks tool-level needsApproval @deprecated in favour of generateText-level ' +
      'toolApproval, but @ai-sdk/workflow\'s own loop reads the tool-level field and exposes no ' +
      'other surface — the correct integration point today, watched for drift in TD-419. No live ' +
      'durable run was exercised (needs a Workflow DevKit deployment — TD-418). See ' +
      'apps/docs/integrations/ai-sdk-workflow.md.',
  },

  // ── O1: orchestrator wrapping OTHER already-gated harnesses ──────────────
  // First entry of this specific shape — see gateKind.ts's 'delegated' kind,
  // which this row's `file: null` feeds into the same way an `'sdk'` row
  // does. O2 (QM) and O3 (agentic-orchestrator, added below) share the same
  // "wraps other harnesses" reasoning.
  {
    file: null,
    harness: 'xirp',
    why:
      'Xirp is not itself an AI agent — it is a macOS-only desktop orchestrator (beta since ' +
      '2026-08-11) that spawns ALREADY-INSTALLED CLI harnesses (Claude Code, Codex, Gemini ' +
      'CLI) each inside its own tmux session and git worktree, so several parallel agent ' +
      'sessions can run against one repo without their working trees colliding. Per Xirp\'s ' +
      'own public FAQ it preserves each wrapped harness\'s NATIVE, UNMODIFIED configuration — ' +
      'it introduces no config format, and therefore no gate surface, of its own for this ' +
      'registry to cover. A tool call made inside a Xirp-managed session is governed by ' +
      'whichever wrapped harness\'s own gate is already running (claude-code-check.js, ' +
      'codex-check.js, etc.) — the SAME gate this registry already lists under that harness\'s ' +
      'own row, not a second one. This is NOT the same claim as "no gate exists" (that would ' +
      'be a `harness: \'xirp\'` NO_GATE row with a `none`-shaped reason, like aider\'s); it is ' +
      '"the gate exists, credited to the harness that actually owns it" — see gateKind.ts\'s ' +
      '`delegated` kind for why that distinction gets its own value rather than being folded ' +
      'into `sdk` or `none`. What IS this phase\'s own responsibility, and what makes Xirp ' +
      'more than a detection-only add: the wrapped harness\'s gate/config files only protect a ' +
      'tool call if they actually exist in the git worktree that call runs in, and a `git ' +
      'worktree` checkout does NOT inherit the main checkout\'s untracked files (governance ' +
      'config files are untracked by convention) — so before this phase, every Xirp-managed ' +
      'worktree session ran completely ungoverned regardless of what was configured in the ' +
      'main checkout. `services/sync-daemon/src/lib/gitWorktrees.ts` + its wiring into ' +
      '`syncLoop.ts`\'s `runSyncIteration` is the fix: it discovers every worktree of the ' +
      'watched repo each cycle and writes the same project-tier files into each one, which ' +
      'restores every wrapped harness\'s own already-existing gate inside Xirp\'s sessions — ' +
      'this row stays a NO_GATE precisely because the gate that ends up protecting a Xirp ' +
      'session was never Xirp\'s to write. See TD-390.',
  },

  // ── O3: second orchestrator of this shape — DoorDash Agentic Orchestrator ─
  {
    file: null,
    harness: 'agentic-orchestrator',
    why:
      'DoorDash\'s "Agentic Orchestrator" (binary `agentico`, Go, Apache-2.0, ' +
      'doordash-oss/agentic-orchestrator — CONFIRMED real and public: the actual released binary ' +
      'was downloaded and run during this integration\'s research, not just its README) is not ' +
      'itself an AI agent — it is a desktop app + CLI that turns a feature prompt into a ' +
      'multi-phase workflow (research, planning, implementation, review, PR publish), delegating ' +
      'the model-driving work to ALREADY-INSTALLED CLI backends: Claude Code, Codex, and OpenCode ' +
      '(CONFIRMED via `agentico server --help`\'s `--providers` flag, live-verified against the ' +
      'real binary: "Available: claude, codex, opencode"). Each feature runs in its own git ' +
      'worktree under `~/.agentic-orchestrator/worktrees/` (confirmed via the project\'s README), ' +
      'the same shape Xirp uses — `gitWorktrees.ts`\'s worktree propagation (added in O1, general ' +
      'and not Xirp-specific) already covers these worktrees too; no new code was needed for that ' +
      'part. A tool call made inside an Agentic-Orchestrator-managed session is governed by ' +
      'whichever wrapped backend\'s own gate is already running (claude-code-check.js, ' +
      'codex-check.js) — the SAME gate this registry already lists under that harness\'s own row, ' +
      'not a second one. This is the same `delegated` reasoning as Xirp\'s row above, not a new ' +
      'kind — see gateKind.ts. ' +
      'IMPORTANT DIFFERENCE FROM XIRP: one of the three wrapped backends, OpenCode, has NO adapter ' +
      'or gate anywhere in this registry at all. A feature run with `--providers opencode` (or the ' +
      'default auto-join behavior when the `opencode` CLI is installed and authenticated) has ZERO ' +
      'Intutic governance today — not "delegated to an existing gate" but genuinely ungoverned, ' +
      'the same as any other unsupported harness. This row still classifies as NO_GATE/`delegated` ' +
      'for the harness AS A WHOLE (claude- and codex-backed features ARE fully covered), but the ' +
      'OpenCode gap is real and tracked, not merely "unconfirmed" — see TD-397.',
  },

  // ── B2: AWS Bedrock AgentCore Runtime — a "delegated" host, not a spawner ─
  {
    file: null,
    harness: 'agentcore-runtime',
    why:
      'AWS Bedrock AgentCore Runtime (GA 2025-10) is a managed hosting environment for a ' +
      'customer\'s OWN agent code, unchanged — NOT itself an agent framework. Because it just ' +
      'runs the customer\'s own code, the blocking tool-call gate is whichever ALREADY-SUPPORTED ' +
      'framework adapter that code uses (Strands, LangGraph, CrewAI, ...) — the SAME gate this ' +
      'registry already lists under that framework\'s own row, not a second one. This adapter\'s ' +
      '`writeConfig` is a no-op for the same reason Xirp\'s and Agentic Orchestrator\'s are. ' +
      'UNLIKE those two, Runtime does not spawn an already-installed CLI harness as a subprocess ' +
      '— it hosts framework-SDK code as a deployment target, which is a different shape of ' +
      '`delegated` (see gateKind.ts) worth naming explicitly: if the hosted code uses no ' +
      'framework this registry supports (raw boto3, a hand-rolled tool loop), coverage is ' +
      'genuinely zero — the same honest gap Agentic Orchestrator\'s OpenCode backend has ' +
      '(TD-397), not something this row can claim to fix. Detection (CONFIRMED against real ' +
      'published artifacts — pip/npm package versions live-checked, config filenames confirmed ' +
      'by extracting and grepping the real tarballs/wheels, not assumed) covers the ' +
      '`bedrock-agentcore` PyPI/npm SDK, the `bedrock-agentcore-starter-toolkit` PyPI CLI, the ' +
      '`@aws/agentcore` npm CLI, and the `.bedrock_agentcore.yaml`/`agentcore/agentcore.json`/ ' +
      '`aws-targets.json` config files those CLIs write. Deployment-target caveats that are NOT ' +
      'a gate concern — environment-variable caps (<=50 vars, <=5000 chars each, CONFIRMED ' +
      'against the CreateAgentRuntime API reference), VPC/NAT egress topology (PUBLIC network ' +
      'mode is the default; private egress needs an explicit NAT setup this adapter cannot do ' +
      'for the operator), and Bedrock\'s own SigV4-signed model-invocation traffic not being ' +
      'proxyable the way an OPENAI_BASE_URL-style override is elsewhere — are documented in ' +
      'apps/docs/integrations/agentcore.md, not encoded here. See TD-430.',
  },
]
