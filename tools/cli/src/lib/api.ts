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

/** API client for control plane communication. */
export interface ApiClient {
  fetchConfig(workspaceId: string): Promise<SyncConfigPayload>
  reportStatus(status: DaemonStatus): Promise<{ ack: boolean; configVersion: number }>
  reportHashes(report: SopHashReport): Promise<{ driftCount: number }>
  getMe(): Promise<{ email: string; memberId: string; workspaceId: string; role: string }>
  login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string; workspaceId: string; email: string; memberId: string }>
  /** Generic GET request for arbitrary API paths. */
  get<T>(path: string): Promise<T>
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

    const data = await res.json()
    if (
      data &&
      typeof data === 'object' &&
      'format' in data &&
      data.format === 'toon' &&
      typeof data.data === 'string' &&
      typeof data.listProperty === 'string'
    ) {
      const decoded = toonDecode(data.data)
      data[data.listProperty] = decoded
      delete data.format
      delete data.data
      delete data.listProperty
    }

    return data as T
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

    async post<T>(path: string, body?: unknown): Promise<T> {
      return request<T>('POST', path, body)
    },

    async put<T>(path: string, body?: unknown): Promise<T> {
      return request<T>('PUT', path, body)
    },
  }
}

function toonDecode(toon: string): Record<string, unknown>[] {
  const lines = toon.trimEnd().split('\n')
  if (lines.length < 1) return []
  const header = lines[0]
  if (!header.startsWith('TOON|')) return []
  const colsStr = header.slice(5) // 'TOON|'.length
  if (colsStr === '(empty)') return []
  const cols = colsStr.split(',')
  const rows: Record<string, unknown>[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = line
      .replace(/\\\|/g, '\x00')
      .split('|')
      .map((c) => c.split('\x00').join('|').replace(/\\n/g, '\n'))
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) {
      const raw = cells[i] ?? '-'
      if (raw === '-') {
        obj[cols[i]] = null
        continue
      }
      if (raw === 't') {
        obj[cols[i]] = true
        continue
      }
      if (raw === 'f') {
        obj[cols[i]] = false
        continue
      }
      const num = Number(raw)
      if (!isNaN(num) && raw !== '') {
        obj[cols[i]] = num
        continue
      }
      if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
          obj[cols[i]] = JSON.parse(raw)
          continue
        } catch {
          /* fall through */
        }
      }
      obj[cols[i]] = raw
    }
    rows.push(obj)
  }
  return rows
}
