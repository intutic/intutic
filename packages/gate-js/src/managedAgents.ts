/**
 * Anthropic Managed Agents (public beta since 2026-04-08) — a session
 * confirmation responder, plus guidance for the two execution surfaces this
 * adapter does NOT cover the same way.
 *
 * `@intutic/gate/managed-agents` — the TypeScript twin of the Python SDK's
 * `intutic_clawde.gate.adapters.managed_agents`. See that module's doc for
 * the full research trail; this header covers only what differs for the
 * TypeScript SDK.
 *
 * Managed Agents is architecturally different from every other adapter in
 * this package: the customer's process does not run the tool-call loop.
 * Anthropic hosts a "session" that emits an event stream, and the customer's
 * backend answers it. There is no local function call to wrap the way
 * `wrapTools()` wraps a Mastra tool.
 *
 * ## The veto mechanism — CONFIRMED against a real install
 *
 * `@anthropic-ai/sdk@0.117.1` (the latest published release at the time this
 * adapter was built) was installed as a devDependency of this package and its
 * shipped `.d.ts` read directly (not inferred from docs alone; the Python
 * twin was checked the same way against `anthropic==0.122.0`, its own
 * latest):
 *
 *   * `resources/beta/sessions/events.d.ts` — every request this module
 *     issues (`.list()`, `.send()`, `.stream()`) carries
 *     `anthropic-beta: managed-agents-2026-04-01` automatically (the real
 *     client sets it); {@link MANAGED_AGENTS_BETA} documents the value for a
 *     caller building a raw request.
 *   * `BetaManagedAgentsUserToolConfirmationEventParams` — the wire shape
 *     this module builds: `{ type: 'user.tool_confirmation', tool_use_id,
 *     result: 'allow' | 'deny', deny_message?, session_thread_id? }`.
 *   * `BetaManagedAgentsAgentToolUseEvent` and
 *     `BetaManagedAgentsAgentMCPToolUseEvent` both carry
 *     `evaluated_permission?: 'allow' | 'ask' | 'deny'`. A call the server
 *     evaluated to `'ask'` (e.g. because its `permission_policy` is
 *     `always_ask` — Anthropic's docs mark MCP toolsets as `always_ask` by
 *     default; the SDK types do not encode a default for built-in
 *     agent-toolset tools, so check current docs) PAUSES the session —
 *     Anthropic's own docs: "Denied tools do not run." A `'deny'` verdict
 *     means the SERVER already denied the call (no confirmation is expected
 *     or accepted); `'allow'` or unset means the call never paused at all.
 *     **This is the real, documented pre-execution veto this module answers
 *     — it is not observe-only.**
 *   * `lib/tools/SessionToolRunner.d.ts` is Anthropic's OWN reference
 *     dispatcher: it executes `agent.tool_use` / `agent.custom_tool_use`
 *     calls and posts results, but it does **not** decide `allow`/`deny` for
 *     an `ask`-gated call itself — it holds until *something* sends the
 *     matching `user.tool_confirmation` event. That "something" is what this
 *     module provides: {@link confirmationForEvent} /
 *     {@link IntuticSessionConfirmer} turn a paused `agent.tool_use` /
 *     `agent.mcp_tool_use` event into a `Gate.guard()`-driven verdict.
 *   * `lib/environments/worker.d.ts`'s `EnvironmentWorker` (the self-hosted
 *     sandbox driver) is built on `SessionToolRunner` for built-in
 *     agent-toolset tools (bash, edit, read, write, glob, grep, web_fetch,
 *     web_search). **Self-hosted built-in tools therefore pause and resolve
 *     through the IDENTICAL `agent.tool_use` / `evaluated_permission` /
 *     `user.tool_confirmation` mechanism as hosted ones** — this adapter
 *     covers them the same way. What differs for self-hosted is only WHERE
 *     the tool body executes (the customer's own worker process), not how
 *     the pre-execution veto works.
 *   * `agent.mcp_tool_use` is explicitly excluded from `SessionToolRunner`'s
 *     own dispatch (its own doc comment: "Server-side `agent.mcp_tool_use`
 *     calls are intentionally excluded — the runner does not handle them" —
 *     MCP tools run server-side at Anthropic). But the confirmation gate is a
 *     SEPARATE mechanism from execution: `BetaManagedAgentsAgentMCPToolUseEvent`
 *     carries `evaluated_permission` exactly like the built-in event does, so
 *     this module answers MCP pauses too, even though nothing in the official
 *     SDK dispatches their execution locally.
 *
 * ## What this module does NOT cover the same way — custom tools
 *
 * `BetaManagedAgentsAgentCustomToolUseEvent` has **no** `evaluated_permission`
 * field and no `permission_policy` concept at all: a custom tool always
 * executes wherever the client that owns its name is listening, with no
 * pause. It is answered with `user.custom_tool_result`
 * (`custom_tool_use_id` + `content` + `is_error`), not
 * `user.tool_confirmation`. This is the "customer's own process runs the
 * call" surface the phase brief anticipated — the natural integration point
 * IS this package's `wrapTools()`/`wrapTool()`, exactly as the brief
 * guessed. BUT verify the shape, because the generic helper does not apply
 * as-is: `BetaRunnableTool` (`lib/tools/BetaRunnableTool.d.ts`, what
 * `SessionToolRunner` dispatches against) exposes a `run(args, context)`
 * method, not the `execute(input)` method `wrapTools()`'s object branch looks
 * for (`wrapTools.ts` only recognises `.execute`) — handing it a
 * `BetaRunnableTool` throws a `TypeError` rather than silently skipping
 * governance, but it still means the generic helper needs a `.run`-aware
 * sibling rather than "just works". {@link wrapManagedAgentsCustomTool} /
 * {@link wrapManagedAgentsCustomTools} are that sibling — same throw-based
 * refusal contract, applied to `.run` instead of `.execute`.
 *
 * ## What this module does NOT cover at all — the sandbox tool BODY
 *
 * The self-hosted `EnvironmentWorker` gates tool PAUSES exactly like the
 * hosted path (see above) — but the tool's actual execution runs inside the
 * customer's own worker process, outside this adapter's reach, same as every
 * other Intutic adapter's posture toward a framework's built-in tool bodies
 * (see openai.ts's module doc for the precedent). This module governs
 * WHETHER the call runs; it does not — and cannot — inspect or modify what
 * the tool body does once allowed.
 *
 * ## Webhook vs. streamed/polled delivery — both are real, verified live
 *
 * `resources/beta/webhooks.d.ts`: `client.beta.webhooks.unwrap(body, {
 * headers, key })` verifies the HMAC signature and returns a typed event
 * (synchronously — no network call); for a pause it is
 * `session.requires_action`, which carries only `id` (the session id),
 * `organization_id`, `workspace_id` — NOT the tool call itself. A webhook is
 * therefore a NOTIFICATION to re-poll, not a self-contained payload —
 * {@link IntuticSessionConfirmer.handleWebhook} does exactly that: re-lists
 * the session's unanswered events and answers them. `events.stream()` /
 * `events.list()` are the poll/stream alternative this module also supports
 * directly via {@link IntuticSessionConfirmer.poll} /
 * {@link IntuticSessionConfirmer.watch}.
 *
 * ## Fail-closed posture
 *
 * Matches every other adapter in this package: no gate configured, or an
 * unexpected exception out of `Gate.guard()`, both produce a `'deny'` verdict
 * — never a silently-allowed, unevaluated call. Only `IntuticGateRefusal` is
 * distinguished (its own message becomes `deny_message`); anything else is
 * wrapped in a generic "gate crashed" `deny_message`.
 *
 * ## What this module does NOT import
 *
 * Deliberately no runtime dependency on `@anthropic-ai/sdk` — the types below
 * are narrow structural copies of only the shapes this adapter touches, same
 * policy as openai.ts / mastra.ts / vercel.ts (see openai.ts's module doc for
 * the full rationale). The real package is a devDependency used by
 * `__tests__/managedAgents.test.ts` to type-check these structural types
 * against the real shipped ones.
 *
 * @module
 */

