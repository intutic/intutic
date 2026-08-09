/**
 * n8nHooks.ts — n8n governance: workflow-level blocking gate + event workflow.
 *
 * Two artifacts, honest about what each is:
 *
 * 1. **The blocking gate** (`~/.intutic/hooks/n8n-governance-hook.js`) — an
 *    n8n *external hook* module. n8n's only pre-execution mechanism is
 *    deployment-level: the operator sets
 *    `EXTERNAL_HOOK_FILES=/path/to/n8n-governance-hook.js` in the n8n
 *    process's environment, and the module's `workflow.preExecute` function
 *    then runs before every workflow execution, receiving the full Workflow
 *    object (all nodes and their parameters). **Throwing aborts the
 *    execution** — this is genuinely blocking, but per WORKFLOW, not per tool
 *    call, and installation is manual and deployment-side: this daemon cannot
 *    set another process's environment (the same reason open-webui's filter
 *    is installed by hand — see openWebuiHooks.ts). `INSTALL.md` next to the
 *    workflow JSON explains the env var.
 *
 * 2. **The event-forwarding workflow** (`~/.intutic/n8n/governance-workflow.json`)
 *    — an importable n8n workflow (webhook → IF → HTTP Request) that forwards
 *    tool_blocked events to the control plane. Telemetry, not enforcement.
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
import { emitN8nWorkflowGate } from './gateBody.js'

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

// ─── External-hook gate builder ───────────────────────────────────────────────

/**
 * The blocking gate — an n8n external-hook module whose `workflow.preExecute`
 * throws to abort an execution. See the module header for the
 * `EXTERNAL_HOOK_FILES` contract and why installation is manual.
 */
function buildN8nGovernanceHook(proxyUrl: string, workspaceId: string): string {
  return `/**
 * Intutic n8n governance gate (external hook module).
 * Auto-generated by intutic sync-daemon. DO NOT EDIT.
 *
 * MANUAL INSTALL (deployment-side): set, in the n8n process's environment,
 *   EXTERNAL_HOOK_FILES=/path/to/this/file
 * and restart n8n. The daemon cannot set another process's environment — see
 * INSTALL.md next to ~/.intutic/n8n/governance-workflow.json.
 *
 * workflow.preExecute runs before every execution with the full Workflow
 * object; a throw here ABORTS the execution. Per-workflow granularity: one
 * offending node stops the whole run, and the error names the node and rule.
 *
 * Proxy: ${proxyUrl}
 * Generated: ${newIso()}
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// Runtime credentials
const _runtimeEnvPath = path.join(os.homedir(), '.intutic', 'env', 'runtime.env');
let _intuticHost = 'https://api.intutic.ai', _intuticKey = '', _intuticWsId = ${JSON.stringify(workspaceId)};
try {
  fs.readFileSync(_runtimeEnvPath, 'utf-8').split('\\n').forEach(line => {
    const eq = line.indexOf('='); if (eq < 0) return;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    if (k === 'INTUTIC_HOST' && v) _intuticHost = v;
    if (k === 'INTUTIC_API_KEY' && v) _intuticKey = v;
    if (k === 'INTUTIC_WORKSPACE_ID' && v) _intuticWsId = v;
  });
} catch {}

${emitN8nWorkflowGate()}

// Events land under HOME, not a workspace: this runs inside the n8n server
// process, which has no workspace root — the same reason cline logs there.
const HOOK_EVENTS_LOG = path.join(os.homedir(), '.intutic', 'events', 'n8n-hook-events.jsonl');

function logEvent(verdict, toolName, reason) {
  try {
    const ts = new Date().toISOString();
    const incidentId = crypto.createHash('sha1').update(ts + toolName + _intuticWsId).digest('hex').slice(0, 16);
    const entry = JSON.stringify({
      // Passed through, not collapsed to two values: the advisory tier emits
      // 'tool_flagged', and a ternary here silently recorded it as an allow.
      event: verdict,
      toolName, reason: reason || '',
      workspaceId: _intuticWsId,
      harnessType: 'n8n',
      timestamp: ts,
      incidentId,
    }) + '\\n';
    const dir = path.dirname(HOOK_EVENTS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(HOOK_EVENTS_LOG, entry, { flag: 'a' });
    if (_intuticKey) {
      try {
        const body = JSON.stringify({ events: [JSON.parse(entry)] });
        const urlObj = new URL('/api/v1/hook-events', _intuticHost);
        const mod = urlObj.protocol === 'https:' ? https : require('http');
        const req = mod.request({ hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + _intuticKey } });
        req.on('error', () => { /* fire-and-forget */ });
        req.write(body); req.end();
      } catch { /* never crash the hook */ }
    }
  } catch { /* never crash the hook */ }
}

module.exports = {
  workflow: {
    preExecute: [
      // No try/catch around the gate: a BLOCKED throw is the refusal, and an
      // internal fault throwing also aborts the execution — fail closed. n8n
      // shows the error message on the aborted execution.
      async function intuticPreExecute(workflow) {
        intuticGateWorkflow(workflow, logEvent, _intuticWsId);
      },
    ],
  },
};
`
}

