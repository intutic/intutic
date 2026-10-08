import { describe, it, expect, vi, afterEach } from 'vitest'
import { printOnboardingGuide } from './onboarding.js'

function captured(harnesses: string[], token?: string): string {
  const out: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    out.push(String(chunk))
    return true
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '))
  })
  printOnboardingGuide(harnesses, token)
  return out.join('')
}

describe('printOnboardingGuide', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Standalone, the proxy passes the agent's own provider key through, so
  // telling an open-core user to export an Intutic key they cannot get sends
  // them to a dead end.
  it('asks for the provider key, not an Intutic key, when not logged in', () => {
    const text = captured(['claude-code', 'aider'])
    expect(text).toContain('use your own provider API key')
    expect(text).toContain('<YOUR_PROVIDER_API_KEY>')
    expect(text).not.toContain('INTUTIC_API_KEY>')
    expect(text).toContain('intutic exec -- claude')
  })

  it('shows the masked workspace key when logged in', () => {
    const text = captured(['claude-code'], 'vk_test_token_value')
    expect(text).toContain('vk_t...alue')
    expect(text).not.toContain('<YOUR_PROVIDER_API_KEY>')
  })
})
