/**
 * policy.ts — PolicyClient: fetches and caches SOP governance rules from the Intutic control plane.
 *
 * Rules are refreshed every policyTtlMs (default: 60s). On fetch failure, the
 * last-known-good set is retained (fail-open behaviour).
 *
 * @module
 */

import * as node_https from 'node:https'
import * as node_http from 'node:http'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { callDaemonSocket } from './daemonClient.js'

const log = createLogger('mcp-proxy-policy')

export interface SopRule {
  id: string
  /** Regex pattern matched against tool name (e.g. "mcp__github__.*" or "Bash") */
  toolPattern: string
  /** Optional regex matched against JSON.stringify(tool_input) */
  argPattern?: string
  /** Action to take when the rule matches */
  action: 'block' | 'warn' | 'require_approval'
  /** Human-readable reason reported back to harness */
  reason: string
}

interface SopRulesResponse {
  rules: SopRule[]
}

export class PolicyClient {
  private rules: SopRule[] = []
  private lastFetchAt = 0
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly workspaceId: string,
    private readonly ttlMs: number = 60_000,
    private readonly mcpProxyMode: string = 'per-session'
  ) {}

  /** Start background refresh timer. */
  start(): void {
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {
        // Errors already logged inside refresh()
      })
    }, this.ttlMs)
    // Don't block Node.js exit on this timer
    this.refreshTimer.unref()

    // Kick off initial fetch (non-blocking — proxy starts immediately)
    void this.refresh().catch(() => {})
  }

  /** Stop the background refresh timer. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /** Return the current cached rule set. */
  getRules(): readonly SopRule[] {
    return this.rules
  }

  /** Find the first matching rule for a given tool name + serialized args. */
  matchRule(toolName: string, toolInputJson: string): SopRule | null {
    for (const rule of this.rules) {
      try {
        const toolRegex = new RegExp(rule.toolPattern)
        if (!toolRegex.test(toolName)) continue
        if (rule.argPattern) {
          const argRegex = new RegExp(rule.argPattern)
          if (!argRegex.test(toolInputJson)) continue
        }
        return rule
      } catch {
        // Malformed regex in rule — skip silently
      }
    }
    return null
  }

  /** Fetch fresh rules from the control plane. */
  async refresh(): Promise<void> {
    if (this.mcpProxyMode === 'daemon') {
      try {
        const policy = await callDaemonSocket('policy.get', { workspaceId: this.workspaceId })
        if (policy) {
          this.rules = (policy.sopRules || []) as SopRule[]
          this.lastFetchAt = Date.now()
          log.info({ action: 'policy_refreshed_from_daemon', ruleCount: this.rules.length }, 'SOP rules refreshed from daemon')
          return
        }
      } catch (err: any) {
        log.warn({ action: 'policy_daemon_failed', err: err.message }, 'Failed to refresh policy from daemon socket — falling back to HTTP')
      }
    }

    const url = `${this.controlPlaneUrl}/api/v1/sop/rules?workspaceId=${encodeURIComponent(this.workspaceId)}&active=true`
    log.debug({ action: 'policy_refresh', url }, 'Fetching SOP rules from control plane')

    const body = await httpGet(url, this.apiKey)
    const parsed = JSON.parse(body) as SopRulesResponse
    const rules = Array.isArray(parsed.rules) ? parsed.rules : []
    this.rules = rules
    this.lastFetchAt = Date.now()
    log.info({ action: 'policy_refreshed', ruleCount: rules.length }, 'SOP rules refreshed')
  }
}

/** Minimal HTTP/HTTPS GET helper (avoids fetch / node-fetch dep). */
function httpGet(url: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? node_https : node_http
    const req = lib.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}: ${body}`))
          } else {
            resolve(body)
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Policy fetch timed out'))
    })
  })
}
