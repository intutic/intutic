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

      const listData = (await listRes.json()) as { data?: Array<{ id: string; name: string }> }
      const workflows = listData.data || []

      if (workflows.length === 0) {
        return 'n8n:no_workflows'
      }

      // 2. Inject parameters into variables of each workflow
      for (const w of workflows) {
        const detailRes = await fetch(`${n8nUrl}/api/v1/workflows/${w.id}`, {
          headers: getHeaders(),
          signal: AbortSignal.timeout(5000),
        })

        if (!detailRes.ok) continue

        const detail = (await detailRes.json()) as any
        const settings = detail.settings || {}
        const variables = settings.variables || {}

        // Inject Intutic values
        variables.intutic_proxy_url = proxyUrl
        variables.intutic_governance_rules = sopsMarkdown
        settings.variables = variables
        detail.settings = settings

        // Save updated workflow
        await fetch(`${n8nUrl}/api/v1/workflows/${w.id}`, {
          method: 'PUT',
          headers: getHeaders(),
          body: JSON.stringify(detail),
          signal: AbortSignal.timeout(5000),
        })
      }

      return `n8n:${workflows.length}_workflows`
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

      const listData = (await listRes.json()) as { data?: Array<{ id: string }> }
      const workflows = listData.data || []
      if (workflows.length === 0) return null

      // Fetch the first workflow's variables to compute the hash
      const firstId = workflows[0].id
      const detailRes = await fetch(`${n8nUrl}/api/v1/workflows/${firstId}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(3000),
      })

      if (!detailRes.ok) return null

      const detail = (await detailRes.json()) as any
      const rules = detail.settings?.variables?.intutic_governance_rules || ''
      if (!rules) return null

      return createHash('sha256').update(rules, 'utf-8').digest('hex')
    } catch {
      return null
    }
  },
}
