/**
 * gateArtifacts.test.ts — the AI inventory's list of gate file paths matches
 * the gates this repo actually generates, and the lookup finds them.
 *
 * @module
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GATE_ARTIFACTS, DSH_PROFILE_GATE_FILE, findGateFile } from '../../src/harness/gateArtifacts.js'
import { gateKindForHarness } from '../../src/harness/gateKind.js'
import { GATES } from './gateRegistry.js'
import type { HarnessType } from '@intutic/shared-types'

/** Registry row names that are not simply the kebab-cased harness type. */
const ROW_HARNESS: Record<string, string> = {
  museCode: 'muse-code',
  openWebui: 'open-webui',
}

const harnessOf = (name: string): string =>
  ROW_HARNESS[name] ?? name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

describe('GATE_ARTIFACTS', () => {
  it('lists every generated gate file under its harness', () => {
    for (const row of GATES) {
      const harness = harnessOf(row.name)
      if (harness === 'dsh') {
        expect(row.artifact.endsWith(DSH_PROFILE_GATE_FILE), row.name).toBe(true)
        continue
      }
      expect(GATE_ARTIFACTS[harness as HarnessType], row.name).toContain(row.artifact)
    }
  })

  it('lists no harness the registry has no gate for, and only hook-gated ones', () => {
    const generated = new Set(GATES.map((row) => harnessOf(row.name)))
    for (const harness of Object.keys(GATE_ARTIFACTS)) {
      expect(generated.has(harness), harness).toBe(true)
      expect(gateKindForHarness(harness as HarnessType), harness).toBe('hook')
    }
  })
})

describe('findGateFile', () => {
  let home: string
  let root: string
  const prevDshHome = process.env.DSH_HOME

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
  })

  function setup(): void {
    home = mkdtempSync(join(tmpdir(), 'intutic-gate-artifacts-home-'))
    root = mkdtempSync(join(tmpdir(), 'intutic-gate-artifacts-root-'))
  }

  function touch(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '#!/bin/sh\n')
  }

  it('finds a workspace gate and a per-user gate, and reports a missing one as null', async () => {
    setup()
    touch(join(root, '.intutic', 'hooks', 'cursor-check.js'))
    touch(join(home, '.agents', 'plugins', 'intutic-governance', 'scripts', 'intutic-check.sh'))

    expect(await findGateFile('cursor', root, home)).toBe(join(root, '.intutic', 'hooks', 'cursor-check.js'))
    expect(await findGateFile('goose', root, home)).toBe(join(home, '.agents', 'plugins', 'intutic-governance', 'scripts', 'intutic-check.sh'))
    expect(await findGateFile('claude-code', root, home)).toBeNull()
    expect(await findGateFile('langgraph', root, home)).toBeNull()
  })

  it('does not count a directory at a gate path as the gate', async () => {
    setup()
    mkdirSync(join(root, '.intutic', 'hooks', 'codex-check.js'), { recursive: true })
    expect(await findGateFile('codex', root, home)).toBeNull()
  })

  it('finds dsh’s gate in whichever profile has it', async () => {
    setup()
    process.env.DSH_HOME = join(home, '.dsh')
    const profile = join(home, '.dsh', 'profiles', 'work')
    touch(join(profile, 'package.json'))
    expect(await findGateFile('dsh', root, home)).toBeNull()
    touch(join(profile, DSH_PROFILE_GATE_FILE))
    expect(await findGateFile('dsh', root, home)).toBe(join(profile, DSH_PROFILE_GATE_FILE))
  })
})
