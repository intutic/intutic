/**
 * OpenAI Agents SDK (TypeScript) adapter: `intuticToolGuardrail()`,
 * `wrapTools()`, `wrapAgent()`, `installOpenAiGate()`.
 *
 * `@intutic/gate/openai` — a framework-specific specialization of the same
 * idea `wrapTools.ts` implements generically (see that file's module doc):
 * wrap the framework's own veto point around this package's `Gate.guard()`.
 * The TypeScript twin of the Python SDK's
 * `intutic_clawde.gate.adapters.openai_agents` (`intutic_tool_guardrail`).
 *
 * ## The veto mechanism — CONFIRMED against a real install
 *
 * `@openai/agents@0.16.1` was installed as a devDependency of this package
 * and its shipped `.d.ts`/compiled source read directly (not inferred from
 * docs alone). `@openai/agents` is a meta-package (`export * from
 * '@openai/agents-core'` + `'@openai/agents-openai'` + `export * as
 * realtime`); the relevant surface lives in `@openai/agents-core`:
 *
 * The SDK's documented per-tool veto point is a **tool input guardrail**
 * (`dist/toolGuardrail.d.ts`, present since `@openai/agents-core` 0.3.8,
 * 2026-01-14):
 *
 * ```ts
 * interface ToolInputGuardrailDefinition<TContext> {
 *   type: 'tool_input'
 *   name: string
 *   run: (data: { context: RunContext; agent: Agent; toolCall: protocol.FunctionCallItem })
 *     => Promise<ToolGuardrailFunctionOutput>   // { behavior, outputInfo? }
 * }
 * // behavior: {type:'allow'} | {type:'rejectContent'; message} | {type:'throwException'}
 * ```
 *
 * The runner (`dist/runner/toolExecution.js`) runs every guardrail in
 * `FunctionTool.inputGuardrails` BEFORE `invoke` — on `rejectContent` the
 * tool body never runs and `message` becomes the model-visible tool output
 * (`resolveFunctionFailureOutput`). `protocol.FunctionCallItem.arguments` is
 * the RAW, unparsed JSON arguments string (`z.ZodString`), same as the Python
 * SDK's `ToolContext.tool_arguments` — hence {@link toolInputFromArguments}.
 *
 * Guardrail attachment is PER-TOOL: there is no run-level tool guardrail.
 * That is what {@link wrapTools} and {@link wrapAgent} are for.
 *
 * Ordering caveat (documented, verified in `toolExecution.js`): for a tool
 * whose `needsApproval` resolves true, input guardrails run AFTER the
 * human-approval flow by default. Opt in to guardrails-before-approval with
 * the run config `toolExecution: { preApprovalInputGuardrails: true }`
 * (available since `@openai/agents-core` 0.11.8;
 * `dist/runner/runConfig.d.ts`).
 *
 * ## The MCP materialization gotcha — why `wrapAgent` patches `getAllTools`
 *
 * Tools contributed by `agent.mcpServers` do NOT live in `agent.tools`: they
 * are materialized per run by `agent.getAllTools()` → `getMcpTools()` →
 * `mcpToFunctionTool()` (`dist/mcp.js`), which builds them with the same
 * `tool()` factory — same guardrail path — but attaches NO guardrails of its
 * own. Mapping over `agent.tools` alone therefore silently misses every
 * MCP-sourced tool. {@link wrapAgent} closes that hole by patching the
 * agent INSTANCE's `getAllTools` to inject the Intutic guardrail into every
 * `FunctionTool` it returns, MCP-derived ones included (the runner resolves
 * tools exclusively through `executionAgent.getAllTools(...)` —
 * `dist/runner/modelPreparation.js`). Injection is idempotent (keyed on
 * {@link GUARDRAIL_NAME}), so tools that are both in `agent.tools` and in the
 * `getAllTools` result are gated exactly once.
 *
 * ## Non-function tools — what is and is not gateable
 *
 *   * **hostedMcpTool** entries execute at OpenAI's side, but expose a
 *     client-visible approval loop: `providerData.require_approval` /
 *     `providerData.on_approval` (snake_case POST-construction — the
 *     camelCase `requireApproval`/`onApproval` exist only as `hostedMcpTool()`
 *     factory options; the runner reads only the snake_case fields,
 *     `dist/runner/mcpApprovals.js`). `wrapTools` rewrites these entries to
 *     `require_approval: 'always'` plus an Intutic `on_approval` that guards
 *     each call and composes any pre-existing handler. NOTE
 *     `hostedMcpTool()`'s own default is `require_approval: 'never'` — an
 *     unwrapped hosted MCP tool is entirely ungated.
 *   * **shellTool / applyPatchTool** (local) carry `needsApproval` +
 *     `onApproval` auto-resolvers. `wrapTools` forces `needsApproval` to
 *     always-true and installs a composed Intutic `onApproval`: gate refusal
 *     → reject (with the BLOCKED message); gate allow → the tool's ORIGINAL
 *     approval policy is replayed (original `needsApproval` false → approve;
 *     original `onApproval` present → delegated to). When the original
 *     policy demanded a human and no original `onApproval` exists, the
 *     decision is deliberately left undecided so the interruption still
 *     surfaces — see {@link OpenAiApprovalDecision} for the verified
 *     mechanism this relies on.
 *   * **computerTool** has NO `onApproval` — only a per-action
 *     `needsApproval` predicate (plus `onSafetyCheck`). `wrapTools` (and
 *     {@link intuticComputerNeedsApproval}) can therefore only turn a gate
 *     refusal into `needsApproval → true`, which surfaces as a pending
 *     interruption in `result.interruptions` that YOUR code must
 *     `state.reject(...)`. Stated honestly: a caller who `state.approve()`s
 *     that interruption overrides the gate — the SDK gives this adapter no
 *     reject-with-message hook for computer actions. (The refusal is still
 *     emitted to the control plane as `tool_blocked` telemetry either way.)
 *   * **Hosted tools** (`webSearchTool`, `fileSearchTool`,
 *     `codeInterpreterTool`, `imageGenerationTool`, ...) are bare
 *     `HostedTool` objects executed server-side at OpenAI: NO client-side
 *     guardrail, approval hook, or wrapper ever sees them. The
 *     hosted-environment variant of `shellTool` (`environment.type:
 *     'container_*'`) is in the same bucket — its factory options type
 *     `needsApproval`/`onApproval` as `never`. `wrapTools` passes all of
 *     these through UNCHANGED rather than pretending they are gated.
 *
 * ## Realtime
 *
 * `@openai/agents-realtime` honours `FunctionTool.inputGuardrails` through
 * the same `runToolInputGuardrails` helper (verified in its shipped
 * `realtimeSession.js`), so a guardrail injected by this module also gates
 * voice-agent tool calls.
 *
 * ## LLM egress and the tracing DLP leak
 *
 * Routing chat traffic through the Intutic proxy is env-only for this SDK:
 * the underlying `openai` client (7.5.0, `client.js`) reads
 * `OPENAI_BASE_URL` whenever no explicit `baseURL`/client is passed to
 * `OpenAIProvider` — so a sourced `.env.intutic` governs egress with zero
 * code, unlike the Vercel AI SDK (see vercel.ts's module doc). The default
 * transport is the HTTP Responses API, whose wire shape the Intutic proxy
 * already parses.
 *
 * BUT: `@openai/agents-openai`'s tracing exporter POSTs trace spans —
 * including tool inputs/outputs — to a HARDCODED
 * `https://api.openai.com/v1/traces/ingest` (`openaiTracingExporter.js`),
 * bypassing `OPENAI_BASE_URL` entirely, and tracing is ON by default. That
 * is a real DLP exfiltration path around the proxy.
 * {@link suppressAgentsTracingExport} (called by {@link installOpenAiGate}
 * unless opted out) sets the SDK's own kill-switch env
 * `OPENAI_AGENTS_DISABLE_TRACING=1` (read lazily per run —
 * `@openai/agents-core`'s `config.js`). Callers who need traces should
 * instead re-point the exporter endpoint in code
 * (`new OpenAITracingExporter({ endpoint })` + `setTraceProcessors`) at an
 * approved collector and opt out with `{ tracingExport: 'keep' }`.
 *
 * ## What this module does NOT import
 *
 * Deliberately no runtime dependency on `@openai/agents`/
 * `@openai/agents-core` — the `OpenAi*` types below are narrow structural
 * copies of only the shapes this adapter touches, same policy as mastra.ts /
 * vercel.ts / dsh.ts (see dsh.ts's module doc for the full rationale). The
 * real packages are devDependencies used by `__tests__/openai.test.ts` to
 * type-check these structural types against the real shipped ones and to
 * drive the real runner machinery end to end.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { Gate, active as activeGate, install } from './gate.js'
import type { GateConfig, ToolInput } from './gate.js'
import { GateClient } from './client.js'
import { IntuticGateRefusal } from './errors.js'

/** The `name` every guardrail this module builds carries. Also the
 *  idempotency key: a `FunctionTool` whose `inputGuardrails` already contains
 *  a guardrail with this name is never double-wrapped. */
