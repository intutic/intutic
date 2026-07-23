import * as vscode from 'vscode'
import * as http from 'node:http'
import { exec } from 'node:child_process'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch JSON from the local Intutic control plane (http://127.0.0.1:4000).
 * Returns null on any error — all callers degrade gracefully.
 */
function fetchLocal<T>(path: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:4000${path}`, { timeout: 2000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Shared webview shell with Intutic dark-mode styling. */
function buildWebview(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e2e);
      --fg: var(--vscode-editor-foreground, #cdd6f4);
      --muted: var(--vscode-descriptionForeground, #6c7086);
      --border: var(--vscode-widget-border, #313244);
      --accent: var(--vscode-textLink-foreground, #89b4fa);
      --success: #a6e3a1;
      --warning: #f9e2af;
      --danger: #f38ba8;
      --radius: 6px;
    }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
      padding: 20px;
      margin: 0;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: 700;
      margin: 0 0 4px 0;
      color: var(--accent);
    }
    .subtitle { color: var(--muted); margin: 0 0 20px 0; font-size: 0.85rem; }
    .offline-banner {
      background: rgba(243,139,168,0.12);
      border: 1px solid rgba(243,139,168,0.3);
      border-radius: var(--radius);
      padding: 12px 16px;
      color: var(--danger);
      margin-bottom: 20px;
    }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    tbody tr { border-bottom: 1px solid var(--border); }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.03); }
    td { padding: 8px 10px; vertical-align: middle; }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 9999px;
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-active   { background: rgba(166,227,161,0.15); color: var(--success); }
    .badge-draft    { background: rgba(249,226,175,0.15); color: var(--warning); }
    .badge-inactive { background: rgba(108,112,134,0.15); color: var(--muted); }
    .badge-open     { background: rgba(243,139,168,0.15); color: var(--danger); }
    .badge-resolved { background: rgba(166,227,161,0.15); color: var(--success); }
    .badge-bypassed { background: rgba(249,226,175,0.15); color: var(--warning); }
    .mono {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Courier New', monospace);
      font-size: 0.8rem;
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .empty {
      text-align: center;
      padding: 40px;
      color: var(--muted);
    }
    .score { font-weight: 700; }
    .score-hi { color: var(--success); }
    .score-lo { color: var(--danger); }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

// ── SOP browser ──────────────────────────────────────────────────────────────

interface SopItem {
  sopId: string
  name: string
  lifecycle_state?: string
  lifecycleState?: string
  godel_score?: number | null
  godelScore?: number | null
  updatedAt?: string
  updated_at?: string
}

async function buildSopsHtml(): Promise<string> {
  const data = await fetchLocal<{ items?: SopItem[] } | SopItem[]>('/api/v1/sops?limit=50&status=ACTIVE')

  let sops: SopItem[] = []
  if (data) {
    sops = Array.isArray(data) ? data : (data.items ?? [])
  }

  let body = `<h1>$(shield) Active SOPs</h1>
<p class="subtitle">Showing up to 50 active SOPs in the connected workspace</p>`

  if (!data) {
    body += `<div class="offline-banner">⚠ Control plane offline — start the sync daemon with <code>intutic connect</code></div>`
  }

  if (sops.length === 0) {
    body += `<div class="empty">No active SOPs found in this workspace.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Name</th><th>State</th><th>Gödel Score</th><th>Updated</th>
</tr></thead>
<tbody>`
    for (const s of sops) {
      const state = (s.lifecycle_state ?? s.lifecycleState ?? 'unknown').toLowerCase()
      const score = s.godel_score ?? s.godelScore
      const scoreDisplay = score != null
        ? `<span class="score ${score >= 0.85 ? 'score-hi' : 'score-lo'}">${(score * 100).toFixed(0)}%</span>`
        : '<span style="color:var(--muted)">—</span>'
      const updated = s.updatedAt ?? s.updated_at
      const dateStr = updated ? new Date(updated).toLocaleDateString() : '—'
      body += `<tr>
  <td>${s.name}</td>
  <td><span class="badge badge-${state}">${state}</span></td>
  <td>${scoreDisplay}</td>
  <td>${dateStr}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── Incidents viewer ─────────────────────────────────────────────────────────

interface IncidentItem {
  incidentId?: string
  incident_id?: string
  toolName?: string
  tool_name?: string
  actionTaken?: string
  action_taken?: string
  status?: string
  severity?: string
  createdAt?: string
  created_at?: string
}

async function buildIncidentsHtml(): Promise<string> {
  const data = await fetchLocal<{ items?: IncidentItem[] } | IncidentItem[]>(
    '/api/v1/incidents?limit=20&sort=desc'
  )

  let incidents: IncidentItem[] = []
  if (data) {
    incidents = Array.isArray(data) ? data : (data.items ?? [])
  }

  let body = `<h1>⚠ Governance Incidents</h1>
<p class="subtitle">Last 20 governance incidents — policy violations, KILL verdicts, anomalies</p>`

  if (!data) {
    body += `<div class="offline-banner">⚠ Control plane offline — start the sync daemon with <code>intutic connect</code></div>`
  }

  if (incidents.length === 0) {
    body += `<div class="empty">No governance incidents — workspace is operating clean.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Tool</th><th>Action</th><th>Status</th><th>Severity</th><th>Date</th>
</tr></thead>
<tbody>`
    for (const inc of incidents) {
      const tool = inc.toolName ?? inc.tool_name ?? '—'
      const action = (inc.actionTaken ?? inc.action_taken ?? '—').toUpperCase()
      const status = (inc.status ?? 'open').toLowerCase()
      const severity = (inc.severity ?? '—').toUpperCase()
      const dateStr = inc.createdAt ?? inc.created_at
        ? new Date((inc.createdAt ?? inc.created_at)!).toLocaleDateString()
        : '—'
      body += `<tr>
  <td><span class="mono">${tool}</span></td>
  <td>${action}</td>
  <td><span class="badge badge-${status}">${status}</span></td>
  <td>${severity}</td>
  <td>${dateStr}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── WASM Rules viewer ────────────────────────────────────────────────────────

interface WasmRuleItem {
  ruleId?: string
  rule_id?: string
  name: string
  bundleSha256?: string
  bundle_sha256?: string
  isActive?: boolean
  is_active?: boolean
  version?: number
  createdAt?: string
  created_at?: string
}

async function buildWasmRulesHtml(): Promise<string> {
  const data = await fetchLocal<WasmRuleItem[] | { items?: WasmRuleItem[] }>(
    '/api/v1/wasm-rules'
  )

  let rules: WasmRuleItem[] = []
  if (data) {
    rules = Array.isArray(data) ? data : (data.items ?? [])
  }

  let body = `<h1>📦 WASM Rule Bundles</h1>
<p class="subtitle">WebAssembly governance rules loaded by the proxy sandbox</p>`

  if (!data) {
    body += `<div class="offline-banner">⚠ Control plane offline — start the sync daemon with <code>intutic connect</code></div>`
  }

  if (rules.length === 0) {
    body += `<div class="empty">No WASM rule bundles uploaded yet.<br>Upload one via the Intutic dashboard at /wasm-rules.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Name</th><th>SHA-256</th><th>Version</th><th>Status</th><th>Uploaded</th>
</tr></thead>
<tbody>`
    for (const r of rules) {
      const sha = r.bundleSha256 ?? r.bundle_sha256 ?? ''
      const active = r.isActive ?? r.is_active ?? false
      const dateStr = r.createdAt ?? r.created_at
        ? new Date((r.createdAt ?? r.created_at)!).toLocaleDateString()
        : '—'
      body += `<tr>
  <td>${r.name}</td>
  <td><span class="mono" title="${sha}">${sha.slice(0, 12)}…</span></td>
  <td>v${r.version ?? 1}</td>
  <td><span class="badge ${active ? 'badge-active' : 'badge-inactive'}">${active ? 'Active' : 'Inactive'}</span></td>
  <td>${dateStr}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── Command Registration ──────────────────────────────────────────────────────

export function registerCommands(context: vscode.ExtensionContext) {
  // 1. Connect
  const connectCmd = vscode.commands.registerCommand('intutic.connect', () => {
    vscode.window.showInformationMessage('Connecting to Intutic Workspace…')
    exec('intutic connect', (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`Failed to connect: ${stderr || err.message}`)
        return
      }
      vscode.window.showInformationMessage(stdout || 'Intutic connected.')
    })
  })

  // 2. Status
  const statusCmd = vscode.commands.registerCommand('intutic.status', () => {
    exec('intutic daemon status', (err, stdout, stderr) => {
      if (err) {
        vscode.window.showWarningMessage(`Daemon Offline: ${stderr || err.message}`)
        return
      }
      vscode.window.showInformationMessage(stdout || 'Daemon active.')
    })
  })

  // 3. Open Traces (legacy webview)
  const openTracesCmd = vscode.commands.registerCommand('intutic.openTraces', () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticTraces',
      'Intutic: Execution Traces',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    exec('intutic traces list', (err, stdout, stderr) => {
      const content = err
        ? `<p class="error" style="color:var(--danger)">Failed: ${stderr || err.message}</p>`
        : `<pre style="white-space:pre-wrap;word-break:break-all">${stdout}</pre>`
      panel.webview.html = buildWebview('Intutic: Execution Traces', `
        <h1>Execution Traces</h1>
        <p class="subtitle">Last 20 traces from the workspace</p>
        ${content}
      `)
    })
  })

  // 4. Open SOPs
  const openSopsCmd = vscode.commands.registerCommand('intutic.openSops', async () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticSops',
      'Intutic: Active SOPs',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    panel.webview.html = buildWebview('Intutic: Active SOPs', '<h1>Loading…</h1>')
    const body = await buildSopsHtml()
    panel.webview.html = buildWebview('Intutic: Active SOPs', body)
  })

  // 5. Open Incidents
  const openIncidentsCmd = vscode.commands.registerCommand('intutic.openIncidents', async () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticIncidents',
      'Intutic: Governance Incidents',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    panel.webview.html = buildWebview('Intutic: Governance Incidents', '<h1>Loading…</h1>')
    const body = await buildIncidentsHtml()
    panel.webview.html = buildWebview('Intutic: Governance Incidents', body)
  })

  // 6. Open WASM Rules
  const openWasmRulesCmd = vscode.commands.registerCommand('intutic.openWasmRules', async () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticWasmRules',
      'Intutic: WASM Rule Bundles',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    panel.webview.html = buildWebview('Intutic: WASM Rule Bundles', '<h1>Loading…</h1>')
    const body = await buildWasmRulesHtml()
    panel.webview.html = buildWebview('Intutic: WASM Rule Bundles', body)
  })

  context.subscriptions.push(
    connectCmd,
    statusCmd,
    openTracesCmd,
    openSopsCmd,
    openIncidentsCmd,
    openWasmRulesCmd,
  )
}
