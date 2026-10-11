import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_SANDBOX_IMAGE, NODE_SANDBOX_IMAGE, ensureSandboxImage, sandboxBuildContext, type RuntimeRunner } from './image.js'

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
    for (const name of ['Dockerfile', 'Dockerfile.node']) {
      const dockerfile = readFileSync(join(context, name), 'utf8')
      for (const copied of [...dockerfile.matchAll(/^COPY\s+(\S+)/gm)].map((m) => m[1]!)) {
        expect(existsSync(join(context, copied)), `${copied} is copied by ${name}`).toBe(true)
      }
    }
  })
})

describe('the Node sandbox image', () => {
  it('is the default tag with a -node suffix', () => {
    expect(NODE_SANDBOX_IMAGE).toBe(`intutic/sandbox:${pkg.version}-node`)
  })

  // Same entrypoint, firewall and capability drop: the Node image may only add
  // packages on top of the default one, never replace how it starts.
  it('only adds Node.js and npm to the default image', () => {
    const lines = readFileSync(join(sandboxBuildContext(), 'Dockerfile.node'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
    expect(lines).toEqual(['ARG INTUTIC_SANDBOX_BASE', 'FROM ${INTUTIC_SANDBOX_BASE}', 'RUN apk add --no-cache nodejs npm'])
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

  it('builds the default image, then the Node image FROM it, when both are missing', async () => {
    const run = runner({ image: 1, build: 0 })
    await ensureSandboxImage('docker', NODE_SANDBOX_IMAGE, run)
    const context = sandboxBuildContext()
    expect(run.calls).toEqual([
      ['image', 'inspect', NODE_SANDBOX_IMAGE],
      ['image', 'inspect', DEFAULT_SANDBOX_IMAGE],
      ['build', '-t', DEFAULT_SANDBOX_IMAGE, context],
      ['build', '-f', join(context, 'Dockerfile.node'), '--build-arg', `INTUTIC_SANDBOX_BASE=${DEFAULT_SANDBOX_IMAGE}`, '-t', NODE_SANDBOX_IMAGE, context],
    ])
  })

  it('builds only the Node image when the default one exists', async () => {
    const calls: string[][] = []
    const run: RuntimeRunner = async (_runtime, args) => {
      calls.push(args)
      return args[0] === 'image' ? (args[2] === DEFAULT_SANDBOX_IMAGE ? 0 : 1) : 0
    }
    await ensureSandboxImage('podman', NODE_SANDBOX_IMAGE, run)
    expect(calls.filter((c) => c[0] === 'build').map((c) => c[c.length - 2])).toEqual([NODE_SANDBOX_IMAGE])
  })

  it('does not build the Node image when the default one fails to build', async () => {
    const run = runner({ image: 1, build: 1 })
    await expect(ensureSandboxImage('docker', NODE_SANDBOX_IMAGE, run)).rejects.toThrow(`build of ${DEFAULT_SANDBOX_IMAGE}`)
    expect(run.calls.filter((c) => c[0] === 'build')).toHaveLength(1)
  })

  it('names the problem when the build context is not installed', async () => {
    await expect(
      ensureSandboxImage('docker', DEFAULT_SANDBOX_IMAGE, runner({ image: 1 }), '/nonexistent/sandbox'),
    ).rejects.toThrow('--sandbox-image')
  })
})
