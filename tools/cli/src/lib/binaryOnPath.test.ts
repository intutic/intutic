import { describe, it, expect } from 'vitest'
import { binaryOnPath } from './binaryOnPath.js'

describe('binaryOnPath', () => {
  it('resolves true for a binary guaranteed present on any POSIX PATH', async () => {
    // `sh` itself is what this function shells out through, so it is always
    // resolvable wherever this function can run at all.
    expect(await binaryOnPath('sh')).toBe(true)
  })

  it('resolves false for a binary name that does not exist', async () => {
    expect(await binaryOnPath('intutic-definitely-not-a-real-binary-xyz')).toBe(false)
  })
})
