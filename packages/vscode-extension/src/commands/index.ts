import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exec } from 'node:child_process'
import {
  buildWebview,
  LOADING_HTML,
  renderIncidents,
  renderSops,
  renderTraces,
  renderWasmRules,
  type IncidentList,
  type SopList,
  type WasmRuleItem,
} from '../webview'

// ── Helpers ──────────────────────────────────────────────────────────────────

interface IntuticCreds {
  controlPlaneUrl?: string
  apiKey?: string
  workspaceId?: string
}

/**
 * Resolve the control plane from the credentials `intutic connect` writes.
 *
 * These views used to hardcode `http://127.0.0.1:4000` — the Rust proxy's port,
 * not the control plane's (3001) — while requesting control-plane paths
 * (/api/v1/sops, /api/v1/incidents, /api/v1/wasm-rules), and they sent no
 * Authorization header at all. So every panel was empty on every machine: wrong
 * port, and a 401 even at the right one.
 *
 * ~/.intutic/credentials.json already carries controlPlaneUrl, apiKey and
 * workspaceId, so the extension can configure itself from a `intutic connect`
 * the developer has already run. A VS Code setting overrides it.
 */
function loadCreds(): IntuticCreds | null {
  const override = vscode.workspace.getConfiguration('intutic').get<string>('controlPlaneUrl')
  try {
    const file = path.join(os.homedir(), '.intutic', 'credentials.json')
    const creds = JSON.parse(fs.readFileSync(file, 'utf-8')) as IntuticCreds
    return { ...creds, controlPlaneUrl: override || creds.controlPlaneUrl }
  } catch {
    return override ? { controlPlaneUrl: override } : null
  }
}

/**
 * Fetch JSON from the Intutic control plane. Returns null on any error — all
 * callers degrade gracefully into an empty panel.
 */
async function fetchLocal<T>(reqPath: string): Promise<T | null> {
  const creds = loadCreds()
  const base = creds?.controlPlaneUrl
  if (!base) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${reqPath}`, {
      headers: {
        ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
        ...(creds.workspaceId ? { 'x-workspace-id': creds.workspaceId } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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
      const body = err
        ? renderTraces({ ok: false, error: stderr || err.message })
        : renderTraces({ ok: true, stdout })
      panel.webview.html = buildWebview('Intutic: Execution Traces', body, panel.webview.cspSource)
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
    const csp = panel.webview.cspSource
    panel.webview.html = buildWebview('Intutic: Active SOPs', LOADING_HTML, csp)
    const data = await fetchLocal<SopList>('/api/v1/sops?limit=50&status=ACTIVE')
    panel.webview.html = buildWebview('Intutic: Active SOPs', renderSops(data), csp)
  })

  // 5. Open Incidents
  const openIncidentsCmd = vscode.commands.registerCommand('intutic.openIncidents', async () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticIncidents',
      'Intutic: Governance Incidents',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    const csp = panel.webview.cspSource
    panel.webview.html = buildWebview('Intutic: Governance Incidents', LOADING_HTML, csp)
    // 19, not 20: a page of 20 or more rows comes back TOON-encoded.
    const data = await fetchLocal<IncidentList>('/api/v1/incidents?limit=19&sort=desc')
    panel.webview.html = buildWebview('Intutic: Governance Incidents', renderIncidents(data), csp)
  })

  // 6. Open WASM Rules
  const openWasmRulesCmd = vscode.commands.registerCommand('intutic.openWasmRules', async () => {
    const panel = vscode.window.createWebviewPanel(
      'intuticWasmRules',
      'Intutic: WASM Rule Bundles',
      vscode.ViewColumn.One,
      { enableScripts: false }
    )
    const csp = panel.webview.cspSource
    panel.webview.html = buildWebview('Intutic: WASM Rule Bundles', LOADING_HTML, csp)
    const data = await fetchLocal<WasmRuleItem[]>('/api/v1/wasm-rules')
    panel.webview.html = buildWebview('Intutic: WASM Rule Bundles', renderWasmRules(data), csp)
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
