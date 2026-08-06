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
 * Split one encoded TOON row into cells, unescaping as it goes.
 *
 * MUST stay behaviourally identical to `splitCells` in the control plane's
 * `services/control-plane/src/lib/toon.ts` and in `apps/dashboard/src/lib/api.ts`.
 * This is the read side of a wire format whose only writer is that encoder.
 *
 * A single left-to-right pass, not a chain of `.replace()` calls. The decoder
 * this replaces substituted a NUL placeholder for `\|` before splitting on `|`,
 * which cannot express the `\\` the encoder emits for a literal backslash:
 * given `x\\|y` the regex pairs the SECOND backslash with the delimiter and
 * swallows it, so two columns merge and every later column shifts one place
 * left. On an incidents row that silently rewrites `severity` to the trace id
 * and `workspace_id` to null — a CRITICAL incident stops printing as CRITICAL.
 * The value is attacker-reachable: `routes/incidents.ts` builds `description`
 * from the hook event's `reason`, which any holder of a workspace API key sets
 * on `POST /api/v1/hook-events`.
 *
 * A lone backslash before anything other than `\`, `|` or `n` is kept literal
 * rather than dropped, so a payload from a control plane that predates the
 * encoder fix degrades to a stale value rather than a discarded character.
 */
function splitCells(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      const next = line[i + 1]
      if (next === '\\') { cur += '\\'; i++; continue }
      if (next === '|') { cur += '|'; i++; continue }
      if (next === 'n') { cur += '\n'; i++; continue }
      cur += '\\'
      continue
    }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells
}

export function toonDecode(toon: string): Record<string, unknown>[] {
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
    const cells = splitCells(line)
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
