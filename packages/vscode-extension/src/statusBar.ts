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

/** Body of `GET /intutic/spend` — see proxy `router.rs`. Loopback-only, which
 * is fine here: this extension always talks to 127.0.0.1:4000. */
interface LocalSpendResponse {
  local_spend_usd_today?: number
  local_cap_usd?: number
  enforced?: boolean
}

/**
 * `$1.23 / $10.00` for the status bar text, or empty when the figure isn't
 * available — offline proxy, or a response missing either number — so the
 * caller can append it without a stray `undefined` or `$NaN`.
 */
function formatSpendSuffix(spend: LocalSpendResponse | null): string {
  if (!spend || typeof spend.local_spend_usd_today !== 'number' || typeof spend.local_cap_usd !== 'number') {
    return ''
  }
  return ` · $${spend.local_spend_usd_today.toFixed(2)}/$${spend.local_cap_usd.toFixed(2)}`
}

// ── Status bar registration ───────────────────────────────────────────────────

/**
 * Fetch from the control plane using the credentials `intutic connect` wrote.
 * Separate from the proxy's /healthz probe above: the proxy (127.0.0.1:4000)
 * reports local governance liveness, while incidents live in the control plane.
 */
async function fetchControlPlane<T>(reqPath: string): Promise<T | null> {
  try {
    const os = await import('node:os')
    const fsp = await import('node:fs/promises')
    const nodePath = await import('node:path')
    const override = vscode.workspace
      .getConfiguration('intutic')
      .get<string>('controlPlaneUrl')
    let base = override
    let apiKey: string | undefined
    let workspaceId: string | undefined
    try {
      const raw = await fsp.readFile(
        nodePath.join(os.homedir(), '.intutic', 'credentials.json'),
        'utf-8',
      )
      const creds = JSON.parse(raw) as {
        controlPlaneUrl?: string
        apiKey?: string
        workspaceId?: string
      }
      base = override || creds.controlPlaneUrl
      apiKey = creds.apiKey
      workspaceId = creds.workspaceId
    } catch {
      // No credentials yet — fall through with the override (if any).
    }
    if (!base) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}${reqPath}`, {
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
        },
        signal: controller.signal,
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

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
   * Poll /health to determine proxy liveness, then also fetch
   * recent open incidents to show a count badge in the status bar.
   *
   * This used to poll /healthz, a path the proxy's router (router.rs) never
   * defines — only /health does. That fell through the catch-all into
   * handle_proxy, which returns a 401 JSON body for an unauthenticated
   * request, so this "liveness" check only ever worked by accident: the
   * helper below only checks that the response parses as JSON, never the
   * HTTP status, so a 401 read the same as a 200. Pointed at the real
   * /health endpoint, which actually reports liveness rather than "some JSON
   * came back."
   *
   * States:
   *  - Checking  (spin icon, neutral)
   *  - Governed  (shield icon, green — 0 open incidents)
   *  - Governed N incidents (warning icon, amber — N > 0 open incidents)
   *  - Offline   (warning icon, red)
   */
  const checkDaemonHealth = async () => {
    const health = await httpGetJson<{ status?: string }>(
      'http://127.0.0.1:4000/health'
    )

    if (!health) {
      // Proxy is offline
      statusBarItem.text = '$(warning) Intutic: Offline'
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      statusBarItem.tooltip = 'Intutic local governance proxy is offline.\nRun: intutic connect'
      return
    }

    // Proxy is online — try the open incident count from the CONTROL PLANE.
    // This used to request /api/v1/incidents from the proxy's port (4000),
    // which does not serve control-plane routes, and without auth — so the
    // count was always 0 and the badge never appeared.
    //
    // The spend fetch runs alongside it, same tick, same 30s cadence: today's
    // machine-local spend from the proxy's own budget accounting
    // (local_spend.rs via /intutic/spend), not the workspace-wide figure —
    // this status bar only ever speaks for this one machine.
    const [incidentsResp, spend] = await Promise.all([
      fetchControlPlane<
        { items?: unknown[]; total?: number; meta?: { total?: number } } | unknown[]
      >('/api/v1/incidents?status=OPEN&limit=1'),
      httpGetJson<LocalSpendResponse>('http://127.0.0.1:4000/intutic/spend'),
    ])
    const spendSuffix = formatSpendSuffix(spend)
    const spendTooltipLine = spendSuffix
      ? `Local spend today: $${spend!.local_spend_usd_today!.toFixed(2)} of $${spend!.local_cap_usd!.toFixed(2)} cap${spend!.enforced === false ? ' (enforcement off)' : ''}.`
      : null

    let openCount = 0
    if (incidentsResp) {
      if (Array.isArray(incidentsResp)) {
        openCount = incidentsResp.length
      } else if (typeof incidentsResp === 'object' && incidentsResp !== null) {
        // GET /api/v1/incidents answers {data, meta:{total,page,limit}}. The old
        // code looked for `total`/`items` at the top level, neither of which
        // that route has ever returned, so the count stayed 0 regardless.
        const r = incidentsResp as {
          meta?: { total?: number }
          data?: unknown[]
          total?: number
          items?: unknown[]
        }
        openCount = r.meta?.total ?? r.total ?? r.data?.length ?? r.items?.length ?? 0
      }
    }

    if (openCount > 0) {
      statusBarItem.text = `$(warning) Intutic: Governed · ${openCount} incident${openCount === 1 ? '' : 's'}${spendSuffix}`
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      statusBarItem.tooltip = [
        `Intutic governance proxy is active.`,
        `⚠ ${openCount} open governance incident${openCount === 1 ? '' : 's'} detected.`,
        ...(spendTooltipLine ? [spendTooltipLine] : []),
        `Click to view daemon status. Use "Intutic: View governance incidents" to inspect.`,
      ].join('\n')
    } else {
      statusBarItem.text = `$(shield) Intutic: Governed${spendSuffix}`
      statusBarItem.backgroundColor = undefined
      statusBarItem.tooltip = [
        'Intutic local governance proxy is active.',
        'No open incidents.',
        ...(spendTooltipLine ? [spendTooltipLine] : []),
      ].join('\n')
    }
  }

  // Poll every 30 seconds
  const interval = setInterval(checkDaemonHealth, 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(interval) })

  // Run immediately
  checkDaemonHealth()
}
