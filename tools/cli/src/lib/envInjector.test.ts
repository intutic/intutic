import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBaseUrlEnvVars, removeBaseUrlEnvVars } from './envInjector.js'
import os from 'node:os'
import { execSync } from 'node:child_process'

describe('Environment Variable Injector', () => {
  it('correctly injects and removes env variables on the current platform', async () => {
    const platform = os.platform()
    const testProxyUrl = 'http://127.0.0.1:3001'

    const result = await injectBaseUrlEnvVars(testProxyUrl)
    expect(result.platform).toBe(platform)
    expect(result.vars).toContain('ANTHROPIC_BASE_URL')
    expect(result.vars).toContain('OPENAI_BASE_URL')

    if (platform === 'darwin') {
      expect(result.scope).toBe('system')
      expect(result.method).toBe('launchctl setenv')
      
      // Verify launchctl has it
      const anthropicVal = execSync('launchctl getenv ANTHROPIC_BASE_URL').toString().trim()
      expect(anthropicVal).toBe(testProxyUrl)
      
      const openaiVal = execSync('launchctl getenv OPENAI_BASE_URL').toString().trim()
      expect(openaiVal).toBe(testProxyUrl)
    }

    // Now clean up/remove
    await removeBaseUrlEnvVars()

    if (platform === 'darwin') {
      const anthropicValAfter = execSync('launchctl getenv ANTHROPIC_BASE_URL').toString().trim()
      expect(anthropicValAfter).toBe('')
      const openaiValAfter = execSync('launchctl getenv OPENAI_BASE_URL').toString().trim()
      expect(openaiValAfter).toBe('')
    }
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
