/**
 * types.ts — AWS Bedrock AgentCore Gateway interceptor Lambda event/response
 * shapes.
 *
 * Confirmed live against AWS's current devguide (fetched 2026-08-19), NOT
 * invented from training-data assumptions — every field below traces to a
 * literal JSON example on one of these pages:
 *
 *   - "Types of interceptors" —
 *     docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html
 *     (the REQUEST/RESPONSE input/output payload examples this file's types
 *     are transcribed from, including the streaming-response variants)
 *   - "Examples" —
 *     docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-examples.html
 *     (the reference pass-through Lambda, whose `event.mcp.gatewayResponse
 *     != null` REQUEST-vs-RESPONSE discriminator this module's handler.ts
 *     reuses)
 *
 * This module covers ONLY the MCP-target interceptor payload shape (the
 * `mcp` key) — AgentCore Gateway also has a structurally different `http` key
 * payload for HTTP/inference targets (base64-encoded bodies, no
 * `rawGatewayRequest`), which this Lambda does not need: it is deployed as an
 * MCP-target REQUEST interceptor only. See handler.ts's module doc for why.
 *
 * # What this Lambda is actually attached to, and the "one interceptor per
 * slot" constraint
 *
 * AWS: "A gateway can have at most one REQUEST interceptor and at most one
 * RESPONSE interceptor configured... you cannot have multiple interceptors
 * of the same type." (gateway-interceptors.html, confirmed via
 * `interceptorConfigurations`'s `Array Members: Minimum number of 1 item.
 * Maximum number of 2 items.` constraint on the real `CreateGateway` API
 * reference). If an operator ALSO needs their own Lambda logic on the same
 * gateway, both concerns must be composed into ONE Lambda — see
 * apps/docs/integrations/agentcore.md's deployment walkthrough for how.
 *
 * # Short-circuit + streaming behaviour (corrections to an earlier
 * assumption-only pass — see TD-430)
 *
 * An earlier, non-live-verified pass assumed "buffered request/response
 * only, no streaming" as a blanket AgentCore Gateway interceptor limitation.
 * That is TRUE for HTTP targets ("Interceptors are not yet supported in
 * streaming mode" — gateway-interceptors-types.html's HTTP-targets section)
 * but FALSE for MCP targets, which this Lambda is deployed against: when
 * gateway response streaming is enabled, the RESPONSE interceptor is invoked
 * MULTIPLE times per request (once per eligible JSON-RPC event on the
 * stream). This Lambda is a REQUEST interceptor only and is invoked once per
 * `tools/call`, so streaming responses do not change its own behaviour — but
 * an operator who also attaches it as a RESPONSE interceptor (see the module
 * doc on `handleResponseInterceptor` in handler.ts) needs to know this.
 *
 * Also corrected: whether a REQUEST-interceptor short-circuit
 * (`transformedGatewayResponse`) still invokes the RESPONSE interceptor
 * DEPENDS ON TARGET TYPE, confirmed via two directly contradicting sentences
 * on the same page: for MCP targets, "If both REQUEST and RESPONSE
 * interceptors are configured and the REQUEST interceptor output contains a
 * transformedGatewayResponse, the RESPONSE interceptor will still be
 * invoked." For HTTP targets, "If transformedGatewayResponse is present in a
 * REQUEST interceptor's output, the gateway returns that response
 * immediately without calling the target (a short-circuit). The RESPONSE
 * interceptor does not run after a short-circuit." This Lambda targets MCP,
 * so a denial IS still visible to any RESPONSE interceptor configured
 * alongside it.
 */

/** The `mcp.gatewayRequest.body` shape for a `tools/call` JSON-RPC request. */
export interface McpToolsCallBody {
  jsonrpc: '2.0'
  id: number | string
  method: 'tools/call'
  params?: {
    name?: string
    arguments?: unknown
  }
}

/** A generic MCP JSON-RPC request body — `method` may be anything, not just `tools/call`. */
export interface McpJsonRpcRequestBody {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface McpGatewayRequest {
  /** Always "/mcp" for MCP targets. */
  path: string
  httpMethod: string
  /** Only present when the interceptor's `passRequestHeaders` config is `true`. */
  headers?: Record<string, string>
  body: McpJsonRpcRequestBody
}

export interface McpGatewayResponse {
  statusCode: number
  headers?: Record<string, string>
  body: unknown
  /** Present and `true` only when gateway response streaming is enabled. */
  isStreamingResponse?: boolean
}

/**
 * The REQUEST interceptor's input event. `gatewayResponse` is never present
 * here — AWS: "The gatewayResponse field is not present for request
 * interceptors since the response has not been generated yet."
 */
export interface McpRequestInterceptorEvent {
  interceptorInputVersion: '1.0'
  mcp: {
    rawGatewayRequest?: { body: string }
    gatewayRequest: McpGatewayRequest
  }
}

/**
 * The RESPONSE interceptor's input event. `gatewayResponse` is present.
 * `handler.ts`'s discriminator (matching AWS's own reference pass-through
 * example) checks for its presence to route between the two shapes, since
 * AWS may invoke ONE Lambda ARN for both interception points.
 */
export interface McpResponseInterceptorEvent {
  interceptorInputVersion: '1.0'
  mcp: {
    rawGatewayRequest?: { body: string }
    gatewayRequest: McpGatewayRequest
    gatewayResponse: McpGatewayResponse
  }
}

export type McpInterceptorEvent = McpRequestInterceptorEvent | McpResponseInterceptorEvent

export interface McpInterceptorOutput {
  interceptorOutputVersion: '1.0'
  mcp: {
    transformedGatewayRequest?: { body: unknown }
    transformedGatewayResponse?: { statusCode: number; body: unknown }
  }
}

/** A JSON-RPC 2.0 error response body, used for a denial short-circuit. */
export interface JsonRpcErrorBody {
  jsonrpc: '2.0'
  id: number | string
  error: {
    /** -32000 is the JSON-RPC "server error" reserved range's first code — no MCP-specific code exists for a policy denial. */
    code: number
    message: string
  }
}
