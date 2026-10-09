/**
 * proxy.ts — McpGovernanceProxy: transparent stdio MCP proxy with governance interception.
 *
 * Architecture (proxy mode):
 *   Harness stdin → [McpGovernanceProxy] → real MCP server stdin
 *   Real MCP server stdout → [McpGovernanceProxy] → Harness stdout
 *
 * Architecture (standalone mode — the `intutic` harness entry):
 *   Harness ↔ [McpGovernanceProxy as MCP Server] ↔ Control Plane REST API
 *   Exposes governance tools: intutic_governance_status, intutic_list_sops, intutic_list_incidents,
 *   intutic_hold_status, intutic_mcp_registry_status, intutic_mcp_budget_remaining.
 *
 * Architecture (remote bridge mode — `--remote-url`, see remoteBridge.ts):
 *   Harness stdin → [McpGovernanceProxy] → remote MCP server (HTTP/SSE)
 *   Remote MCP server → [McpGovernanceProxy] → Harness stdout
 *   The harness still spawns this proxy as an ordinary stdio child process —
 *   only the UPSTREAM side changes, from a spawned child's stdin/stdout to an
 *   MCP SDK client transport talking HTTP/SSE. `handleHarnessLine` (request
 *   direction) and `handleServerLine` (response direction) are the exact same
 *   functions proxy mode uses; remoteBridge.ts only supplies a different
 *   upstream and a different `forward`.
 *
 * CRITICAL: Never write to process.stdout except for valid JSON-RPC frames.
 *           All logging MUST go to process.stderr via @intutic/logger.
 *
 * JSON-RPC framing: newline-delimited JSON (one JSON object per line).
 *
 * @module
 */

import * as node_child from 'node:child_process'
import * as node_readline from 'node:readline'
import { createStderrLogger as createLogger } from './stderrLog.js'
import type { ProxyConfig } from './config.js'
import { PolicyClient } from './policy.js'
import { GovernanceEmitter, detectionFinding } from './emitter.js'
import { ToolCallInterceptor, type Block } from './interceptor.js'
import { budgetRemaining, describeFailure, holdStatus, readControlPlane, registryStatus } from './agentTools.js'
import type { RefusalData } from './refusals.js'
import { redactText as redactMcpText, setWorkspacePii } from './dlp.js'
import { scanText, injectionSeverity, setDynamicInjectionPatterns, type InjectionSource } from './injection.js'
import { toolPoisoning, dlpEscalation, type AnomalyFinding } from './anomaly/index.js'
import { SessionState } from './session.js'
import { ValkeySessionStore, type SharedSessionStore } from './sessionStore.js'
import { GuardedValkey } from './guardedValkey.js'
import { McpBudgetEnforcer, ValkeyBudgetStore } from './budget.js'
import { WasmRunner } from './wasm/runner.js'
import { checkTofu, decideTofuAction } from './tofu.js'
import { RegistryObserver } from './registryObserver.js'
import { ApprovalHolds } from './approvalHold.js'
import { callerIdentity, type CallerIdentity } from './identity.js'
import { normalizeToolDefinition, type McpToolDefinition } from '@intutic/shared-types'
import { PACKAGE_VERSION } from './version.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { watchWasmDir, type WasmDirWatcher } from './wasm/watch.js'

const log = createLogger('mcp-governance-proxy')

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolsCallParams {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Build a JSON-RPC 2.0 error response for a blocked tool call. `data` names
 * the refusal for a client that reads it programmatically (refusals.ts).
 */
function buildBlockResponse(id: string | number | null, reason: string, data: RefusalData): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603, // Internal error (closest standard code to "blocked")
      message: `[Intutic Governance] Tool call blocked: ${reason}`,
      data,
    },
  }
}

/** The `error.data` of a block decision: its code, rule id and detail. */
function blockData(decision: Block): RefusalData {
  return { code: decision.code, ruleId: decision.ruleId, ...decision.detail }
}

/**
 * The JSON-RPC error for a call held for approval. Same code as a block (the
 * call did not run), a message that says "held" rather than "blocked", and
 * the hold id in `data` for a client that reads it programmatically — empty
 * when the hold could not be recorded, so there is nothing to approve yet.
 */
function buildHoldResponse(id: string | number | null, reason: string, holdId: string, ruleId: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message: `[Intutic Governance] Tool call ${reason}`,
      data: { code: 'HELD', ruleId, status: 'pending_approval', holdId } satisfies RefusalData,
    },
  }
}

/**
 * Who a per-member MCP budget counts when the control plane has not named the
 * member behind this proxy's key: the key's prefix, else the OS user. Callers
 * with neither share one allowance.
 */
export function fallbackBudgetCaller(identity: CallerIdentity): string {
  if (identity.apiKeyPrefix) return `key:${identity.apiKeyPrefix}`
  if (identity.osUser) return `os:${identity.osUser}`
  return 'unknown'
}

/**
 * Write a JSON-RPC frame to stdout (the ONLY valid place to write in a stdio MCP proxy).
 */
