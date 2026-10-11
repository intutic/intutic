/**
 * atomicWrite.test.ts — the shared atomic writer every harness writer, gate
 * and policy snapshot write goes through.
 *
 * What it promises: the target ends up with exactly the new content and the
 * requested mode; no temp file outlives the call, whether it succeeds or
 * fails; concurrent writers never collide; and a reader racing the writer
 * only ever sees a whole version, never a truncated one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

/** Rename failures to inject, by errno code, consumed one per rename call. */
const renameFailures: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      const code = renameFailures.shift()
      if (code) throw Object.assign(new Error(`${code}: injected`), { code })
      return real.rename(from, to)
    },
  }
})

const { writeFileAtomic } = await import('../../src/lib/atomicWrite.js')

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-atomic-'))
  renameFailures.length = 0
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777
const listDir = () => fs.readdir(dir)

describe('writeFileAtomic', () => {
  it('creates and then replaces the file, string or bytes', async () => {
    const file = path.join(dir, 'gate.js')
    await writeFileAtomic(file, 'first\n')
    expect(await fs.readFile(file, 'utf-8')).toBe('first\n')
    await writeFileAtomic(file, Buffer.from('second\n'))
    expect(await fs.readFile(file, 'utf-8')).toBe('second\n')
    expect(await listDir()).toEqual(['gate.js'])
  })

  it('sets the requested mode whatever the umask, and replaces a read-only file', async () => {
    const file = path.join(dir, 'policy-snapshot.rules')
    const umask = process.umask(0o077)
    try {
      await writeFileAtomic(file, 'v1', { mode: 0o444 })
      expect(await modeOf(file)).toBe(0o444)
      await writeFileAtomic(file, 'v2', { mode: 0o444 })
      expect(await fs.readFile(file, 'utf-8')).toBe('v2')
      expect(await modeOf(file)).toBe(0o444)
      await writeFileAtomic(file, '#!/bin/sh\n', { mode: 0o755 })
      expect(await modeOf(file)).toBe(0o755)
    } finally {
      process.umask(umask)
    }
  })

  it("keeps the replaced file's mode when none is given, and gives a new file the plain writeFile default", async () => {
    const kept = path.join(dir, 'settings.json')
    await fs.writeFile(kept, '{}')
    await fs.chmod(kept, 0o600)
    await writeFileAtomic(kept, '{"a":1}')
    expect(await modeOf(kept)).toBe(0o600)

    const fresh = path.join(dir, 'fresh.json')
    const plain = path.join(dir, 'plain.json')
    await writeFileAtomic(fresh, '{}')
    await fs.writeFile(plain, '{}')
    expect(await modeOf(fresh)).toBe(await modeOf(plain))
  })

  it('is never visible without its final mode', async () => {
    // A gate renamed in and then chmodded can be found non-executable; Cline
    // runs nothing that is not executable, and the settings guard takes that
    // for tampering.
    const file = path.join(dir, 'PreToolUse')
    await writeFileAtomic(file, 'v0', { mode: 0o755 })
    let done = false
    const seen = new Set<number>()
    const watch = (async () => {
      while (!done) {
        try {
          seen.add(await modeOf(file))
        } catch {
          seen.add(-1)
        }
      }
    })()
    for (let i = 0; i < 100; i++) await writeFileAtomic(file, `v${i}`, { mode: 0o755 })
    done = true
    await watch
    expect([...seen]).toEqual([0o755])
  })

  it('leaves no temp file and the old content when the write fails', async () => {
    const file = path.join(dir, 'hooks.json')
    await writeFileAtomic(file, 'old')
    renameFailures.push('EIO')
    await expect(writeFileAtomic(file, 'new')).rejects.toThrow('EIO')
    expect(await fs.readFile(file, 'utf-8')).toBe('old')
    expect(await listDir()).toEqual(['hooks.json'])

    // Replacing a directory fails at the rename, after the temp was written.
    await fs.mkdir(path.join(dir, 'a-dir'))
    await expect(writeFileAtomic(path.join(dir, 'a-dir'), 'x')).rejects.toThrow()
    expect((await listDir()).sort()).toEqual(['a-dir', 'hooks.json'])

    // A missing parent fails before any temp exists.
    await expect(writeFileAtomic(path.join(dir, 'missing', 'f'), 'x')).rejects.toThrow()
    expect((await listDir()).sort()).toEqual(['a-dir', 'hooks.json'])
  })

  it('lets concurrent writers to one target each land whole, without sharing a temp file', async () => {
    const file = path.join(dir, 'settings.json')
    const versions = Array.from({ length: 50 }, (_, i) => JSON.stringify({ writer: i, pad: 'x'.repeat(10_000) }))
    await Promise.all(versions.map((v) => writeFileAtomic(file, v)))
    expect(versions).toContain(await fs.readFile(file, 'utf-8'))
    expect(await listDir()).toEqual(['settings.json'])
  })

  it('never lets a reader see a partial file', async () => {
    // Two large versions written alternately while reads race them. A plain
    // writeFile truncates and then fills, so a read in between gets an empty
    // or cut-off file; here every read must parse to one whole version.
    const file = path.join(dir, 'claude-code-check.json')
    const versions = ['a', 'b'].map((tag) => JSON.stringify({ tag, body: tag.repeat(2_000_000) }))
    await writeFileAtomic(file, versions[0]!)
    let done = false
    let reads = 0
    const bad: string[] = []
    const reader = (async () => {
      while (!done) {
        const text = await fs.readFile(file, 'utf-8')
        reads++
        if (!versions.includes(text)) bad.push(`${text.length} bytes`)
      }
    })()
    for (let i = 1; i <= 40; i++) await writeFileAtomic(file, versions[i % 2]!)
    done = true
    await reader
    expect(reads).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })

  it('writes through a symlink only when asked, and otherwise replaces the link itself', async () => {
    const real = path.join(dir, 'dotfiles-settings.json')
    const link = path.join(dir, 'settings.json')
    await fs.writeFile(real, 'old')
    await fs.symlink(real, link)

    await writeFileAtomic(link, 'through', { followSymlink: true })
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(real, 'utf-8')).toBe('through')

    // A file the daemon owns: a planted link must not redirect the write.
    await writeFileAtomic(link, 'replaced')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(false)
    expect(await fs.readFile(link, 'utf-8')).toBe('replaced')
    expect(await fs.readFile(real, 'utf-8')).toBe('through')
  })

  describe('on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }))
    afterEach(() => Object.defineProperty(process, 'platform', platform))

    it('retries a rename refused for a moment (an open or read-only target)', async () => {
      const file = path.join(dir, 'policy-snapshot.json')
      await writeFileAtomic(file, 'old', { mode: 0o444 })
      renameFailures.push('EPERM', 'EBUSY')
      await writeFileAtomic(file, 'new', { mode: 0o444 })
      expect(await fs.readFile(file, 'utf-8')).toBe('new')
      expect(await modeOf(file)).toBe(0o444)
      expect(await listDir()).toEqual(['policy-snapshot.json'])
    })

    it('falls back to writing in place when the rename keeps being refused', async () => {
      const file = path.join(dir, 'settings.json')
      await writeFileAtomic(file, 'old')
      renameFailures.push(...Array(5).fill('EBUSY'))
      await writeFileAtomic(file, 'new', { mode: 0o640 })
      expect(renameFailures).toEqual([])
      expect(await fs.readFile(file, 'utf-8')).toBe('new')
      expect(await modeOf(file)).toBe(0o640)
      expect(await listDir()).toEqual(['settings.json'])
    })

    it('does not retry an error a retry cannot fix', async () => {
      const file = path.join(dir, 'settings.json')
      renameFailures.push('ENOSPC')
      await expect(writeFileAtomic(file, 'x')).rejects.toThrow('ENOSPC')
      expect(await listDir()).toEqual([])
    })
  })
})
