import { describe, it, expect } from 'vitest'
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