function writeFrame(frame: unknown): void {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

/** What the harness asked for under a given request id, awaiting its response. */
export interface PendingRequest {
  method: 'tools/call' | 'tools/list' | 'resources/read'
  toolName?: string
}

/** The outcome of inspecting one server→harness line. */
export interface ServerLineOutcome {
  /** The line to forward — possibly rewritten. */
  line: string
  /** Set when result content was redacted: the tool (or resource) it came from. */
  redactedTool?: string
  /** Pattern descriptions redacted out of the result. */
  redactions?: string[]
  /** Set when a tools/list response was filtered or had descriptions overridden. */
  curated?: { hidden: number; overridden: number }
  /**
   * The (post-curation) tool array, set whenever this line was a `tools/list`
   * response — regardless of whether curation changed anything — so the
   * caller can run TOFU pinning (tofu.ts) over it. `undefined` for every
   * other line.
   */
  toolsListTools?: Array<Record<string, unknown>>
  /**
   * Every tool the upstream server declared, as it declared them — before
   * curation hid any or an override rewrote a description. Set alongside
   * `toolsListTools`; the registry gets these.
   */
  toolsListUpstream?: McpToolDefinition[]
  /** The JSON-RPC id of the `tools/list` response, needed to build a block
   *  frame in the caller if TOFU refuses it. Set alongside `toolsListTools`. */
  toolsListMsgId?: string | number | null
  /**
   * Prompt-injection findings (injection.ts) from this line, one entry per
   * scanned surface that matched — a `tools/call`/`resources/read` result
   * (`tool_result`) yields at most one entry; a `tools/list` response can
   * yield one per tool whose (post-curation) description matched. The
   * caller (`handleServerLine`) emits `injection_detected` (and, on a
   * response-direction block, `tool_blocked`) from these — `processServerLine`
   * itself stays a pure function with no emitter access, the same reason
   * `redactedTool`/`redactions` exist as outcome fields rather than emitting
   * directly.
   */
  injectionFindings?: Array<{ source: InjectionSource; toolName: string; patterns: string[] }>
  /**
   * Set when a response-direction injection match, under `mcpInjectionAction:
   * 'block'`, caused `line` to carry a withheld-result error frame instead of
   * the real result — mirrors `redactedTool` for the injection path, so the
   * caller can log/emit the block distinctly from a plain redaction.
   */
  injectionBlocked?: boolean
  /**
   * Phase 2's `dlp_escalation` finding (anomaly/detectors.ts), set when a
   * `tools/call`/`resources/read` result carried ≥3 distinct DLP-redacted
   * pattern types. Severity-escalation only — see `dlpEscalation`'s own doc
   * comment for why this never becomes a NEW block: the content is already
   * redacted (`redactions` above), and this proxy's DLP scan already blocks
   * any request-direction finding unconditionally, so escalating an
   * already-redacted RESPONSE protects nothing further.
   */
  dlpEscalation?: AnomalyFinding
  /**
   * Phase 2's `tool_poisoning` finding (anomaly/detectors.ts), set on a
   * `tools/list` response whose post-curation tool descriptions matched
   * `toolPoison.ts`'s 7-pattern scanner. Report-only, same as
   * `injectionFindings` on this same response type — never removes or
   * blocks a listing.
   */
  toolPoisoning?: AnomalyFinding
}

/**
 * Inspect one line of real-server output before it reaches the harness.
 *
 * This is the seam the byte-for-byte pipe never had: the request direction has
 * been scanned since the interceptor existed, while the real server's stdout —
 * tool results, resource reads, every tools/list — streamed into the agent's
 * context untouched. A result carrying a credential put it straight into
 * model-visible context; a `redact` Decision variant and a `tool_redacted`
 * event existed as declared types with no producer. This function is the
 * producer.
 *
 * Redaction, not blocking, on results: the call already executed, so refusing
 * the response protects nothing — keeping the secret out of the agent's
 * context is the only thing still at stake. If the redacted result no longer
 * parses (a secret that spanned JSON syntax), the whole result is withheld
 * and replaced with an error naming why — forwarding either the original or
 * a broken body would be worse, the same fail-closed reparse rule the Rust
 * proxy applies to non-streaming bodies.
 *
 * tools/list curation (the Uber-gateway mechanism): when the workspace
 * declares an additive allowlist, tools outside it are removed from the
 * listing, as are tools the registry disables on this server — an agent that never sees a tool does not hallucinate calls to
 * it, and the call-time block in the interceptor stays as the enforcement
 * backstop. Operator description overrides apply to what remains, which is
 * also the counter to a poisoned upstream description — the pin detects the
 * change; the override controls what the agent actually reads.
 */
export function processServerLine(
  raw: string,
  pending: Map<string | number, PendingRequest>,
  allowedTools: readonly string[],
  overrides: Readonly<Record<string, string>>,
  injectionAction: 'warn' | 'block' = 'warn',
  injectionPatterns: readonly string[] = [],
  disabledTools: readonly string[] = [],
): ServerLineOutcome {
  // Workspace-supplied injection patterns (TD-436), on top of the floor.
  // Idempotent when the list has not changed, so this is cheap per line.
  setDynamicInjectionPatterns(injectionPatterns)
  const trimmed = raw.trim()
  if (!trimmed) return { line: raw }
  let msg: JsonRpcResponse & { result?: Record<string, unknown> }
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return { line: raw } // not JSON-RPC (or partial) — forward untouched
  }
  if (msg.id === undefined || msg.id === null) return { line: raw } // notification
  const req = pending.get(msg.id)
  if (!req) return { line: raw }
  pending.delete(msg.id)
  if (!msg.result || typeof msg.result !== 'object') return { line: raw }

  if (req.method === 'tools/call' || req.method === 'resources/read') {
    const serialized = JSON.stringify(msg.result)
    const { redacted, findings } = redactMcpText(serialized)
    const label = req.toolName ?? req.method

    // DLP redaction runs FIRST — a secret must never reach the injection
    // scanner (or anything downstream of it) unredacted. If a match spans
    // JSON syntax and the redacted text no longer parses, this withholds the
    // whole result exactly as before Phase 1 existed; the injection scanner
    // never sees a body that DLP already decided to withhold.
    let resultText = serialized
    let resultObj: Record<string, unknown> = msg.result
    let redactedTool: string | undefined
    let redactions: string[] | undefined
    if (findings.length > 0) {
      redactedTool = label
      redactions = findings.map((f) => f.description)
      try {
        resultObj = JSON.parse(redacted) as Record<string, unknown>
        resultText = redacted
      } catch {
        const withheld: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message:
              `[Intutic Governance] Result withheld: it contained sensitive data ` +
              `whose redaction did not survive re-parsing. The tool ran; its output ` +
              `was not delivered. (${findings.map((f) => f.description).join('; ')})`,
            data: { code: 'RESULT_WITHHELD_DLP', ruleId: `dlp.${findings[0]?.pattern ?? 'output'}` } satisfies RefusalData,
          },
        }
        return { line: JSON.stringify(withheld), redactedTool, redactions }
      }
    }

    // Injection scan — response direction. Runs on the (already
    // DLP-redacted, if applicable) result text: a tool result or
    // resources/read body is exactly the "one node's output becomes the
    // next node's input" untrusted-content case injection.rs's module doc
    // describes.
    const injectionPatterns = scanText(resultText)
    let injectionFindings: ServerLineOutcome['injectionFindings']
    if (injectionPatterns.length > 0) {
      injectionFindings = [{ source: 'tool_result', toolName: label, patterns: injectionPatterns }]
      if (injectionAction === 'block') {
        // Response-side block never claims the CALL was refused — it
        // already ran. Only the delivered output is withheld, worded the
        // same way the DLP reparse-withheld frame above is.
        const withheldInjection: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message:
              `[Intutic Governance] Result withheld: it triggered prompt-injection ` +
              `pattern(s) (${injectionPatterns.join(', ')}). The tool call already ran; ` +
              `its output was not delivered.`,
            data: { code: 'RESULT_WITHHELD_INJECTION', ruleId: 'injection.tool_result' } satisfies RefusalData,
          },
        }
        return {
          line: JSON.stringify(withheldInjection),
          redactedTool,
          redactions,
          injectionFindings,
          injectionBlocked: true,
        }
      }
      // 'warn' (default): report only, fall through and deliver the result.
    }

    // Phase 2's dlp_escalation: ≥3 distinct DLP-redacted pattern types in
    // this one response is a credential sweep, not a single mistake — see
    // `dlpEscalation`'s own doc comment for why this only escalates the
    // event severity below and never gates a new block.
    const dlpEscalationFinding = redactions ? dlpEscalation(redactions) : null

    if (findings.length === 0 && injectionFindings === undefined && !dlpEscalationFinding) return { line: raw }

    msg.result = resultObj
    return {
      line: JSON.stringify(msg),
      redactedTool,
      redactions,
      injectionFindings,
      dlpEscalation: dlpEscalationFinding ?? undefined,
    }
  }

  if (req.method === 'tools/list') {
    const tools = msg.result['tools']
    if (!Array.isArray(tools)) return { line: raw }
    let hidden = 0
    let overridden = 0
    // Copied before the overrides below rewrite descriptions in place.
    const upstream = tools
      .map(normalizeToolDefinition)
      .filter((t): t is McpToolDefinition => t !== null)
    let kept = tools as Array<Record<string, unknown>>
    if (allowedTools.length > 0 || disabledTools.length > 0) {
      kept = kept.filter((t) => {
        const name = t['name']
        const keep =
          typeof name === 'string' &&
          (allowedTools.length === 0 || allowedTools.includes(name)) &&
          !disabledTools.includes(name)
        if (!keep) hidden += 1
        return keep
      })
    }
    for (const t of kept) {
      const name = t['name']
      if (typeof name === 'string' && overrides[name] !== undefined) {
        t['description'] = overrides[name]
        overridden += 1
      }
    }

    // Injection scan — tool descriptions, POST-curation (after allowlist
    // filtering and operator overrides above, so a description an operator
    // already replaced is scanned as what the agent will actually read, not
    // as the upstream server's original text). Report-only in v1: curation
    // and TOFU already govern what the agent sees in a tools/list response,
    // so a description match here never removes or blocks a listing — it
    // only produces an `injection_detected` event for the caller to emit.
    let injectionFindings: ServerLineOutcome['injectionFindings']
    for (const t of kept) {
      const name = t['name']
      const description = t['description']
      if (typeof name !== 'string' || typeof description !== 'string') continue
        const patterns = scanText(description)
      if (patterns.length === 0) continue
      injectionFindings ??= []
      injectionFindings.push({ source: 'tool_description', toolName: name, patterns })
    }

    // Phase 2's tool_poisoning — same post-curation tool set the injection
    // scan just ran over, a different pattern set (toolPoison.ts's 7
    // description-poisoning patterns, tuned for documentation-shaped
    // payloads rather than conversational jailbreak phrasing).
    const toolPoisoningFinding = toolPoisoning(
      kept
        .filter((t): t is Record<string, unknown> & { name: string } => typeof t['name'] === 'string')
        .map((t) => ({ name: t['name'], description: typeof t['description'] === 'string' ? t['description'] : undefined })),
    )

    // toolsListTools/toolsListMsgId are set on EVERY tools/list response,
    // curated or not — TOFU pinning (tofu.ts) needs the full post-curation
    // tool set regardless of whether allowlist filtering or description
    // overrides touched it this time.
    if (hidden === 0 && overridden === 0) {
      return {
        line: raw,
        toolsListTools: kept,
        toolsListUpstream: upstream,
        toolsListMsgId: msg.id,
        injectionFindings,
        toolPoisoning: toolPoisoningFinding ?? undefined,
      }
    }
    msg.result['tools'] = kept
    return {
      line: JSON.stringify(msg),
      curated: { hidden, overridden },
      toolsListTools: kept,
      toolsListUpstream: upstream,
      toolsListMsgId: msg.id,
      injectionFindings,
      toolPoisoning: toolPoisoningFinding ?? undefined,
    }
  }

  return { line: raw }
}

