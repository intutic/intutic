import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'http'
import { ClawdeClient } from '../src/client'
import { ClawdeVerdictError, ClawdeConnectionError } from '../src/errors'

describe('ClawdeClient', () => {
  let server: Server
  let serverPort: number
  let receivedHeaders: any = {}
  let receivedBody: any = {}
  let respondWithStatus = 200
  let respondWithHeaders: Record<string, string> = {}
  let respondWithBody: any = {}

  beforeAll(() => {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        receivedHeaders = req.headers
        
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          if (body) {
            try {
              receivedBody = JSON.parse(body)
            } catch {
              receivedBody = body
            }
          }
          
          res.writeHead(respondWithStatus, {
            'Content-Type': 'application/json',
            ...respondWithHeaders,
          })
          res.end(JSON.stringify(respondWithBody))
        })
      })

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any
        serverPort = addr.port
        resolve()
      })
    })
  })

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('correctly passes virtual api key, context, and cost limits to proxy gateway', async () => {
    respondWithStatus = 200
    respondWithHeaders = {
      'x-intutic-verdict': 'allow',
      'x-intutic-budget-remaining': '45.50',
      'x-intutic-budget-pct': '8.2',
    }
    respondWithBody = {
      id: 'chatcmpl-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Mock response from proxy' },
          finish_reason: 'stop',
        },
      ],
    }

    const client = new ClawdeClient({
      apiKey: 'vk_test_123',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      autoContext: false, // keep it simple
    })

    const response = await client.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      max_cost_usd: 1.5,
      sensitivity_tier: 'high',
    })

    // Verify headers forwarded to the proxy
    expect(receivedHeaders['authorization']).toBe('Bearer vk_test_123')
    expect(receivedHeaders['x-intutic-cost-limit']).toBe('1.5')
    expect(receivedHeaders['x-intutic-sensitivity']).toBe('high')
    expect(receivedHeaders['x-intutic-context']).toBe('{}')

    // Verify returned payload decorations
    expect(response.verdict).toBe('allow')
    expect(response.budgetRemainingUsd).toBe(45.50)
    expect(response.budgetPctUsed).toBe(8.2)
    expect(response.choices[0].message.content).toBe('Mock response from proxy')
  })

  it('triggers registered event listeners on hijack/kill verdicts', async () => {
    respondWithStatus = 200
    respondWithHeaders = {
      'x-intutic-verdict': 'hijack',
    }
    respondWithBody = {
      id: 'chatcmpl-hijack',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hijacked content' },
          finish_reason: 'stop',
        },
      ],
    }

    const client = new ClawdeClient({
      apiKey: 'vk_test_456',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      autoContext: false,
    })

    let hijackFired = false
    client.on('hijack', (data) => {
      hijackFired = true
      expect(data.verdict).toBe('hijack')
    })

    const response = await client.chat({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'test hijack' }],
    })

    expect(response.verdict).toBe('hijack')
    expect(hijackFired).toBe(true)
  })

  it('throws ClawdeVerdictError immediately when proxy verdict is KILL', async () => {
    respondWithStatus = 200
    respondWithHeaders = {
      'x-intutic-verdict': 'kill',
    }
    respondWithBody = {
      id: 'chatcmpl-killed',
      choices: [],
    }

    const client = new ClawdeClient({
      apiKey: 'vk_test_kill',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      autoContext: false,
    })

    let killFired = false
    client.on('kill', () => {
      killFired = true
    })

    await expect(client.chat({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'attack payload' }],
    })).rejects.toThrow(ClawdeVerdictError)

    expect(killFired).toBe(true)
  })
})
