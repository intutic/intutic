/**
 * OpenHands detection, and where the adapter puts the rule sets.
 *
 * A bare `config.toml` used to be enough for detection, so every Hugo site
 * (and any project with a config.toml) was reported as OpenHands and then had
 * `[llm]` and `[intutic]` tables merged into its config. The rule sets went
 * into that `[intutic]` table, which OpenHands never reads; they now go into
 * a repository microagent, which it keeps active in every conversation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncSopEntry } from '@intutic/shared-types'
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

describe('openhandsAdapter.writeConfig', () => {
  const PROXY = 'http://localhost:4000'
  const SOPS: SyncSopEntry[] = [
    { sopId: 'sop_1', title: 'No secrets', content: 'Never print a secret.', contentHash: '', harnessTargets: [] },
  ]
  const microagent = () => join(root, '.openhands', 'microagents', 'intutic-governance.md')
  const config = () => join(root, 'config.toml')

  it('writes the rule sets into an always-on microagent, and only [llm] base_url into config.toml', async () => {
    await fs.writeFile(config(), '[core]\nworkspace_base = "./ws"\n\n[intutic]\ninstructions = """\nold rules\n"""\n')

    expect(await openhandsAdapter.writeConfig(root, SOPS, PROXY)).toBe(microagent())

    const rules = await fs.readFile(microagent(), 'utf-8')
    // No frontmatter, so no triggers: OpenHands keeps it active in every conversation.
    expect(rules.startsWith('# Intutic Governance Rules (auto-generated)\n')).toBe(true)
    expect(rules).toContain('## No secrets\n\nNever print a secret.')
    expect(await fs.readFile(config(), 'utf-8')).toBe(`[core]\nworkspace_base = "./ws"\n\n[llm]\nbase_url = "${PROXY}/v1"\n`)
  })

  it('writes no microagent without rule sets', async () => {
    await openhandsAdapter.writeConfig(root, [], PROXY)
    expect(existsSync(microagent())).toBe(false)
    expect(existsSync(config())).toBe(true)
  })
})