/**
 * Handle one harness→upstream line — shared, byte-for-byte, between stdio
 * proxy mode (`McpGovernanceProxy.runProxy`, below) and the remote HTTP/SSE
 * bridge (`remoteBridge.ts`'s `runRemoteProxy`): parse JSON-RPC, register any
 * `tools/list`/`resources/read` request so its response gets inspected on the
 * way back (see `processServerLine`), and run every `tools/call` through the
 * SAME `interceptor.decide()` call this proxy has always used. `forward` is
 * the ONLY thing that differs by upstream transport — stdio mode writes to
 * the spawned child process's stdin, remote bridge mode calls the MCP SDK
 * transport's `send()` — so pulling it out as a parameter, rather than
 * forking this whole function, is what keeps governance identical across
 * both upstream transports instead of two copies that could quietly drift.
 *
 * A free function (like `processServerLine`), not a class method, precisely
 * so `remoteBridge.ts` can call it without needing a `McpGovernanceProxy`
 * instance shaped for the stdio child-process lifecycle it doesn't have.
 */
export function handleHarnessLine(
  line: string,
  pending: Map<string | number, PendingRequest>,
  interceptor: ToolCallInterceptor,
  forward: (line: string) => void,
  session?: SessionState,
): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg: JsonRpcRequest
  try {
    msg = JSON.parse(trimmed) as JsonRpcRequest
  } catch {
    log.warn({ action: 'parse_error', line: trimmed.slice(0, 100) }, 'Failed to parse JSON-RPC line')
    return
  }

  // Register responses that need inspecting on the way back.
  if (msg.id !== null && msg.id !== undefined) {
    if (msg.method === 'tools/list') {
      pending.set(msg.id, { method: 'tools/list' })
    } else if (msg.method === 'resources/read') {
      pending.set(msg.id, { method: 'resources/read' })
    }
  }

  // Intercept tools/call
  if (msg.method === 'tools/call') {
    const params = msg.params as McpToolsCallParams | undefined
    const toolName = params?.name ?? '<unknown>'
    const toolInput = params?.arguments ?? {}

    // Run governance check asynchronously
    interceptor.decide(toolName, toolInput).then((decision) => {
      if (decision.action === 'block') {
        log.warn(
          { action: 'tool_blocked', toolName, reason: decision.reason },
          'Tool call blocked by governance proxy'
        )
        writeFrame(buildBlockResponse(msg.id, decision.reason, blockData(decision)))
      } else if (decision.action === 'hold') {
        writeFrame(buildHoldResponse(msg.id, decision.reason, decision.holdId, decision.ruleId))
      } else {
        // Allow: the response now needs inspecting on the way back —
        // registered BEFORE forwarding, or a fast server could answer
        // into the gap.
        if (msg.id !== null && msg.id !== undefined) {
          pending.set(msg.id, { method: 'tools/call', toolName })
        }
        // Phase 2: record into the session's rolling tool-call sequence only
        // NOW that the call is actually allowed — a blocked call must not
        // count toward consecutive_repeat/ping_pong_cycle/landmark_cycle/
        // tool_diversity_collapse, or an agent could be penalized for calls
        // that never ran.
        session?.recordCall(toolName)
        forward(line)
      }
    }).catch((err) => {
      // Governance check failed — fail-open: forward to real server
      log.error({ action: 'interceptor_error', err: (err as Error).message }, 'Interceptor error — failing open')
      forward(line)
    })
  } else {
    // Non-tools/call messages pass through immediately
    forward(line)
  }
}

