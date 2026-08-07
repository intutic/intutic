/**
 * HTTP client for Intutic control plane API.
 *
 * Uses native fetch() (Node 18+). All requests include
 * Authorization: Bearer <apiKey> header.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import type {
  SyncConfigPayload,
  DaemonStatus,
  SopHashReport,
} from '@intutic/shared-types'
import { toonDecode as sharedToonDecode } from '@intutic/shared-types'

/** API client for control plane communication. */
export interface ApiClient {
  fetchConfig(workspaceId: string): Promise<SyncConfigPayload>
  reportStatus(status: DaemonStatus): Promise<{ ack: boolean; configVersion: number }>
  reportHashes(report: SopHashReport): Promise<{ driftCount: number }>
  getMe(): Promise<{ email: string; memberId: string; workspaceId: string; role: string }>
  login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string; workspaceId: string; email: string; memberId: string }>
  /** Generic GET request for arbitrary API paths. */
  get<T>(path: string): Promise<T>
  /**
   * GET that hands back the status instead of throwing on it.
   *
   * For endpoints where a non-2xx *is* the answer: `/api/v1/integrity/chain`
   * returns 409 with the whole chain walk in the body when a root names a
   * predecessor that is not there. `get()` throws on any non-2xx, which would
   * leave the caller digging the break out of an error message.
   */
  getWithStatus<T>(path: string): Promise<{ status: number; body: T }>
  /** Generic POST request for arbitrary API paths. */
  post<T>(path: string, body?: unknown): Promise<T>
  /** Generic PUT request for arbitrary API paths. */
  put<T>(path: string, body?: unknown): Promise<T>
}

/**
 * Create an API client bound to a control plane URL and API key.
 *
 * @param controlPlaneUrl - Base URL (e.g., http://localhost:3001 or https://api.intutic.ai)
 * @param apiKey - API key (vk_*) or JWT access token
 */
export function createApiClient(controlPlaneUrl: string, apiKey: string): ApiClient {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${controlPlaneUrl}${path}`
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`)
    }

    return unwrapToonEnvelope(await res.json()) as T
  }

  return {
    async fetchConfig(workspaceId: string): Promise<SyncConfigPayload> {
      return request<SyncConfigPayload>('POST', '/api/v1/sync/config', { workspaceId })
    },

    async reportStatus(status: DaemonStatus): Promise<{ ack: boolean; configVersion: number }> {
      return request('POST', '/api/v1/sync/status', status)
    },

    async reportHashes(report: SopHashReport): Promise<{ driftCount: number }> {
      return request('POST', '/api/v1/sync/sop-hash', report)
    },

    async getMe(): Promise<{ email: string; memberId: string; workspaceId: string; role: string }> {
      return request('GET', '/api/v1/auth/me')
    },

    async login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string; workspaceId: string; email: string; memberId: string }> {
      return request('POST', '/api/v1/auth/login', { email, password })
    },

    async get<T>(path: string): Promise<T> {
      return request<T>('GET', path)
    },

    async getWithStatus<T>(path: string): Promise<{ status: number; body: T }> {
      const res = await fetch(`${controlPlaneUrl}${path}`, { method: 'GET', headers })
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        // Kept rather than discarded: a proxy's HTML error page is the thing
        // that explains a status the caller did not expect.
        body = { error: text }
      }
      return { status: res.status, body: body as T }
    },

    async post<T>(path: string, body?: unknown): Promise<T> {
      return request<T>('POST', path, body)
    },

    async put<T>(path: string, body?: unknown): Promise<T> {
      return request<T>('PUT', path, body)
    },
  }
}

/**
 * Decodes a TOON payload, normalising "not TOON" to an empty list.
 *
 * The format lives in `@intutic/shared-types`, imported rather than copied. It
 * used to be a private `splitCells` here, byte-identical to one in the dashboard
 * and a third in the control plane, with a comment in each saying they must not
 * diverge. They did — an escaping fix reached the encoder and the control
 * plane's own decoder, which nothing calls, while these two kept the old code
 * and a CRITICAL incident carried on printing as its trace id.
 *
 * The shared decoder returns `null` for input that is not TOON; this surface has
 * always returned a list, and its caller assigns the result straight onto the
 * response object, so the shape is preserved here rather than pushed outward.
 */
export function toonDecode(toon: string): Record<string, unknown>[] {
  return sharedToonDecode(toon) ?? []
}

/**
 * Move a TOON-encoded list out of its envelope and onto `listProperty`.
 *
 * Extracted from `request` because it was inline and therefore untestable, and
 * it was wrong: the old code assigned the decoded rows and only THEN deleted
 * `data`. `listProperty` names where the rows should land, and for
 * `/api/v1/incidents` that name IS `data` — so the rows were written and
 * immediately deleted, and any incidents response over the 20-row TOON
 * threshold arrived as `{meta:{total:22}}`. Zero rows, no error.
 * `/api/v1/traces` escaped only because its listProperty is `traces`.
 *
 * Non-TOON bodies pass through untouched.
 */
export function unwrapToonEnvelope(data: unknown): unknown {
  if (
    !data ||
    typeof data !== 'object' ||
    !('format' in data) ||
    (data as Record<string, unknown>)['format'] !== 'toon'
  ) {
    return data
  }
  const body = data as Record<string, unknown>
  const listProperty = body['listProperty']
  if (typeof body['data'] !== 'string' || typeof listProperty !== 'string') return data

  const decoded = toonDecode(body['data'])
  delete body['format']
  delete body['data']
  delete body['listProperty']
  body[listProperty] = decoded
  return body
}

