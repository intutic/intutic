import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_SANDBOX_IMAGE, ensureSandboxImage, sandboxBuildContext, type RuntimeRunner } from './image.js'

const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string; files: string[] }

vi.spyOn(console, 'log').mockImplementation(() => {})

describe('the default sandbox image', () => {
  it('is a local tag carrying the CLI version, not a registry image nothing publishes', () => {
    expect(DEFAULT_SANDBOX_IMAGE).toBe(`intutic/sandbox:${pkg.version}`)
  })

  // The build needs these at run time on a user's machine, so they must be in
  // the npm package, not only in the repository.
  it('ships its build context in the npm package', () => {
    expect(pkg.files).toContain('resources/sandbox/')
    const context = sandboxBuildContext()
    expect(existsSync(join(context, 'Dockerfile'))).toBe(true)
    const dockerfile = readFileSync(join(context, 'Dockerfile'), 'utf8')
    for (const copied of [...dockerfile.matchAll(/^COPY\s+(\S+)/gm)].map((m) => m[1]!)) {
      expect(existsSync(join(context, copied)), `${copied} is copied by the Dockerfile`).toBe(true)
    }
  })
})

describe('ensureSandboxImage', () => {
  function runner(codes: Record<string, number>): RuntimeRunner & { calls: string[][] } {
    const calls: string[][] = []
    const fn: RuntimeRunner = async (_runtime, args) => {
      calls.push(args)
      return codes[args[0]!] ?? 0
    }
    return Object.assign(fn, { calls })
  }

  it('leaves any other image to the runtime', async () => {
    const run = runner({})
    await ensureSandboxImage('docker', 'ghcr.io/acme/agent:1', run)
    expect(run.calls).toEqual([])
  })

  it('does nothing more when the default image already exists', async () => {
    const run = runner({ image: 0 })
    await ensureSandboxImage('docker', DEFAULT_SANDBOX_IMAGE, run)
    expect(run.calls).toEqual([['image', 'inspect', DEFAULT_SANDBOX_IMAGE]])
  })

  it('builds the default image from the shipped context when it is missing', async () => {
    const run = runner({ image: 1, build: 0 })
    await ensureSandboxImage('podman', DEFAULT_SANDBOX_IMAGE, run)
    expect(run.calls[1]).toEqual(['build', '-t', DEFAULT_SANDBOX_IMAGE, sandboxBuildContext()])
  })

  it('throws when the build fails', async () => {
    await expect(ensureSandboxImage('docker', DEFAULT_SANDBOX_IMAGE, runner({ image: 1, build: 1 }))).rejects.toThrow(
      'build of',
    )
  })

  it('names the problem when the build context is not installed', async () => {
    await expect(
      ensureSandboxImage('docker', DEFAULT_SANDBOX_IMAGE, runner({ image: 1 }), '/nonexistent/sandbox'),
    ).rejects.toThrow('--sandbox-image')
  })
})