export class McpGovernanceProxy {
  private readonly policy: PolicyClient
  private readonly emitter: GovernanceEmitter
  private readonly interceptor: ToolCallInterceptor
  /**
   * Phase 2's session state — the tool-call sequence and per-detector reask
   * counters. ONE instance per proxy process, shared with the interceptor
   * (for detection + reask counting), `handleHarnessLine` (for post-decision
   * recording), and this class's own `handleServerLine` (for caching the
   * post-curation tools/list the tool_poisoning detector reads). Since Wave
   * 5.3 (TD-437) it is also shared ACROSS the session's sibling proxy
   * processes through `sessionStore` when a Valkey URL is configured — see
   * session.ts's module doc.
   */
  private readonly session: SessionState
  /**
   * The process's one Valkey connection, when `config.valkeyUrl` is set and
   * this is not the standalone entry: the shared session window and the MCP
   * call budgets both use it.
   */
  private readonly valkey: GuardedValkey | undefined
  /** The Valkey-backed shared window, on {@link valkey}. */
  private readonly sessionStore: SharedSessionStore | undefined
  /**
   * Phase 3's WASM custom-rule runner — owns the one dedicated
   * `worker_threads` Worker and the `~/.intutic/wasm/` directory loader.
   * Rescanned on the SAME 60s policy-tick timer `PolicyClient.start` already
   * runs, not a second one (see `policy.ts`'s `start(onTick)`).
   */
  private readonly wasmRunner: WasmRunner
  /** Reports this proxy's server to the registry; absent for the standalone `intutic` entry, which fronts none. */
  private readonly registryObserver: RegistryObserver | undefined
  private realServer: node_child.ChildProcess | null = null

