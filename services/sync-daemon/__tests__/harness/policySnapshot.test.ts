/**
 * The policy snapshot is the only thing in this design that can turn an allow
 * into a block without a release, so it is the only thing that can turn a
 * workspace off by accident.
 *
 * Two live landmines make that concrete rather than theoretical:
 *
 *  1. `evaluate.ts` emits `{toolPattern: '.*', action: 'warn'}` for **every**
 *     HIGH- or CRITICAL-risk SOP in a workspace. Anything that ships resolved
 *     rules to a blocking path and does not filter on the action will put a
 *     catch-all on every developer's machine.
 *  2. A `BLOCK:` SOP's `toolPattern` is author-written text. It reaches thirteen
 *     gates, five of which evaluate it with `grep -E` and eight with JavaScript
 *     `RegExp`.
 *
 * So the assertions here are mostly about what does *not* get written.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  writePolicySnapshot,
  buildSnapshotRules,
  validateRule,
  fetchResolvedPolicy,
  SNAPSHOT_JSON,
  SNAPSHOT_RULES,
  DESTRUCTIVE_TIER_SEVERITY,
  SKILL_SURFACE_TIER_SEVERITY,
  type ResolvedPolicy,
} from '../../src/lib/policySnapshot.js'
import { SKILL_SURFACE_PATTERNS, staticFloorPatterns, DESTRUCTIVE_COMMAND_PATTERNS } from '../../src/harness/protectedPaths.js'

function policy(over: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    workspaceId: 'ws_test',
    interventionMode: 'TRANSPARENT',
    sopRules: [],
    mcpAllowedServers: [],
    sqlDropStrictBlock: false,
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('fetchResolvedPolicy — absorbing allowedServers from GET /api/v1/policy/resolve', () => {
  it('reads mcpAllowedServers off the response field named `allowedServers`', async () => {
    // The M1-added field on this route — confirmed by reading
    // services/control-plane/src/routes/evaluate.ts and lib/mcpCuration.ts
    // directly: both name it `allowedServers`, not `mcpAllowedServers` or
    // anything else. This test pins that this module reads the SAME name
    // rather than a differently-spelled one nobody's route actually emits.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          workspaceId: 'ws_1',
          sopRules: [],
          interventionMode: 'TRANSPARENT',
          allowedServers: ['github', 'filesystem'],
        }),
      })) as unknown as typeof fetch,
    )
    const policy = await fetchResolvedPolicy({
      controlPlaneUrl: 'https://cp.example',
      apiKey: 'k',
      workspaceId: 'ws_1',
    })
    expect(policy?.mcpAllowedServers).toEqual(['github', 'filesystem'])
  })

  it('defaults mcpAllowedServers to [] when the field is absent or the wrong type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ workspaceId: 'ws_1', sopRules: [], interventionMode: 'TRANSPARENT' }),
      })) as unknown as typeof fetch,
    )
    const policy = await fetchResolvedPolicy({
      controlPlaneUrl: 'https://cp.example',
      apiKey: 'k',
      workspaceId: 'ws_1',
    })
    expect(policy?.mcpAllowedServers).toEqual([])
  })

  it('drops non-string entries rather than letting them through to the sanitiser untyped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          workspaceId: 'ws_1',
          sopRules: [],
          interventionMode: 'TRANSPARENT',
          allowedServers: ['github', 42, null, 'filesystem'],
        }),
      })) as unknown as typeof fetch,
    )
    const policy = await fetchResolvedPolicy({
      controlPlaneUrl: 'https://cp.example',
      apiKey: 'k',
      workspaceId: 'ws_1',
    })
    expect(policy?.mcpAllowedServers).toEqual(['github', 'filesystem'])
  })
})

describe('validateRule', () => {
  it('accepts an ordinary tool pattern', () => {
    expect(validateRule('Bash', 'sop_1')).toBeNull()
    expect(validateRule('Write|Edit', 'sop_2')).toBeNull()
  })

  it('rejects a pattern that matches every known tool', () => {
    // Written as "matches all the canaries" rather than as a denylist of the
    // three spellings we happened to think of, so `.+`, `[A-Za-z]*` and
    // anything else someone reaches for is caught by the same rule.
    for (const catchAll of ['.*', '.+', '^.*$', '[A-Za-z]*', '.?.*']) {
      expect(validateRule(catchAll, 'sop_x'), `${catchAll} was accepted`).toMatch(/catch-all/)
    }
  })

  it('M3: accepts a properly-scoped mcp__<server>__.* pattern, rejects a raw catch-all against the widened canary set', () => {
    // CANARY_TOOLS grew two mcp__<server>__<tool>-shaped entries in M3
    // (mcp__github__create_issue, mcp__filesystem__read_file) specifically so
    // this threshold check is exercised against MCP-shaped tool names too,
    // not just native ones. A rule scoped to one server must still pass; a
    // raw catch-all must still fail even with the wider canary set.
    expect(validateRule('mcp__github__.*', 'sop_mcp')).toBeNull()
    expect(validateRule('.*', 'sop_mcp_catchall')).toMatch(/catch-all/)
  })

  it('rejects an empty or anchor-only pattern', () => {
    expect(validateRule('', 'sop_x')).toMatch(/empty/)
    expect(validateRule('   ', 'sop_x')).toMatch(/empty/)
    expect(validateRule('^$', 'sop_x')).toMatch(/only anchors/)
  })

  it('rejects a pattern the two engines would read differently', () => {
    // `\s` is a JavaScript construct POSIX ERE does not define. A rule using it
    // would enforce in the eight JS gates and match nothing in the five bash
    // ones — enforcement that looks present and is half absent.
    expect(validateRule('Bash\\s+run', 'sop_x')).toMatch(/not portable/)
    expect(validateRule('[[:alpha:]]+', 'sop_x')).toMatch(/not portable/)
  })
})

describe('buildSnapshotRules', () => {
  it('drops every non-block rule', () => {
    const rules = buildSnapshotRules(
      policy({
        sopRules: [
          { id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' },
          { id: 's2', toolPattern: 'Write', action: 'warn', reason: 'careful' },
          { id: 's3', toolPattern: 'Edit', action: 'require_approval', reason: 'ask' },
        ],
      }),
    )
    const sopIds = rules.filter((r) => r.id.startsWith('sop.')).map((r) => r.id)
    expect(sopIds).toEqual(['sop.s1'])
  })

  it('drops the HIGH/CRITICAL catch-all the control plane emits', () => {
    // The landmine, verbatim: evaluate.ts returns this for every HIGH or
    // CRITICAL SOP in the workspace. Two independent things stop it — the
    // action filter and validateRule — because one of them being right is not
    // the same as it being guarded.
    const rules = buildSnapshotRules(
      policy({
        sopRules: [{ id: 'risky', toolPattern: '.*', action: 'warn', reason: 'High-risk SOP active' }],
      }),
    )
    expect(rules.filter((r) => r.id.startsWith('sop.'))).toEqual([])

    const asBlock = buildSnapshotRules(
      policy({
        sopRules: [{ id: 'risky', toolPattern: '.*', action: 'block', reason: 'High-risk SOP active' }],
      }),
    )
    expect(
      asBlock.filter((r) => r.id.startsWith('sop.')),
      'a catch-all survived even with the action filter bypassed',
    ).toEqual([])
  })

  it('matches a whole tool token, not a substring', () => {
    const [rule] = buildSnapshotRules(
      policy({ sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }] }),
    )
    const re = new RegExp(rule!.source)
    expect(re.test(' Bash '), 'did not match the tool it names').toBe(true)
    expect(re.test(' BashHistory '), 'matched an unrelated tool by prefix').toBe(false)
    expect(rule!.subject, 'a tool rule matched against command text would never fire').toBe('tool')
  })

  it('carries a WHERE clause through to the gate rule', () => {
    // The defect this whole change repairs: resolve served argPattern, this
    // type dropped it, and every gate enforced the rule as an unconditional
    // tool-name block — over-blocking `make test` while never testing the
    // condition the rule was written for.
    const [rule] = buildSnapshotRules(
      policy({
        sopRules: [{
          id: 's1', toolPattern: '^shell$', action: 'block',
          argPattern: 'kubectl\\s+apply(?!.*@sha256:)', reason: 'pin your images',
        }],
      }),
    )
    expect(rule!.argPattern).toBe('kubectl\\s+apply(?!.*@sha256:)')
    // The tool half still gets the portable-ERE treatment; the arg half must
    // NOT — it is a JS regex matched against serialized input, and lookahead
    // is most of why it exists.
    expect(rule!.source).toBe(' (shell) ')
  })

  it('strips an un-compilable argPattern and keeps the rule name-only', () => {
    // The clause NARROWS a block. Losing the clause widens enforcement (safe,
    // and visible as over-blocking); losing the rule would open a hole.
    const [rule] = buildSnapshotRules(
      policy({
        sopRules: [{
          id: 's1', toolPattern: 'Bash', action: 'block',
          argPattern: '*invalid(', reason: 'x',
        }],
      }),
    )
    expect(rule!.id).toBe('sop.s1')
    expect(rule!.argPattern).toBeUndefined()
  })

  it('ships the destructive tier at the declared severity', () => {
    const rules = buildSnapshotRules(policy())
    const rm = rules.find((r) => r.id === 'destructive.rm_rf_root')
    expect(rm, 'the destructive tier is not in the snapshot at all').toBeDefined()
    expect(rm!.severity).toBe(DESTRUCTIVE_TIER_SEVERITY)
  })

  it('marks rules shadow, not warn, in SILENT_LOG mode', () => {
    const rules = buildSnapshotRules(
      policy({
        interventionMode: 'SILENT_LOG',
        sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }],
      }),
    )
    // `shadow`, not `warn`. Both allow, but only one means "this would have
    // blocked" — and a shadow rollout is decided on that count. Collapsing them
    // made it unmeasurable.
    expect(rules.every((r) => r.severity === 'shadow')).toBe(true)
    expect(rules.some((r) => r.severity === 'warn'), 'a shadow snapshot still emits warn rules').toBe(false)
  })

  it('SILENT_LOG demotes the dynamic tier only — the static floor is untouched', () => {
    // The demotion is keyed on SILENT_LOG, the one intervention_mode_type
    // value that means observe-only (this check used to compare against
    // 'SHADOW', which the enum can never produce — a dead branch, so a
    // SILENT_LOG workspace shipped fully-blocking snapshots).
    const rules = buildSnapshotRules(policy({ interventionMode: 'SILENT_LOG' }))
    expect(rules.length).toBeGreaterThan(0)
    // Every snapshot-delivered (dynamic-tier) rule is advisory…
    expect(rules.every((r) => r.severity === 'shadow')).toBe(true)
    // …and none of them IS a static-floor rule: the floor's compiled-in
    // patterns are a separate table (staticFloorPatterns) this builder never
    // emits, so no settings string can demote the floor itself.
    const floorIds = new Set(staticFloorPatterns().map((r) => r.id))
    for (const r of rules) {
      expect(floorIds.has(r.id), `${r.id} would shadow a static-floor rule`).toBe(false)
    }
    // And the floor keeps its own severities regardless of workspace mode.
    expect(staticFloorPatterns().some((r) => r.severity === ('shadow' as never))).toBe(false)
  })

  it('the other two real modes (TRANSPARENT, OPAQUE) do NOT demote — both enforce', () => {
    for (const mode of ['TRANSPARENT', 'OPAQUE']) {
      const rules = buildSnapshotRules(
        policy({
          interventionMode: mode,
          sopRules: [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'x' }],
        }),
      )
      expect(
        rules.some((r) => r.severity === 'shadow'),
        `${mode} produced shadow rules — only SILENT_LOG is observe-only`,
      ).toBe(false)
    }
  })

  describe('skill-surface tier (TD-358 block-tier promotion)', () => {
    it('ships one rule per SKILL_SURFACE_PATTERNS entry at SKILL_SURFACE_TIER_SEVERITY', () => {
      const rules = buildSnapshotRules(policy())
      const skillRules = rules.filter((r) => r.id.startsWith('skill_surface.'))
      expect(skillRules.length).toBe(SKILL_SURFACE_PATTERNS.length)
      for (const r of skillRules) {
        expect(r.severity).toBe(SKILL_SURFACE_TIER_SEVERITY)
      }
      // Sanity: this test is only meaningful while the constant is 'block'.
      // If it is ever flipped back to 'warn' as the retraction this comment
      // predicts, this assertion still holds — it reads the constant, not a
      // hardcoded 'block'.
      expect(SKILL_SURFACE_TIER_SEVERITY).toBe('block')
    })

    it('suffixes snapshot-delivered ids so they never collide with the static-floor copies', () => {
      const rules = buildSnapshotRules(policy())
      const skillRules = rules.filter((r) => r.id.startsWith('skill_surface.'))
      const floorIds = new Set(staticFloorPatterns().map((r) => r.id))
      for (const r of skillRules) {
        expect(r.id.endsWith('.tier'), `${r.id} is not suffixed .tier`).toBe(true)
        expect(floorIds.has(r.id), `${r.id} collides with a static-floor rule id`).toBe(false)
        // The un-suffixed id IS a floor id — proving the suffix is what
        // prevents the collision, not that the ids were unrelated to begin
        // with.
        const base = r.id.slice(0, -'.tier'.length)
        expect(floorIds.has(base), `${base} was expected to be the floor's own id for ${r.id}`).toBe(true)
      }
    })

    it('matches the same source pattern as the corresponding floor rule', () => {
      const rules = buildSnapshotRules(policy())
      for (const floorPattern of SKILL_SURFACE_PATTERNS) {
        const snapshotRule = rules.find((r) => r.id === `${floorPattern.id}.tier`)
        expect(snapshotRule, `no snapshot rule for ${floorPattern.id}`).toBeDefined()
        expect(snapshotRule!.source).toBe(floorPattern.source)
        expect(snapshotRule!.subject).toBe(floorPattern.subject)
      }
    })

    it('marks skill-surface rules shadow, not block, in SILENT_LOG mode', () => {
      const rules = buildSnapshotRules(policy({ interventionMode: 'SILENT_LOG' }))
      const skillRules = rules.filter((r) => r.id.startsWith('skill_surface.'))
      expect(skillRules.length).toBeGreaterThan(0)
      expect(skillRules.every((r) => r.severity === 'shadow')).toBe(true)
    })
  })
})

describe('writePolicySnapshot', () => {
  it('writes both artifacts, read-only, with a shared digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-'))
    try {
      const { digest, ruleCount } = await writePolicySnapshot(
        policy({
          sopRules: [
            { id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' },
            {
              id: 's2', toolPattern: '^shell$', action: 'block',
              argPattern: 'kubectl\\s+apply(?!.*@sha256:)', reason: 'pin your images',
            },
          ],
        }),
        dir,
      )
      const jsonPath = join(dir, SNAPSHOT_JSON)
      const rulesPath = join(dir, SNAPSHOT_RULES)

      const doc = JSON.parse(readFileSync(jsonPath, 'utf8'))
      expect(doc.digest).toBe(digest)
      expect(doc.rules.length).toBe(ruleCount)
      expect(doc.workspaceId).toBe('ws_test')

      const rulesText = readFileSync(rulesPath, 'utf8')
      expect(rulesText).toContain(`#digest ${digest}`)

      // The projection must be derivable from the JSON — otherwise the bash
      // gates and the JS gates are reading two different policies that merely
      // claim the same digest.
      const lines = rulesText.split('\n').filter((l) => l && !l.startsWith('#'))
      expect(lines.length).toBe(doc.rules.length)
      expect(createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)).toBe(digest)

      // Every line has a declared column count. A reason containing a tab
      // would shift `source` into the reason column and the rule would
      // silently stop matching anything. Six columns without an argPattern —
      // byte-identical to the v3 layout, which is the forward-compat
      // contract — and seven with one.
      for (const line of lines) {
        const cols = line.split('\t').length
        expect([6, 7], `wrong column count (${cols}): ${line}`).toContain(cols)
      }

      // The WHERE rule's clause rides the seventh column, base64 — the one
      // encoding that cannot collide with the tab separator, since an
      // argPattern is an arbitrary regex the portable-ERE rules never vetted.
      const whereLine = lines.find((l) => l.startsWith('sop.s2\t'))!
      const cols = whereLine.split('\t')
      expect(cols.length).toBe(7)
      expect(Buffer.from(cols[6]!, 'base64').toString('utf8')).toBe('kubectl\\s+apply(?!.*@sha256:)')
      // And the name-only rule stays six columns — no trailing empty field.
      expect(lines.find((l) => l.startsWith('sop.s1\t'))!.split('\t').length).toBe(6)

      // 0444. The daemon replaces this by rename and never needs write access to
      // the file itself.
      expect(statSync(jsonPath).mode & 0o777).toBe(0o444)
      expect(statSync(rulesPath).mode & 0o777).toBe(0o444)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces an existing read-only snapshot rather than failing on it', async () => {
    // 0444 plus a plain overwrite is EACCES. The writer renames onto the target
    // instead, which is also what stops a gate from ever reading a half-written
    // file.
    const dir = mkdtempSync(join(tmpdir(), 'intutic-snap2-'))
    try {
      await writePolicySnapshot(policy(), dir)
      const second = await writePolicySnapshot(
        policy({ sopRules: [{ id: 's9', toolPattern: 'Edit', action: 'block', reason: 'x' }] }),
        dir,
      )
      const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
      expect(doc.digest).toBe(second.digest)
      expect(doc.rules.some((r: { id: string }) => r.id === 'sop.s9')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('mcpAllowedServers — the #mcpservers header (M3)', () => {
    it('omits the #mcpservers header entirely when the list is empty', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp1-'))
      try {
        await writePolicySnapshot(policy({ mcpAllowedServers: [] }), dir)
        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        expect(rulesText).not.toContain('#mcpservers')
        const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
        expect(doc.mcpAllowedServers).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('emits #mcpservers block <csv> when servers are configured, enforcing mode', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp2-'))
      try {
        await writePolicySnapshot(
          policy({ interventionMode: 'TRANSPARENT', mcpAllowedServers: ['github', 'filesystem'] }),
          dir,
        )
        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        expect(rulesText).toContain('#mcpservers block github,filesystem')
        const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
        expect(doc.mcpAllowedServers).toEqual(['github', 'filesystem'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('emits #mcpservers shadow <csv> in SILENT_LOG mode', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp3-'))
      try {
        await writePolicySnapshot(
          policy({ interventionMode: 'SILENT_LOG', mcpAllowedServers: ['github'] }),
          dir,
        )
        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        expect(rulesText).toContain('#mcpservers shadow github')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('drops a server name containing whitespace or a comma, rather than corrupting the header', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp4-'))
      try {
        await writePolicySnapshot(
          policy({
            mcpAllowedServers: ['github', 'bad name', 'bad,name', 'bad\tname', 'filesystem'],
          }),
          dir,
        )
        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        // Only the two clean names survive, and the header line still has
        // exactly one occurrence of each — a dropped name must not leave a
        // dangling comma or a corrupted line behind.
        expect(rulesText).toContain('#mcpservers block github,filesystem')
        expect(rulesText).not.toContain('bad name')
        expect(rulesText).not.toContain('bad,name')
        expect(rulesText).not.toContain('bad\tname')
        const doc = JSON.parse(readFileSync(join(dir, SNAPSHOT_JSON), 'utf8'))
        expect(doc.mcpAllowedServers).toEqual(['github', 'filesystem'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('drops every server name and omits the header when all names are unsafe', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp5-'))
      try {
        await writePolicySnapshot(policy({ mcpAllowedServers: ['bad name', '  ', 'a,b'] }), dir)
        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        expect(rulesText).not.toContain('#mcpservers')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('digest is unchanged by the #mcpservers header — it covers rule lines only', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'intutic-snap-mcp6-'))
      try {
        const sopRules = [{ id: 's1', toolPattern: 'Bash', action: 'block', reason: 'no shell' }]
        const without = await writePolicySnapshot(policy({ sopRules, mcpAllowedServers: [] }), dir)
        const withServers = await writePolicySnapshot(
          policy({ sopRules, mcpAllowedServers: ['github', 'filesystem'] }),
          dir,
        )
        expect(withServers.digest).toBe(without.digest)

        const rulesText = readFileSync(join(dir, SNAPSHOT_RULES), 'utf8')
        expect(rulesText).toContain('#mcpservers block github,filesystem')
        expect(rulesText).toContain(`#digest ${without.digest}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('sqlDropStrictBlock — Wave 7 (audit-remediation) per-rule override', () => {
  function findSqlDrop(rules: ReturnType<typeof buildSnapshotRules>) {
    return rules.find((r) => r.id === 'destructive.sql_drop')
  }

  it('stays warn when the flag is off, regardless of DESTRUCTIVE_TIER_SEVERITY', () => {
    const rules = buildSnapshotRules(policy({ sqlDropStrictBlock: false }))
    expect(findSqlDrop(rules)?.severity).toBe('warn')
  })

  it('promotes to block when the flag is on', () => {
    const rules = buildSnapshotRules(policy({ sqlDropStrictBlock: true }))
    expect(findSqlDrop(rules)?.severity).toBe('block')
  })

  it('does not affect the other six destructive-command patterns — DESTRUCTIVE_TIER_SEVERITY is untouched', () => {
    const withoutFlag = buildSnapshotRules(policy({ sqlDropStrictBlock: false }))
    const withFlag = buildSnapshotRules(policy({ sqlDropStrictBlock: true }))
    for (const p of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (p.id === 'destructive.sql_drop') continue
      const a = withoutFlag.find((r) => r.id === p.id)?.severity
      const b = withFlag.find((r) => r.id === p.id)?.severity
      expect(b, `${p.id} must be unaffected by sqlDropStrictBlock`).toBe(a)
    }
  })

  it('SILENT_LOG mode still demotes sql_drop to shadow, even with the flag on', () => {
    const rules = buildSnapshotRules(policy({ sqlDropStrictBlock: true, interventionMode: 'SILENT_LOG' }))
    expect(findSqlDrop(rules)?.severity).toBe('shadow')
  })

  it('sql_drop is never part of the DESTRUCTIVE_TIER_SEVERITY ramp — its static definition is warn, not block', () => {
    const staticDef = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.id === 'destructive.sql_drop')
    expect(staticDef?.severity).toBe('warn')
  })
})
