/**
 * skillWriter Unit Tests
 *
 * Validates write-if-missing semantics for bundled agent skills and that the
 * embedded skill constant stays identical to the canonical repo file at
 * .agents/skills/intutic-rule-author/SKILL.md.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import {
  writeBundledSkills,
  RULE_AUTHOR_SKILL,
  RULE_AUTHOR_SKILL_PATH,
} from '../src/skillWriter.js'

describe('skillWriter', () => {
  const testWorkspaceRoot = node_path.join(__dirname, 'mock_skill_workspace')

  beforeEach(async () => {
    await node_fs.rm(testWorkspaceRoot, { recursive: true, force: true })
    await node_fs.mkdir(testWorkspaceRoot, { recursive: true })
  })

  afterEach(async () => {
    await node_fs.rm(testWorkspaceRoot, { recursive: true, force: true })
  })

  it('writes the rule-author skill when absent', async () => {
    const written = await writeBundledSkills(testWorkspaceRoot)
    const dest = node_path.join(testWorkspaceRoot, RULE_AUTHOR_SKILL_PATH)
    expect(written).toEqual([dest])

    const content = await node_fs.readFile(dest, 'utf-8')
    expect(content).toBe(RULE_AUTHOR_SKILL)
    expect(content).toContain('name: intutic-rule-author')
  })

  it('never overwrites an existing (possibly user-edited) skill file', async () => {
    await writeBundledSkills(testWorkspaceRoot)
    const dest = node_path.join(testWorkspaceRoot, RULE_AUTHOR_SKILL_PATH)

    const userEdited = '# my customized skill\n'
    await node_fs.writeFile(dest, userEdited, 'utf-8')

    const written = await writeBundledSkills(testWorkspaceRoot)
    expect(written).toEqual([])
    expect(await node_fs.readFile(dest, 'utf-8')).toBe(userEdited)
  })

  it('embedded constant matches the canonical repo SKILL.md', async () => {
    // Guards the intentional duplication (the daemon runs outside the repo).
    const canonical = node_path.join(
      __dirname,
      '../../../.agents/skills/intutic-rule-author/SKILL.md',
    )
    let repoContent: string
    try {
      repoContent = await node_fs.readFile(canonical, 'utf-8')
    } catch {
      console.log('skipping: canonical SKILL.md not present (running outside the monorepo)')
      return
    }
    expect(RULE_AUTHOR_SKILL).toBe(repoContent)
  })
})