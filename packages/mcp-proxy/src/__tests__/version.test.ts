import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PACKAGE_VERSION } from '../version.js'

describe('PACKAGE_VERSION', () => {
  it('is the version in package.json, not a constant that drifts from it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }
    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})
