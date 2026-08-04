/**
 * claudeCodeHooks.test.ts — Unit tests for Claude Code hooks compilation.
 *
 * Verifies that SOP markdown content and settings are parsed correctly to
 * extract blacklisted tools and regex patterns, and that the settings.json
 * config is written correctly.
 *
 * LLD #14 — Test Strategy
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { parseSopConstraints, updatePreToolUseHooks } from '../../src/harness/claudeCodeHooks.js'
import { HarnessType, type SyncSopEntry } from '@intutic/shared-types'

describe('Claude Code PreToolUse Hooks Compiler', () => {
  const mockSops: SyncSopEntry[] = [
    {
      sopId: 'sop_1',
      title: 'Security SOP',
      content: `
        This SOP forbids using raw destructive commands.
        High Risk Tool: Bash
        Blacklist Pattern: rm -rf *
        Deny Pattern: truncate table
      `,
      contentHash: 'hash1',
      harnessTargets: [HarnessType.CLAUDE_CODE],
    },
    {
      sopId: 'sop_2',
      title: 'DB SOP',
      content: `
        \`\`\`json
        {
          "highRiskTools": ["Write"],
          "patterns": ["drop database"]
        }
        \`\`\`
      `,
      contentHash: 'hash2',
      harnessTargets: [HarnessType.CLAUDE_CODE],
    },
  ]

  it('correctly parses constraints from markdown text and settings', () => {
    const settings = {
      highRiskTools: ['Read'],
      patterns: ['cat .env'],
    }

    const constraints = parseSopConstraints(mockSops, settings)

    expect(constraints.highRiskTools).toContain('Bash')
    expect(constraints.highRiskTools).toContain('Write')
    expect(constraints.highRiskTools).toContain('Read')

    expect(constraints.patterns).toContain('rm -rf *')
    expect(constraints.patterns).toContain('truncate table')
    expect(constraints.patterns).toContain('drop database')
    expect(constraints.patterns).toContain('cat .env')
  })

  it('writes settings.json and pre-tool-check.js to workspace root', async () => {
    const tempRoot = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-hooks-test-'))

    await updatePreToolUseHooks(tempRoot, mockSops)

    // Check script creation
    const scriptPath = node_path.join(tempRoot, '.intutic', 'hooks', 'pre-tool-check.js')
    const scriptStat = await node_fs.stat(scriptPath)
    expect(scriptStat.isFile()).toBe(true)

    const scriptContent = await node_fs.readFile(scriptPath, 'utf-8')
    expect(scriptContent).toContain('rm -rf *')
    expect(scriptContent).toContain('drop database')

    // Check local settings.json creation
    const settingsPath = node_path.join(tempRoot, '.claude', 'settings.json')
    const settingsStat = await node_fs.stat(settingsPath)
    expect(settingsStat.isFile()).toBe(true)

    const settings = JSON.parse(await node_fs.readFile(settingsPath, 'utf-8'))
    expect(settings.permissions?.deny).toContain('Bash')
    expect(settings.permissions?.deny).toContain('Write')
    expect(settings.permissions?.deny).toContain('Bash(*rm -rf **)')
    expect(settings.permissions?.deny).toContain('Bash(*drop database*)')
    expect(settings.hooks?.PreToolUse).toBeDefined()
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('pre-tool-check.js')

    await node_fs.rm(tempRoot, { recursive: true, force: true })
  })
})

// The pre-execution half of `review_before:`.
//
// This is the only gate in the product that can stop an action *before* it
// happens. The proxy sees a tool call after the harness made it, so its hold
// stops everything the run does next — valuable, but not the same thing. These
// tests pin the difference.
describe('review_before hook gate', () => {
  const sop = (content: string) => [{ sopId: 's1', title: 'Deploy', content } as never]

  it('parses review_before out of SOP front matter', () => {
    const c = parseSopConstraints(
      sop('---\nroles: deployer\nreview_before: action:deploy, Write\n---\nprose'),
    )
    expect(c.reviewBefore).toEqual(['action:deploy', 'Write'])
  })

  it('declares nothing when no SOP asks for a hold', () => {
    // The safety property: nothing is ever held unless someone declared it.
    const c = parseSopConstraints(sop('---\nroles: deployer\n---\nprose'))
    expect(c.reviewBefore).toEqual([])
  })

  it('agrees with the proxy parser on the shared fixture', async () => {
    // Two parsers for one directive is how a rule ends up enforced at one gate
    // and silently ignored at the other. This reads the same file
    // `packages/proxy/src/sops.rs` asserts against, so the two cannot drift
    // without one of them going red. The awkward whitespace and quoting in the
    // fixture are what they would disagree about first.
    const raw = await node_fs.readFile(
      // Inside packages/proxy, not the repo root. Both this package and the
      // proxy are in the open-core sync set; the repo root is not, so a
      // root-level fixture compiled fine here and broke the public build.
      node_path.resolve(
        __dirname,
        '../../../../packages/proxy/tests/fixtures/review-before-sop.md',
      ),
      'utf-8',
    )
    expect(parseSopConstraints(sop(raw)).reviewBefore).toEqual([
      'action:deploy',
      'action:publish',
      'Bash',
    ])
  })

  it('writes a hook script that blocks a declared action', async () => {
    const dir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-hook-'))
    await updatePreToolUseHooks(
      dir,
      sop('---\nreview_before: action:deploy\n---\nprose'),
    )
    const script = await node_fs.readFile(
      node_path.join(dir, '.intutic', 'hooks', 'pre-tool-check.js'),
      'utf-8',
    )
    await node_fs.rm(dir, { recursive: true, force: true })

    expect(script).toContain('action:deploy')
    expect(script).toContain('Held for human review')
    // exit(2) is Claude Code's block signal. Without it the hook observes and
    // the action proceeds — the exact inert-gate shape this feature replaces.
    expect(script).toMatch(/Held for human review[\s\S]{0,600}process\.exit\(2\)/)
  })

  it('makes no network call on the tool path', async () => {
    // This runs before every tool invocation. A hook that waits on HTTP makes
    // every agent slower, so the hold is a local file write and an exit code.
    const dir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-hook-'))
    await updatePreToolUseHooks(dir, sop('---\nreview_before: action:deploy\n---\nx'))
    const script = await node_fs.readFile(
      node_path.join(dir, '.intutic', 'hooks', 'pre-tool-check.js'),
      'utf-8',
    )
    await node_fs.rm(dir, { recursive: true, force: true })

    const holdBlock = script.slice(
      script.indexOf('const reviewBefore'),
      script.indexOf('SOP-compiled pattern blacklist'),
    )
    expect(holdBlock).not.toContain('http')
    expect(holdBlock).toContain('writeFileSync')
  })
})

describe('review_before parsing without regex backtracking', () => {
  /**
   * CodeQL alerts #29 and #30 flagged the two regexes this parser used as
   * "polynomial regular expression used on uncontrolled data" — and the data
   * really is uncontrolled: `content` is SOP text, and an agent that can write
   * a SOP file chooses it.
   *
   * MEASURED BEFORE CHANGING ANYTHING, and the finding did not reproduce. The
   * old `/^\s*review_before:\s*(.+)$/gim` parses 8 MB of adversarial
   * whitespace in 12 ms, and the old quote-trim is flat to 80k characters.
   * V8 prefilters the literal that follows `\s*`, and the trim's leading
   * alternative short-circuits, so neither degrades in practice. A timing test
   * here would have passed against the unfixed code — the first version of
   * this block did exactly that, and proved nothing.
   *
   * The rewrite is kept anyway, on two grounds that do not depend on the alert
   * being exploitable: it removes regex from a hot parser entirely, and it
   * mirrors the Rust side it is pinned against — `sops.rs` uses `trim()` and
   * `trim_matches(['"', '\'', '[', ']'])`, never a regex. A clean security tab
   * is also worth something: a real alert is easier to see without two
   * permanent false positives beside it.
   *
   * So these assert BEHAVIOUR, which is what actually changed hands here.
   */
  const sop = (content: string) => [{ sopId: 's1', title: 'Deploy', content } as never]

  it('strips surrounding quotes and brackets exactly as the Rust parser does', () => {
    const c = parseSopConstraints(sop('---\nreview_before: "action:deploy", [Bash], \'Write\'\n---\n'))
    expect(c.reviewBefore).toEqual(['action:deploy', 'Bash', 'Write'])
  })

  it('keeps quotes that are inside a token rather than around it', () => {
    // A linear trim walks in from both ends and stops; it must not strip
    // characters the Rust `trim_matches` would leave alone.
    const c = parseSopConstraints(sop('---\nreview_before: say"hi"\n---\n'))
    // Rust's trim_matches walks in from both ends and stops at the first
    // non-trim character, so the inner quote survives and the trailing one does not.
    expect(c.reviewBefore).toEqual(['say"hi'])
  })

  it('reads the key on an indented line, and ignores lines that only look like it', () => {
    const c = parseSopConstraints(
      sop('---\n    review_before: action:deploy\nnot_review_before: action:merge\n---\n'),
    )
    expect(c.reviewBefore).toEqual(['action:deploy'])
  })

  it('handles a large SOP without pathological slowdown', () => {
    // Not a ReDoS assertion — see above, the old code was fine too. This is a
    // plain sanity bound so an accidentally quadratic rewrite would show up.
    const payload = `${' '.repeat(200_000)}x\nreview_before: action:deploy\n`
    const started = Date.now()
    const c = parseSopConstraints(sop(payload))
    expect(c.reviewBefore).toEqual(['action:deploy'])
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