  constructor(private readonly config: ProxyConfig) {
    this.policy = new PolicyClient(
      config.controlPlaneUrl,
      config.apiKey,
      config.workspaceId,
      config.policyTtlMs,
      config.mcpProxyMode
    )

    const identity = callerIdentity(config.apiKey, config.serverName, config.sessionScope)
    this.emitter = new GovernanceEmitter(
      config.controlPlaneUrl,
      config.apiKey,
      config.eventsFilePath,
      config.workspaceId,
      config.mcpProxyMode,
      identity,
    )

    this.valkey = config.valkeyUrl ? new GuardedValkey(config.valkeyUrl) : undefined
    // The standalone `intutic` entry fronts no real server and records no
    // calls worth sharing; it reads Valkey only for the budget counters its
    // `intutic_mcp_budget_remaining` tool reports. Every wrapped server gets
    // the shared window.
    this.sessionStore = this.valkey && !config.standalone ? new ValkeySessionStore(this.valkey) : undefined
    this.session = new SessionState({ scope: config.sessionScope, store: this.sessionStore })
    log.info(
      { action: 'session_scope', scope: config.sessionScope ?? null, shared: Boolean(this.sessionStore && config.sessionScope) },
      this.sessionStore && config.sessionScope
        ? 'Anomaly session window shared with sibling proxies through Valkey'
        : 'Anomaly session window is per-process',
    )
    this.wasmRunner = new WasmRunner(config.mcpWasmDir)
    this.registryObserver = config.standalone
      ? undefined
      : new RegistryObserver(config.controlPlaneUrl, config.apiKey, config.serverName, config.remoteTransport ?? 'stdio')

    this.interceptor = new ToolCallInterceptor(
      this.policy,
      this.emitter,
      config.failOpen,
      config.serverName,
      config.mcpInjectionAction,
      this.session,
      config.mcpAnomalyMode,
      config.mcpAnomalyOverrides,
      this.wasmRunner,
      config.workspaceId,
      new ApprovalHolds(config.controlPlaneUrl, config.apiKey, config.workspaceId, config.serverName, identity),
      new McpBudgetEnforcer(
        this.valkey ? new ValkeyBudgetStore(this.valkey) : undefined,
        config.workspaceId,
        config.serverName,
        fallbackBudgetCaller(identity),
      ),
    )
  }

  /**
   * The tools/call decision engine — exposed so `remoteBridge.ts` can drive
   * `handleHarnessLine` (the exported free function above) against the SAME
   * interceptor instance this class builds from `config` in its constructor,
   * rather than constructing a second one that could drift.
   */
  getInterceptor(): ToolCallInterceptor {
    return this.interceptor
  }

  /**
   * The shared session state — exposed for the same reason `getInterceptor`
   * is: `remoteBridge.ts` drives `handleHarnessLine` with this exact
   * instance so the sequence detectors read and the sequence
   * `handleHarnessLine` records into are never two different objects.
   */
  getSessionState(): SessionState {
    return this.session
  }

  /**
   * Start the policy client's background refresh timer. Exposed alongside
   * `stopPolicy` so `remoteBridge.ts` can drive the same policy lifecycle
   * `runProxy` below drives for stdio mode, without reaching into `policy`
   * (private) directly. Also rides this same tick to rescan Phase 3's
   * `~/.intutic/wasm/` directory — see `policy.ts`'s `start(onTick)` doc.
   */
  startPolicy(): void {
    this.policy.start(() => {
      this.ensureWasmWatch()
      return this.wasmRunner.rescan()
    })
    void this.registryObserver?.observe()
  }

  private wasmWatch: WasmDirWatcher | null = null

  /**
   * Hot reload for `~/.intutic/wasm/` (TD-442): a directory watcher, not a
   * second timer, so a dropped-in rule takes effect within a second instead
   * of at the next 60-second tick. Re-armed on every tick because the
   * directory may not exist when the proxy starts.
   */
  private ensureWasmWatch(): void {
    if (this.wasmWatch) return
    this.wasmWatch = watchWasmDir(this.wasmRunner.getDir(), () => this.wasmRunner.rescan())
  }

  /**
   * Stop the policy client's background refresh timer, and shut down the
   * WASM worker thread. See `startPolicy`.
   */
  stopPolicy(): void {
    this.policy.stop()
    this.wasmWatch?.close()
    this.wasmWatch = null
    void this.wasmRunner.shutdown()
    void this.valkey?.close()
  }

  /**
   * Start the proxy. Dispatches to standalone or proxy mode based on config.
   */
  async run(): Promise<void> {
    if (this.config.standalone) {
      return this.runStandalone()
    }
    return this.runProxy()
  }

  // ─── Standalone MCP Server Mode ──────────────────────────────────────────────

  /**
   * Run as a standalone MCP server (the `intutic` harness entry).
   * Exposes Intutic governance tools directly to the harness.
   * Gracefully degrades when the control plane is unreachable.
   */
  private async runStandalone(): Promise<void> {
    log.info(
      { action: 'standalone_start', workspaceId: this.config.workspaceId },
      'Starting Intutic MCP governance server (standalone mode)'
    )

    const server = new McpServer({
      name: 'intutic',
      version: PACKAGE_VERSION,
    })

    const cpUrl = this.config.controlPlaneUrl
    const apiKey = this.config.apiKey
    const workspaceId = this.config.workspaceId

    const callControlPlane = (path: string) => readControlPlane(cpUrl, apiKey, workspaceId, path)

    // Tool: intutic_governance_status
    server.tool(
      'intutic_governance_status',
      'Returns the current governance status and health of the Intutic control plane for this workspace.',
      {},
      async () => {
        const health = await callControlPlane('/healthz')
        const status = health.ok
          ? { connected: true, controlPlane: cpUrl, workspaceId, ...(health.data as Record<string, unknown>) }
          : {
              connected: false,
              controlPlane: cpUrl,
              workspaceId,
              error:
                health.reason === 'forbidden'
                  ? 'Control plane rejected this API key'
                  : 'Control plane unreachable',
            }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        }
      }
    )

