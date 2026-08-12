// That `intutic gateway` and `intutic credentials` exist in the binary at
// all — mirrors integrityRegistration.test.ts's reasoning: gateway.test.ts
// and credentials.test.ts import their handlers directly and never touch
// cli.ts, so a deleted registration block would leave the handlers correct,
// tested, and unreachable, with no test failing to say so.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(here, '../cli.ts')
const source = readFileSync(CLI, 'utf8')

describe('gateway command registration', () => {
  it('registers the gateway command group', () => {
    expect(source).toMatch(/\.command\(\s*['"]gateway['"]\s*\)/)
  })

  it.each([
    ['register', 'runGatewayRegister'],
    ['list', 'runGatewayList'],
    ['status <gateway_id>', 'runGatewayStatus'],
    ['rotate <gateway_id>', 'runGatewayRotate'],
    ['revoke <gateway_id>', 'runGatewayRevoke'],
  ])('wires the %s subcommand to its handler', (subcommand, handler) => {
    const name = subcommand.split(' ')[0]
    expect(source, `subcommand '${name}' is not registered`).toMatch(
      new RegExp(`\\.command\\(\\s*['"]${name}(\\s+<[^>]+>)?['"]`),
    )
    expect(source, `'${name}' does not dispatch to ${handler}`).toContain(handler)
  })

  it('registers gateway config set', () => {
    expect(source).toMatch(/\.command\(\s*['"]config['"]\s*\)/)
    expect(source).toMatch(/\.command\(\s*['"]set\s+<gateway_id>['"]\s*\)/)
    expect(source).toContain('runGatewayConfigSet')
  })
})

describe('credentials command registration', () => {
  it('registers the credentials command group', () => {
    expect(source).toMatch(/\.command\(\s*['"]credentials['"]\s*\)/)
  })

  it.each([
    ['list', 'runCredentialsList'],
    ['set <provider>', 'runCredentialsSet'],
    ['unset <provider>', 'runCredentialsUnset'],
  ])('wires the %s subcommand to its handler', (subcommand, handler) => {
    const name = subcommand.split(' ')[0]
    expect(source, `subcommand '${name}' is not registered`).toMatch(
      new RegExp(`\\.command\\(\\s*['"]${name}(\\s+<[^>]+>)?['"]`),
    )
    expect(source, `'${name}' does not dispatch to ${handler}`).toContain(handler)
  })
})