import { Gate, active as activeGate } from './gate.js'
import type { ToolInput } from './gate.js'
import { IntuticGateRefusal } from './errors.js'

// ---------------------------------------------------------------------------
// Structural copies of the @anthropic-ai/sdk shapes this adapter touches.
// Confirmed field-for-field against @anthropic-ai/sdk@0.117.1's shipped
// resources/beta/sessions/events.d.ts (see module doc). This package does
// not depend on the SDK at runtime, so the shapes are declared here rather
// than imported.
// ---------------------------------------------------------------------------

/** The beta header every Sessions-API request needs. The real SDK sets this
 *  on every `.list()`/`.send()`/`.stream()` call automatically — this
 *  constant exists for callers building their own request against the
 *  endpoint directly. */
export const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01'

/** Slice of `BetaManagedAgentsAgentToolUseEvent` this module reads. */
export interface AgentToolUseEventLike {
  id: string
  type: 'agent.tool_use'
  name: string
  input: Record<string, unknown>
  evaluated_permission?: 'allow' | 'ask' | 'deny' | null
  session_thread_id?: string | null
}

/** Slice of `BetaManagedAgentsAgentMCPToolUseEvent` this module reads. */
export interface AgentMcpToolUseEventLike {
  id: string
  type: 'agent.mcp_tool_use'
  name: string
  mcp_server_name: string
  input: Record<string, unknown>
  evaluated_permission?: 'allow' | 'ask' | 'deny' | null
  session_thread_id?: string | null
}

