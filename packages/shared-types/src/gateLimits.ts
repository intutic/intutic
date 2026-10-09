/**
 * How much a gate will evaluate, and for how long, before it refuses.
 *
 * Most harnesses treat a hook that runs past its timeout as having allowed
 * the call (see {@link HOOK_GATE_TIMEOUTS}), so a gate that is slow on a
 * crafted call is no gate. Two bounds keep every gate inside its harness's
 * timeout:
 *
 * - **Size.** A command over {@link COMMAND_SIZE_LIMIT} bytes, or tool
 *   arguments over {@link ARGUMENTS_SIZE_LIMIT} bytes (serialized as compact
 *   JSON), are refused as `COMMAND_TOO_LARGE` before any rule runs. The limits
 *   come from 85,314 tool calls in real coding-agent transcripts: the largest
 *   shell command was 38.5 KB (99.9th percentile 13 KB), the largest file
 *   write 120 KB, the largest arguments of any tool 418 KB (a plan). So the
 *   command limit is six times the largest seen and the arguments limit more
 *   than twice.
 * - **Time.** Each hook gate stops at {@link gateDeadlineMs} for its harness
 *   after it starts and refuses with a `GATE_DEADLINE` reason. Every built-in
 *   rule is linear in the text (sequence.ts, the phrase matcher,
 *   regexLinearity.ts in the sync daemon), so only a workspace's own WHERE
 *   patterns can get there.
 *
 * Sizes are UTF-8 bytes, which every gate can count the same way.
 *
 * @module
 */

/** The largest shell command, in UTF-8 bytes, a gate evaluates. */
export const COMMAND_SIZE_LIMIT = 256 * 1024

/** The largest tool arguments, in UTF-8 bytes of compact JSON, a gate evaluates. */
export const ARGUMENTS_SIZE_LIMIT = 1024 * 1024

/**
 * The timeout `intutic connect` sets on a gate's hook entry, in seconds,
 * wherever the harness has a key for one. Harness defaults run from 30 s to
 * 600 s; 10 s keeps a stalled gate from holding the agent for minutes, and is
 * also the longest any gate runs where the harness sets no limit at all.
 */
export const HOOK_TIMEOUT_SECONDS = 10

/**
 * How far below its harness's hook timeout a gate refuses.
 *
 * The harness starts its clock when it spawns the hook; the gate starts its
 * own once its interpreter is running (Node's `process.uptime()`, the bash
 * gate's watchdog), and once its deadline fires it still has to stop its
 * children, write the refusal and the audit line, and exit, and the harness
 * has to read the exit. On a 14-core machine running every package's test
 * suite beside 100 busy threads (load average near 190), a gate's refusal
 * reached the harness at most 260 ms after its deadline, Node and bash alike.
 * One second is nearly four times that.
 */
export const GATE_DEADLINE_MARGIN_MS = 1000

/** Who decides the timeout a harness applies to its gate. */
export type HookTimeoutSetBy =
  /** `intutic connect` writes it into the hook entry. */
  | 'connect'
  /** The harness's own value, which no setting changes. */
  | 'harness'
  /** The harness documents none, so the gate assumes the shortest default of any documented harness that runs a call whose hook timed out: Grok Build's 5 s. */
  | 'undocumented'
  /** The gate runs in the harness's process, which waits for it without a limit. */
  | 'none'

/** The timeout a harness applies to its hook gate. */
export interface HookGateTimeout {
  /** In milliseconds; null when the harness waits without a limit. */
  readonly timeoutMs: number | null
  readonly setBy: HookTimeoutSetBy
  /** Where the value comes from. */
  readonly source: string
}

const CONNECT_MS = HOOK_TIMEOUT_SECONDS * 1000
/** Grok Build's default hook timeout, the shortest any documented harness uses; assumed where a harness documents none. */
const UNDOCUMENTED_ASSUMED_MS = 5000

/**
 * The hook timeout each harness applies to its gate, keyed by the harness id
 * the gate is emitted for. The one source every gate's deadline is derived
 * from: the writers set the timeouts marked `connect` from here, and a test
 * reads each written hook entry back against it.
 */
