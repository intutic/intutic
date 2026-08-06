/**
 * n8n adapter — Real-time REST parameter sync.
 *
 * Interacts with n8n workflow management API (GET/PUT /api/v1/workflows)
 * to inject Intutic proxy URL and SOP governance rules as workflow variables.
 *
 * Supports local n8n instances by falling back to unauthenticated requests
 * if N8N_API_TOKEN is not provided.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * Tech Debt: TD-037 — n8n API Adapter
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'

// ─── n8n REST payloads ──────────────────────────────────────────────
//
// These describe the subset of the n8n public API this adapter touches. Every
// field is optional because the response is unvalidated JSON from a server
// whose version we do not control — the code below supplies a default for each
// one it needs rather than trusting the shape.

/** Entry in the `data` array of `GET /api/v1/workflows`. */
interface N8nWorkflowListEntry {
  id: string
  name?: string
}

interface N8nWorkflowListResponse {
  data?: N8nWorkflowListEntry[]
}

/**
 * Workflow `settings` blob. n8n keeps its own keys here (executionOrder,
 * timezone, error workflow, …) which this adapter does not interpret but must
 * round-trip, hence the index signature.
 */
interface N8nWorkflowSettings {
  variables?: Record<string, string>
  [key: string]: unknown
}

/** Workflow as returned by `GET /api/v1/workflows/{id}`. */
interface N8nWorkflowDetail {
  id?: string
  name?: string
  /** Opaque to this adapter — round-tripped unchanged. */
  nodes?: unknown[]
  connections?: Record<string, unknown>
  settings?: N8nWorkflowSettings
  staticData?: unknown
}

/**
 * Body accepted by `PUT /api/v1/workflows/{id}`.
 *
 * The n8n public API validates this body with `additionalProperties: false`,
 * so it must carry the writable fields and nothing else. Read-only fields that
 * come back on the GET (`id`, `active`, `createdAt`, `updatedAt`, `tags`,
 * `versionId`, …) make the request fail with HTTP 400.
 */
interface N8nWorkflowUpdateBody {
  name: string
  nodes: unknown[]
  connections: Record<string, unknown>
  settings: N8nWorkflowSettings
  staticData?: unknown
}

// Format SOPs for n8n parameters
function buildSopsMarkdown(sops: SyncSopEntry[]): string {
  if (sops.length === 0) return ''
  return sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n') + '\n'
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (process.env.N8N_API_TOKEN) {
    headers['X-N8N-API-KEY'] = process.env.N8N_API_TOKEN
  }
  return headers
}

export const n8nAdapter: IHarnessAdapter = {
  type: HarnessType.N8N,
  configFileName: '',

  async detect(_workspaceRoot: string): Promise<boolean> {
    const n8nUrl = process.env.N8N_URL || 'http://localhost:5678'
    try {
      const res = await fetch(`${n8nUrl}/api/v1/health`, { signal: AbortSignal.timeout(1000) })
      return res.status === 200 || res.status === 401 || res.status === 403
    } catch {
      return !!process.env.N8N_API_TOKEN
    }
  },

  async writeConfig(_workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const n8nUrl = process.env.N8N_URL || 'http://localhost:5678'
    const sopsMarkdown = buildSopsMarkdown(sops)

    try {
      // 1. Get list of workflows
      const listRes = await fetch(`${n8nUrl}/api/v1/workflows`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5000),
      })

      if (!listRes.ok) {
        throw new Error(`Failed to list workflows: ${listRes.statusText}`)
      }

      const listData = (await listRes.json()) as N8nWorkflowListResponse
      const workflows = listData.data || []

      if (workflows.length === 0) {
        return 'n8n:no_workflows'
      }

      // 2. Inject parameters into variables of each workflow
      let updated = 0
      for (const w of workflows) {
        const detailRes = await fetch(`${n8nUrl}/api/v1/workflows/${w.id}`, {
          headers: getHeaders(),
          signal: AbortSignal.timeout(5000),
        })

        if (!detailRes.ok) continue

        const detail = (await detailRes.json()) as N8nWorkflowDetail

        // Inject Intutic values, preserving the workflow's own settings and
        // any variables it already had.
        const settings: N8nWorkflowSettings = {
          ...detail.settings,
          variables: {
            ...detail.settings?.variables,
            intutic_proxy_url: proxyUrl,
            intutic_governance_rules: sopsMarkdown,
          },
        }

        // Only the writable fields — see N8nWorkflowUpdateBody. Echoing the
        // whole GET payload back (which is what this used to do) is rejected
        // by the API's additionalProperties check.
        const body: N8nWorkflowUpdateBody = {
          name: detail.name ?? w.name ?? 'Untitled',
          nodes: detail.nodes ?? [],
          connections: detail.connections ?? {},
          settings,
        }
        if (detail.staticData !== undefined) {
          body.staticData = detail.staticData
        }

        // Save updated workflow
        const updateRes = await fetch(`${n8nUrl}/api/v1/workflows/${w.id}`, {
          method: 'PUT',
          headers: getHeaders(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })

        if (!updateRes.ok) {
          console.warn(
            `[n8n-adapter] workflow ${w.id} was not updated: HTTP ${updateRes.status} ${updateRes.statusText}`,
          )
          continue
        }
        updated++
      }

      // Reporting a write that every workflow rejected as a success left the
      // sync daemon recording a config version it had never applied.
      if (updated === 0) return null

      return `n8n:${updated}_workflows`
    } catch (err) {
      console.warn(`[n8n-adapter] failed to sync parameters:`, err)
      return null
    }
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    const n8nUrl = process.env.N8N_URL || 'http://localhost:5678'
    try {
      const listRes = await fetch(`${n8nUrl}/api/v1/workflows`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(3000),
      })

      if (!listRes.ok) return null

      const listData = (await listRes.json()) as N8nWorkflowListResponse
      const workflows = listData.data || []
      if (workflows.length === 0) return null

      // Fetch the first workflow's variables to compute the hash
      const firstId = workflows[0].id
      const detailRes = await fetch(`${n8nUrl}/api/v1/workflows/${firstId}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(3000),
      })

      if (!detailRes.ok) return null

      const detail = (await detailRes.json()) as N8nWorkflowDetail
      const rules = detail.settings?.variables?.intutic_governance_rules ?? ''
      if (!rules) return null

      return createHash('sha256').update(rules, 'utf-8').digest('hex')
    } catch {
      return null
    }
  },
}