/** Slice of `BetaManagedAgentsAgentCustomToolUseEvent` — carries no
 *  `evaluated_permission`: custom tools never pause (see module doc). */
export interface AgentCustomToolUseEventLike {
  id: string
  type: 'agent.custom_tool_use'
  name: string
  input: Record<string, unknown>
  session_thread_id?: string | null
}

/** Any session event — this module inspects only `.type` (and, for the
 *  confirmable two, the fields above) so a wider real event passes through
 *  this structural type untouched. */
export type ManagedAgentsSessionEventLike =
  | AgentToolUseEventLike
  | AgentMcpToolUseEventLike
  | AgentCustomToolUseEventLike
  | { id?: string; type: string; tool_use_id?: string; [key: string]: unknown }

/** Structural copy of `BetaManagedAgentsUserToolConfirmationEventParams` —
 *  exactly what this module sends via `events.send()`. */
export interface UserToolConfirmationParams {
  type: 'user.tool_confirmation'
  tool_use_id: string
  result: 'allow' | 'deny'
  deny_message?: string
  session_thread_id?: string
}

/** Structural slice of `client.beta.sessions.events` — only the three
 *  methods this module calls, positional-argument-compatible with the real
 *  SDK's `list(sessionID, params?, options?)` / `send(sessionID, params,
 *  options?)` / `stream(sessionID, params?, options?)`. */
export interface ManagedAgentsSessionEventsClientLike {
  list(
    sessionId: string,
    params?: { limit?: number; types?: string[] },
  ): AsyncIterable<ManagedAgentsSessionEventLike>
  send(
    sessionId: string,
    params: { events: UserToolConfirmationParams[] },
  ): Promise<unknown>
  stream(sessionId: string): Promise<AsyncIterable<ManagedAgentsSessionEventLike>>
}

/** Structural slice of the Anthropic client this module needs:
 *  `client.beta.sessions.events`. */
export interface ManagedAgentsClientLike {
  beta: {
    sessions: {
      events: ManagedAgentsSessionEventsClientLike
    }
  }
}

const CONFIRMABLE_EVENT_TYPES: ReadonlySet<string> = new Set(['agent.tool_use', 'agent.mcp_tool_use'])
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['session.status_terminated', 'session.deleted'])