export const GUARDRAIL_NAME = 'intutic'

// ---------------------------------------------------------------------------
// Structural copies of the @openai/agents-core shapes this adapter touches.
// Confirmed field-for-field against @openai/agents-core@0.16.1's shipped
// dist/*.d.ts (see module doc). This package does not depend on the SDK at
// runtime, so the shapes are declared here rather than imported.
// ---------------------------------------------------------------------------

/** Slice of `protocol.FunctionCallItem` read by the guardrail: `arguments`
 *  is the RAW, unparsed JSON string (the full item also carries `callId`,
 *  `type: 'function_call'`, ...). */
export interface OpenAiFunctionCallLike {
  name: string
  arguments: string
}

/** Slice of `ToolInputGuardrailData` the guardrail reads. The real data also
 *  carries `context: RunContext` and `agent: Agent`, which pass through this
 *  (wider-parameter) structural type untouched. */
export interface OpenAiToolInputGuardrailData {
  toolCall: OpenAiFunctionCallLike
}

/** Structural copy of `ToolGuardrailFunctionOutput` — the subset of
 *  `behavior` values this adapter emits (`throwException` is never used:
 *  a refusal is a model-visible rejection, not a run-fatal tripwire). */
export interface OpenAiToolGuardrailFunctionOutput {
  behavior: { type: 'allow' } | { type: 'rejectContent'; message: string }
  outputInfo?: unknown
}

