import { randomBytes } from 'node:crypto'

/**
 * Pure HTML rendering for the extension's webview panels. Nothing here imports
 * `vscode`, so the renderers can be unit-tested with plain Node.
 *
 * Every value that comes from the control-plane API or from CLI output is
 * escaped before it reaches the markup, and the shell sets a strict
 * Content-Security-Policy, so a SOP titled `<img src=x onerror=…>` renders as
 * text instead of markup.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Badge classes come from this fixed list, never from the API value itself,
 * so a lifecycle state or incident status cannot add classes or attributes.
 */
const BADGE_CLASSES = new Map<string, string>([
  ['active', 'badge-active'],
  ['validated', 'badge-active'],
  ['draft', 'badge-draft'],
  ['inactive', 'badge-inactive'],
  ['open', 'badge-open'],
  ['resolved', 'badge-resolved'],
  ['auto_resolved', 'badge-resolved'],
  ['bypassed', 'badge-bypassed'],
])

function badge(label: string): string {
  const cls = BADGE_CLASSES.get(label)
  return `<span class="${cls ? `badge ${cls}` : 'badge'}">${escapeHtml(label)}</span>`
}

function formatDate(value: unknown): string {
  return value ? escapeHtml(new Date(String(value)).toLocaleDateString()) : '—'
}

const OFFLINE_BANNER =
  '<div class="offline-banner">⚠ No control plane reachable. These panels read one: set <code>intutic.controlPlaneUrl</code> or <code>INTUTIC_CONTROL_PLANE_URL</code>, or sign in with <code>intutic login</code>.</div>'

/**
 * Shared webview shell with Intutic dark-mode styling.
 *
 * `cspSource` is the panel's `webview.cspSource`. A fresh nonce is generated
 * per render and carried by the only inline `<style>`; the panels run no
 * scripts, and inline `style=""` attributes are blocked by the policy.
 */