/** Read a field off any session event by key, regardless of which member of
 *  {@link ManagedAgentsSessionEventLike} it structurally is — e.g.
 *  `tool_use_id`, which only `user.tool_confirmation` events carry. Mirrors
 *  the Python adapter's `_field` helper. */
function eventField(event: ManagedAgentsSessionEventLike, key: string): unknown {
  return (event as unknown as Record<string, unknown>)[key]
}

export interface ManagedAgentsWrapOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
}

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

function crashMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `[Intutic Governance] BLOCKED: gate crashed (${detail}) — failing closed rather than allowing an unevaluated call.`
}

/**
 * Build the `user.tool_confirmation` params answering `event`, or `null` if
 * `event` needs no answer from this module.
 *
 * `null` covers three cases, all correct to send nothing for: the event
 * isn't `agent.tool_use`/`agent.mcp_tool_use` (including
 * `agent.custom_tool_use` — see the module doc); its `evaluated_permission`
 * is `'allow'` or unset (the call never paused); or it is already `'deny'`
 * (the SERVER already resolved it — sending a confirmation for an id the
 * server considers closed would just error).
 *
 * Anything else — `'ask'`, or a permission value this module doesn't
 * recognise — is treated as a pause needing a verdict, matching
 * `SessionToolRunner`'s own fail-closed handling of unrecognised wire values
 * (hold/deny rather than dispatch).
 *
 * ASYNC: `Gate.guard()` is async in this package (unlike the Python SDK's
 * synchronous twin) — every caller must `await` this.
 */
export async function confirmationForEvent(
  event: ManagedAgentsSessionEventLike,
  opts: ManagedAgentsWrapOptions = {},
): Promise<UserToolConfirmationParams | null> {
  if (!CONFIRMABLE_EVENT_TYPES.has(event.type)) return null

  const typed = event as AgentToolUseEventLike | AgentMcpToolUseEventLike
  const permission = typed.evaluated_permission ?? null
  if (permission === null || permission === 'allow' || permission === 'deny') return null

  const eventId = typed.id
  if (!eventId) return null

  const toolName = typed.name || 'tool'
  const toolInput: ToolInput = { ...typed.input }
  if (typed.type === 'agent.mcp_tool_use' && typed.mcp_server_name) {
    if (!('mcp_server_name' in toolInput)) {
      toolInput.mcp_server_name = typed.mcp_server_name
    }
  }

  const result: UserToolConfirmationParams = {
    type: 'user.tool_confirmation',
    tool_use_id: eventId,
    result: 'allow',
  }
  if (typed.session_thread_id) {
    result.session_thread_id = typed.session_thread_id
  }

  let g: Gate
  try {
    g = resolveGate(opts.gate, 'confirmationForEvent()')
  } catch (err) {
    result.result = 'deny'
    result.deny_message = err instanceof Error ? `[Intutic Governance] BLOCKED: ${err.message}` : String(err)
    return result
  }

  try {
    await g.guard(toolName, toolInput)
  } catch (err) {
    result.result = 'deny'
    result.deny_message = err instanceof IntuticGateRefusal ? err.message : crashMessage(err)
  }
  return result
}

/**
 * Attaches Intutic governance to one Managed Agents session's confirmation
 * pauses.
 *
 * Duck-typed on `client`: only `client.beta.sessions.events.list(sessionId,
 * ...)`, `.send(sessionId, { events })`, and `.stream(sessionId)` are ever
 * called — pass a real `Anthropic` client, or a test double satisfying
 * {@link ManagedAgentsClientLike}.
 *
 * Usage — polling (e.g. right after creating a session, or from a
 * cron/worker loop):
 *
 * ```ts
 * import { Anthropic } from '@anthropic-ai/sdk'
 * import { Gate, install } from '@intutic/gate'
 * import { IntuticSessionConfirmer } from '@intutic/gate/managed-agents'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 * const client = new Anthropic()
 * const confirmer = new IntuticSessionConfirmer(client, session.id)
 * await confirmer.poll() // answers every currently-pending tool_use/mcp_tool_use pause
 * ```
 *
 * Usage — webhook (`session.requires_action`):
 *
 * ```ts
 * const event = client.beta.webhooks.unwrap(rawBody, { headers })
 * if (event.data.type === 'session.requires_action') {
 *   await new IntuticSessionConfirmer(client, event.data.id).poll()
 * }
 * ```
 *
 * Usage — live stream, single connection (see {@link watch}'s doc for why
 * this does not reconnect on its own):
 *
 * ```ts
 * for await (const sent of confirmer.watch()) {
 *   console.log(sent.tool_use_id, sent.result)
 * }
 * ```
 */
