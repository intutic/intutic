import { describe, it, expect, afterEach } from 'vitest'
import { localProxyPort, localProxyProbeBase } from './localProxy.js'

describe('localProxyPort', () => {
  const saved = process.env.INTUTIC_PROXY_URL
  const savedPort = process.env.PORT

  afterEach(() => {
    if (saved === undefined) delete process.env.INTUTIC_PROXY_URL
    else process.env.INTUTIC_PROXY_URL = saved
    if (savedPort === undefined) delete process.env.PORT
    else process.env.PORT = savedPort
  })

  it('is 4000 with nothing set, and ignores the shell PORT', () => {
    delete process.env.INTUTIC_PROXY_URL
    process.env.PORT = '3000'
    expect(localProxyPort()).toBe(4000)
    expect(localProxyProbeBase()).toBe('http://127.0.0.1:4000')
  })

  it('follows INTUTIC_PROXY_URL', () => {
    process.env.INTUTIC_PROXY_URL = 'http://localhost:8080'
    expect(localProxyPort()).toBe(8080)
    expect(localProxyProbeBase()).toBe('http://127.0.0.1:8080')
  })

  it('treats an empty or portless value as the default', () => {
    process.env.INTUTIC_PROXY_URL = ''
    expect(localProxyPort()).toBe(4000)
    process.env.INTUTIC_PROXY_URL = 'http://proxy.internal.example'
    expect(localProxyPort()).toBe(4000)
  })
})
