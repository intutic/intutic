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

/** A response with an error status, carrying the status for a caller that acts on it. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

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
        if (status >= 400) reject(new HttpStatusError(status, `HTTP ${method} ${url} returned ${status}: ${text.slice(0, 200)}`))
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

/**
 * GETs a binary body, refusing one larger than `maxBytes` as soon as it is:
 * the custom-rule binaries (`wasm/cloudRules.ts`) are the one non-JSON body
 * this package reads, and their size is the control plane's to promise, not
 * this process's to trust.
 */
export function getBytes(url: string, apiKey: string, maxBytes: number, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = new URL(url).protocol === 'https:' ? node_https : node_http
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/wasm' }
    const req = lib.request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error(`HTTP GET ${url} returned more than ${maxBytes} bytes`))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (status >= 400) reject(new HttpStatusError(status, `HTTP GET ${url} returned ${status}: ${body.toString('utf-8').slice(0, 200)}`))
        else resolve(body)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`HTTP GET ${url} timed out`))
    })
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
