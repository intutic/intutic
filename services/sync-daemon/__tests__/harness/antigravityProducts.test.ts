/**
 * antigravityProducts.test.ts — which of Google Antigravity and Gemini CLI a
 * machine has, the answer the agent report, the AI inventory and the CLI's
 * detection all use.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { antigravityGateIdentities, presentGateIdentities } from '../../src/harness/antigravityProducts.js'
import { GATE_ARTIFACTS, GATE_IDENTITY_ARTIFACTS } from '../../src/harness/gateArtifacts.js'
import { gateIdentitiesOf } from '@intutic/shared-types'

describe('antigravityGateIdentities', () => {
  let base: string
  let home: string
  let ws: string
  let bin: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'intutic-gemini-products-'))
    home = join(base, 'home')
    ws = join(base, 'ws')
    bin = join(base, 'bin')
    for (const d of [home, ws, bin]) mkdirSync(d, { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const probe = () => antigravityGateIdentities(ws, { home, path: bin })
  const executable = (name: string) => {
    writeFileSync(join(bin, name), '#!/bin/sh\n')
    chmodSync(join(bin, name), 0o755)
  }
  const settings = (doc: unknown) => {
    mkdirSync(join(home, '.gemini'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify(doc))
  }

  it('finds neither on a bare machine', async () => {
    expect(await probe()).toEqual([])
  })

  it('finds a plain Gemini CLI install by its binary, with no .gemini in the workspace', async () => {
    executable('gemini')
    expect(await probe()).toEqual(['gemini-cli'])
  })

  it('finds Gemini CLI by a settings file of its own, and not by the hooks Intutic writes there', async () => {
    settings({ hooks: { BeforeTool: [] } })
    expect(await probe()).toEqual([])
    settings({ hooks: { BeforeTool: [] }, security: { auth: { selectedType: 'oauth-personal' } } })
    expect(await probe()).toEqual(['gemini-cli'])
  })

  it('does not take the intutic MCP server Intutic adds there for Gemini CLI, but does a server of the user\'s', async () => {
    const intutic = { command: 'node', args: ['/x/@intutic/mcp-governance-proxy/dist/index.js'] }
    settings({ hooks: { BeforeTool: [] }, mcpServers: { intutic } })
    expect(await probe()).toEqual([])
    settings({ hooks: { BeforeTool: [] }, mcpServers: { intutic, github: { command: 'gh-mcp' } } })
    expect(await probe()).toEqual(['gemini-cli'])
  })

  it('finds Gemini CLI by a project .gemini directory', async () => {
    mkdirSync(join(ws, '.gemini'))
    expect(await probe()).toEqual(['gemini-cli'])
  })

  it('finds Antigravity by its app-data directory, its project hooks file or its binary', async () => {
    mkdirSync(join(home, '.gemini', 'antigravity-ide'), { recursive: true })
    expect(await probe()).toEqual(['antigravity'])
    rmSync(join(home, '.gemini'), { recursive: true })
    mkdirSync(join(ws, '.agents'))
    writeFileSync(join(ws, '.agents', 'hooks.json'), '{}')
    expect(await probe()).toEqual(['antigravity'])
    rmSync(join(ws, '.agents'), { recursive: true })
    executable('antigravity')
    expect(await probe()).toEqual(['antigravity'])
  })

  it('finds both on a machine with both', async () => {
    executable('gemini')
    mkdirSync(join(home, '.gemini', 'antigravity'), { recursive: true })
    expect(await probe()).toEqual(['antigravity', 'gemini-cli'])
  })

  it('keeps a configured antigravity harness under its own id when neither product is found, and leaves other harnesses alone', async () => {
    expect(await presentGateIdentities('antigravity', ws, { home, path: bin })).toEqual(['antigravity'])
    executable('gemini')
    expect(await presentGateIdentities('antigravity', ws, { home, path: bin })).toEqual(['gemini-cli'])
    expect(await presentGateIdentities('cursor', ws, { home, path: bin })).toEqual(['cursor'])
  })
})

describe('GATE_IDENTITY_ARTIFACTS', () => {
  it('splits the antigravity gate files between its two gate ids, one each', () => {
    expect(Object.keys(GATE_IDENTITY_ARTIFACTS).sort()).toEqual([...gateIdentitiesOf('antigravity')].sort())
    expect(Object.values(GATE_IDENTITY_ARTIFACTS).flat().sort()).toEqual([...GATE_ARTIFACTS['antigravity']!].sort())
  })
})