/** INSTALL.md explaining the deployment-side env var the daemon cannot set. */
function buildInstallMd(hookPath: string, workflowPath: string): string {
  return `# Intutic governance for n8n — installation

Auto-generated by the Intutic sync-daemon. Two artifacts, two install steps.

## 1. The blocking gate (manual, deployment-side)

n8n's only pre-execution hook mechanism is the \`EXTERNAL_HOOK_FILES\`
environment variable, read by the **n8n server process at startup**. The
Intutic daemon cannot set another process's environment, so this step is
yours:

\`\`\`bash
export EXTERNAL_HOOK_FILES=${hookPath}
# then (re)start n8n; for Docker:
#   docker run -e EXTERNAL_HOOK_FILES=/hooks/n8n-governance-hook.js \\
#     -v ${hookPath}:/hooks/n8n-governance-hook.js ...
\`\`\`

Once loaded, the module's \`workflow.preExecute\` hook runs before **every
workflow execution**, evaluates each node's type and parameters against the
compiled floor and the policy snapshot, and **throws** on a block-severity
match — which aborts the execution with an error naming the node and rule.

Granularity is per workflow, not per tool call: that is all n8n's hook
surface offers. If the env var is not set, no gate runs — the daemon
regenerates this file every sync cycle, but only your deployment can load it.

## 2. The event-forwarding workflow (import via the n8n UI)

Import \`${workflowPath}\`
(Settings > Import Workflow), activate it, and set \`INTUTIC_API_KEY\` as an
n8n credential. It forwards tool_blocked events to the Intutic control plane.
This workflow is telemetry only; the gate above is what blocks.
`
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Write the n8n governance gate, workflow, and installation notes.
 *
 *  1. Writes `~/.intutic/hooks/n8n-governance-hook.js` — the blocking
 *     EXTERNAL_HOOK_FILES module (manual, deployment-side install).
 *  2. Writes `~/.intutic/n8n/governance-workflow.json` — importable n8n 1.x workflow.
 *  3. Writes `~/.intutic/n8n/INSTALL.md` — the EXTERNAL_HOOK_FILES instructions.
 *  4. Writes `.intutic/env/n8n.env` with webhook URL and import instructions.
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
  // homedir() read at call time (unlike the module-scope N8N_DIR) so tests
  // that move HOME before invoking are honoured — the gooseHooks lesson.
  const hooksDir = path.join(os.homedir(), '.intutic', 'hooks')

  await Promise.all([
    fs.mkdir(N8N_DIR, { recursive: true }),
    fs.mkdir(envDir, { recursive: true }),
    fs.mkdir(hooksDir, { recursive: true }),
  ])

  // ── 1b. Write the blocking external-hook gate (atomic) ────────────────────

  const hookPath = path.join(hooksDir, 'n8n-governance-hook.js')
  const tmpHook = hookPath + '.intutic-tmp'
  await fs.writeFile(tmpHook, buildN8nGovernanceHook(proxyUrl, workspaceId), 'utf-8')
  await fs.rename(tmpHook, hookPath)

  log.info(
    { action: 'n8n_governance_hook_written', path: hookPath },
    'n8n workflow-level gate written (requires EXTERNAL_HOOK_FILES — see INSTALL.md)',
  )

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

  // ── 2b. Write INSTALL.md (atomic) ─────────────────────────────────────────

  const installPath = path.join(N8N_DIR, 'INSTALL.md')
  const tmpInstall = installPath + '.intutic-tmp'
  await fs.writeFile(tmpInstall, buildInstallMd(hookPath, workflowPath), 'utf-8')
  await fs.rename(tmpInstall, installPath)

  // ── 3. Write .intutic/env/n8n.env (atomic) ────────────────────────────────

  const envContent = [
    `# Intutic n8n governance env — auto-generated ${newIso()}`,
    `# This file is managed by the Intutic sync-daemon. DO NOT EDIT.`,
    `INTUTIC_N8N_WEBHOOK=http://localhost:5678/webhook/intutic-governance`,
    `# BLOCKING GATE (manual, deployment-side): set in the n8n process's env`,
    `#   EXTERNAL_HOOK_FILES=${hookPath}`,
    `# and restart n8n. See ~/.intutic/n8n/INSTALL.md.`,
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
