// That `intutic org` and `intutic team` exist in the binary at all — same
// reasoning as gatewayCredentialsRegistration.test.ts and
// integrityRegistration.test.ts: org.test.ts/team.test.ts import their
// handlers directly and never touch cli.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(here, '../cli.ts')
const source = readFileSync(CLI, 'utf8')

describe('org command registration', () => {
  it('registers the org command group', () => {
    expect(source).toMatch(/\.command\(\s*['"]org['"]\s*\)/)
  })

  it('wires signup to its handler', () => {
    expect(source).toMatch(/\.command\(\s*['"]signup['"]\s*\)/)
    expect(source).toContain('runOrgSignup')
  })
})

describe('team command registration', () => {
  it('registers the team command group', () => {
    expect(source).toMatch(/\.command\(\s*['"]team['"]\s*\)/)
  })

  it.each([
    ['list', 'runTeamList'],
    ['create', 'runTeamCreate'],
    ['workspaces <team_id>', 'runTeamWorkspaces'],
    ['create-workspace <team_id>', 'runTeamCreateWorkspace'],
  ])('wires the %s subcommand to its handler', (subcommand, handler) => {
    const name = subcommand.split(' ')[0]
    expect(source, `subcommand '${name}' is not registered`).toMatch(
      new RegExp(`\\.command\\(\\s*['"]${name}(\\s+<[^>]+>)?['"]`),
    )
    expect(source, `'${name}' does not dispatch to ${handler}`).toContain(handler)
  })
})
