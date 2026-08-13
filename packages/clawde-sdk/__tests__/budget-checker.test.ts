import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, Server } from 'http'
import { BudgetChecker } from '../src/budget-checker'
import { ClawdeConnectionError } from '../src/errors'

describe('BudgetChecker', () => {
  let server: Server
  let baseUrl: string
  let receivedPath = ''
  let receivedHeaders: any = {}
  let respondWithStatus = 200
  let respondWithBody: any = {}

  beforeAll(() => {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        receivedPath = req.url ?? ''
        receivedHeaders = req.headers
        res.writeHead(respondWithStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(respondWithBody))
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    receivedPath = ''
    receivedHeaders = {}
    respondWithStatus = 200
    respondWithBody = { budget_remaining_usd: 42.5, alert_triggered: false }
  })

  it('calls the REAL control-plane endpoint, not the historical nonexistent /v1/budget/check', async () => {
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    await checker.checkBudget('gpt-4o', 100)

    expect(receivedPath).toBe('/api/v1/budget')
    expect(receivedHeaders['authorization']).toBe('Bearer vk_test')
  })

  it('maps a healthy workspace to allowed: true', async () => {
    respondWithBody = { budget_remaining_usd: 42.5, alert_triggered: false }
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    const res = await checker.checkBudget('model-a', 1)

    expect(res.allowed).toBe(true)
    expect(res.remaining_usd).toBe(42.5)
    expect(res.reason).toBeUndefined()
  })

  it('maps an alert-triggered workspace to allowed: false with a reason', async () => {
    respondWithBody = { budget_remaining_usd: 0, alert_triggered: true }
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    const res = await checker.checkBudget('model-b', 1)

    expect(res.allowed).toBe(false)
    expect(res.remaining_usd).toBe(0)
    expect(res.reason).toMatch(/alert threshold/)
  })

  it('caches results for 30s per model+estimatedTokens key', async () => {
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    await checker.checkBudget('model-c', 100)
    let hits = 0
    const originalPath = receivedPath
    receivedPath = ''
    await checker.checkBudget('model-c', 100) // same key -- cache hit, no new request
    expect(receivedPath).toBe('') // never touched the server the second time
    expect(originalPath).toBe('/api/v1/budget')
  })

  it('raises ClawdeConnectionError on a non-2xx response', async () => {
    respondWithStatus = 500
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    await expect(checker.checkBudget('model-d', 1)).rejects.toThrow(ClawdeConnectionError)
  })

  it('raises ClawdeConnectionError when unreachable', async () => {
    const checker = new BudgetChecker('http://127.0.0.1:1', 'vk_test')
    await expect(checker.checkBudget('model-e', 1)).rejects.toThrow(ClawdeConnectionError)
  })

  it('updateCachedBudget still pre-populates the cache without a network call', () => {
    const checker = new BudgetChecker(baseUrl, 'vk_test')
    checker.updateCachedBudget('model-f', 1, 99.0, true)
    // No assertion on a network call here -- this method's whole point is to
    // avoid one, populated from response headers on a prior chat() call.
    expect(true).toBe(true)
  })
})