/** Structural copy of `ToolInputGuardrailDefinition` — directly assignable
 *  both to a built `FunctionTool.inputGuardrails` array and to the `tool()`
 *  factory's `inputGuardrails` option. */
export interface OpenAiToolInputGuardrail {
  type: 'tool_input'
  name: string
  run: (data: OpenAiToolInputGuardrailData) => Promise<OpenAiToolGuardrailFunctionOutput>
}

/**
 * Structural copy of the `{ approve, reason? }` decision `onApproval` /
 * `on_approval` handlers resolve with — with one deliberate widening:
 * `approve` is optional here.
 *
 * For SHELL and APPLY_PATCH tools the runner checks `decision.approve ===
 * true` and `=== false` explicitly and treats anything else as "no decision
 * made", leaving the approval pending so it surfaces as an interruption
 * (VERIFIED against `@openai/agents-core@0.16.1`'s
 * `dist/runner/toolExecution.js`, `resolveToolApproval()`). This adapter
 * returns `{}` exactly once — when the gate allows a call whose ORIGINAL
 * tool policy demanded a human and no original `onApproval` exists — so the
 * caller's own interruption flow survives wrapping. That fall-through is
 * real but UNDOCUMENTED SDK behaviour; see the TD entry this phase filed.
 *
 * Hosted MCP `on_approval` results are consumed with a TRUTHY check instead
 * (`dist/runner/mcpApprovals.js`), so `{}` there would silently REJECT —
 * the hosted-MCP wrapper never uses the fall-through.
 */
export interface OpenAiApprovalDecision {
  approve?: boolean
  reason?: string
}

/** Slice of `RunToolApprovalItem` the approval handlers read. */
export interface OpenAiToolApprovalItemLike {
  rawItem?: unknown
}

/** Minimal structural slice of `Agent` needed by {@link wrapAgent}: the
 *  static tool list plus the per-run materializer the runner actually
 *  consumes (`dist/runner/modelPreparation.js`). */
export interface OpenAiAgentLike {
  tools: object[]
  getAllTools(...args: never[]): Promise<object[]>
}

// Internal structural slices of the Tool union, discriminated on `type`.
interface FunctionToolSlice {
  type: 'function'
  name: string
  inputGuardrails?: OpenAiToolInputGuardrail[]
}
interface HostedToolSlice {
  type: 'hosted_tool'
  name: string
  providerData?: Record<string, unknown>
}
interface ShellToolSlice {
  type: 'shell'
  name: string
  /** Present (a `Shell` impl) only in local mode — the discriminator this
   *  adapter uses for "hosted shell is not client-gateable". */
  shell?: unknown
  needsApproval: (...args: unknown[]) => Promise<boolean> | boolean
  onApproval?: (runContext: unknown, item: OpenAiToolApprovalItemLike) => Promise<OpenAiApprovalDecision>
}
interface ApplyPatchToolSlice {
  type: 'apply_patch'
  name: string
  needsApproval: (...args: unknown[]) => Promise<boolean> | boolean
  onApproval?: (runContext: unknown, item: OpenAiToolApprovalItemLike) => Promise<OpenAiApprovalDecision>
}
interface ComputerToolSlice {
  type: 'computer'
  name: string
  needsApproval: (...args: unknown[]) => Promise<boolean> | boolean
}

