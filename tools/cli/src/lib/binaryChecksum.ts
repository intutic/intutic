/**
 * Checksum verification for downloaded release binaries.
 *
 * Mirrors packages/proxy/bin/proxy.js's own copy of these three functions
 * (same names, same behavior, same `sha256:<hex>` digest shape) — that file
 * has no build step and deliberately no dependencies beyond Node builtins, so
 * it cannot import this package; the logic is kept in lockstep by hand
 * instead, same as this file's caller already mirrors that one's asset-name
 * resolution and download flow.
 *
 * @module
 */
import { createHash } from 'node:crypto'

/** `sha256:<hex>` of `buffer` — the shape publish.yml's checksums.json values use. */
export function sha256Hex(buffer: Buffer): string {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex')
}

/** Parses a checksums.json body into a plain name→digest map. Throws on any other shape. */
export function parseChecksums(text: string): Record<string, string> {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('checksums.json did not parse to an object')
  }
  return data as Record<string, string>
}

/**
 * Throws unless `buffer`'s digest matches `checksums[assetName]`. A missing entry
 * fails the same as a mismatch — an asset absent from the manifest is exactly as
 * unverifiable as one that fails it, and treating it as "nothing to check" would
 * make the whole guard optional for any release that forgot to list an asset.
 */
export function verifyChecksum(buffer: Buffer, checksums: Record<string, string>, assetName: string): void {
  const expected = checksums[assetName]
  const actual = sha256Hex(buffer)
  if (!expected) {
    throw new Error(`checksums.json has no entry for ${assetName} — refusing to install an unverified binary.`)
  }
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}:\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `This could mean a corrupted download or a tampered release asset — refusing to install it. Do not retry blindly.`,
    )
  }
}
