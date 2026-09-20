/**
 * Shutdown that actually ends the process (TD-484).
 *
 * `intutic connect` trapped SIGTERM, logged "Shutting down", aborted its poll
 * loop, and then stayed alive: a daemon asked to stop kept polling its control
 * plane for four and a half hours, through two stops. Aborting a loop is a
 * request; nothing enforced it. An await that never settles, or a child whose
 * pipes stay open, is enough to keep the event loop — and the process — alive.
 *
 * Two rules, both enforced by timers that are `unref`'d so they never keep a
 * process alive themselves, only end one that something else is holding open:
 *
 *   1. a child told to stop is killed if it has not exited after a grace period;
 *   2. the process exits after a deadline whether or not cleanup finished, and
 *      at once on a second signal.
 *
 * @module
 */

import type { ChildProcess } from 'node:child_process'

export const CHILD_GRACE_MS = 3_000
export const EXIT_DEADLINE_MS = 8_000

/** SIGTERM now, SIGKILL after `graceMs` if the child is still running. */
export function terminateChild(child: ChildProcess, graceMs = CHILD_GRACE_MS): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, graceMs)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}

export interface ShutdownHandlerOptions {
  /** Starts the graceful path: abort loops, stop children. Runs once. */
  onShutdown: () => void
  deadlineMs?: number
  /** Injectable for tests. */
  exit?: (code: number) => void
}

/**
 * Returns a signal handler. First call: run `onShutdown` and arm the exit
 * deadline. Any later call: exit immediately — a second Ctrl-C or a second
 * `kill` means "now", and the first one evidently was not enough.
 */
export function createShutdownHandler(opts: ShutdownHandlerOptions): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  let started = false
  return () => {
    if (started) {
      exit(1)
      return
    }
    started = true
    const timer = setTimeout(() => exit(0), opts.deadlineMs ?? EXIT_DEADLINE_MS)
    timer.unref()
    try {
      opts.onShutdown()
    } catch {
      exit(1)
    }
  }
}