export class IntuticSessionConfirmer {
  readonly sessionId: string
  private readonly client: ManagedAgentsClientLike
  private readonly gate: Gate | undefined
  /** Tool-call event ids already answered (by this instance), so a `poll()`
   *  that overlaps a live `watch()` — or a re-delivered webhook — never
   *  double-sends a confirmation for the same id. */
  private readonly answered = new Set<string>()

  constructor(client: ManagedAgentsClientLike, sessionId: string, opts: ManagedAgentsWrapOptions = {}) {
    this.client = client
    this.sessionId = sessionId
    this.gate = opts.gate
  }

  private noteConfirmationEvent(event: ManagedAgentsSessionEventLike): void {
    const toolUseId = eventField(event, 'tool_use_id')
    if (typeof toolUseId === 'string' && toolUseId) this.answered.add(toolUseId)
  }

  /** Answer one event if it needs an answer; returns the sent params, or
   *  `null` if nothing was sent (already answered, or
   *  {@link confirmationForEvent} returned `null` — see its doc). */
  async handleEvent(event: ManagedAgentsSessionEventLike): Promise<UserToolConfirmationParams | null> {
    const eventId = event.id
    if (!eventId || this.answered.has(eventId)) return null
    const confirmation = await confirmationForEvent(event, { gate: this.gate })
    if (confirmation === null) return null
    await this.client.beta.sessions.events.send(this.sessionId, { events: [confirmation] })
    this.answered.add(eventId)
    return confirmation
  }

  /**
   * List recent events and answer every unanswered
   * `agent.tool_use`/`agent.mcp_tool_use` pause found. Returns the sent
   * confirmations, in event order.
   */
  async poll(opts: { limit?: number } = {}): Promise<UserToolConfirmationParams[]> {
    const sent: UserToolConfirmationParams[] = []
    const events = this.client.beta.sessions.events.list(this.sessionId, {
      limit: opts.limit ?? 1000,
      types: ['agent.tool_use', 'agent.mcp_tool_use', 'user.tool_confirmation'],
    })
    for await (const event of events) {
      if (event.type === 'user.tool_confirmation') {
        this.noteConfirmationEvent(event)
        continue
      }
      const confirmation = await this.handleEvent(event)
      if (confirmation !== null) sent.push(confirmation)
    }
    return sent
  }

  /**
   * Answer the pause a `session.requires_action` webhook signalled.
   *
   * `unwrapped` is what `client.beta.webhooks.unwrap(rawBody, { headers })`
   * returns (or its `.data`, or a plain object of the same shape). Anything
   * other than a `session.requires_action` payload is a no-op (`[]`): this
   * module only ever answers tool-confirmation pauses, so every other
   * webhook event type is intentionally ignored here.
   *
   * The webhook payload carries only the session id — it does NOT carry the
   * tool call itself — so this always falls through to a {@link poll}.
   */
  async handleWebhook(unwrapped: { data?: { type?: string; id?: string }; type?: string; id?: string }): Promise<
    UserToolConfirmationParams[]
  > {
    const data = unwrapped.data ?? unwrapped
    if (data.type !== 'session.requires_action') return []
    if (data.id !== undefined && data.id !== this.sessionId) {
      throw new Error(
        `webhook session id ${JSON.stringify(data.id)} does not match this confirmer's ` +
          `sessionId ${JSON.stringify(this.sessionId)}; construct a confirmer per session ` +
          'rather than reusing one across sessions',
      )
    }
    return this.poll()
  }