    // Tool: intutic_list_sops
    server.tool(
      'intutic_list_sops',
      'Lists Standard Operating Procedures (SOPs) active in this workspace.',
      { limit: z.number().int().min(1).max(50).default(10).describe('Number of SOPs to return (1–50)') },
      async ({ limit }) => {
        const result = await callControlPlane(
          `/api/v1/sops?workspaceId=${workspaceId}&limit=${limit}`
        )
        const text = result.ok
          ? JSON.stringify(result.data, null, 2)
          : describeFailure(result, 'list SOPs')

        return {
          content: [{ type: 'text' as const, text }],
        }
      }
    )

    // Tool: intutic_list_incidents
    server.tool(
      'intutic_list_incidents',
      'Lists recent governance incidents (policy violations, blocked tool calls) in this workspace.',
      { limit: z.number().int().min(1).max(50).default(10).describe('Number of incidents to return (1–50)') },
      async ({ limit }) => {
        const result = await callControlPlane(
          `/api/v1/incidents?workspaceId=${workspaceId}&limit=${limit}`
        )
        const text = result.ok
          ? JSON.stringify(result.data, null, 2)
          : describeFailure(result, 'list incidents')

        return {
          content: [{ type: 'text' as const, text }],
        }
      }
    )

    // Tool: intutic_hold_status
    server.tool(
      'intutic_hold_status',
      'Reports whether a held tool call (a refusal with code HELD and a hold id) has been approved or rejected, ' +
        'and whether retrying the identical call will now pass. Pass the hold id the refusal gave (hold_…).',
      { holdId: z.string().min(1).max(128).describe('The hold id from the refusal, hold_…') },
      async ({ holdId }) => {
        const decision = await callControlPlane(`/api/v1/decisions/${encodeURIComponent(holdId)}`)
        let text: string
        if (!decision.ok) {
          text =
            decision.reason === 'not_found'
              ? `No hold ${holdId} was found in this workspace. Check the id the refusal gave; a hold that could not be recorded has none.`
              : describeFailure(decision, `report hold ${holdId}`)
        } else {
          // Only an approval needs the bypasses, to say whether a retry passes.
          const status = (decision.data as { status?: unknown }).status
          const bypasses = status === 'APPROVED' ? await callControlPlane('/api/v1/decisions/approved-bypasses') : null
          text = JSON.stringify(holdStatus(holdId, decision.data as { status?: unknown }, bypasses?.ok ? bypasses.data : null), null, 2)
        }
        return { content: [{ type: 'text' as const, text }] }
      }
    )

    // Tool: intutic_mcp_registry_status
    server.tool(
      'intutic_mcp_registry_status',
      "Reports what this workspace's MCP server registry says about each server: whether calls to it are allowed " +
        'or refused (blocked, held after a risky tool change, or not approved under a deny default), and which of its ' +
        'tools are switched off.',
      { server: z.string().min(1).max(256).optional().describe('One server name; every server when omitted') },
      async ({ server: name }) => {
        const result = await callControlPlane('/api/v1/mcp/servers')
        const text = result.ok
          ? JSON.stringify(registryStatus(result.data, name), null, 2)
          : describeFailure(result, 'read the MCP server registry')
        return { content: [{ type: 'text' as const, text }] }
      }
    )

    // Tool: intutic_mcp_budget_remaining
    server.tool(
      'intutic_mcp_budget_remaining',
      "Lists this workspace's MCP call budgets that count your calls, with how many calls each has left this " +
        'period and when it resets. Counts are read from the Valkey the MCP proxies on this machine count in.',
      {},
      async () => {
        await this.policy.ready()
        const identity = callerIdentity(apiKey, 'intutic', this.config.sessionScope)
        const store = this.valkey ? new ValkeyBudgetStore(this.valkey) : undefined
        const budgets = await budgetRemaining(
          this.policy.getMcpBudgets(),
          workspaceId,
          { memberId: this.policy.getPrincipal()?.memberId ?? null, fallback: fallbackBudgetCaller(identity) },
          async (keys) => store?.used(keys),
        )
        const unread = budgets.some((b) => b.used === null)
        const text = JSON.stringify(
          {
            budgets,
            ...(unread
              ? {
                  note:
                    'Used counts are null: this server has no Valkey to read them from (INTUTIC_VALKEY_URL), or it ' +
                    'did not answer. The limits still apply.',
                }
              : {}),
          },
          null,
          2,
        )
        return { content: [{ type: 'text' as const, text }] }
      }
    )

    const transport = new StdioServerTransport()
    await server.connect(transport)
    log.info({ action: 'standalone_ready' }, 'Intutic MCP server ready')

    // Keep alive until stdin closes (harness disconnects)
    await new Promise<void>((resolve) => {
      process.stdin.on('close', resolve)
      process.on('SIGINT', resolve)
      process.on('SIGTERM', resolve)
    })

