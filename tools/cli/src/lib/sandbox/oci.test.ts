import { describe, it, expect } from 'vitest'
import { buildOciArgs } from './oci.js'
import type { SandboxSpec } from './types.js'

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    command: ['claude'],
    workdir: '/home/dev/project',
    image: 'intutic/sandbox:latest',
    envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
    proxyHostAlias: 'host.docker.internal',
    allowCidrs: [],
    memory: '2g',
    cpus: '2',
    pidsLimit: 512,
    tty: false,
    ...overrides,
  }
}

describe('buildOciArgs', () => {
  it('starts from zero capabilities and adds back only the transition set', () => {
    const args = buildOciArgs('docker', spec())
    expect(args).toContain('--cap-drop=ALL')
    // Exactly the caps the entrypoint needs to install nft + drop privilege.
    for (const cap of ['NET_ADMIN', 'NET_RAW', 'SETPCAP', 'SETUID', 'SETGID']) {
      expect(args).toContain(`--cap-add=${cap}`)
    }
    // No other cap is added.
    const added = args.filter((a) => a.startsWith('--cap-add=')).sort()
    expect(added).toEqual(
      ['--cap-add=NET_ADMIN', '--cap-add=NET_RAW', '--cap-add=SETPCAP', '--cap-add=SETUID', '--cap-add=SETGID'].sort(),
    )
  })

  it('pins the rest of the isolation envelope', () => {
    const args = buildOciArgs('docker', spec())
    expect(args).toContain('--security-opt=no-new-privileges')
    expect(args).toContain('--read-only')
    expect(args).toContain('--pids-limit=512')
    expect(args).toContain('--memory=2g')
    expect(args).toContain('--cpus=2')
    expect(args).toContain('--add-host=host.docker.internal:host-gateway')
    // the project is the one writable mount
    expect(args.join(' ')).toContain('-v /home/dev/project:/work')
  })

  it('passes env by NAME, never by value (keeps secrets out of argv)', () => {
    const args = buildOciArgs('docker', spec())
    expect(args).toContain('--env')
    expect(args).toContain('ANTHROPIC_API_KEY')
    // The literal must not appear as KEY=VALUE anywhere.
    expect(args.join(' ')).not.toMatch(/ANTHROPIC_API_KEY=/)
  })

  it('separates the agent command with -- so the entrypoint execs it', () => {
    const args = buildOciArgs('docker', spec({ command: ['python', 'agent.py'] }))
    const dashDash = args.lastIndexOf('--')
    expect(dashDash).toBeGreaterThan(-1)
    expect(args.slice(dashDash)).toEqual(['--', 'python', 'agent.py'])
    // the image comes right before the separator
    expect(args[dashDash - 1]).toBe('intutic/sandbox:latest')
  })

  it('allocates a TTY only when asked', () => {
    expect(buildOciArgs('docker', spec({ tty: true }))).toContain('-it')
    expect(buildOciArgs('docker', spec({ tty: false }))).toContain('-i')
    expect(buildOciArgs('docker', spec({ tty: false }))).not.toContain('-it')
  })
})
