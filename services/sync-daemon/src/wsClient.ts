/**
 * wsClient.ts — WebSocket client for real-time config updates.
 *
 * Establishes a persistent, auto-reconnecting WebSocket connection to
 * the control plane. When a `config_update` event is received, it
 * immediately applies the new configuration, bypassing HTTP polling latency.
 *
 * LLD #14 — wsClient.ts
 * HLD §3.14 — Real-Time State Mirroring (WebSocket push)
 *
 * @module
 */

import WebSocket from 'ws'
import { createLogger } from '@intutic/logger'
import type { SyncConfigPayload } from '@intutic/shared-types'

const log = createLogger('sync-ws-client')

export interface WsClientOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  onConfigUpdate: (config: SyncConfigPayload) => Promise<void>
  onContextSyncTrigger?: (adapterId: string) => Promise<void>
  onActiveLocalSopsUpdate?: (activeLocalSops: string[]) => Promise<void>
  signal?: AbortSignal
}

export class SyncWsClient {
  private ws: WebSocket | null = null
  private reconnectTimeout: NodeJS.Timeout | null = null
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private maxReconnectDelayMs = 30000
  private baseReconnectDelayMs = 1000
  private isClosed = false

  constructor(private readonly options: WsClientOptions) {
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => {
        this.close()
      })
    }
  }

  /**
   * Start the connection.
   */
  connect(): void {
    if (this.isClosed || (this.options.signal && this.options.signal.aborted)) {
      return
    }

    // Convert http(s) URL to ws(s)
    let wsUrl = this.options.controlPlaneUrl.replace(/^http/, 'ws')
    if (!wsUrl.endsWith('/')) {
      wsUrl += '/'
    }
    wsUrl += `api/v1/sync/ws?token=${encodeURIComponent(this.options.apiKey)}`

    log.info({ action: 'ws_connect_attempt', url: this.options.controlPlaneUrl }, 'Connecting to sync WebSocket server')

    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      log.info({ action: 'ws_connected' }, 'WebSocket connection established')
      this.reconnectAttempt = 0
      this.startHeartbeat()
    })

    this.ws.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString())
        log.debug({ action: 'ws_message_received', type: payload.type }, 'Received WebSocket event')

        if (payload.type === 'config_update') {
          // Handle config update payload
          await this.options.onConfigUpdate(payload as SyncConfigPayload)
        } else if (payload.type === 'active_local_sops_update') {
          if (this.options.onActiveLocalSopsUpdate) {
            await this.options.onActiveLocalSopsUpdate(payload.activeLocalSops)
          }
        } else if (payload.type === 'context_sync_trigger') {
          // Trigger a ContextGraph filesystem scan and sync push
          if (this.options.onContextSyncTrigger) {
            await this.options.onContextSyncTrigger(payload.adapterId)
          }
        } else if (payload.type === 'pong') {
          log.debug({ action: 'ws_pong' }, 'Received pong from server')
        }
      } catch (err) {
        log.error({ action: 'ws_message_parse_error', err }, 'Failed to parse WebSocket message')
      }
    })

    this.ws.on('close', (code, reason) => {
      this.cleanup()
      if (!this.isClosed) {
        log.warn({ action: 'ws_closed', code, reason: reason.toString() }, 'WebSocket connection closed. Retrying...')
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err) => {
      log.error({ action: 'ws_error', err }, 'WebSocket client encountered an error')
      // Close event will follow error event, handling the reconnect
    })
  }

  /**
   * Send a custom event or report to the control plane.
   */
  send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      log.warn({ action: 'ws_send_skipped' }, 'Cannot send message: WebSocket is not open')
    }
  }

  /**
   * Close the connection.
   */
  close(): void {
    this.isClosed = true
    this.cleanup()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore
      }
      this.ws = null
    }
    log.info({ action: 'ws_closed_by_user' }, 'WebSocket client connection closed')
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.isClosed) return

    const delay = Math.min(
      this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelayMs
    )
    this.reconnectAttempt++

    log.info({ action: 'ws_schedule_reconnect', delayMs: delay }, `Scheduling reconnect in ${delay}ms`)
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }
}
