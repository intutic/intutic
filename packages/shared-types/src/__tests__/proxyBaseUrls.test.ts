/**
 * proxyBaseUrls.test.ts — the proxy routes only `/v1/messages`,
 * `/v1/chat/completions` and `/v1/responses`, so the Anthropic base URL must
 * be the bare host and the OpenAI one must end in `/v1`. Writing one URL into
 * both variables mis-routed whichever SDK family it did not fit.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_PROXY_HOST, proxyHost, anthropicBaseUrl, openaiBaseUrl } from '../proxyBaseUrls.js'

describe('proxy base URLs', () => {
  it('appends the SDK-specific suffix to reach the routes the proxy serves', () => {
    const host = 'http://localhost:4000'
    // Anthropic SDKs append /v1/messages; OpenAI SDKs append /chat/completions.
    expect(`${anthropicBaseUrl(host)}/v1/messages`).toBe('http://localhost:4000/v1/messages')
    expect(`${openaiBaseUrl(host)}/chat/completions`).toBe('http://localhost:4000/v1/chat/completions')
    expect(`${openaiBaseUrl(host)}/responses`).toBe('http://localhost:4000/v1/responses')
  })

  it('accepts a configured URL that already carries /v1 or a trailing slash', () => {
    for (const configured of ['http://gw:4000/v1', 'http://gw:4000/v1/', 'http://gw:4000/', ' http://gw:4000 ']) {
      expect(proxyHost(configured)).toBe('http://gw:4000')
      expect(anthropicBaseUrl(configured)).toBe('http://gw:4000')
      expect(openaiBaseUrl(configured)).toBe('http://gw:4000/v1')
    }
  })

  it('keeps a path prefix in front of /v1', () => {
    expect(openaiBaseUrl('https://example.com/intutic')).toBe('https://example.com/intutic/v1')
    expect(anthropicBaseUrl('https://example.com/intutic/v1')).toBe('https://example.com/intutic')
  })

  it('falls back to the local proxy when no URL is configured', () => {
    for (const empty of ['', undefined, null]) {
      expect(proxyHost(empty)).toBe(DEFAULT_PROXY_HOST)
      expect(openaiBaseUrl(empty)).toBe(`${DEFAULT_PROXY_HOST}/v1`)
    }
  })
})
