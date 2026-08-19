/**
 * Vercel AI SDK adapter: `intuticToolApproval()` and `withIntuticProxy()`.
 *
 * `@intutic/gate/vercel` — a framework-specific specialization of the same
 * idea `wrapTools.ts` implements generically (see that file's module doc):
 * wrap the framework's own veto point around this package's `Gate.guard()`.
 *
 * The `ai` package (v6+) exposes a documented pre-execution veto point: a
 * `toolApproval` callback accepted by `generateText`/`streamText` and
 * `ToolLoopAgent`. It runs once per tool call, before execution, and its
 * return value decides whether the call proceeds.
 *
 * ## Confirmed against a real install
 *
 * `ai@7.0.68` + `@ai-sdk/openai@4.0.43` were installed in a scratch directory
 * and `node_modules/ai/dist/index.d.ts` read directly (not inferred from
 * docs alone). The relevant types:
 *
 * ```ts
 * type ToolApprovalStatus =
 *   | undefined | 'not-applicable' | 'approved' | 'denied' | 'user-approval'
 *   | { type: 'not-applicable'; reason?: never }
 *   | { type: 'approved'; reason?: string }
 *   | { type: 'denied'; reason?: string }
 *   | { type: 'user-approval'; reason?: never }
 *
 * type GenericToolApprovalFunction<TOOLS, TOOLS_CONTEXT, RUNTIME_CONTEXT> = (options: {
 *   toolCall: TypedToolCall<TOOLS>        // { toolName: string; input: ... ; ... }
 *   tools: TOOLS | undefined
 *   toolsContext: TOOLS_CONTEXT
 *   runtimeContext: RUNTIME_CONTEXT
 *   messages: ModelMessage[]
 * }) => MaybePromiseLike<ToolApprovalStatus>
 *
 * type ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> =
 *   GenericToolApprovalFunction<...> | { [toolName]?: ToolApprovalStatus | SingleToolApprovalFunction<...> }
 * ```
 * (`generateText`/`streamText`/`ToolLoopAgent` all accept
 * `toolApproval?: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT>`.)
 *
 * `'not-applicable'` (also spelled `{ type: 'not-applicable' }`, and
 * `undefined` is treated the same) means "this gate has no opinion, proceed
 * normally" — exactly matching the plan's description. `'denied'` (or
 * `{ type: 'denied', reason }`) vetoes the call before execution; the SDK
 * hands `reason` back to the model in place of a tool result. This adapter
 * implements `GenericToolApprovalFunction`, the whole-config form (not the
 * per-tool-keyed form), so a single `intuticToolApproval()` call covers every
 * tool in `tools`.
 *
 * ## Known, documented limitation — no env-var LLM routing
 *
 * Unlike almost every other harness in this codebase (which honour
 * `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` or an equivalent), the Vercel AI SDK
 * has NO environment-variable-based base-URL override mechanism. Routing LLM
 * traffic through the Intutic proxy requires IN-CODE provider construction —
 * `createOpenAI({ baseURL })`, `createGateway({ baseURL })`, etc. — not a
 * sourced `.env.intutic` file the way `langchainAdapter`/`langgraphAdapter`
 * and the rest of the SDK-gated family work. `withIntuticProxy()` below is a
 * small factory wrapper for that in-code construction; it does not — and
 * cannot — make this "zero-code" the way an env-var-honouring harness's
 * integration correctly can claim to be. See
 * `apps/docs/integrations/vercel-ai-sdk.md` for the operator-facing version
 * of this same limitation, stated plainly rather than oversold.
 */

import { active as activeGate, type Gate } from './gate.js'
import { IntuticGateRefusal } from './errors.js'

/** Structural copy of `ai`'s `ToolApprovalStatus` — this package does not
 *  depend on `ai` at runtime, so the shape is declared here rather than
 *  imported. Confirmed field-for-field against `ai@7.0.68`'s
 *  `dist/index.d.ts` (see module doc). */
export type VercelToolApprovalStatus =
  | undefined
  | 'not-applicable'
  | 'approved'
  | 'denied'
  | 'user-approval'
  | { type: 'not-applicable'; reason?: undefined }
  | { type: 'approved'; reason?: string }
  | { type: 'denied'; reason?: string }
  | { type: 'user-approval'; reason?: undefined }

/** Structural copy of `ai`'s `TypedToolCall` — the fields this adapter
 *  actually reads (`toolName`, `input`); the real type carries more. */
export interface VercelToolCall {
  toolName: string
  input: unknown
}

/** Structural copy of the options object `ai`'s `GenericToolApprovalFunction`
 *  receives — the whole-config form of `toolApproval` accepted by
 *  `generateText`/`streamText`/`ToolLoopAgent`. Only `toolCall` is read here;
 *  the rest pass through the structural type so this function is assignable
 *  to the real (wider) signature. */
