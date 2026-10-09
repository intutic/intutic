/**
 * n8n adapter — the workflow-level gate.
 *
 * Writes the external-hook gate module (`~/.intutic/hooks/
 * n8n-governance-hook.js`) with its INSTALL.md — see n8nHooks.ts. The gate
 * takes effect only once the n8n operator sets EXTERNAL_HOOK_FILES to it.
 *
 * Rule sets are not written anywhere for n8n: n8n has no file or setting it
 * loads as standing instructions. An AI Agent node's system message is a
 * parameter of that node, written by whoever builds the workflow. Earlier
 * versions put the rule sets in each workflow's `settings.variables` through
 * `PUT /api/v1/workflows/{id}`, but the public API's workflow-settings schema
 * has had `additionalProperties: false` since the API was introduced, with no
 * free-text field, so every one of those updates was refused with a 400
 * (https://github.com/n8n-io/n8n/blob/6fc0aeda35ea62ee353dd80b0f8d3e0f1f4e50d0/packages/cli/src/public-api/v1/handlers/workflows/spec/schemas/workflowSettings.yml).
 * n8n's instance variables are no substitute: a value is capped at 1,000
 * characters and the feature needs a paid licence
 * (https://github.com/n8n-io/n8n/blob/6fc0aeda35ea62ee353dd80b0f8d3e0f1f4e50d0/packages/@n8n/api-types/src/dto/variables/base.dto.ts).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 *
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { writeN8nHooks } from '@intutic/sync-daemon'

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

  /** The local external-hook gate. */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writeN8nHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  /** No rules file: see the module doc. */
  async writeConfig(): Promise<string | null> {
    return null
  },

  async readCurrentHash(): Promise<string | null> {
    return null
  },
}
