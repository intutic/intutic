/**
 * Trajectory Monitor — Daemon-side session watcher (Worker Thread).
 *
 * Runs inside the sync-daemon as a Node.js Worker thread. Subscribes to
 * Valkey pub/sub `trace:live:{sessionId}` channels, buffers events in a
 * sliding window, and submits trajectory summaries to the control plane
 * for analysis.
 *
 * Key guarantees:
 * - Non-blocking: Worker thread isolation, fire-and-forget analysis
 * - No LLM calls on developer machine (all judgment is server-side)
 * - Cooldown rate limiter: 1 analysis request per minute per session
 *
 * LLD #52 §4.1 — Daemon-side trajectory buffer
 *
 * @module
 */

import { createLogger } from '@intutic/logger'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const log = createLogger('trajectory-monitor')

// ─── Types ──────────────────────────────────────────────────────────

/** Individual trace event from the proxy pub/sub stream. */
export interface TraceEvent {
  sessionId: string
  workspaceId: string
  toolName: string
  model: string
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  status: 'success' | 'error'
  timestamp: string
}

/** Configuration for the trajectory monitor. */
export interface TrajectoryMonitorConfig {
  /** Valkey connection URL. */
  valkeyUrl: string
  /** Control plane base URL for submitting summaries. */
  controlPlaneUrl: string
  /** API key for control plane authentication. */
  apiKey: string
  /** Sliding window size in milliseconds. Default: 300_000 (5 minutes). */
  windowMs?: number
  /** Maximum events per buffer. Default: 500. */
  maxBufferSize?: number
  /** Summary submission interval in ms. Default: 60_000 (1 minute). */
  submitIntervalMs?: number
  /** Session IDs to monitor. Empty = monitor all. */
  sessionFilter?: string[]
}

// ─── Sliding Window Buffer ──────────────────────────────────────────

/**
 * Per-session sliding window buffer for trace events.
 */
export class TrajectoryBuffer {
  private events: TraceEvent[] = []
  private readonly maxSize: number
  private readonly windowMs: number
  private lastSubmitTime = 0

  constructor(
    readonly sessionId: string,
    readonly workspaceId: string,
    maxSize = 500,
    windowMs = 300_000,
  ) {
    this.maxSize = maxSize
    this.windowMs = windowMs
  }

  /** Add an event to the buffer. Trims old events and enforces size cap. */
  push(event: TraceEvent): void {
    this.events.push(event)

    // Enforce size cap
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize)
    }

    // Trim events outside the sliding window
    const cutoff = Date.now() - this.windowMs
    this.events = this.events.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    )
  }

  /** Check if cooldown has elapsed since last submission. */
  canSubmit(cooldownMs: number): boolean {
    return Date.now() - this.lastSubmitTime >= cooldownMs
  }

  /** Mark that a submission was made. */
  markSubmitted(): void {
    this.lastSubmitTime = Date.now()
  }

  /** Get the current buffer size. */
  get size(): number {
    return this.events.length
  }

  /**
   * Compute a trajectory summary from the current buffer.
   */
  toSummary(activeSopIds: string[], budgetUtilization: number): TrajectorySummaryPayload {
    const tools = this.events.map((e) => e.toolName)
    const uniqueTools = [...new Set(tools)]
    const totalTokens = this.events.reduce(
      (sum, e) => sum + e.inputTokens + e.outputTokens + (e.reasoningTokens ?? 0),
      0,
    )
    const errorCount = this.events.filter((e) => e.status === 'error').length

    // Calculate velocities
    const windowStartMs = this.events.length > 0
      ? new Date(this.events[0].timestamp).getTime()
      : Date.now()
    const windowEndMs = this.events.length > 0
      ? new Date(this.events[this.events.length - 1].timestamp).getTime()
      : Date.now()
    const windowMinutes = Math.max(1, (windowEndMs - windowStartMs) / 60_000)

    const tokenVelocity = totalTokens / windowMinutes
    const toolCallVelocity = this.events.length / windowMinutes

    // Detect consecutive identical calls
    let maxConsecutive = 0
    let currentConsecutive = 1
    for (let i = 1; i < tools.length; i++) {
      if (tools[i] === tools[i - 1]) {
        currentConsecutive++
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
      } else {
        currentConsecutive = 1
      }
    }

    // Detect model switches
    const models = this.events.map((e) => e.model)
    let modelSwitches = 0
    for (let i = 1; i < models.length; i++) {
      if (models[i] !== models[i - 1]) modelSwitches++
    }

    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      windowStartedAt: this.events[0]?.timestamp ?? new Date().toISOString(),
      windowEndedAt: this.events[this.events.length - 1]?.timestamp ?? new Date().toISOString(),
      toolCallCount: this.events.length,
      uniqueTools,
      totalTokens,
      modelSwitches,
      errorCount,
      tokenVelocity,
      toolCallVelocity,
      maxConsecutiveIdenticalCalls: maxConsecutive,
      activeSopIds,
      budgetUtilization,
    }
  }
}

/** Payload sent to the control plane for analysis. */
export interface TrajectorySummaryPayload {
  sessionId: string
  workspaceId: string
  windowStartedAt: string
  windowEndedAt: string
  toolCallCount: number
  uniqueTools: string[]
  totalTokens: number
  modelSwitches: number
  errorCount: number
  tokenVelocity: number
  toolCallVelocity: number
  maxConsecutiveIdenticalCalls: number
  activeSopIds: string[]
  budgetUtilization: number
}

// ─── Monitor Controller ─────────────────────────────────────────────

