/**
 * dlp.test.ts — Unit tests for the DLP argument scanner.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { scanToolInput, formatDlpBlockReason } from '../dlp.js'

describe('scanToolInput', () => {
  it('returns no findings for benign content', () => {
    const result = scanToolInput({ path: '/tmp/file.txt', content: 'hello world' })
    expect(result.hasFinding).toBe(false)
    expect(result.findings).toHaveLength(0)
  })

  it('detects OpenAI API keys', () => {
    const result = scanToolInput({ env: 'OPENAI_KEY=sk-abc123def456ghi789jkl012mno345pqr' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('OpenAI'))).toBe(true)
  })

  it('detects Anthropic API keys', () => {
    const result = scanToolInput({ key: 'sk-ant-api03-verylongantkeyhere12345678901234' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('Anthropic'))).toBe(true)
  })

  it('detects GitHub personal access tokens', () => {
    const result = scanToolInput({ token: 'ghp_abcdefghijklmnopqrstuvwxyz123456789012' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('GitHub'))).toBe(true)
  })

  it('detects AWS Access Key IDs', () => {
    const result = scanToolInput({ key: 'AKIAIOSFODNN7EXAMPLE' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('AWS'))).toBe(true)
  })

  it('detects PEM private keys', () => {
    const result = scanToolInput({ cert: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('private key'))).toBe(true)
  })

  it('detects destructive rm -rf / commands', () => {
    const result = scanToolInput({ command: 'rm -rf /var/data' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('Destructive'))).toBe(true)
  })

  it('detects SQL DROP TABLE', () => {
    const result = scanToolInput({ query: 'DROP TABLE users; SELECT 1' })
    expect(result.hasFinding).toBe(true)
    expect(result.findings.some((f) => f.description.includes('DROP TABLE'))).toBe(true)
  })

  it('detects SQL DROP DATABASE', () => {
    const result = scanToolInput({ sql: 'DROP DATABASE production' })
    expect(result.hasFinding).toBe(true)
  })

  it('handles null/undefined input gracefully', () => {
    expect(() => scanToolInput(null)).not.toThrow()
    expect(() => scanToolInput(undefined)).not.toThrow()
    const result = scanToolInput(undefined)
    expect(result.hasFinding).toBe(false)
  })

  it('handles deeply nested objects', () => {
    const result = scanToolInput({ outer: { inner: { key: 'sk-abc123def456ghi789jkl012mno345pqr' } } })
    expect(result.hasFinding).toBe(true)
  })

  it('returns multiple findings when multiple patterns match', () => {
    const result = scanToolInput({
      openai: 'sk-abc123def456ghi789jkl012mno345pqr',
      aws: 'AKIAIOSFODNN7EXAMPLE',
    })
    expect(result.findings.length).toBeGreaterThanOrEqual(2)
  })
})

describe('formatDlpBlockReason', () => {
  it('formats a single finding into readable text', () => {
    const findings = [{ pattern: 'sk-.*', description: 'OpenAI API key pattern' }]
    const reason = formatDlpBlockReason(findings)
    expect(reason).toContain('DLP scanner')
    expect(reason).toContain('OpenAI API key pattern')
    expect(reason).toContain('•')
  })

  it('formats multiple findings', () => {
    const findings = [
      { pattern: 'sk-.*', description: 'OpenAI API key' },
      { pattern: 'AKIA.*', description: 'AWS Access Key' },
    ]
    const reason = formatDlpBlockReason(findings)
    expect(reason).toContain('OpenAI API key')
    expect(reason).toContain('AWS Access Key')
  })
})
