/**
 * OpenHands detection. A bare `config.toml` used to be enough, so every Hugo
 * site (and any project with a config.toml) was reported as OpenHands and
 * then had `[llm]` and `[intutic]` tables merged into its config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openhandsAdapter } from './openhands.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'intutic-openhands-detect-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const detect = () => openhandsAdapter.detect(root)

describe('openhandsAdapter.detect', () => {
  it('ignores a config.toml that is not an OpenHands configuration', async () => {
    await fs.writeFile(join(root, 'config.toml'), 'baseURL = "https://example.org/"\ntitle = "Blog"\n\n[params]\nauthor = "me"\n')
    expect(await detect()).toBe(false)
    await fs.writeFile(join(root, 'config.toml'), '[llm]\nmodel = "x"\n\n[mcp]\nurl = "y"\n')
    expect(await detect()).toBe(false)
    await fs.writeFile(join(root, 'config.toml'), 'not = toml = at all\n')
    expect(await detect()).toBe(false)
  })

  it('detects nothing in an empty workspace', async () => {
    expect(await detect()).toBe(false)
  })

  it.each([
    ['[core]', '[core]\nworkspace_base = "./workspace"\n'],
    ['[sandbox]', '[llm]\nmodel = "gpt-4o"\n\n[sandbox]\ntimeout = 120\n'],
    ['[agent]', '[agent]\nenable_browsing = true\n'],
    ['[intutic], written by an earlier connect', '[intutic]\nproxy_url = "http://localhost:4000"\n'],
  ])('detects a config.toml with %s', async (_label, content) => {
    await fs.writeFile(join(root, 'config.toml'), content)
    expect(await detect()).toBe(true)
  })

  it('detects the per-repository .openhands directory', async () => {
    await fs.mkdir(join(root, '.openhands'))
    await fs.writeFile(join(root, '.openhands', 'setup.sh'), '#!/bin/sh\n')
    expect(await detect()).toBe(true)
  })
})