/**
 * Trajectory Monitor controller.
 *
 * Manages per-session buffers, subscribes to trace events via Valkey pub/sub,
 * and periodically submits summaries to the control plane for analysis.
 */
export class TrajectoryMonitor {
  private buffers = new Map<string, TrajectoryBuffer>()
  private submitTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly config: TrajectoryMonitorConfig) {}

  /**
   * Start the monitor — subscribe to Valkey and begin periodic submission.
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('trajectory_monitor already running')
      return
    }

    this.running = true
    const submitIntervalMs = this.config.submitIntervalMs ?? 60_000

    log.info(
      { submitIntervalMs, windowMs: this.config.windowMs ?? 300_000 },
      'Starting trajectory monitor',
    )

    // Start periodic summary submission
    this.submitTimer = setInterval(() => {
      void this.submitAllSummaries()
    }, submitIntervalMs)

    // Note: Valkey subscription is handled by the sync-daemon's existing
    // Redis subscriber. Events are forwarded to this worker via postMessage.
    // See LLD #52 §4.1 for the worker thread lifecycle.
  }

  /**
   * Stop the monitor and clean up resources.
   */
  stop(): void {
    if (this.submitTimer) {
      clearInterval(this.submitTimer)
      this.submitTimer = null
    }
    this.buffers.clear()
    this.running = false
    log.info('Trajectory monitor stopped')
  }

  /**
   * Process an incoming trace event from the Valkey pub/sub stream.
   * Called by the sync-daemon when a trace:live event is received.
   */
  handleTraceEvent(event: TraceEvent): void {
    // Apply session filter if configured
    if (
      this.config.sessionFilter?.length &&
      !this.config.sessionFilter.includes(event.sessionId)
    ) {
      return
    }

    let buffer = this.buffers.get(event.sessionId)
    if (!buffer) {
      buffer = new TrajectoryBuffer(
        event.sessionId,
        event.workspaceId,
        this.config.maxBufferSize ?? 500,
        this.config.windowMs ?? 300_000,
      )
      this.buffers.set(event.sessionId, buffer)
    }

    buffer.push(event)

    // Immediate submission for critical signals
    if (event.status === 'error' && buffer.size > 3) {
      void this.submitSummary(buffer)
    }
  }

  /**
   * Submit summaries for all active session buffers.
   */
  private async submitAllSummaries(): Promise<void> {
    const cooldownMs = this.config.submitIntervalMs ?? 60_000

    // Drain any cached offline trajectories first
    await this.drainOfflineTrajectories()

    for (const buffer of this.buffers.values()) {
      if (buffer.size === 0 || !buffer.canSubmit(cooldownMs)) continue
      await this.submitSummary(buffer)
    }

    // Clean up empty/stale buffers
    for (const [sessionId, buffer] of this.buffers.entries()) {
      if (buffer.size === 0) {
        this.buffers.delete(sessionId)
      }
    }
  }

  /**
   * Submit a single session's trajectory summary to the control plane.
   */
  private async submitSummary(buffer: TrajectoryBuffer): Promise<void> {
    const summary = buffer.toSummary([], 0) // SOPs and budget filled by CP
    const offlineFile = path.join(os.homedir(), '.intutic', 'events', 'offline-trajectories.jsonl')

    try {
      const res = await fetch(
        `${this.config.controlPlaneUrl}/api/v1/trajectory/analyze`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(summary),
          signal: AbortSignal.timeout(10_000), // 10s timeout
        },
      )

      buffer.markSubmitted()

      if (!res.ok) {
        log.warn(
          { sessionId: buffer.sessionId, status: res.status },
          `Trajectory submission failed: ${res.status}, buffering offline`,
        )
        this.saveOffline(summary, offlineFile)
        return
      }

      const verdict = (await res.json()) as { state: string; verdict: string }
      log.debug(
        { sessionId: buffer.sessionId, state: verdict.state, verdict: verdict.verdict },
        `Trajectory verdict: ${verdict.verdict}`,
      )
    } catch (err) {
      log.debug({ err, sessionId: buffer.sessionId }, 'Trajectory submission error (buffering offline)')
      buffer.markSubmitted()
      this.saveOffline(summary, offlineFile)
    }
  }

  private saveOffline(summary: TrajectorySummaryPayload, filePath: string): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.appendFileSync(filePath, JSON.stringify(summary) + '\n', 'utf-8')
    } catch (err) {
      log.error({ err }, 'Failed to write offline trajectory')
    }
  }

  private async drainOfflineTrajectories(): Promise<void> {
    const offlineFile = path.join(os.homedir(), '.intutic', 'events', 'offline-trajectories.jsonl')
    if (!fs.existsSync(offlineFile)) return

    try {
      const raw = fs.readFileSync(offlineFile, 'utf-8')
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 0) return

      log.info({ count: lines.length }, 'Attempting to drain offline trajectories')
      const remaining: string[] = []
      
      for (const line of lines) {
        try {
          const summary = JSON.parse(line)
          const res = await fetch(
            `${this.config.controlPlaneUrl}/api/v1/trajectory/analyze`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.apiKey}`,
              },
              body: JSON.stringify(summary),
              signal: AbortSignal.timeout(5000),
            }
          )
          if (!res.ok) {
            remaining.push(line)
          }
        } catch {
          remaining.push(line)
        }
      }

      if (remaining.length > 0) {
        fs.writeFileSync(offlineFile, remaining.join('\n') + '\n', 'utf-8')
      } else {
        fs.unlinkSync(offlineFile)
      }
    } catch (err) {
      log.error({ err }, 'Failed to drain offline trajectories')
    }
  }

  /** Get the number of active session buffers. */
  get activeSessionCount(): number {
    return this.buffers.size
  }
}
