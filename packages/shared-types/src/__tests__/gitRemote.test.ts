import { describe, it, expect } from 'vitest'
import { normalizeGitRemote } from '../gitRemote.js'

// Credential-shaped values are assembled at runtime so no contiguous token
// literal sits in source for a secret scanner to trip on.
const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')

describe('normalizeGitRemote', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['https://github.com/acme/widgets', 'github.com/acme/widgets'],
    ['https://GitHub.com/acme/widgets/', 'github.com/acme/widgets'],
    ['git@github.com:acme/widgets.git', 'github.com/acme/widgets'],
    ['ssh://git@gitlab.example.com:2222/group/sub/widgets.git', 'gitlab.example.com/group/sub/widgets'],
    ['git+ssh://git@github.com/acme/widgets.git', 'github.com/acme/widgets'],
    ['git://example.com/acme/widgets', 'example.com/acme/widgets'],
    ['  https://github.com/acme/widgets.git\n', 'github.com/acme/widgets'],
  ])('%s -> %s', (remote, expected) => {
    expect(normalizeGitRemote(remote)).toBe(expected)
  })

  it('strips credentials from an https remote', () => {
    const out = normalizeGitRemote(`https://alice:${token}@github.com/acme/widgets.git`)
    expect(out).toBe('github.com/acme/widgets')
    expect(out).not.toContain(token)
    expect(out).not.toContain('alice')
  })

  it('strips a token-only userinfo, as CI checkouts write it', () => {
    expect(normalizeGitRemote(`https://x-access-token:${token}@github.com/acme/widgets`)).toBe('github.com/acme/widgets')
    expect(normalizeGitRemote(`https://${token}@github.com/acme/widgets`)).toBe('github.com/acme/widgets')
  })

  it('strips credentials from the scp-like form', () => {
    const out = normalizeGitRemote(`deploy:${token}@git.example.com:acme/widgets.git`)
    expect(out).toBe('git.example.com/acme/widgets')
  })

  it('drops a query string and fragment, where tokens also travel', () => {
    expect(normalizeGitRemote(`https://example.com/acme/widgets.git?access_token=${token}#main`)).toBe('example.com/acme/widgets')
  })

  it('drops the port, so the ssh and https spellings of one repository compare equal', () => {
    expect(normalizeGitRemote('ssh://git@github.com:22/acme/widgets.git')).toBe(normalizeGitRemote('https://github.com/acme/widgets'))
  })

  it.each([
    [''],
    ['   '],
    ['/home/dev/widgets'],
    ['../widgets'],
    ['file:///home/dev/widgets.git'],
    ['C:\\src\\widgets'],
    ['C:/src/widgets'],
    ['https://github.com'],
    ['https://github.com/'],
    ['not a url'],
  ])('%j is not a hosted repository: null', (remote) => {
    expect(normalizeGitRemote(remote)).toBeNull()
  })
})