/** `providerData` slice of a hosted MCP tool (snake_case is what the runner
 *  and the Responses converter read; camelCase variants are tolerated on
 *  READ because hand-rolled tool literals sometimes carry them — the SDK's
 *  own identity extraction does the same, `dist/toolIdentity.js`). */
interface HostedMcpProviderDataSlice {
  type?: unknown
  require_approval?: unknown
  requireApproval?: unknown
  on_approval?: (context: unknown, item: OpenAiToolApprovalItemLike) => Promise<OpenAiApprovalDecision>
  onApproval?: (context: unknown, item: OpenAiToolApprovalItemLike) => Promise<OpenAiApprovalDecision>
  [key: string]: unknown
}

const WRAPPED = Symbol.for('intutic.gate.openai.wrapped')
const AGENT_WRAPPED = Symbol.for('intutic.gate.openai.agentWrapped')

export interface OpenAiWrapOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
}

// ------------------------------------------------------------------ helpers

function resolveGate(explicit: Gate | undefined, what: string): Gate {
  const g = explicit ?? activeGate()
  if (g === null) {
    throw new Error(
      'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
        `{ gate } to ${what}. Refusing to run the tool unguarded.`,
    )
  }
  return g
}

/**
 * Parse the raw JSON `arguments` string into the object `Gate.guard()`
 * evaluates. Port of the Python adapter's `_tool_input_of` — same fallback
 * keys (`raw`, `value`): a call the gate cannot parse should still reach a
 * rule, not silently skip evaluation.
 */
export function toolInputFromArguments(raw: string | null | undefined): ToolInput {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { raw }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as ToolInput
  }
  return { value: parsed }
}

function crashMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `[Intutic Governance] BLOCKED: gate crashed (${detail}) — failing closed rather than allowing an unevaluated call.`
}

/** Refusal → rejection decision; anything else → fail-closed rejection.
 *  Same posture as dsh.ts's `createPreExecuteListener` (see that module's
 *  doc for why every adapter takes the closed direction on failure). */
function errorToDecision(err: unknown): OpenAiApprovalDecision {
  if (err instanceof IntuticGateRefusal) {
    return { approve: false, reason: err.message }
  }
  return { approve: false, reason: crashMessage(err) }
}

// -------------------------------------------------------- primary guardrail

/**
 * Builds the Intutic tool input guardrail — `{ type: 'tool_input', name:
 * 'intutic', run }` — attachable to any `FunctionTool`, either at
 * construction:
 *
 * ```ts
 * import { tool } from '@openai/agents'
 * import { Gate, install } from '@intutic/gate'
 * import { intuticToolGuardrail } from '@intutic/gate/openai'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * const shell = tool({
 *   name: 'shell',
 *   description: 'Run a shell command',
 *   parameters: z.object({ command: z.string() }),
 *   inputGuardrails: [intuticToolGuardrail()],
 *   execute: async ({ command }) => run(command),
 * })
 * ```
 *
 * or after the fact via {@link wrapTools}/{@link wrapAgent}. On refusal the
 * guardrail resolves `{ behavior: { type: 'rejectContent', message } }` —
 * the runner skips the tool body and hands `message` (the
 * `[Intutic Governance] BLOCKED: ...` text) back to the model in place of a
 * tool result. On an unexpected gate crash it rejects too (fail closed). On
 * allow it resolves `{ behavior: { type: 'allow' } }`.
 *
 * Requires a `Gate` — either passed via `{ gate }`, or installed
 * process-wide with `install(new Gate(...))`. A call with neither throws
 * out of `run` (which the runner escalates into a run-fatal `ToolCallError`)
 * rather than running the tool unguarded — same posture as
 * `wrapTool`/`intuticHooks`/`intuticToolApproval`.
 */
export function intuticToolGuardrail(opts: OpenAiWrapOptions = {}): OpenAiToolInputGuardrail {
  return {
    type: 'tool_input',
    name: GUARDRAIL_NAME,
    run: async (data) => {
      const g = resolveGate(opts.gate, 'intuticToolGuardrail()')
      try {
        await g.guard(data.toolCall.name, toolInputFromArguments(data.toolCall.arguments))
      } catch (err) {
        if (err instanceof IntuticGateRefusal) {
          return {
            behavior: { type: 'rejectContent', message: err.message },
            outputInfo: { code: err.code, incidentId: err.incidentId },
          }
        }
        return { behavior: { type: 'rejectContent', message: crashMessage(err) } }
      }
      return { behavior: { type: 'allow' } }
    },
  }
}

