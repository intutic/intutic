import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, Server } from 'http'
import { ClawdeClient } from '../src/client'
import { ClawdeBlockedError, ClawdeConnectionError, ClawdeVerdictError } from '../src/errors'

interface Reply {
  status: number
  body: unknown
  headers?: Record<string, string>
  /** Sent as is instead of `body`, for an event stream. */
  raw?: string
}

interface Received {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any
}

/** The proxy's error body, as `json_error` in packages/proxy/src/proxy.rs writes it. */
const proxyError = (type: string, message: string) => ({ error: { type, message } })

const completion = {
  id: 'chatcmpl-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response from proxy' }, finish_reason: 'stop' }],
}

describe('ClawdeClient', () => {
  let server: Server
  let baseUrl: string
  let replies: Reply[] = []
  let received: Received[] = []

  beforeAll(() => {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          received.push({ path: req.url ?? '', headers: req.headers, body: body ? JSON.parse(body) : undefined })
          // The last reply repeats, so "always 503" is one entry.
          const reply = replies.length > 1 ? replies.shift()! : replies[0]
          res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers })
          res.end(reply.raw ?? JSON.stringify(reply.body))
        })
      })
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    replies = []
    received = []
  })

  const client = (extra: Partial<ConstructorParameters<typeof ClawdeClient>[0]> = {}) =>
    new ClawdeClient({ apiKey: 'vk_test_123', baseUrl, autoContext: false, ...extra })

  const ask = (c: ClawdeClient) => c.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] })

  it('reports allow on a 2xx and sends only headers the proxy reads', async () => {
    replies = [{ status: 200, body: completion }]

    const response = await ask(client())

    expect(response.verdict).toBe('allow')
    expect(response.choices[0].message.content).toBe('Mock response from proxy')
    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/v1/chat/completions')
    const headers = received[0].headers
    expect(headers['authorization']).toBe('Bearer vk_test_123')
    expect(headers['x-intutic-graph-id']).toBeTruthy()
    // Never read by the proxy, which forwards unknown headers to the provider.
    expect(headers['x-intutic-context']).toBeUndefined()
    expect(headers['x-intutic-cost-limit']).toBeUndefined()
    expect(headers['x-intutic-sensitivity']).toBeUndefined()
  })

  it.each([
    [403, 'policy_denied', 'kill'],
    [403, 'model_not_allowed', 'kill'],
    [403, 'LOOP_RUN_TERMINATED', 'kill'],
    [403, 'LOOP_RUN_PENDING_REVIEW', 'hold'],
    [409, 'policy_reask', 'reask'],
    [403, 'GOVERNANCE_UNAVAILABLE', 'kill'],
    [429, 'BUDGET_EXCEEDED', 'kill'],
    [429, 'OVERAGE_HARD_CAP_EXCEEDED', 'kill'],
    [402, 'COST_GATE_EXCEEDED', 'kill'],
    [400, 'dlp_policy_violation', 'kill'],
  ])('a %i %s refusal is not retried, fires %s and throws ClawdeBlockedError', async (status, code, verdict) => {
    replies = [{ status, body: proxyError(code, `refused: ${code}`) }]
    const c = client()
    const events: any[] = []
    c.on(verdict as 'kill' | 'reask' | 'hold', (event) => { events.push(event) })

    const err = await ask(c).catch((e) => e)

    expect(err).toBeInstanceOf(ClawdeBlockedError)
    // Callers that already catch ClawdeVerdictError for blocks keep working.
    expect(err).toBeInstanceOf(ClawdeVerdictError)
    expect(err).toMatchObject({ verdict, code, status, message: `refused: ${code}` })
    expect(received).toHaveLength(1)
    expect(events).toEqual([{ verdict, code, status, message: `refused: ${code}` }])
  })

  // The cost-prediction gate answers a non-streaming request with a 200 whose
  // assistant turn explains the estimate. It used to come back as `allow`.
  it('treats a 200 the proxy names as a refusal as one, not as an answer', async () => {
    const explanation = 'This request is estimated to cost $1.2000, which exceeds your workspace threshold of $0.5000.'
    replies = [{
      status: 200,
      headers: { 'x-intutic-refusal': 'COST_GATE_EXCEEDED' },
      body: { ...completion, choices: [{ index: 0, message: { role: 'assistant', content: explanation }, finish_reason: 'stop' }] },
    }]
    const c = client()
    const events: any[] = []
    c.on('kill', (event) => { events.push(event) })

    const err = await ask(c).catch((e) => e)

    expect(err).toBeInstanceOf(ClawdeBlockedError)
    expect(err).toMatchObject({ verdict: 'kill', code: 'COST_GATE_EXCEEDED', status: 200, message: explanation })
    expect(events).toEqual([{ verdict: 'kill', code: 'COST_GATE_EXCEEDED', status: 200, message: explanation }])
    expect(received).toHaveLength(1)
  })

  // The proxy's response gate withholds a tool call the model made and puts
  // the reason in its place. That 200 used to come back as `allow`.
  it.each([
    ['TOOL_DENIED', 'deny_tools.Bash'],
    ['SSO_GROUP', 'sso_group.high_risk.Bash'],
    ['SQL_GUARD', 'sql_guard.sql_allow_dsns'],
    ['RESPONSE_UNPARSEABLE', 'response_gate.fail_closed'],
    ['OUTPUT_DLP', 'dlp.aws_access_key'],
  ])('throws a withheld answer named %s with its rule id', async (code, ruleId) => {
    const reason = `[Intutic] Blocked: ${code}`
    replies = [{
      status: 200,
      headers: { 'x-intutic-refusal': code, 'x-intutic-refusal-rule': ruleId },
      body: { ...completion, choices: [{ index: 0, message: { role: 'assistant', content: reason }, finish_reason: 'stop' }] },
    }]
    const c = client()
    const events: any[] = []
    c.on('kill', (event) => { events.push(event) })

    const err = await ask(c).catch((e) => e)

    expect(err).toBeInstanceOf(ClawdeBlockedError)
    expect(err).toMatchObject({ verdict: 'kill', code, status: 200, message: reason, ruleId })
    expect(events).toEqual([{ verdict: 'kill', code, status: 200, message: reason, ruleId }])
    expect(received).toHaveLength(1)
  })

  it('throws a refusal a stream names in its marker line, not a connection error', async () => {
    const reason = '[Intutic] Blocked tool call: Bash.'
    replies = [{
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: null,
      raw:
        'data: {"choices":[{"index":0,"delta":{"content":"Let me look."}}]}\n\n' +
        `: intutic-refusal ${JSON.stringify({ code: 'TOOL_DENIED', rule: 'deny_tools.Bash', message: reason })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reason } }] })}\n\ndata: [DONE]\n\n`,
    }]

    const err = await client().chat({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'Hello' }] }).catch((e) => e)

    expect(err).toBeInstanceOf(ClawdeBlockedError)
    expect(err).toMatchObject({ verdict: 'kill', code: 'TOOL_DENIED', status: 200, message: reason, ruleId: 'deny_tools.Bash' })
  })

  it('retries a 5xx and returns the answer that follows', async () => {
    replies = [
      { status: 503, body: proxyError('BUDGET_UNVERIFIABLE', 'Retry shortly.') },
      { status: 502, body: proxyError('upstream_error', 'connection reset') },
      { status: 200, body: completion },
    ]

    const response = await ask(client())

    expect(response.verdict).toBe('allow')
    expect(received).toHaveLength(3)
  })

  it('throws ClawdeConnectionError once every attempt has failed with a 5xx', async () => {
    replies = [{ status: 500, body: proxyError('build_error', 'boom') }]

    await expect(ask(client({ retries: 1 }))).rejects.toThrow(ClawdeConnectionError)
    expect(received).toHaveLength(2)
  })

  it.each([
    [403, proxyError('workspace_mismatch', 'key belongs to another workspace')],
    [429, { error: { type: 'rate_limit_error', message: 'provider rate limit' } }],
    [409, { error: 'conflict' }],
  ])('a %i that is not a governance refusal throws ClawdeConnectionError without retrying', async (status, body) => {
    replies = [{ status, body }]
    const c = client()
    let fired = false
    for (const v of ['kill', 'reask', 'hold'] as const) c.on(v, () => { fired = true })

    const err = await ask(c).catch((e) => e)

    expect(err).toBeInstanceOf(ClawdeConnectionError)
    expect(err).not.toBeInstanceOf(ClawdeVerdictError)
    expect(err.message).toContain(String(status))
    expect(received).toHaveLength(1)
    expect(fired).toBe(false)
  })

  it('retries an unreachable proxy and throws ClawdeConnectionError', async () => {
    const c = new ClawdeClient({ apiKey: 'vk_x', baseUrl: 'http://127.0.0.1:1', autoContext: false, retries: 1 })
    await expect(ask(c)).rejects.toThrow(/after 2 attempts/)
  })

  it("sends provider 'anthropic' requests to the proxy's Messages route in Messages shape", async () => {
    replies = [{
      status: 200,
      body: {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Hi from Claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }]

    const response = await client({ provider: 'anthropic' }).chat({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
    })

    expect(received[0].path).toBe('/v1/messages')
    expect(received[0].headers['x-api-key']).toBe('vk_test_123')
    expect(received[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(received[0].body).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: 'Be brief.',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }],
    })
    expect(response.verdict).toBe('allow')
    expect(response.choices[0].message.content).toBe('Hi from Claude')
    expect(response.usage?.total_tokens).toBe(7)
  })
})
