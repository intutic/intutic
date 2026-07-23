/**
 * n8nHooks.ts — n8n governance workflow generator.
 *
 * n8n has no native SDK hook system. Governance is implemented via a
 * pre-built n8n workflow that users import into their n8n instance:
 *   - Webhook trigger listening on /webhook/intutic-governance
 *   - IF node filtering tool_blocked events
 *   - HTTP Request node forwarding events to the Intutic control plane
 *
 * LLD #14 — Phase 3 cross-harness defence (Gap 3, WS-B)
 * HLD §3.14 — Three-Tier Defense Cascade (Tier 1 Native Gating)
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLogger } from '@intutic/logger'
import { newIso } from '@intutic/id'

const log = createLogger('sync-n8n-hooks')

/** Default n8n governance workflow directory. */
const N8N_DIR = path.join(os.homedir(), '.intutic', 'n8n')

// ─── Static node UUIDs (hardcoded for workflow stability) ─────────────────────

const NODE_ID_WEBHOOK   = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const NODE_ID_IF        = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
const NODE_ID_HTTP      = 'c3d4e5f6-a7b8-9012-cdef-123456789012'
const NODE_ID_NO_OP     = 'd4e5f6a7-b8c9-0123-defa-234567890123'
const WORKFLOW_ID       = 'e5f6a7b8-c9d0-1234-efab-345678901234'

// ─── n8n workflow JSON builder ────────────────────────────────────────────────

function buildN8nWorkflow(proxyUrl: string, workspaceId: string): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: 'Intutic Governance — Hook Events',
    active: true,
    meta: {
      instanceId: 'intutic-sync-daemon',
      templateCredsSetupCompleted: true,
    },
    tags: [{ name: 'intutic' }, { name: 'governance' }],
    // n8n 1.x settings block
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: false,
      callerPolicy: 'workflowsFromSameOwner',
      errorWorkflow: '',
    },
    // Static credential placeholders (user fills in API key via n8n UI)
    staticData: null,
    nodes: [
      // ── Webhook trigger ──────────────────────────────────────────────────
      {
        id: NODE_ID_WEBHOOK,
        name: 'Intutic Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 1,
        position: [240, 300],
        parameters: {
          httpMethod: 'POST',
          path: 'intutic-governance',
          responseMode: 'onReceived',
          responseData: 'allEntries',
          options: {},
        },
        webhookId: 'intutic-governance',
      },
      // ── IF — filter tool_blocked events ──────────────────────────────────
      {
        id: NODE_ID_IF,
        name: 'Is Blocked?',
        type: 'n8n-nodes-base.if',
        typeVersion: 1,
        position: [480, 300],
        parameters: {
          conditions: {
            string: [
              {
                value1: '={{ $json.body.event }}',
                operation: 'equal',
                value2: 'tool_blocked',
              },
            ],
          },
        },
      },
      // ── HTTP Request — forward to Intutic control plane ───────────────────
      {
        id: NODE_ID_HTTP,
        name: 'Forward to Intutic',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 3,
        position: [720, 200],
        parameters: {
          method: 'POST',
          url: `${proxyUrl}/api/v1/hook-events`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              {
                name: 'Content-Type',
                value: 'application/json',
              },
              {
                name: 'Authorization',
                // Users should replace this with their API key via n8n Credentials
                value: 'Bearer {{ $env.INTUTIC_API_KEY }}',
              },
              {
                name: 'X-Intutic-Workspace-Id',
                value: workspaceId,
              },
            ],
          },
          sendBody: true,
          bodyParameters: {
            parameters: [],
          },
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ events: [$json.body] }) }}',
          options: {
            timeout: 10000,
          },
        },
      },
      // ── No-op for non-blocked events ──────────────────────────────────────
      {
        id: NODE_ID_NO_OP,
        name: 'Allowed (no-op)',
        type: 'n8n-nodes-base.noOp',
        typeVersion: 1,
        position: [720, 400],
        parameters: {},
      },
    ],
    // n8n 1.x connections format
    connections: {
      'Intutic Webhook': {
        main: [
          [
            { node: 'Is Blocked?', type: 'main', index: 0 },
          ],
        ],
      },
      'Is Blocked?': {
        main: [
          // true branch → forward to control plane
          [{ node: 'Forward to Intutic', type: 'main', index: 0 }],
          // false branch → no-op
          [{ node: 'Allowed (no-op)', type: 'main', index: 0 }],
        ],
      },
    },
    // Workflow metadata
    _intuticMeta: {
      generatedBy: 'intutic-sync-daemon',
      generatedAt: newIso(),
      workspaceId,
      proxyUrl,
      webhookPath: '/webhook/intutic-governance',
    },
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Write the n8n governance workflow and installation env snippet.
 *
 *  1. Writes `~/.intutic/n8n/governance-workflow.json` — importable n8n 1.x workflow.
 *  2. Writes `.intutic/env/n8n.env` with webhook URL and import instructions.
 *
 * Safe to call repeatedly — uses atomic rename (`.intutic-tmp` → final path).
 *
 * @param workspaceRoot - Absolute workspace root path.
 * @param proxyUrl      - Intutic control plane URL for the HTTP Request node.
 * @param workspaceId   - Workspace ID embedded in workflow metadata and HTTP headers.
 */
export async function writeN8nHooks(
  workspaceRoot: string,
  proxyUrl: string,
  workspaceId = '',
): Promise<void> {
  // ── 1. Ensure directories ──────────────────────────────────────────────────

  const envDir = path.join(workspaceRoot, '.intutic', 'env')

  await Promise.all([
    fs.mkdir(N8N_DIR, { recursive: true }),
    fs.mkdir(envDir, { recursive: true }),
  ])

  // ── 2. Write governance-workflow.json (atomic) ────────────────────────────

  const workflowPath = path.join(N8N_DIR, 'governance-workflow.json')
  const workflow = buildN8nWorkflow(proxyUrl, workspaceId)
  const tmpWorkflow = workflowPath + '.intutic-tmp'
  await fs.writeFile(tmpWorkflow, JSON.stringify(workflow, null, 2) + '\n', 'utf-8')
  await fs.rename(tmpWorkflow, workflowPath)

  log.info(
    { action: 'n8n_workflow_written', path: workflowPath },
    'n8n governance workflow written',
  )

  // ── 3. Write .intutic/env/n8n.env (atomic) ────────────────────────────────

  const envContent = [
    `# Intutic n8n governance env — auto-generated ${newIso()}`,
    `# This file is managed by the Intutic sync-daemon. DO NOT EDIT.`,
    `INTUTIC_N8N_WEBHOOK=http://localhost:5678/webhook/intutic-governance`,
    `# Import ~/.intutic/n8n/governance-workflow.json into your n8n instance.`,
    `# In n8n: Settings > Import Workflow > select the file above.`,
    `# Then activate the workflow and set INTUTIC_API_KEY as an n8n credential.`,
    workspaceId ? `INTUTIC_WORKSPACE_ID=${workspaceId}` : '',
  ].filter((l) => l !== '').join('\n') + '\n'

  const envFilePath = path.join(envDir, 'n8n.env')
  const tmpEnv = envFilePath + '.intutic-tmp'
  await fs.writeFile(tmpEnv, envContent, 'utf-8')
  await fs.rename(tmpEnv, envFilePath)

  log.info(
    { action: 'n8n_env_written', path: envFilePath },
    'n8n env snippet written',
  )
}