export const HOOK_GATE_TIMEOUTS = {
  'claude-code': { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the hook entry in .claude/settings.json; default 600 s, a call whose hook times out runs (code.claude.com/docs/en/hooks)' },
  cursor: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the hooks.json entry, beside `failClosed: true`; default not stated (cursor.com/docs/agent/hooks)' },
  windsurf: { timeoutMs: UNDOCUMENTED_ASSUMED_MS, setBy: 'undocumented', source: 'hooks.json entries have no timeout key and Windsurf documents no timeout; any exit but 2 runs the call (docs.devin.ai/desktop/cascade/hooks)' },
  codex: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the hooks.json entry; default 600 s (Codex hooks documentation)' },
  'muse-code': { timeoutMs: UNDOCUMENTED_ASSUMED_MS, setBy: 'undocumented', source: 'Muse Code documents no hook timeout and no key for one (dev.meta.ai/docs/muse-code)' },
  'github-copilot': { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the hook entry, the Copilot CLI\'s alias for `timeoutSec` and VS Code\'s key; default 30 s, a call whose hook times out runs (docs.github.com/en/copilot/reference/hooks-configuration)' },
  cline: { timeoutMs: 30_000, setBy: 'harness', source: 'HOOK_EXECUTION_TIMEOUT_MS = 30000 in Cline\'s hook-factory.ts, not configurable; a call whose hook times out runs' },
  grok: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the hook entry; default 5 s, no stated maximum, a call whose hook times out runs (docs.x.ai/build/features/hooks)' },
  antigravity: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) on the PreToolUse handler in ~/.gemini/config/hooks.json; default 30 s (antigravity.google/docs/hooks)' },
  'gemini-cli': { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (milliseconds) on the BeforeTool hook in ~/.gemini/settings.json; default 60 000 (geminicli.com/docs/hooks/reference)' },
  goose: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) beside `on_failure: "block"` in the plugin\'s hooks.json; default 30 s (goose hooks guide)' },
  openhands: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) in .openhands/hooks.json; default 60 s, a call whose hook times out runs (openhands-sdk hooks/config.py)' },
  hermes: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeout` (seconds) beside `fail_closed: true` in ~/.hermes/config.yaml; default 60 s, at most 300 s (hermes-agent shell_hooks.py)' },
  openclaw: { timeoutMs: CONNECT_MS, setBy: 'connect', source: '`timeoutMs` on the before_tool_call registration; default 15 s, a timeout blocks the call but cannot interrupt the handler (OpenClaw docs/plugins/hooks/reference.md)' },
  pi: { timeoutMs: null, setBy: 'none', source: 'Pi awaits an extension\'s tool_call handler without a limit (core/extensions/runner.ts)' },
  opencode: { timeoutMs: null, setBy: 'none', source: 'OpenCode awaits a plugin\'s tool.execute.before without a limit (packages/opencode/src/plugin/index.ts)' },
} as const satisfies Record<string, HookGateTimeout>

/** A harness that runs a hook gate. */
export type HookGateHarness = keyof typeof HOOK_GATE_TIMEOUTS

/**
 * How long a harness's hook gate may decide, from its start, before it
 * refuses with `GATE_DEADLINE`: {@link GATE_DEADLINE_MARGIN_MS} under the
 * harness's timeout, and never longer than {@link HOOK_TIMEOUT_SECONDS} minus
 * that margin, so a gate the harness waits on for 30 s or without limit still
 * answers as promptly as one connect set a timeout for. On the loaded machine
 * above, a call at the size limits took the bash gates at most 4.6 s and the
 * JavaScript gates at most 1.2 s; every 4 s deadline is a JavaScript gate's.
 * Only a workspace's own pathological WHERE pattern runs this long.
 */
export function gateDeadlineMs(harness: HookGateHarness): number {
  const timeoutMs: number | null = HOOK_GATE_TIMEOUTS[harness].timeoutMs
  return Math.min(timeoutMs ?? CONNECT_MS, CONNECT_MS) - GATE_DEADLINE_MARGIN_MS
}
