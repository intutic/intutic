/**
 * handler.ts — the AgentCore Gateway REQUEST interceptor Lambda handler.
 *
 * Deployed as a Gateway REQUEST interceptor (see
 * apps/docs/integrations/agentcore.md for the `create-gateway`/
 * `update-gateway` `--interceptor-configurations` walkthrough). AWS invokes
 * this function synchronously, once per gateway request, before the gateway
 * calls the real MCP target — see types.ts's module doc for the exact event/
 * response shapes this file implements, confirmed against AWS's current
 * devguide.
 *
 * # What gets governed, and what deliberately passes through unchanged
 *
 * Only `tools/call` is evaluated. AWS invokes the REQUEST interceptor for
 * EVERY MCP method (`initialize`, `tools/list`, `resources/list`, ...), but
 * this codebase's governance model is a per-TOOL-CALL allow/deny gate (the
 * same scope `POST /api/v1/hook-gate` and every harness adapter's gate
 * already have) — there is nothing to allow/deny about a client listing
 * available tools. Every non-`tools/call` method, and a malformed
 * `tools/call` missing `params.name`, passes through unchanged; the real
 * target (or the gateway's own JSON-RPC validation) handles it from there.
 *
 * # Fail-open vs fail-closed on a control-plane failure
 *
 * Defaults to FAIL CLOSED (deny) when the control-plane call itself fails —
 * times out, network-errors, or returns a non-2xx/unparseable body. This is
 * a deliberate difference from `/api/v1/hook-gate`'s own fail-open default:
 * hook-gate protects a developer's local edit-test loop, where failing
 * closed would block their work for an infra blip. A Gateway an operator
 * explicitly wired an interceptor onto is a production governance boundary,
 * not a laptop — see apps/docs/integrations/agentcore.md for the reasoning
 * and the `INTUTIC_FAIL_OPEN=true` escape hatch for operators who have
 * judged their own uptime requirements differently. See TD-431.
 *
 * # Both interception points share this file, matching AWS's own reference
 * pass-through example (gateway-interceptors-examples.html): a REQUEST
 * event never carries `mcp.gatewayResponse`, a RESPONSE event always does —
 * that presence check is the documented discriminator. This Lambda's own
 * `interceptionPoints` config (see the docs walkthrough) attaches it as
 * REQUEST only; `handleResponseInterceptor` exists so an operator who
 * mistakenly (or deliberately, to compose custom response-side logic)
 * attaches the SAME Lambda ARN to the RESPONSE slot gets an honest
 * pass-through rather than a runtime crash on an unhandled event shape.
 *
 * @module
 */

import type {
  McpInterceptorEvent,
  McpInterceptorOutput,
  McpRequestInterceptorEvent,
  McpResponseInterceptorEvent,
  McpToolsCallBody,
  JsonRpcErrorBody,
} from './types.js'

// ─── Configuration (env vars — see apps/docs/integrations/agentcore.md) ───

export interface InterceptorConfig {
  /** e.g. https://your-intutic-control-plane.example.com */
  controlPlaneUrl: string
  /** A workspace virtual key (`vk_...`), sent as `Authorization: Bearer`. */
  apiKey: string
  /** Milliseconds before the control-plane call is treated as a failure. Default 3000. */
  timeoutMs: number
  /** Verdict on a control-plane call failure. Default false (fail CLOSED). */
  failOpen: boolean
  /** Optional — attached to the request for control-plane log correlation only. */
  gatewayId?: string
}

/**
 * Reads the Lambda's configuration from its environment. Exported for an
 * operator composing their own interceptor (see
 * {@link composeRequestInterceptor}); throws when a required variable is
 * missing, so a misconfigured Lambda fails loudly on its first invocation.
 */
export function readConfig(): InterceptorConfig {
  const controlPlaneUrl = process.env.INTUTIC_CONTROL_PLANE_URL
  const apiKey = process.env.INTUTIC_API_KEY
  if (!controlPlaneUrl) throw new Error('INTUTIC_CONTROL_PLANE_URL is not configured')
  if (!apiKey) throw new Error('INTUTIC_API_KEY is not configured')

  return {
    controlPlaneUrl: controlPlaneUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: Number(process.env.INTUTIC_TIMEOUT_MS ?? 3000),
    failOpen: process.env.INTUTIC_FAIL_OPEN === 'true',
    gatewayId: process.env.AGENTCORE_GATEWAY_ID,
  }
}

export interface GatewayCheckResponse {
  allowed: boolean
  reason?: string
}

/**
 * Call `POST /api/v1/integrations/agentcore/gateway-check`
 * (services/control-plane/src/routes/agentcoreGateway.ts) for a verdict.
 *
 * Never throws for an ordinary "the call was denied" outcome — only for a
 * genuine failure to get an answer at all (network error, timeout,
 * non-2xx, unparseable body), which the caller maps to `config.failOpen`.
 */