// ------------------------------------------------------- per-type wrapping

function wrapFunctionTool(tool: FunctionToolSlice, opts: OpenAiWrapOptions): FunctionToolSlice {
  const existing = tool.inputGuardrails ?? []
  if (existing.some((gr) => gr.name === GUARDRAIL_NAME)) return tool
  // Intutic FIRST: a governance refusal should not depend on (or pay the
  // cost of) whatever caller-authored guardrails follow it.
  return { ...tool, inputGuardrails: [intuticToolGuardrail(opts), ...existing] }
}

function isHostedMcp(tool: HostedToolSlice): boolean {
  if (tool.name === 'hosted_mcp') return true
  const pd = tool.providerData as HostedMcpProviderDataSlice | undefined
  return pd?.type === 'mcp'
}

/** Whether the tool's ORIGINAL `require_approval` demanded approval for
 *  `toolName`. Interpretation of the filter object form: a tool listed under
 *  `never` does not need approval; everything else does (matching the
 *  conservative reading of OpenAI's approval filter — unlisted tools require
 *  approval unless the whole setting is 'never'). */
function originallyDemandedApproval(requireApproval: unknown, toolName: string): boolean {
  if (requireApproval === undefined || requireApproval === 'never') return false
  if (requireApproval === 'always') return true
  if (requireApproval !== null && typeof requireApproval === 'object') {
    const filter = requireApproval as {
      never?: { tool_names?: string[]; toolNames?: string[] }
      always?: { tool_names?: string[]; toolNames?: string[] }
    }
    const neverNames = filter.never?.tool_names ?? filter.never?.toolNames ?? []
    if (neverNames.includes(toolName)) return false
    return true
  }
  return false
}

function hostedMcpApprovalDetails(item: OpenAiToolApprovalItemLike): { toolName: string; rawArguments?: string } | null {
  const rawItem = item?.rawItem as { type?: unknown; name?: unknown; providerData?: Record<string, unknown> } | undefined
  if (!rawItem || rawItem.type !== 'hosted_tool_call') return null
  const pd = rawItem.providerData ?? {}
  const toolName =
    typeof pd.name === 'string' && pd.name.length > 0
      ? pd.name
      : typeof rawItem.name === 'string' && rawItem.name !== 'mcp_approval_request'
        ? rawItem.name
        : null
  if (toolName === null) return null
  return {
    toolName,
    ...(typeof pd.arguments === 'string' ? { rawArguments: pd.arguments } : {}),
  }
}

