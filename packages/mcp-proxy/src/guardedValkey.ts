/**
 * guardedValkey.ts — the one Valkey connection a proxy process holds, and the
 * guard every command on it goes through.
 *
 * Two things in a proxy read and write Valkey: the shared session window
 * (sessionStore.ts) and the MCP call budgets (budget.ts). They share this
 * connection, and they share its rule: a command runs only on a connected
 * client, never waits longer than a short timeout, and any failure comes back
 * as `undefined`. What `undefined` means is each caller's business — the
 * session window falls back to its per-process copy; a budget follows the
 * proxy's fail setting.
 *
 * @module
 */

import { Redis } from 'ioredis'
import { createStderrLogger } from './stderrLog.js'
import { describeConnectionError } from './valkeyErrors.js'

const log = createStderrLogger('mcp-proxy.valkey')

/** A command that takes longer than this is treated as Valkey being unavailable. */
export const VALKEY_COMMAND_TIMEOUT_MS = 200

export interface GuardedValkeyOptions {
  timeoutMs?: number
}

export interface GuardedRunOptions {
  /**
   * Wait (within the timeout) for a connection that is still being set up,
   * instead of answering `undefined` straight away. For a check whose
   * `undefined` can refuse a call: the first call after the proxy starts
   * must not be refused because the connection was a few milliseconds old.
   */
  awaitConnect?: boolean
}

export class GuardedValkey {
  readonly client: Redis
  private readonly timeoutMs: number
  private warned = false

  constructor(url: string, opts: GuardedValkeyOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? VALKEY_COMMAND_TIMEOUT_MS
    this.client = new Redis(url, {
      lazyConnect: true,
      // No offline queue: a command issued before the connection is up must
      // fail now, not wait for a Valkey that may never answer.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: (times) => Math.min(1000 * 2 ** Math.min(times, 5), 30_000),
    })
    this.client.on('error', (err: unknown) => this.warnOnce('Valkey unreachable', err))
    void this.client.connect().catch((err: unknown) => this.warnOnce('Valkey connect failed', err))
  }

  /** Runs `op`, or answers `undefined` when Valkey is not connected, too slow, or fails. */
  async run<T>(op: (client: Redis) => Promise<T>, opts: GuardedRunOptions = {}): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.timeoutMs)
      timer.unref()
    })
    try {
      if (this.client.status !== 'ready') {
        const settingUp = this.client.status === 'connecting' || this.client.status === 'connect'
        if (!opts.awaitConnect || !settingUp) return undefined
        const ready = new Promise<true>((resolve) => this.client.once('ready', () => resolve(true)))
        if ((await Promise.race([ready, timeout])) !== true) return undefined
      }
      return await Promise.race([op(this.client), timeout])
    } catch (err) {
      this.warnOnce('Valkey command failed', err)
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
  }

  private warnOnce(msg: string, err: unknown): void {
    const detail = { err: describeConnectionError(err) }
    if (this.warned) {
      log.debug(detail, msg)
      return
    }
    this.warned = true
    log.warn(
      detail,
      `${msg} — the anomaly session window falls back to this process, and MCP call budgets follow the fail setting`,
    )
  }
}