export interface VercelToolApprovalOptions {
  toolCall: VercelToolCall
  [key: string]: unknown
}

/** Structural copy of `ai`'s `GenericToolApprovalFunction` — the exact shape
 *  `toolApproval` expects. */
export type VercelToolApproval = (
  options: VercelToolApprovalOptions,
) => Promise<VercelToolApprovalStatus>

export interface IntuticToolApprovalOptions {
  /** Overrides the process-wide installed gate (`install(new Gate(...))`). */
  gate?: Gate
}

/**
 * Builds a `toolApproval` callback matching `ai`'s `GenericToolApprovalFunction`
 * signature, for direct use on `generateText`/`streamText`/`ToolLoopAgent`:
 *
 * ```ts
 * import { generateText } from 'ai'
 * import { Gate, install } from '@intutic/gate'
 * import { intuticToolApproval } from '@intutic/gate/vercel'
 *
 * install(new Gate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID }))
 *
 * await generateText({
 *   model,
 *   tools,
 *   toolApproval: intuticToolApproval(),
 * })
 * ```
 *
 * Resolves to `'not-applicable'` on allow (this gate has no opinion; any
 * other approval mechanism the caller has configured still applies) and to
 * `{ type: 'denied', reason }` on refusal — `reason` is the
 * `[Intutic Governance] BLOCKED: ...` message, handed back to the model in
 * place of a tool result.
 *
 * Requires a `Gate` — either passed via `{ gate }` here, or installed
 * process-wide with `install(new Gate(...))`. A call with neither throws,
 * refusing to run the tool unguarded rather than silently skipping
 * enforcement — same posture as `wrapTool`/`intuticHooks`.
 */
export function intuticToolApproval(opts: IntuticToolApprovalOptions = {}): VercelToolApproval {
  return async ({ toolCall }) => {
    const g = opts.gate ?? activeGate()
    if (g === null) {
      throw new Error(
        'No gate configured: call install(new Gate(...)) from @intutic/gate, or pass ' +
          '{ gate } to intuticToolApproval(). Refusing to run the tool unguarded.',
      )
    }
    try {
      await g.guard(toolCall.toolName, (toolCall.input ?? {}) as Record<string, unknown>)
      return 'not-applicable'
    } catch (exc) {
      if (exc instanceof IntuticGateRefusal) {
        return { type: 'denied', reason: exc.message }
      }
      throw exc
    }
  }
}

/**
 * Resolves the Intutic proxy URL the same way the rest of this codebase does
 * — `INTUTIC_PROXY_URL`, falling back to the local default every CLI command
 * and env-writer here shares (`tools/cli/src/commands/exec.ts`,
 * `tools/cli/src/lib/onboarding.ts`, `services/sync-daemon/src/agentReporter.ts`).
 * Not re-hardcoded per call site — one resolution rule, reused.
 */
export function intuticProxyUrl(): string {
  return process.env.INTUTIC_PROXY_URL || 'http://localhost:4000'
}

/**
 * Wraps a provider-constructing function so it points at the Intutic proxy.
 *
 * The Vercel AI SDK has no env-var base-URL override (see module doc), so
 * routing LLM traffic through the proxy is IN-CODE: pass the provider
 * factory you would otherwise call directly (`createOpenAI`, `createGateway`,
 * any `@ai-sdk/*` `create*` export or compatible custom factory that accepts
 * a `{ baseURL }`-shaped options object) and get back one pre-configured to
 * call the proxy instead of the provider's real endpoint:
 *
 * ```ts
 * import { createOpenAI } from '@ai-sdk/openai'
 * import { withIntuticProxy } from '@intutic/gate/vercel'
 *
 * const openai = withIntuticProxy(createOpenAI)({ apiKey: process.env.OPENAI_API_KEY })
 * const model = openai('gpt-5-mini')
 * ```
 *
 * `baseUrl` overrides the resolved proxy URL (see {@link intuticProxyUrl});
 * omit it to use `INTUTIC_PROXY_URL`/the local default, same as every other
 * harness in this codebase.
 *
 * This does NOT make Vercel AI SDK integration "zero-code": every provider
 * construction call site in the caller's application must go through this
 * wrapper (or otherwise set `baseURL` itself) for LLM egress to be governed
 * — there is no ambient env var this package (or any other) can set to
 * achieve the same effect for this framework.
 */
export function withIntuticProxy<
  TOptions extends { baseURL?: string },
  TProvider,
>(providerFactory: (options: TOptions) => TProvider, baseUrl?: string): (options: TOptions) => TProvider {
  const url = baseUrl ?? intuticProxyUrl()
  return (options: TOptions): TProvider => providerFactory({ ...options, baseURL: url })
}
