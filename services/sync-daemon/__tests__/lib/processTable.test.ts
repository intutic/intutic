import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProcTable } from '../../src/lib/processTable.js'

describe('readProcTable', () => {
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true })))

  it('reads each numeric entry and skips kernel threads and the rest of /proc', () => {
    const root = mkdtempSync(join(tmpdir(), 'proc-'))
    roots.push(root)
    mkdirSync(join(root, '12'))
    writeFileSync(join(root, '12', 'cmdline'), 'node\0/usr/bin/intutic\0connect\0')
    mkdirSync(join(root, '13'))
    writeFileSync(join(root, '13', 'cmdline'), '')
    mkdirSync(join(root, '14')) // Exited: no cmdline left to read.
    mkdirSync(join(root, 'net'))
    expect(readProcTable(root)).toEqual([{ pid: 12, command: 'node /usr/bin/intutic connect' }])
  })

  it('is empty where there is no /proc', () => {
    expect(readProcTable('/no/such/proc')).toEqual([])
  })
})
