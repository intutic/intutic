import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handler, composeRequestInterceptor, checkToolCall, readConfig } from './handler.js'
import type {
  McpRequestInterceptorEvent,
  McpResponseInterceptorEvent,
  McpInterceptorOutput,
  JsonRpcErrorBody,
} from './types.js'

const CONTROL_PLANE_URL = 'https://control-plane.example.com'
const API_KEY = 'vk_test_key_1234567890'

function toolsCallEvent(overrides: {
  name?: string
  args?: unknown
  headers?: Record<string, string>
  id?: number | string
  method?: string
} = {}): McpRequestInterceptorEvent {
  return {
    interceptorInputVersion: '1.0',
    mcp: {
      gatewayRequest: {
        path: '/mcp',
        httpMethod: 'POST',
        headers: overrides.headers,
        body: {
          jsonrpc: '2.0',
          id: overrides.id ?? 1,
          method: overrides.method ?? 'tools/call',
          params: overrides.method === undefined || overrides.method === 'tools/call'
            ? { name: overrides.name ?? 'read_file', arguments: overrides.args ?? { path: 'README.md' } }
            : undefined,
        },
      },
    },
  }
}

describe('AgentCore Gateway interceptor Lambda handler', () => {
  const prevEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTUTIC_CONTROL_PLANE_URL = CONTROL_PLANE_URL
    process.env.INTUTIC_API_KEY = API_KEY
    delete process.env.INTUTIC_FAIL_OPEN
    delete process.env.AGENTCORE_GATEWAY_ID
    delete process.env.INTUTIC_TIMEOUT_MS
  })

  afterEach(() => {
    process.env = { ...prevEnv }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('configuration', () => {
    it('throws when INTUTIC_CONTROL_PLANE_URL is missing', async () => {
      delete process.env.INTUTIC_CONTROL_PLANE_URL
      await expect(handler(toolsCallEvent())).rejects.toThrow('INTUTIC_CONTROL_PLANE_URL')
    })

    it('throws when INTUTIC_API_KEY is missing', async () => {
      delete process.env.INTUTIC_API_KEY
      await expect(handler(toolsCallEvent())).rejects.toThrow('INTUTIC_API_KEY')
    })
  })

  describe('non-tools/call methods pass through unchanged', () => {
    it('passes tools/list through without calling the control plane', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const event = toolsCallEvent({ method: 'tools/list' })
      const result = await handler(event)

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.interceptorOutputVersion).toBe('1.0')
      expect(result.mcp.transformedGatewayRequest?.body).toEqual(event.mcp.gatewayRequest.body)
    })

    it('passes a tools/call with no params.name through unchanged (malformed — not this gate\'s concern)', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const event: McpRequestInterceptorEvent = {
        interceptorInputVersion: '1.0',
        mcp: {
          gatewayRequest: {
            path: '/mcp',
            httpMethod: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
          },
        },
      }
      const result = await handler(event)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.mcp.transformedGatewayRequest).toBeDefined()
    })
  })

  describe('allowed verdict', () => {
    it('passes the request through unchanged when the control plane allows it', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ allowed: true }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const event = toolsCallEvent({ name: 'read_file', args: { path: 'README.md' } })
      const result = await handler(event)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${CONTROL_PLANE_URL}/api/v1/integrations/agentcore/gateway-check`)
      expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
      const sentBody = JSON.parse(init.body)
      expect(sentBody.toolName).toBe('read_file')
      expect(sentBody.toolInput).toEqual({ path: 'README.md' })

      expect(result.interceptorOutputVersion).toBe('1.0')
      expect(result.mcp.transformedGatewayRequest?.body).toEqual(event.mcp.gatewayRequest.body)
      expect(result.mcp.transformedGatewayResponse).toBeUndefined()
    })

    it('forwards Mcp-Session-Id from headers when present', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) })
      vi.stubGlobal('fetch', fetchMock)

      await handler(toolsCallEvent({ headers: { 'Mcp-Session-Id': 'sess-abc123' } }))

      const [, init] = fetchMock.mock.calls[0]!
      const sentBody = JSON.parse(init.body)
      expect(sentBody.sessionId).toBe('sess-abc123')
    })

    it('sends AGENTCORE_GATEWAY_ID when configured', async () => {
      process.env.AGENTCORE_GATEWAY_ID = 'my-gateway-abc123xyz01'
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) })
      vi.stubGlobal('fetch', fetchMock)

      await handler(toolsCallEvent())

      const [, init] = fetchMock.mock.calls[0]!
      expect(JSON.parse(init.body).gatewayId).toBe('my-gateway-abc123xyz01')
    })
  })

  describe('denied verdict', () => {
    it('short-circuits with a JSON-RPC error carrying the deny reason', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ allowed: false, reason: 'DLP: AWS access key detected in tool arguments' }),
      })
      vi.stubGlobal('fetch', fetchMock)

      const event = toolsCallEvent({ id: 42 })
      const result = await handler(event)

      expect(result.mcp.transformedGatewayRequest).toBeUndefined()
      expect(result.mcp.transformedGatewayResponse).toBeDefined()
      expect(result.mcp.transformedGatewayResponse!.statusCode).toBe(200)
      const errorBody = result.mcp.transformedGatewayResponse!.body as JsonRpcErrorBody
      expect(errorBody.jsonrpc).toBe('2.0')
      expect(errorBody.id).toBe(42)
      expect(errorBody.error.message).toContain('AWS access key')
    })

    it('still uses a denial short-circuit even with no reason given', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: false }) })
      vi.stubGlobal('fetch', fetchMock)

      const result = await handler(toolsCallEvent())
      const errorBody = result.mcp.transformedGatewayResponse!.body as JsonRpcErrorBody
      expect(errorBody.error.message).toContain('denied by policy')
    })
  })

  describe('control-plane failure — fail-closed default', () => {
    it('denies (fail closed) on a network error by default', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await handler(toolsCallEvent())
      expect(result.mcp.transformedGatewayResponse).toBeDefined()
      const errorBody = result.mcp.transformedGatewayResponse!.body as JsonRpcErrorBody
      expect(errorBody.error.message).toContain('failing closed')
    })

    it('denies (fail closed) on a non-2xx response by default', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)

      const result = await handler(toolsCallEvent())
      expect(result.mcp.transformedGatewayResponse).toBeDefined()
    })

    it('denies (fail closed) on an unparseable body by default', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ notAllowed: true }) })
      vi.stubGlobal('fetch', fetchMock)

      const result = await handler(toolsCallEvent())
      expect(result.mcp.transformedGatewayResponse).toBeDefined()
    })
  })

  describe('control-plane failure — INTUTIC_FAIL_OPEN=true escape hatch', () => {
    it('passes the request through when fail-open is configured', async () => {
      process.env.INTUTIC_FAIL_OPEN = 'true'
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      vi.stubGlobal('fetch', fetchMock)

      const event = toolsCallEvent()
      const result = await handler(event)
      expect(result.mcp.transformedGatewayRequest?.body).toEqual(event.mcp.gatewayRequest.body)
      expect(result.mcp.transformedGatewayResponse).toBeUndefined()
    })
  })

  describe('RESPONSE interceptor invocation — always a pass-through', () => {
    it('passes the gateway response through unchanged, never calling the control plane', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const event: McpResponseInterceptorEvent = {
        interceptorInputVersion: '1.0',
        mcp: {
          gatewayRequest: {
            path: '/mcp',
            httpMethod: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } },
          },
          gatewayResponse: {
            statusCode: 200,
            body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } },
          },
        },
      }

      const result = await handler(event)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.mcp.transformedGatewayResponse).toEqual({
        statusCode: 200,
        body: event.mcp.gatewayResponse.body,
      })
    })
  })
  describe('exported building blocks', () => {
    it('readConfig reads the same environment the handler does', () => {
      process.env.AGENTCORE_GATEWAY_ID = 'gw-1'
      expect(readConfig()).toEqual({
        controlPlaneUrl: CONTROL_PLANE_URL,
        apiKey: API_KEY,
        timeoutMs: 3000,
        failOpen: false,
        gatewayId: 'gw-1',
      })
    })

    it('checkToolCall returns the control-plane verdict', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: false, reason: 'nope' }) }))
      await expect(checkToolCall(readConfig(), { toolName: 'rm', toolInput: {} })).resolves.toEqual({
        allowed: false,
        reason: 'nope',
      })
    })
  })

  describe('composeRequestInterceptor', () => {
    const passThrough = (event: McpRequestInterceptorEvent): McpInterceptorOutput => ({
      interceptorOutputVersion: '1.0',
      mcp: { transformedGatewayRequest: { body: event.mcp.gatewayRequest.body } },
    })

    it('returns own-logic rejection without calling Intutic', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const rejection: McpInterceptorOutput = {
        interceptorOutputVersion: '1.0',
        mcp: {
          transformedGatewayResponse: {
            statusCode: 200,
            body: { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'missing tenant header' } },
          },
        },
      }
      const composed = composeRequestInterceptor(() => rejection)

      const result = await composed(toolsCallEvent())

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toEqual(rejection)
    })

    it('denies when own logic passes but Intutic denies', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: false, reason: 'BLOCK: no deletes' }) }))
      const own = vi.fn(passThrough)
      const composed = composeRequestInterceptor(own)

      const result = await composed(toolsCallEvent({ name: 'delete_repo', id: 9 }))

      expect(own).toHaveBeenCalledTimes(1)
      expect(result.mcp.transformedGatewayRequest).toBeUndefined()
      const err = result.mcp.transformedGatewayResponse?.body as JsonRpcErrorBody
      expect(err.id).toBe(9)
      expect(err.error.message).toBe('Blocked by Intutic governance: BLOCK: no deletes')
    })

    it('returns own-logic output, rewrites included, when both allow', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true }) })
      vi.stubGlobal('fetch', fetchMock)
      const composed = composeRequestInterceptor((event) => {
        const body = event.mcp.gatewayRequest.body
        return {
          interceptorOutputVersion: '1.0',
          mcp: { transformedGatewayRequest: { body: { ...body, params: { ...body.params, name: 'read_file_v2' } } } },
        }
      })

      const result = await composed(toolsCallEvent({ name: 'read_file' }))

      // Intutic checks what will actually reach the target: the rewritten call.
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).toolName).toBe('read_file_v2')
      expect((result.mcp.transformedGatewayRequest?.body as { params: { name: string } }).params.name).toBe('read_file_v2')
    })

    it('fails closed on an Intutic network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const composed = composeRequestInterceptor(passThrough)

      const result = await composed(toolsCallEvent())

      expect(result.mcp.transformedGatewayRequest).toBeUndefined()
      const err = result.mcp.transformedGatewayResponse?.body as JsonRpcErrorBody
      expect(err.error.message).toContain('ECONNREFUSED')
      expect(err.error.message).toContain('failing closed')
    })

    it('fails closed when own logic throws, even with INTUTIC_FAIL_OPEN=true', async () => {
      process.env.INTUTIC_FAIL_OPEN = 'true'
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const composed = composeRequestInterceptor(() => {
        throw new Error('tenant lookup crashed')
      })

      const result = await composed(toolsCallEvent())

      expect(fetchMock).not.toHaveBeenCalled()
      const err = result.mcp.transformedGatewayResponse?.body as JsonRpcErrorBody
      expect(err.error.message).toContain('tenant lookup crashed')
    })

    it('passes RESPONSE events through without running own logic', async () => {
      const own = vi.fn(passThrough)
      const composed = composeRequestInterceptor(own)
      const body = { jsonrpc: '2.0', id: 1, result: {} }
      const result = await composed({
        interceptorInputVersion: '1.0',
        mcp: {
          gatewayRequest: toolsCallEvent().mcp.gatewayRequest,
          gatewayResponse: { statusCode: 200, body },
        },
      })
      expect(own).not.toHaveBeenCalled()
      expect(result.mcp.transformedGatewayResponse).toEqual({ statusCode: 200, body })
    })
  })
})
