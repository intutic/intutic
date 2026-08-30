import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex, parseChecksums, verifyChecksum } from './binaryChecksum.js'

function realSha256Hex(buffer: Buffer): string {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex')
}

describe('sha256Hex', () => {
  it('matches a hand-computed digest', () => {
    const buf = Buffer.from('intutic-proxy fixture bytes')
    expect(sha256Hex(buf)).toBe(realSha256Hex(buf))
  })

  it('is sensitive to a single byte', () => {
    const a = Buffer.from('same except one byte: a')
    const b = Buffer.from('same except one byte: b')
    expect(sha256Hex(a)).not.toBe(sha256Hex(b))
  })
})

describe('parseChecksums', () => {
  it('accepts a well-formed object', () => {
    expect(parseChecksums('{"intutic-proxy-darwin-arm64":"sha256:abc"}')).toEqual({
      'intutic-proxy-darwin-arm64': 'sha256:abc',
    })
  })

  it.each(['[1,2,3]', 'null', '"just a string"', '42', 'not json at all'])(
    'rejects %s',
    (bad) => {
      expect(() => parseChecksums(bad)).toThrow()
    },
  )
})

describe('verifyChecksum', () => {
  it('passes when the digest matches', () => {
    const buf = Buffer.from('a real, unmodified release binary')
    const checksums = { 'intutic-proxy-linux-x64': sha256Hex(buf) }
    expect(() => verifyChecksum(buf, checksums, 'intutic-proxy-linux-x64')).not.toThrow()
  })

  it('refuses a tampered binary — one flipped byte', () => {
    const original = Buffer.from('a real, unmodified release binary')
    const checksums = { 'intutic-proxy-linux-x64': sha256Hex(original) }

    const tampered = Buffer.from(original)
    tampered[0] = tampered[0]! ^ 0xff // flip a single byte, simulating a swapped/corrupted asset

    expect(() => verifyChecksum(tampered, checksums, 'intutic-proxy-linux-x64')).toThrow(
      /Checksum mismatch/,
    )
  })

  it('refuses an asset absent from the manifest, not silently allows it', () => {
    const buf = Buffer.from('binary for an asset checksums.json forgot to list')
    const checksums = { 'intutic-proxy-darwin-arm64': sha256Hex(Buffer.from('a different asset')) }
    expect(() => verifyChecksum(buf, checksums, 'intutic-proxy-linux-x64')).toThrow(
      /no entry for intutic-proxy-linux-x64/,
    )
  })

  it('refuses against an empty manifest', () => {
    expect(() => verifyChecksum(Buffer.from('anything'), {}, 'intutic-proxy-win32-x64.exe')).toThrow()
  })
})
