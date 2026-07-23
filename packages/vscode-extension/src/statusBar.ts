import * as vscode from 'vscode'
import * as http from 'node:http'

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGetJson<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
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

// ── Status bar registration ───────────────────────────────────────────────────

export function registerStatusBar(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  )
  statusBarItem.command = 'intutic.status'
  statusBarItem.text = '$(sync~spin) Intutic: Checking…'
  statusBarItem.tooltip = 'Intutic local governance proxy status'
  statusBarItem.show()

  context.subscriptions.push(statusBarItem)

  /**
   * Poll /healthz to determine proxy liveness, then also fetch
   * recent open incidents to show a count badge in the status bar.
   *
   * States:
   *  - Checking  (spin icon, neutral)
   *  - Governed  (shield icon, green — 0 open incidents)
   *  - Governed N incidents (warning icon, amber — N > 0 open incidents)
   *  - Offline   (warning icon, red)
   */
  const checkDaemonHealth = async () => {
    const health = await httpGetJson<{ status?: string }>(
      'http://127.0.0.1:4000/healthz'
    )

    if (!health) {
      // Proxy is offline
      statusBarItem.text = '$(warning) Intutic: Offline'
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      statusBarItem.tooltip = 'Intutic local governance proxy is offline.\nRun: intutic connect'
      return
    }

    // Proxy is online — try to fetch open incident count
    const incidentsResp = await httpGetJson<
      { items?: unknown[]; total?: number } | unknown[]
    >('http://127.0.0.1:4000/api/v1/incidents?status=open&limit=1')

    let openCount = 0
    if (incidentsResp) {
      if (Array.isArray(incidentsResp)) {
        openCount = incidentsResp.length
      } else if (typeof incidentsResp === 'object' && incidentsResp !== null) {
        const r = incidentsResp as { total?: number; items?: unknown[] }
        openCount = r.total ?? r.items?.length ?? 0
      }
    }

    if (openCount > 0) {
      statusBarItem.text = `$(warning) Intutic: Governed · ${openCount} incident${openCount === 1 ? '' : 's'}`
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      statusBarItem.tooltip = [
        `Intutic governance proxy is active.`,
        `⚠ ${openCount} open governance incident${openCount === 1 ? '' : 's'} detected.`,
        `Click to view daemon status. Use "Intutic: View governance incidents" to inspect.`,
      ].join('\n')
    } else {
      statusBarItem.text = '$(shield) Intutic: Governed'
      statusBarItem.backgroundColor = undefined
      statusBarItem.tooltip = 'Intutic local governance proxy is active.\nNo open incidents.'
    }
  }

  // Poll every 30 seconds
  const interval = setInterval(checkDaemonHealth, 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(interval) })

  // Run immediately
  checkDaemonHealth()
}
