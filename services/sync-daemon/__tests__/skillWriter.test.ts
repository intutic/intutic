/**
 * skillWriter Unit Tests
 *
 * Validates write-if-missing semantics for bundled agent skills, that each is
 * recorded as a file Intutic created (so disconnect can take it back), and
 * that the embedded skill constants stay identical to the canonical repo
 * files under .agents/skills/.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { scanSkillContent } from '@intutic/shared-types'
import {
  writeBundledSkills,
  BUNDLED_SKILLS,
  KITKAT_SKILL,
  KITKAT_SKILL_PATH,
  RULE_AUTHOR_SKILL,
  RULE_AUTHOR_SKILL_PATH,
} from '../src/skillWriter.js'
import { readOriginal } from '../src/disconnect/originals.js'

describe('skillWriter', () => {
  const testWorkspaceRoot = node_path.join(__dirname, 'mock_skill_workspace')

  beforeEach(async () => {
    await node_fs.rm(testWorkspaceRoot, { recursive: true, force: true })
    await node_fs.mkdir(testWorkspaceRoot, { recursive: true })
  })

  afterEach(async () => {
    await node_fs.rm(testWorkspaceRoot, { recursive: true, force: true })
  })

  it('writes the rule-author and Kitkat skills when absent, each recorded as Intutic\'s', async () => {
    const written = await writeBundledSkills(testWorkspaceRoot)
    const ruleAuthor = node_path.join(testWorkspaceRoot, RULE_AUTHOR_SKILL_PATH)
    const kitkat = node_path.join(testWorkspaceRoot, KITKAT_SKILL_PATH)
    expect(written).toEqual([ruleAuthor, kitkat])

    expect(await node_fs.readFile(ruleAuthor, 'utf-8')).toBe(RULE_AUTHOR_SKILL)
    expect(await node_fs.readFile(kitkat, 'utf-8')).toBe(KITKAT_SKILL)
    expect(KITKAT_SKILL).toContain('name: intutic-governance-kitkat')
    // Disconnect deletes what this record says connect created.
    const record = await readOriginal(kitkat, testWorkspaceRoot)
    expect(record).toMatchObject({ existed: false, writtenSha256: expect.any(String) })
    expect(record?.createdDirs).toContain(node_path.join(testWorkspaceRoot, '.agents', 'skills', 'intutic-governance-kitkat'))
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

  it('leaves a skill the user already had alone, and keeps no record of it', async () => {
    const dest = node_path.join(testWorkspaceRoot, KITKAT_SKILL_PATH)
    await node_fs.mkdir(node_path.dirname(dest), { recursive: true })
    await node_fs.writeFile(dest, '# downloaded\n', 'utf-8')
    expect(await writeBundledSkills(testWorkspaceRoot)).toEqual([node_path.join(testWorkspaceRoot, RULE_AUTHOR_SKILL_PATH)])
    expect(await node_fs.readFile(dest, 'utf-8')).toBe('# downloaded\n')
    expect(await readOriginal(dest, testWorkspaceRoot)).toBeNull()
  })

  it('embedded constants match the canonical repo SKILL.md files', async () => {
    // Guards the intentional duplication (the daemon runs outside the repo).
    for (const skill of BUNDLED_SKILLS) {
      const canonical = node_path.join(__dirname, '../../..', skill.path)
      let repoContent: string
      try {
        repoContent = await node_fs.readFile(canonical, 'utf-8')
      } catch {
        console.log(`skipping: canonical ${skill.path} not present (running outside the monorepo)`)
        return
      }
      expect(skill.content, skill.path).toBe(repoContent)
    }
  })

  // The single most load-bearing fixture for `packages/shared-types/src/skillScan.ts`'s
  // pattern table (see that module's own doc comment). RULE_AUTHOR_SKILL is
  // full of the exact imperative security prose ("Never embed secrets…",
  // "kill requests once the session budget drops below…") most likely to
  // trip an overzealous pattern, and it is a real skill this codebase
  // already ships to every workspace. This assertion lives here rather than
  // in shared-types' own test suite because `packages/shared-types` is a
  // leaf package `sync-daemon` depends on — importing sync-daemon's source
  // from shared-types would invert that dependency. This is the one point
  // in the dependency graph where both pieces are available together.
  it('scanSkillContent reports both bundled skills as clean (zero findings)', () => {
    for (const skill of BUNDLED_SKILLS) {
      const result = scanSkillContent(skill.content)
      expect(result.findings, `unexpected findings in ${skill.path}: ${JSON.stringify(result.findings)}`).toEqual([])
      expect(result.clean).toBe(true)
    }
  })
})