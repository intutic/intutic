import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { injectBaseUrlEnvVars, removeBaseUrlEnvVars, type EnvInjectorTarget } from './envInjector.js'

// Every case runs against temporary files and a recording `exec`: persisting
// for real would edit this machine's shell profile or launchd session.
let dir: string
let commands: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-env-'))
  commands = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function target(platform: NodeJS.Platform, etcEnvironment = join(dir, 'no-such-dir', 'environment')): Required<Pick<EnvInjectorTarget, 'bashrc'>> & EnvInjectorTarget {
  return { platform, bashrc: join(dir, '.bashrc'), etcEnvironment, exec: (c) => { commands.push(c) } }
}

const URL = 'http://127.0.0.1:3001'

describe('env persist / clear on Linux, user level', () => {
  const original = '# mine\nalias ll="ls -l"\n'

  it('appends the marked exports and clear puts ~/.bashrc back exactly', async () => {
    const t = target('linux')
    writeFileSync(t.bashrc, original)

    const result = await injectBaseUrlEnvVars(URL, t)
    expect(result).toMatchObject({ scope: 'user', method: '~/.bashrc' })
    expect(readFileSync(t.bashrc, 'utf8')).toBe(
      original +
        `export ANTHROPIC_BASE_URL="${URL}" # intutic-env-ANTHROPIC_BASE_URL\n` +
        `export OPENAI_BASE_URL="${URL}" # intutic-env-OPENAI_BASE_URL\n`,
    )

    await removeBaseUrlEnvVars(t)
    expect(readFileSync(t.bashrc, 'utf8')).toBe(original)
  })

  it('does not grow ~/.bashrc on repeated persist or clear', async () => {
    const t = target('linux')
    writeFileSync(t.bashrc, original)
    await injectBaseUrlEnvVars(URL, t)
    const persisted = readFileSync(t.bashrc, 'utf8')
    await injectBaseUrlEnvVars(URL, t)
    expect(readFileSync(t.bashrc, 'utf8')).toBe(persisted)

    await removeBaseUrlEnvVars(t)
    await removeBaseUrlEnvVars(t)
    expect(readFileSync(t.bashrc, 'utf8')).toBe(original)
  })

  it('clear with nothing persisted changes nothing and creates nothing', async () => {
    const t = target('linux')
    await removeBaseUrlEnvVars(t)
    expect(existsSync(t.bashrc)).toBe(false)
  })
})

describe('env persist / clear on Linux, as root', () => {
  it('writes /etc/environment and clear removes the lines again', async () => {
    const etc = join(dir, 'environment')
    const original = 'PATH="/usr/local/sbin:/usr/local/bin:/usr/bin"\n'
    writeFileSync(etc, original)
    const t = target('linux', etc)

    const result = await injectBaseUrlEnvVars(URL, t)
    expect(result).toMatchObject({ scope: 'system', method: '/etc/environment' })
    expect(readFileSync(etc, 'utf8')).toBe(`${original}ANTHROPIC_BASE_URL="${URL}"\nOPENAI_BASE_URL="${URL}"\n`)
    expect(existsSync(t.bashrc)).toBe(false)

    await removeBaseUrlEnvVars(t)
    expect(readFileSync(etc, 'utf8')).toBe(original)
  })
})

describe('env persist / clear on macOS and Windows', () => {
  it('macOS: launchctl setenv, then unsetenv for both variables', async () => {
    const t = target('darwin')
    expect(await injectBaseUrlEnvVars(URL, t)).toMatchObject({ scope: 'system', method: 'launchctl setenv' })
    await removeBaseUrlEnvVars(t)
    expect(commands).toEqual([
      `launchctl setenv ANTHROPIC_BASE_URL "${URL}"`,
      `launchctl setenv OPENAI_BASE_URL "${URL}"`,
      'launchctl unsetenv ANTHROPIC_BASE_URL',
      'launchctl unsetenv OPENAI_BASE_URL',
    ])
  })

  it('macOS: clear succeeds when launchctl reports nothing to unset', async () => {
    await expect(removeBaseUrlEnvVars({ platform: 'darwin', exec: () => { throw new Error('exit 1') } })).resolves.toBeUndefined()
  })

  it('Windows: setx, then the HKCU\\Environment values are deleted', async () => {
    const t = target('win32')
    await injectBaseUrlEnvVars(URL, t)
    await removeBaseUrlEnvVars(t)
    expect(commands).toEqual([
      `setx ANTHROPIC_BASE_URL "${URL}"`,
      `setx OPENAI_BASE_URL "${URL}"`,
      'reg delete HKCU\\Environment /v ANTHROPIC_BASE_URL /f',
      'reg delete HKCU\\Environment /v OPENAI_BASE_URL /f',
    ])
  })
})

describe('the injector is reachable from a command', () => {
  // envInjector shipped under a ✅ RESOLVED marker with this test file beside
  // it and no caller anywhere in `src/` — the tests exercised the functions
  // directly, which is exactly why nobody noticed there was no way for a user
  // to invoke them (TD-041). Testing a function is not the same as shipping it.
  const here = dirname(fileURLToPath(import.meta.url))
  const commandsDir = join(here, '..', 'commands')

  const commandSrc = readdirSync(commandsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(commandsDir, f), 'utf8'))
    .join('\n')
    // Prose naming a function is not a call.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  const exported = [...readFileSync(join(here, 'envInjector.ts'), 'utf8')
    .matchAll(/export async function (\w+)/g)].map((m) => m[1]!)

  it('finds the exported entry points to check', () => {
    expect(exported.length).toBeGreaterThanOrEqual(2)
  })

  for (const name of exported) {
    it(`some command calls ${name}`, () => {
      const called = new RegExp(`\\b${name}\\b`).test(commandSrc)
      expect(called, `${name} is exported and tested but no command calls it`).toBe(true)
    })
  }
})