    await server.close()
  }

  // ─── Proxy Mode ───────────────────────────────────────────────────────────────

  /**
   * Inspects one real-server → harness line (see `processServerLine`) and
   * writes the outcome to stdout. Async, unlike the byte pipe this replaced,
   * because a `tools/list` response also runs server-level TOFU pinning
   * (tofu.ts), which does file I/O — the ONLY case this awaits before
   * writing; every other line is forwarded exactly as fast as before.
   *
   * On a TOFU mismatch, honors `mcpProxyFailBehavior` via the interceptor's
   * `failOpen` — the SAME value its own fail-open/fail-closed branches read,
   * not a new mechanism: fail-open logs and forwards
   * the (possibly curated) tools/list response as normal; fail-closed
   * replaces it with a JSON-RPC error naming the server and the setting,
   * mirroring `buildBlockResponse`'s existing wording style.
   *
   * Public (not `private`) so `remoteBridge.ts` can hand it every message
   * `transport.onmessage` receives from a remote upstream, VERBATIM — DLP
   * redaction, TOFU pinning, and event emission on the response direction
   * must apply identically regardless of which upstream transport produced
   * the line, and this is the one place that logic lives.
   */
  async handleServerLine(
    rawLine: string,
    pending: Map<string | number, PendingRequest>,
  ): Promise<void> {
    const injectionAction = this.policy.getInjectionAction() ?? this.config.mcpInjectionAction
    // Results are redacted with the workspace's PII detector actions too —
    // a resources/read answer can arrive before any tools/call set them.
    setWorkspacePii(this.policy.getPiiDetectors())
    const outcome = processServerLine(
      rawLine,
      pending,
      this.policy.getAllowedTools(),
      this.policy.getToolDescriptionOverrides(),
      injectionAction,
      this.policy.getInjectionPatterns(),
      this.policy.getRegistry()?.disabledTools[this.config.serverName] ?? [],
    )
    if (outcome.injectionFindings) {
      for (const finding of outcome.injectionFindings) {
        const severity = injectionSeverity(finding.patterns, finding.source)
        const reason = `Prompt-injection pattern(s) detected in ${finding.source} ("${finding.toolName}"): ${finding.patterns.join(', ')}`
        log.warn(
          {
            action: 'injection_detected',
            toolName: finding.toolName,
            source: finding.source,
            patterns: finding.patterns,
            severity,
            withheld: outcome.injectionBlocked === true && finding.source === 'tool_result',
          },
          'Prompt-injection pattern matched in MCP response traffic',
        )
        const withheld = outcome.injectionBlocked === true && finding.source === 'tool_result'
        this.emitter.emit('injection_detected', finding.toolName, undefined, reason, {
          detectorId: `injection:${finding.source}`,
          kind: 'prompt_injection',
          disposition: withheld ? 'kill' : 'steer',
          severity,
          confidence: 1,
        })
        // tools/list description findings are report-only in v1 (never
        // blocked by injection alone — curation + TOFU already govern the
        // listing); only a `tool_result` finding can carry
        // `injectionBlocked`.
        if (outcome.injectionBlocked === true && finding.source === 'tool_result') {
          this.emitter.emit('tool_blocked', finding.toolName, undefined, reason)
        }
      }
    }
    if (outcome.redactedTool) {
      log.warn(
        {
          action: 'result_redacted',
          toolName: outcome.redactedTool,
          redactions: outcome.redactions,
        },
        'Sensitive data redacted from a tool result before it reached the agent',
      )
      this.emitter.emit(
        'tool_redacted',
        outcome.redactedTool,
        undefined,
        `Result redacted: ${(outcome.redactions ?? []).join('; ')}`,
        {
          detectorId: 'result_redaction',
          kind: 'data_exfiltration',
          disposition: 'steer',
          severity: outcome.dlpEscalation ? 'high' : 'medium',
          confidence: 1,
        },
      )
    }
    if (outcome.dlpEscalation) {
      // Phase 2's dlp_escalation: severity escalation only, never a new
      // block — see `ServerLineOutcome.dlpEscalation`'s doc comment. So the
      // finding records `steer`, what it did, not the detector's declared kill.
      log.warn(
        { action: 'anomaly_detected', detectorId: 'dlp_escalation', toolName: outcome.redactedTool },
        outcome.dlpEscalation.reason,
      )
      this.emitter.emit(
        'anomaly_detected',
        outcome.redactedTool ?? 'unknown',
        undefined,
        outcome.dlpEscalation.reason,
        detectionFinding(outcome.dlpEscalation, 'steer', 'high'),
      )
    }
    if (outcome.curated) {
      log.info(
        { action: 'tools_list_curated', ...outcome.curated },
        'tools/list curated: allowlist filtering and/or description overrides applied',
      )
    }
    if (outcome.toolPoisoning) {
      // Phase 2's tool_poisoning: report-only (Steer), same as Phase 1's
      // tools/list description injection scan — never blocks the listing.
      log.warn({ action: 'anomaly_detected', detectorId: 'tool_poisoning' }, outcome.toolPoisoning.reason)
      this.emitter.emit(
        'anomaly_detected',
        this.config.serverName,
        undefined,
        outcome.toolPoisoning.reason,
        detectionFinding(outcome.toolPoisoning, 'steer', 'low'),
      )
    }

    if (outcome.toolsListTools) {
      // The registry gets the server's own tool names, before curation:
      // per-tool toggles must be able to re-enable a tool curation hid.
      void this.registryObserver?.observe(outcome.toolsListUpstream ?? [])
      // Cache the post-curation tools/list for Phase 2's tool_poisoning
      // detector (already applied above, from this same outcome) and for
      // Phase 3's WASM rule context (`tools` field) once that lands.
      this.session.setToolsList(
        outcome.toolsListTools
          .filter((t): t is Record<string, unknown> & { name: string } => typeof t['name'] === 'string')
          .map((t) => ({
            name: t['name'],
            description: typeof t['description'] === 'string' ? t['description'] : undefined,
          })),
      )
      const serverName = this.config.serverName
      let tofu: Awaited<ReturnType<typeof checkTofu>>
      try {
        tofu = await checkTofu(this.config.workspaceId, serverName, outcome.toolsListTools)
      } catch (err) {
        // Pin storage I/O failed (disk full, permissions, ~/.intutic
        // unwritable). This is a governance-check failure like any other in
        // this package — fail-open forwards, fail-closed refuses — never a
        // silent skip either way.
        log.error({ action: 'tofu_check_error', err: (err as Error).message }, 'TOFU check failed')
        if (!this.interceptor.failOpen) {
          writeFrame(
            buildBlockResponse(
              outcome.toolsListMsgId ?? null,
              `TOFU pin check for MCP server "${serverName}" failed (could not read/write ` +
                `~/.intutic/mcp-pins/). Blocked by workspace policy (fail-closed mode). ` +
                `Contact your administrator or update mcpProxyFailBehavior to open.`,
              { code: 'TOFU_UNAVAILABLE', ruleId: 'mcpProxyFailBehavior' },
            ),
          )
          return
        }
        process.stdout.write(outcome.line + '\n')
        return
      }

      // Phase 3's `tool_contract_changed` WASM context field mirrors this
      // check's OUTCOME, not its blocking decision — a rule may want to see
      // the mismatch even in fail-open mode, where `action.block` is false.
      // 'skipped' (no tools declared) deliberately leaves the session's
      // cached flag untouched; see SessionState.setToolContractChanged's doc.
      if (tofu.status === 'first_contact' || tofu.status === 'match') {
        this.session.setToolContractChanged(false)
      } else if (tofu.status === 'mismatch') {
        this.session.setToolContractChanged(true)
      }

      if (tofu.status === 'first_contact') {
        log.info(
          { action: 'tofu_first_contact', serverName, fingerprint: tofu.fingerprint },
          'MCP server tool definitions pinned on first contact',
        )
      } else if (tofu.status === 'mismatch') {
        const action = decideTofuAction(tofu, serverName, this.interceptor.failOpen)
        const reason = action.reason ?? 'MCP server tool definitions changed since first pinned.'
        log.warn(
          {
            action: 'mcp_server_definition_changed',
            serverName,
            previousFingerprint: tofu.previousFingerprint,
            fingerprint: tofu.fingerprint,
            blocked: action.block,
          },
          reason,
        )
        this.emitter.emit('mcp_server_definition_changed', serverName, undefined, reason)

        if (action.block) {
          writeFrame(
            buildBlockResponse(outcome.toolsListMsgId ?? null, reason, { code: 'TOOL_DEFINITIONS_CHANGED', ruleId: `tofu.${serverName}` }),
          )
          return
        }
      }
    }

    process.stdout.write(outcome.line + '\n')
  }

  /**
   * Start the proxy. Spawns the real MCP server and begins proxying stdin/stdout.
   * Returns a promise that resolves when the real server exits.
   */
  private async runProxy(): Promise<void> {
    const [cmd, ...args] = this.config.realServerCommand

    log.info(
      { action: 'proxy_start', cmd, args, workspaceId: this.config.workspaceId },
      'Starting MCP governance proxy'
    )

    // Start background policy refresh (and, on the same tick, Phase 3's
    // WASM rescan — see startPolicy).
    this.startPolicy()

    // Spawn the real MCP server
    const realServer = node_child.spawn(cmd!, args, {
      stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr so real server logs appear normally
    })

    this.realServer = realServer

    // Handle graceful shutdown
    const shutdown = (signal: string) => {
      log.info({ action: 'proxy_shutdown', signal }, 'Shutting down MCP governance proxy')
      this.stopPolicy()
      if (!realServer.killed) {
        realServer.kill()
      }
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Requests whose responses this proxy must inspect on the way back.
    // Bounded by the number of in-flight calls; entries are removed when the
    // response arrives (or lost with the process, which is fine — the map
    // exists to route inspection, not to account).
    const pending = new Map<string | number, PendingRequest>()

    // Real server stdout → response inspection → harness stdout. The pipe
    // this replaces forwarded bytes verbatim, which left the whole response
    // direction unscanned; see processServerLine. Line-framed like the input
    // direction (MCP stdio is newline-delimited JSON-RPC), so readline does
    // the chunk reassembly a byte pipe never had to think about.
    const serverRl = node_readline.createInterface({
      input: realServer.stdout!,
      terminal: false,
    })
    serverRl.on('line', (rawLine) => {
      void this.handleServerLine(rawLine, pending)
    })

    // Harness stdin → governance interceptor → real server stdin. Delegates
    // to the module-level `handleHarnessLine`, shared verbatim with
    // remoteBridge.ts's remote bridge mode — only `forward` differs: here it
    // writes to the spawned child process's stdin.
    const rl = node_readline.createInterface({ input: process.stdin, terminal: false })

    rl.on('line', (line) => {
      handleHarnessLine(line, pending, this.interceptor, (l) => {
        realServer.stdin!.write(l + '\n')
      }, this.session)
    })

    rl.on('close', () => {
      log.info({ action: 'stdin_closed' }, 'Harness stdin closed — shutting down')
      this.stopPolicy()
      if (!realServer.killed) {
        realServer.kill()
      }
    })

    // Wait for the real server to exit
    return new Promise((resolve, reject) => {
      realServer.on('exit', (code, signal) => {
        log.info({ action: 'real_server_exit', code, signal }, 'Real MCP server exited')
        this.stopPolicy()
        resolve()
      })
      realServer.on('error', (err) => {
        log.error({ action: 'real_server_error', err: err.message }, 'Real MCP server process error')
        this.stopPolicy()
        reject(err)
      })
    })
  }
}