export function buildWebview(title: string, bodyHtml: string, cspSource: string): string {
  const nonce = randomBytes(16).toString('base64')
  const src = escapeHtml(cspSource)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${src} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${src};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
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
    .muted { color: var(--muted); }
    .error { color: var(--danger); }
    .trace-output { white-space: pre-wrap; word-break: break-all; }
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

/** Placeholder body while a panel's data loads. */
export const LOADING_HTML = '<h1>Loading…</h1>'

// ── SOP browser ──────────────────────────────────────────────────────────────
//
// The item types below name only fields the routes send: `test/response-types.ts`
// pins each to the control plane's response schema (`pnpm typecheck`).

const list = <T>(rows: T[] | undefined): T[] => (Array.isArray(rows) ? rows : [])

/** A SOP as `GET /api/v1/sops` sends it (`SopResponse`). */
export interface SopItem {
  sopId: string
  title: string
  lifecycleState?: string
  /** Null for a SOP written without a tier. */
  riskTier?: string | null
  updatedAt?: string
}

/** `GET /api/v1/sops` (`SopListResponse`): one page of SOPs under `items`. */
export interface SopList {
  items?: SopItem[]
}

/** `data` is the `GET /api/v1/sops` response, or null when the fetch failed. */
export function renderSops(data: SopList | null): string {
  const sops = list(data?.items)

  let body = `<h1>Active SOPs</h1>
<p class="subtitle">Showing up to 50 active SOPs in the connected workspace</p>`

  if (!data) body += OFFLINE_BANNER

  if (sops.length === 0) {
    body += `<div class="empty">No active SOPs found in this workspace.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Name</th><th>State</th><th>Risk</th><th>Updated</th>
</tr></thead>
<tbody>`
    for (const s of sops) {
      const state = String(s.lifecycleState ?? 'unknown').toLowerCase()
      body += `<tr>
  <td>${escapeHtml(s.title)}</td>
  <td>${badge(state)}</td>
  <td>${s.riskTier ? escapeHtml(s.riskTier) : '<span class="muted">—</span>'}</td>
  <td>${formatDate(s.updatedAt)}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── Incidents viewer ─────────────────────────────────────────────────────────

/** An incident as `GET /api/v1/incidents` sends it (`IncidentListRowResponse`, snake_case). */
export interface IncidentItem {
  incident_id?: string
  anomaly_type?: string
  severity?: string
  /** OPEN, INVESTIGATING, RESOLVED or AUTO_RESOLVED; null when never set. */
  resolution_status?: string | null
  created_at?: string
}

/**
 * `GET /api/v1/incidents` (`IncidentListResponse`): the rows under `data`. A
 * page of 20 or more rows arrives TOON-encoded (`data` is then a string), so
 * the panel asks for fewer.
 */
export interface IncidentList {
  data?: IncidentItem[] | string
}

/** `data` is the `GET /api/v1/incidents` response, or null when the fetch failed. */
export function renderIncidents(data: IncidentList | null): string {
  const incidents = typeof data?.data === 'string' ? [] : list(data?.data)

  let body = `<h1>⚠ Governance Incidents</h1>
<p class="subtitle">The most pressing governance incidents — policy violations, KILL verdicts, anomalies</p>`

  if (!data) body += OFFLINE_BANNER

  if (incidents.length === 0) {
    body += `<div class="empty">No governance incidents — workspace is operating clean.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Type</th><th>Status</th><th>Severity</th><th>Date</th>
</tr></thead>
<tbody>`
    for (const inc of incidents) {
      const type = inc.anomaly_type ?? '—'
      const status = String(inc.resolution_status ?? 'open').toLowerCase()
      const severity = String(inc.severity ?? '—').toUpperCase()
      body += `<tr>
  <td><span class="mono">${escapeHtml(type)}</span></td>
  <td>${badge(status)}</td>
  <td>${escapeHtml(severity)}</td>
  <td>${formatDate(inc.created_at)}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── WASM Rules viewer ────────────────────────────────────────────────────────

/** A rule as `GET /api/v1/wasm-rules` sends it (`WasmRuleResponse`); the route answers a bare array. */
export interface WasmRuleItem {
  ruleId?: string
  name: string
  bundleSha256?: string
  isActive?: boolean
  version?: number
  createdAt?: string
}

/** `data` is the `GET /api/v1/wasm-rules` response, or null when the fetch failed. */
export function renderWasmRules(data: WasmRuleItem[] | null): string {
  const rules = list(data ?? undefined)

  let body = `<h1>📦 WASM Rule Bundles</h1>
<p class="subtitle">WebAssembly governance rules loaded by the proxy sandbox</p>`

  if (!data) body += OFFLINE_BANNER

  if (rules.length === 0) {
    body += `<div class="empty">No WASM rule bundles uploaded yet.<br>Upload one via the Intutic dashboard at /policies/filters.</div>`
  } else {
    body += `<table>
<thead><tr>
  <th>Name</th><th>SHA-256</th><th>Version</th><th>Status</th><th>Uploaded</th>
</tr></thead>
<tbody>`
    for (const r of rules) {
      const sha = String(r.bundleSha256 ?? '')
      body += `<tr>
  <td>${escapeHtml(r.name)}</td>
  <td><span class="mono" title="${escapeHtml(sha)}">${escapeHtml(sha.slice(0, 12))}…</span></td>
  <td>v${escapeHtml(r.version ?? 1)}</td>
  <td>${r.isActive ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td>
  <td>${formatDate(r.createdAt)}</td>
</tr>`
    }
    body += `</tbody></table>`
  }
  return body
}

// ── Traces ───────────────────────────────────────────────────────────────────

/** Output of `intutic traces list`: stdout on success, stderr/message on failure. */
export type TracesResult = { ok: true; stdout: string } | { ok: false; error: string }

export function renderTraces(result: TracesResult): string {
  const content = result.ok
    ? `<pre class="trace-output">${escapeHtml(result.stdout)}</pre>`
    : `<p class="error">Failed: ${escapeHtml(result.error)}</p>`
  return `
        <h1>Execution Traces</h1>
        <p class="subtitle">Last 20 traces from the workspace</p>
        ${content}
      `
}