export async function checkToolCall(
  config: InterceptorConfig,
  args: { toolName: string; toolInput: unknown; sessionId?: string },
): Promise<GatewayCheckResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const res = await fetch(`${config.controlPlaneUrl}/api/v1/integrations/agentcore/gateway-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        toolName: args.toolName,
        toolInput: args.toolInput,
        sessionId: args.sessionId,
        gatewayId: config.gatewayId,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`gateway-check returned HTTP ${res.status}`)
    }

    const body = (await res.json()) as unknown
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { allowed?: unknown }).allowed !== 'boolean'
    ) {
      throw new Error('gateway-check returned an unparseable body')
    }

    return body as GatewayCheckResponse
  } finally {
    clearTimeout(timer)
  }
}

/** A pass-through REQUEST output: the original body, unchanged. */
function passThroughRequest(body: unknown): McpInterceptorOutput {
  return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } }
}

/** A denial short-circuit: the gateway returns this JSON-RPC error to the caller without ever calling the target. */
function denyResponse(id: number | string, reason: string): McpInterceptorOutput {
  const errorBody: JsonRpcErrorBody = {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: `Blocked by Intutic governance: ${reason}` },
  }
  return {
    interceptorOutputVersion: '1.0',
    mcp: { transformedGatewayResponse: { statusCode: 200, body: errorBody } },
  }
}

function isToolsCall(body: { method: string }): body is McpToolsCallBody {
  return body.method === 'tools/call'
}

async function handleRequestInterceptor(
  event: McpRequestInterceptorEvent,
  config: InterceptorConfig,
): Promise<McpInterceptorOutput> {
  const { body, headers } = event.mcp.gatewayRequest

  if (!isToolsCall(body) || typeof body.params?.name !== 'string') {
    // Not a tool call (or malformed one) — nothing for this gate to decide.
    return passThroughRequest(body)
  }

  const toolName = body.params.name
  const toolInput = body.params.arguments
  // Only present when the gateway's `passRequestHeaders` interceptor config
  // is enabled (see types.ts's module doc) — absent otherwise, and that is
  // fine: sessionId is a correlation aid for control-plane logging, never
  // part of the allow/deny decision itself.
  const sessionId = headers?.['Mcp-Session-Id']

  try {
    const verdict = await checkToolCall(config, { toolName, toolInput, sessionId })
    if (verdict.allowed) return passThroughRequest(body)
    return denyResponse(body.id, verdict.reason ?? 'denied by policy')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (config.failOpen) {
      return passThroughRequest(body)
    }
    return denyResponse(body.id, `Intutic governance check failed (${message}) — failing closed`)
  }
}

/**
 * RESPONSE-interceptor path — see this module's doc for why it exists.
 * Always a pass-through: this Lambda's job is the pre-execution veto, and it
 * has already run (or been bypassed by a short-circuit) on the REQUEST side.
 */
function handleResponseInterceptor(event: McpResponseInterceptorEvent): McpInterceptorOutput {
  const { gatewayResponse } = event.mcp
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: gatewayResponse.statusCode,
        body: gatewayResponse.body,
      },
    },
  }
}

/**
 * Your own REQUEST-interceptor logic, for {@link composeRequestInterceptor}.
 * Return `transformedGatewayRequest` to let the call continue (optionally
 * with a rewritten body), or `transformedGatewayResponse` to answer or reject
 * it yourself.
 */
export type RequestInterceptorLogic = (
  event: McpRequestInterceptorEvent,
) => McpInterceptorOutput | Promise<McpInterceptorOutput>

/**
 * Composes an operator's own REQUEST-interceptor logic with Intutic's check
 * into ONE Lambda handler. A gateway takes at most one REQUEST interceptor
 * (see apps/docs/integrations/agentcore.md), so two cannot be attached side
 * by side.
 *
 * Order and outcomes:
 *
 * 1. `ownLogic` runs first. If it short-circuits
 *    (`transformedGatewayResponse`), that answer is returned as-is and
 *    Intutic is never called.
 * 2. Otherwise Intutic checks the body `ownLogic` forwards, which may be a
 *    rewrite of the original, because that is what reaches the target. Only
 *    `tools/call` is checked, the same as {@link handler}.
 * 3. Allowed: `ownLogic`'s output is returned unchanged. Denied: the Intutic
 *    denial is returned instead.
 * 4. A control-plane failure follows `INTUTIC_FAIL_OPEN` (closed by default),
 *    exactly as {@link handler} does. If `ownLogic` THROWS, the call is denied
 *    regardless of that flag: the flag is about Intutic's availability, and
 *    letting an unchecked call through because the operator's own code
 *    crashed would be failing open on someone else's behalf.
 *
 * RESPONSE events pass through unchanged, as in {@link handler}.
 */
export function composeRequestInterceptor(
  ownLogic: RequestInterceptorLogic,
): (event: McpInterceptorEvent) => Promise<McpInterceptorOutput> {
  return async (event) => {
    const config = readConfig()

    if ('gatewayResponse' in event.mcp && event.mcp.gatewayResponse != null) {
      return handleResponseInterceptor(event as McpResponseInterceptorEvent)
    }
    const requestEvent = event as McpRequestInterceptorEvent

    let own: McpInterceptorOutput
    try {
      own = await ownLogic(requestEvent)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return denyResponse(
        requestEvent.mcp.gatewayRequest.body.id,
        `custom interceptor logic failed (${message}) — failing closed`,
      )
    }
    if (own.mcp.transformedGatewayResponse) return own

    const forwarded = (own.mcp.transformedGatewayRequest?.body ??
      requestEvent.mcp.gatewayRequest.body) as McpRequestInterceptorEvent['mcp']['gatewayRequest']['body']
    const verdict = await handleRequestInterceptor(
      { ...requestEvent, mcp: { ...requestEvent.mcp, gatewayRequest: { ...requestEvent.mcp.gatewayRequest, body: forwarded } } },
      config,
    )
    return verdict.mcp.transformedGatewayResponse ? verdict : own
  }
}

/**
 * Lambda entry point. Matches AWS's own reference pass-through example's
 * discriminator: `gatewayResponse` present => RESPONSE interceptor event,
 * absent => REQUEST interceptor event.
 */
export async function handler(event: McpInterceptorEvent): Promise<McpInterceptorOutput> {
  const config = readConfig()

  if ('gatewayResponse' in event.mcp && event.mcp.gatewayResponse != null) {
    return handleResponseInterceptor(event as McpResponseInterceptorEvent)
  }

  return handleRequestInterceptor(event as McpRequestInterceptorEvent, config)
}
