import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createShutdownHandler, terminateChild } from './gracefulShutdown.js'

afterEach(() => vi.useRealTimers())

describe('createShutdownHandler', () => {
  it('runs the graceful path once and exits at the deadline even if cleanup never finishes', () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const onShutdown = vi.fn()
    const handler = createShutdownHandler({ onShutdown, exit, deadlineMs: 5_000 })
    handler()
    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4_999)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits immediately on a second signal without rerunning the graceful path', () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const onShutdown = vi.fn()
    const handler = createShutdownHandler({ onShutdown, exit })
    handler()
    handler()
    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits when the graceful path itself throws', () => {
    const exit = vi.fn()
    createShutdownHandler({ onShutdown: () => { throw new Error('boom') }, exit })()
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('terminateChild', () => {
  it('kills a child that ignores SIGTERM once the grace period is over', async () => {
    // A real child that traps SIGTERM: the case that kept a proxy alive.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
    await once(child.stdout!, 'data')
    terminateChild(child, 200)
    const [code, signal] = await once(child, 'exit')
    expect(code).toBeNull()
    expect(signal).toBe('SIGKILL')
  }, 10_000)

  it('lets a well-behaved child exit on SIGTERM and does nothing to one already gone', async () => {
    const child = spawn(process.execPath, ['-e', "console.log('up');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
    await once(child.stdout!, 'data')
    terminateChild(child, 5_000)
    const [, signal] = await once(child, 'exit')
    expect(signal).toBe('SIGTERM')
    expect(() => terminateChild(child)).not.toThrow()
  }, 10_000)
})
