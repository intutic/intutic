/**
 * httpJson.ts — the one HTTP client this package uses to talk to the control
 * plane (node:http/https; no fetch polyfill, no extra dependency).
 *
 * Rejects on a transport error, a timeout, or any status >= 400, with the
 * status in the message — a wrong or removed endpoint must surface as a
 * failure, never as an empty success.
 *
 * @module
 */

import * as node_https from 'node:https'
import * as node_http from 'node:http'

export function httpRequest(
  method: 'GET' | 'POST',
  url: string,
  apiKey: string,
  body?: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = new URL(url).protocol === 'https:' ? node_https : node_http
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = lib.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        const status = res.statusCode ?? 0
        if (status >= 400) reject(new Error(`HTTP ${method} ${url} returned ${status}: ${text.slice(0, 200)}`))
        else resolve(text)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`HTTP ${method} ${url} timed out`))
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export async function getJson(url: string, apiKey: string, timeoutMs?: number): Promise<unknown> {
  return JSON.parse(await httpRequest('GET', url, apiKey, undefined, timeoutMs)) as unknown
}

export async function postJson(url: string, apiKey: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
  const text = await httpRequest('POST', url, apiKey, JSON.stringify(payload), timeoutMs)
  return text ? (JSON.parse(text) as unknown) : null
}