  /**
   * Catch up on anything already pending, then follow the live event
   * stream, yielding each confirmation as it is sent.
   *
   * Ends when the session terminates (`session.status_terminated` /
   * `session.deleted`) or the stream itself ends. Deliberately NOT a
   * production-grade reconnect loop the way `SessionToolRunner` is
   * (reconnect with capped backoff, idle watchdog, partial-fulfillment
   * bookkeeping — see that class's real implementation for the scope of
   * what a fully robust version would need): a dropped connection here
   * simply ends iteration. Wrap `watch()` in your own retry loop for a
   * long-running confirmer, or prefer `poll()` from a webhook/cron trigger,
   * which is naturally idempotent and needs no reconnect logic at all. See
   * TD-428.
   */
  async *watch(): AsyncGenerator<UserToolConfirmationParams> {
    for (const confirmation of await this.poll()) {
      yield confirmation
    }
    const stream = await this.client.beta.sessions.events.stream(this.sessionId)
    for await (const event of stream) {
      if (TERMINAL_EVENT_TYPES.has(event.type)) return
      if (event.type === 'user.tool_confirmation') {
        this.noteConfirmationEvent(event)
        continue
      }
      const confirmation = await this.handleEvent(event)
      if (confirmation !== null) yield confirmation
    }
  }
}

// ---------------------------------------------------------------------- custom tools

/** Structural slice of `BetaRunnableTool` — the shape
 *  `SessionToolRunner`/`EnvironmentWorker` dispatch custom tools against
 *  (`lib/tools/BetaRunnableTool.d.ts`). Note the method is `run`, not
 *  `execute` — the reason `wrapTools()`'s generic object branch cannot be
 *  used as-is here (see module doc). */
export interface ManagedAgentsRunnableToolLike {
  name: string
  run: (args: Record<string, unknown>, context?: unknown) => unknown
  [key: string]: unknown
}

const CUSTOM_TOOL_GUARDED = Symbol.for('intutic.gate.managedAgents.customToolGuarded')

/**
 * Wrap one Managed Agents custom tool (`BetaRunnableTool` shape) so
 * `Gate.guard()` runs before `run()` executes.
 *
 * Returns a NEW object (a shallow copy with `run` replaced); does not mutate
 * the one passed in. On refusal the wrapped `run()` THROWS
 * `IntuticGateRefusal` before the real implementation ever runs — the same
 * throw-based contract `wrapTool()` uses. Already-wrapped tools pass through
 * unchanged.
 */
export function wrapManagedAgentsCustomTool<T extends ManagedAgentsRunnableToolLike>(
  tool: T,
  opts: ManagedAgentsWrapOptions = {},
): T {
  const marked = tool as T & Record<symbol, unknown>
  if (marked[CUSTOM_TOOL_GUARDED] === true) return tool

  const originalRun = tool.run
  const toolName = tool.name || 'tool'
  const guardedRun = async (args: Record<string, unknown>, context?: unknown) => {
    const g = resolveGate(opts.gate, 'wrapManagedAgentsCustomTool()')
    await g.guard(toolName, args ?? {})
    return originalRun.call(tool, args, context)
  }

  const wrapped: T = { ...tool, run: guardedRun }
  Object.defineProperty(wrapped, CUSTOM_TOOL_GUARDED, { value: true, enumerable: false })
  return wrapped
}

/** Wrap a collection of Managed Agents custom tools in one call — see
 *  {@link wrapManagedAgentsCustomTool}. */
export function wrapManagedAgentsCustomTools<T extends ManagedAgentsRunnableToolLike>(
  tools: readonly T[],
  opts: ManagedAgentsWrapOptions = {},
): T[] {
  return tools.map((t) => wrapManagedAgentsCustomTool(t, opts))
}