function wrapHostedMcpTool(tool: HostedToolSlice, opts: OpenAiWrapOptions): HostedToolSlice {
  const marked = tool as HostedToolSlice & Record<symbol, unknown>
  if (marked[WRAPPED] === true) return tool

  const pd: HostedMcpProviderDataSlice = { ...(tool.providerData ?? {}) }
  const originalOnApproval = pd.on_approval ?? pd.onApproval
  const originalRequireApproval = pd.require_approval ?? pd.requireApproval

  pd.require_approval = 'always'
  pd.on_approval = async (context, item) => {
    const g = resolveGate(opts.gate, 'wrapTools()')
    const details = hostedMcpApprovalDetails(item)
    if (details === null) {
      // Nothing recognisable to evaluate — refuse rather than approve a call
      // the gate never saw.
      return {
        approve: false,
        reason:
          '[Intutic Governance] BLOCKED: could not extract the MCP tool call from the approval ' +
          'request — failing closed rather than approving an unevaluated call.',
      }
    }
    try {
      await g.guard(details.toolName, toolInputFromArguments(details.rawArguments))
    } catch (err) {
      return errorToDecision(err)
    }
    if (originalOnApproval) return originalOnApproval(context, item)
    if (originallyDemandedApproval(originalRequireApproval, details.toolName)) {
      // The caller's original config demanded a human for this tool but gave
      // the runner no resolver. The hosted-MCP approval loop consumes
      // decisions with a truthy check (see OpenAiApprovalDecision's doc), so
      // there is no "leave it pending" here: per this product's own posture
      // (gate.ts, SOP_RULE_APPROVAL), an approval that cannot be granted is a
      // block. Keep your own onApproval on the hostedMcpTool — this wrapper
      // composes with it — to retain a human flow.
      return {
        approve: false,
        reason:
          '[Intutic Governance] BLOCKED: this MCP tool call requires human approval ' +
          '(require_approval) and the tool has no onApproval resolver; an approval that ' +
          'cannot be granted in an unattended run is a block.',
      }
    }
    return { approve: true }
  }
  delete pd.requireApproval
  delete pd.onApproval

  const wrapped: HostedToolSlice = { ...tool, providerData: pd as Record<string, unknown> }
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

/** Shared shell/apply_patch wrapping: force every action through the
 *  approval path, gate it there, then replay the tool's original policy. */
function wrapApprovalGatedTool<T extends ShellToolSlice | ApplyPatchToolSlice>(
  tool: T,
  opts: OpenAiWrapOptions,
  extract: (rawItem: unknown) => { toolInputs: ToolInput[]; action: unknown; callId?: string } | null,
): T {
  const marked = tool as T & Record<symbol, unknown>
  if (marked[WRAPPED] === true) return tool

  const originalNeedsApproval = tool.needsApproval
  const originalOnApproval = tool.onApproval

  const onApproval = async (runContext: unknown, item: OpenAiToolApprovalItemLike): Promise<OpenAiApprovalDecision> => {
    const g = resolveGate(opts.gate, 'wrapTools()')
    const details = extract(item?.rawItem)
    if (details === null) {
      return {
        approve: false,
        reason:
          `[Intutic Governance] BLOCKED: could not extract the ${tool.type} action from the ` +
          'approval item — failing closed rather than approving an unevaluated call.',
      }
    }
    try {
      for (const toolInput of details.toolInputs) {
        await g.guard(tool.name, toolInput)
      }
    } catch (err) {
      return errorToDecision(err)
    }
    // Gate allows. Replay the tool's ORIGINAL approval policy so wrapping is
    // behaviour-preserving beyond the gate itself.
    const originallyNeeded =
      typeof originalNeedsApproval === 'function'
        ? await originalNeedsApproval(runContext, details.action, details.callId)
        : Boolean(originalNeedsApproval)
    if (!originallyNeeded) return { approve: true }
    if (originalOnApproval) return originalOnApproval(runContext, item)
    // Original policy: interruption for a human. Leave the decision unmade —
    // the runner's `=== true`/`=== false` checks fall through to "pending"
    // and the interruption surfaces exactly as before wrapping. See
    // OpenAiApprovalDecision's doc for the verification of this mechanism.
    return {}
  }

  const wrapped: T = { ...tool, needsApproval: async () => true, onApproval }
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

function shellDetails(rawItem: unknown): { toolInputs: ToolInput[]; action: unknown; callId?: string } | null {
  const raw = rawItem as { type?: unknown; callId?: unknown; action?: { commands?: unknown } } | undefined
  if (!raw || raw.type !== 'shell_call') return null
  const commands = Array.isArray(raw.action?.commands) ? raw.action.commands : null
  if (commands === null) return null
  return {
    // One guard() per command: a snapshot/SOP rule written against `command`
    // must see each command on its own, not a joined blob.
    toolInputs: commands.map((command) => ({ command: String(command) })),
    action: raw.action,
    ...(typeof raw.callId === 'string' ? { callId: raw.callId } : {}),
  }
}

function applyPatchDetails(rawItem: unknown): { toolInputs: ToolInput[]; action: unknown; callId?: string } | null {
  const raw = rawItem as {
    type?: unknown
    callId?: unknown
    operation?: { type?: unknown; path?: unknown; diff?: unknown; moveTo?: unknown }
  } | undefined
  if (!raw || raw.type !== 'apply_patch_call' || !raw.operation) return null
  const op = raw.operation
  if (typeof op.path !== 'string') return null
  const toolInput: ToolInput = {
    path: op.path,
    operation: typeof op.type === 'string' ? op.type : 'unknown',
    // `content` so gate.ts's authoring-time infra check sees the diff body.
    ...(typeof op.diff === 'string' ? { content: op.diff } : {}),
    ...(typeof op.moveTo === 'string' ? { move_to: op.moveTo } : {}),
  }
  return {
    toolInputs: [toolInput],
    action: op,
    ...(typeof raw.callId === 'string' ? { callId: raw.callId } : {}),
  }
}

/**
 * Gate-driven `needsApproval` predicate for `computerTool` — the ONLY
 * pre-execution hook that tool exposes (no guardrails, no `onApproval`):
 *
 * ```ts
 * computerTool({ computer, needsApproval: intuticComputerNeedsApproval() })
 * ```
 *
 * A gate-refused (or gate-crashed — fail closed) action resolves `true`,
 * which the runner turns into a pending interruption in
 * `result.interruptions`; your interruption handler must `state.reject(...)`
 * it. This is honestly weaker than the guardrail path: the SDK offers no way
 * for this adapter to auto-reject a computer action with a message, and a
 * handler that `state.approve()`s the interruption overrides the gate. An
 * allowed action defers to `fallback` (the predicate the tool would
 * otherwise have used; defaults to no approval).
 */
export function intuticComputerNeedsApproval(
  opts: OpenAiWrapOptions & {
    /** Tool name reported to the gate. Defaults to `computer_use_preview`. */
    toolName?: string
    /** Original predicate to defer to when the gate allows. */
    fallback?: (...args: unknown[]) => Promise<boolean> | boolean
  } = {},
): (runContext: unknown, action: unknown, callId?: unknown) => Promise<boolean> {
  const toolName = opts.toolName ?? 'computer_use_preview'
  return async (runContext, action, callId) => {
    const g = resolveGate(opts.gate, 'intuticComputerNeedsApproval()')
    const toolInput: ToolInput =
      action !== null && typeof action === 'object' && !Array.isArray(action)
        ? (action as ToolInput)
        : { value: action }
    try {
      await g.guard(toolName, toolInput)
    } catch {
      // Refusal OR crash: force the approval interruption (fail closed).
      // The refusal itself was already emitted as tool_blocked telemetry
      // inside guard().
      return true
    }
    if (opts.fallback) {
      return opts.fallback(runContext, action, callId)
    }
    return false
  }
}

function wrapComputerTool(tool: ComputerToolSlice, opts: OpenAiWrapOptions): ComputerToolSlice {
  const marked = tool as ComputerToolSlice & Record<symbol, unknown>
  if (marked[WRAPPED] === true) return tool
  const wrapped: ComputerToolSlice = {
    ...tool,
    needsApproval: intuticComputerNeedsApproval({
      ...opts,
      toolName: tool.name,
      fallback: typeof tool.needsApproval === 'function' ? tool.needsApproval : undefined,
    }),
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

// -------------------------------------------------------------- public API

function wrapOneTool<T extends object>(tool: T, opts: OpenAiWrapOptions): T {
  const t = tool as { type?: unknown; shell?: unknown }
  switch (t.type) {
    case 'function':
      return wrapFunctionTool(tool as unknown as FunctionToolSlice, opts) as unknown as T
    case 'hosted_tool': {
      const hosted = tool as unknown as HostedToolSlice
      // Non-MCP hosted tools (webSearch, fileSearch, codeInterpreter, image
      // generation, ...) execute server-side at OpenAI with no client-side
      // hook — pass through UNCHANGED, documented in the module doc.
      return isHostedMcp(hosted) ? (wrapHostedMcpTool(hosted, opts) as unknown as T) : tool
    }
    case 'shell': {
      // Hosted-environment shell (no local `shell` impl) is server-side —
      // its factory types needsApproval/onApproval as `never`. Pass through.
      if (t.shell === undefined) return tool
      return wrapApprovalGatedTool(tool as unknown as ShellToolSlice, opts, shellDetails) as unknown as T
    }
    case 'apply_patch':
      return wrapApprovalGatedTool(tool as unknown as ApplyPatchToolSlice, opts, applyPatchDetails) as unknown as T
    case 'computer':
      return wrapComputerTool(tool as unknown as ComputerToolSlice, opts) as unknown as T
    default:
      return tool
  }
}

/**
 * Wrap a list of OpenAI Agents SDK tools so `Gate.guard()` runs before each
 * one executes — see the module doc for exactly what each tool `type` gets
 * (and what hosted tools cannot get). Returns NEW tool objects (shallow
 * copies); the ones passed in are not mutated. Wrapping twice is a no-op.
 *
 * NOTE: this covers only the tools you hand it. Tools materialized from
 * `agent.mcpServers` do not exist yet at wrapping time — use
 * {@link wrapAgent} for an agent with MCP servers.
 */
export function wrapTools<T extends object>(tools: readonly T[], opts: OpenAiWrapOptions = {}): T[] {
  return tools.map((t) => wrapOneTool(t, opts))
}

/**
 * Gate every tool an agent can reach, MCP-sourced tools included.
 *
 * ```ts
 * import { Agent, run } from '@openai/agents'
 * import { installOpenAiGate, wrapAgent } from '@intutic/gate/openai'
 *
 * installOpenAiGate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID })
 *
 * const agent = wrapAgent(new Agent({
 *   name: 'ops',
 *   tools: [shell],
 *   mcpServers: [filesystemServer],
 * }))
 * const result = await run(agent, prompt)
 * ```
 *
 * Two things happen, both idempotent:
 *
 *   1. `agent.tools` is replaced with {@link wrapTools}' wrapped copies.
 *   2. The agent INSTANCE's `getAllTools` — the materializer the runner
 *      actually consumes each turn, and the ONLY place `mcpServers`-derived
 *      tools ever appear (see module doc) — is patched to wrap everything it
 *      returns.
 *
 * MUTATES (and returns) the agent passed in.
 *
 * Scope, stated plainly: this wraps ONE agent. Agents reached via handoffs
 * are separate objects — wrap each of them too.
 */
export function wrapAgent<T extends OpenAiAgentLike>(agent: T, opts: OpenAiWrapOptions = {}): T {
  const marked = agent as T & Record<symbol, unknown>
  if (marked[AGENT_WRAPPED] === true) return agent

  agent.tools = wrapTools(agent.tools, opts)

  const originalGetAllTools = agent.getAllTools.bind(agent) as (...args: unknown[]) => Promise<object[]>
  ;(agent as OpenAiAgentLike).getAllTools = async (...args: unknown[]) =>
    wrapTools(await originalGetAllTools(...args), opts)

  Object.defineProperty(marked, AGENT_WRAPPED, { value: true, enumerable: false })
  return agent
}

// ------------------------------------------------------------ installation

/**
 * Close the tracing DLP leak: set the SDK's own kill-switch env
 * (`OPENAI_AGENTS_DISABLE_TRACING=1`) so the default exporter never POSTs
 * trace spans — which carry tool inputs/outputs — to its HARDCODED
 * `https://api.openai.com/v1/traces/ingest` endpoint (which ignores
 * `OPENAI_BASE_URL`, i.e. bypasses the Intutic proxy). The SDK reads the env
 * lazily per run, so calling this any time before `run(...)` is effective.
 *
 * To keep traces instead, re-point the exporter at an approved collector in
 * your own code — `setTraceProcessors([new BatchTraceProcessor(new
 * OpenAITracingExporter({ endpoint }))])` — and pass
 * `{ tracingExport: 'keep' }` to {@link installOpenAiGate}.
 */
export function suppressAgentsTracingExport(): void {
  process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'
}

/** Config for {@link installOpenAiGate}. Extends the core {@link GateConfig}. */
export interface OpenAiGateConfig extends GateConfig {
  /** Overrides the generated-per-process session id. Mirrors
   *  `INTUTIC_SESSION_ID` for callers that already have one to hand. */
  sessionId?: string
  /**
   * What to do about the tracing exporter's proxy bypass (see
   * {@link suppressAgentsTracingExport}). `'disable'` (default) sets the
   * SDK's kill-switch env; `'keep'` leaves tracing exactly as configured —
   * choose it ONLY once the exporter endpoint is re-pointed somewhere
   * approved, otherwise tool inputs/outputs leave via api.openai.com.
   */
  tracingExport?: 'disable' | 'keep'
}

/**
 * One-call setup: build a {@link Gate} (with a `GateClient` from the
 * environment when credentials allow — degrading to a client-less gate, Tier
 * B/A3 inactive, rather than throwing out of setup, same posture as dsh.ts's
 * `apply()`), `install()` it process-wide so every guardrail/wrapper in this
 * module picks it up, and close the tracing leak (unless `tracingExport:
 * 'keep'`). Returns the gate.
 *
 * Session id: one per PROCESS (`sessionId` option, else
 * `INTUTIC_SESSION_ID`, else a random UUID) — the SDK has no single "current
 * session" readable at install time; see dsh.ts's `resolveSessionId` for the
 * full rationale this mirrors.
 */
export function installOpenAiGate(config: OpenAiGateConfig = {}): Gate {
  if ((config.tracingExport ?? 'disable') === 'disable') {
    suppressAgentsTracingExport()
  }

  let client: GateClient | null
  try {
    client = GateClient.fromEnv({
      harness: 'openai-agents',
      sessionId: config.sessionId || process.env.INTUTIC_SESSION_ID || randomUUID(),
    })
  } catch {
    client = null
  }

  const gate = new Gate(config, client)
  install(gate)
  return gate
}
