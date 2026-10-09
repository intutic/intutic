/**
 * Every gate rule, decided the same way by every engine that runs it, in
 * bounded time.
 *
 * `packages/shared-types/fixtures/gate-rule-vectors.json` is generated here
 * from the rule tables: per rule, its `.rules` line, the calls it must hold
 * (its `matches`), the calls it must let through (its `notMatches`) and its
 * adversarial cases — 256 KiB texts shaped to stall a backtracking engine.
 * This file checks the fixture is current (`INTUTIC_UPDATE_VECTORS=1`
 * rewrites it) and runs every case through the JavaScript the JS gates run,
 * the Python the bash gates and the Open WebUI filter run, and `grep -E`,
 * which the bash gates run. `@intutic/gate` and intutic-clawde run the same
 * fixture through their own snapshot readers.
 *
 * It also holds the two properties the rewrite rests on: a sequence rule
 * means what its regex means (fuzzed), and no rule contains a construct a
 * backtracking engine can take super-linear time on, unless a reviewed
 * allowlist entry says why it is safe.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARGUMENTS_SIZE_LIMIT,
  COMMAND_SIZE_LIMIT,
  GATE_DEADLINE_MS,
  SKILL_SCAN_PATTERNS,
  compileSequence,
  hasPhrase,
  phraseText,
  sequenceAlternatives,
  sequenceMatch,
} from '@intutic/shared-types'
import {
  ADVERSARIAL_LENGTH,
  DESTRUCTIVE_COMMAND_PATTERNS,
  GOVERNANCE_BYPASS_PATTERNS,
  HOOK_SETTING_PATTERNS,
  NORMALISE_CONTRACT,
  SECRET_CONTENT_PATTERNS,
  SKILL_CONTENT_PATTERNS,
  SKILL_SURFACE_PATTERNS,
  protectedPathShellPatterns,
  ruleFlags,
  type AdversarialCase,
  type GuardPattern,
} from '../../src/harness/protectedPaths.js'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { BACKTRACKING_ALLOWLIST, backtrackingAllowance, backtrackingFindings } from '../../src/lib/regexLinearity.js'
import { PHRASES_PY_SOURCE } from '../../src/lib/phrasesPy.js'
import { expectLinearTime, expectLinearTimes } from './linearTime.js'
import { SEQUENCE_PY_SOURCE } from '../../src/lib/sequencePy.js'

const VECTORS = join(import.meta.dirname, '../../../../packages/shared-types/fixtures/gate-rule-vectors.json')
const CLAWDE_SEQUENCE = join(import.meta.dirname, '../../../../packages/intutic-clawde/intutic_clawde/gate/sequence.py')

/** Where a skill-content case writes: a path every skill_content rule's target matches. */
const SKILL_FILE = '/w/.claude/skills/x/SKILL.md'

interface Call {
  tool: string
  input: Record<string, string>
}
interface Adversarial extends Call {
  name: string
  /** The input field the built text goes into. */
  fill: string
  prefix: string
  unit: string
  suffix: string
  length: number
  held: boolean
}
interface VectorRule {
  id: string
  subject: string
  flags: string
  /** The rule's `.rules` line, severity `block`, as the snapshot readers load it. */
  line: string
  /** The rule also has an argument condition (the line's seventh column). */
  argPattern: boolean
  held: Call[]
  benign: Call[]
  adversarial: Adversarial[]
}

function allRules(): GuardPattern[] {
  return [
    ...GOVERNANCE_BYPASS_PATTERNS,
    ...HOOK_SETTING_PATTERNS,
    ...SECRET_CONTENT_PATTERNS,
    ...SKILL_SURFACE_PATTERNS,
    ...SKILL_CONTENT_PATTERNS,
    ...DESTRUCTIVE_COMMAND_PATTERNS,
    ...protectedPathShellPatterns(),
  ]
}

/** A fixture string (`matches`, `notMatches`) as the call a gate would see. */
function fixtureCall(p: GuardPattern, m: string): Call {
  if (p.subject === 'content') return { tool: 'Write', input: JSON.parse(m) as Record<string, string> }
  if (p.subject === 'target') return { tool: 'Write', input: { file_path: m.trim() } }
  return { tool: 'Bash', input: { command: m } }
}

function adversarialCall(p: GuardPattern, c: AdversarialCase): Adversarial {
  const base = { name: c.name, prefix: c.prefix ?? '', unit: c.unit, suffix: c.suffix ?? '', length: ADVERSARIAL_LENGTH, held: c.held }
  if (p.argPattern) return { ...base, tool: 'Write', input: { file_path: SKILL_FILE, content: '' }, fill: 'content' }
  if (p.subject === 'content') return { ...base, tool: 'Write', input: { file_path: 'notes.txt', content: '' }, fill: 'content' }
  if (p.subject === 'target') return { ...base, tool: 'Write', input: { file_path: '' }, fill: 'file_path' }
  return { ...base, tool: 'Bash', input: { command: '' }, fill: 'command' }
}

function vectorRule(p: GuardPattern): VectorRule {
  let held = p.matches.map((m) => fixtureCall(p, m))
  let benign = p.notMatches.map((m) => fixtureCall(p, m))
  if (p.argPattern) {
    // A skill-content rule: the scan pattern's own fixtures, written as a
    // skill file's content, and its matches written somewhere else.
    const scan = SKILL_SCAN_PATTERNS.find((s) => `skill_content.${s.id}` === p.id)!
    const write = (file_path: string, content: string): Call => ({ tool: 'Write', input: { file_path, content } })
    held = scan.matches.map((m) => write(SKILL_FILE, m))
    benign = [
      ...scan.notMatches.map((m) => write(SKILL_FILE, m)),
      ...p.notMatches.map((t) => write(t.trim(), scan.matches[0]!)),
    ]
  }
  return {
    id: p.id,
    subject: p.subject ?? 'any',
    flags: ruleFlags(p),
    line: toRulesLine({ ...p, severity: 'block' }),
    argPattern: !!p.argPattern,
    held,
    benign,
    adversarial: (p.adversarial ?? []).map((c) => adversarialCall(p, c)),
  }
}

/**
 * The `secrets.*` rules stay out of the file: their cases are credentials in
 * shape, which no file in the repository holds in one piece (their fixtures
 * are assembled at run time). Only the hook gates run them, and this file
 * runs their cases from the tables.
 */
const IN_FILE = (v: VectorRule) => !v.id.startsWith('secrets.')

function buildVectors(): { rules: VectorRule[] } & Record<string, unknown> {
  return {
    _comment:
      'Generated by services/sync-daemon/__tests__/harness/gateRuleVectors.test.ts from the rule tables ' +
      '(INTUTIC_UPDATE_VECTORS=1 rewrites it). Per gate rule: its .rules line at severity block, calls it ' +
      'must hold, calls it must let through, and adversarial calls whose `fill` field is `prefix`, then ' +
      '`unit` repeated as many whole times as fit, then `suffix`, at most `length` characters in all. ' +
      'Every reader decides every ' +
      'case as `held` says, in time linear in its length (a quarter of `length` against the whole). ' +
      '`limits` are gateLimits.ts. The secrets.* rules are ' +
      'not here: their cases are credential-shaped, and the sync daemon runs them from its tables.',
    limits: {
      commandBytes: COMMAND_SIZE_LIMIT,
      argumentsBytes: ARGUMENTS_SIZE_LIMIT,
      deadlineMs: GATE_DEADLINE_MS,
    },
    rules: allRules().map(vectorRule),
  }
}

/**
 * The adversarial text: what every reader builds from the recipe, `length`
 * characters at most. At scale 1 a quarter of that: the linear-time check
 * compares the two.
 */
function buildText(c: Adversarial, scale: 1 | 4 = 4): string {
  const length = (c.length / 4) * scale
  return c.prefix + c.unit.repeat(Math.floor((length - c.prefix.length - c.suffix.length) / c.unit.length)) + c.suffix
}

function materialise(c: Adversarial, scale: 1 | 4 = 4): Call {
  return { tool: c.tool, input: { ...c.input, [c.fill]: buildText(c, scale) } }
}

/**
 * Whether the rule matches the call, the way the JS gates decide it: the
 * subject strings by `subject`, a sequence rule by its steps, a phrase rule
 * by the phrase matcher, then the argument condition on the compact JSON.
 */
function jsFires(p: GuardPattern, call: Call): boolean {
  const command = call.input.command ?? ''
  const json = JSON.stringify(call.input)
  if (p.argPattern && !new RegExp(p.argPattern).test(json)) return false
  if (p.subject === 'phrase') {
    const words = phraseText(command)
    return p.source.split('|').some((phrase) => hasPhrase(words, phrase, true))
  }
  const nCommand = NORMALISE_CONTRACT.js(command)
  const nTarget = NORMALISE_CONTRACT.js(call.input.file_path ?? '')
  const subjects =
    p.subject === 'content' ? [json] : p.subject === 'command' ? [nCommand] : p.subject === 'target' ? [nTarget] : [nCommand, nTarget]
  const seq = p.sequence ? compileSequence(p.source, !!p.ignoreCase) : null
  const re = new RegExp(p.source, p.ignoreCase ? 'i' : '')
  return subjects.some((s) => (seq ? sequenceMatch(seq, s) : re.test(s)))
}

function run(cmd: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(input)
  })
}

/**
 * The Python the bash gates and the Open WebUI filter run, over every case:
 * `re` for regex rules, sequence.py for sequence rules, phrases.py for phrase
 * rules, and `re` for an argument condition on `json.dumps` compact. Returns
 * per rule per case `[fires, bestOf3CpuMs]`.
 */
async function pythonDecide(
  rules: ReadonlyArray<{ p: GuardPattern; calls: Call[] }>,
): Promise<Array<Array<[boolean, number]>>> {
  const program = String.raw`
import json, os, re, sys, time
lib = {}
exec(os.environ["SEQUENCE_PY"], lib)
exec(os.environ["PHRASES_PY"], lib)
def norm(v):
    return " " + re.sub(r"\s+", " ", str(v if v is not None else "")) + " "
out = []
for rule in json.load(sys.stdin):
    flags = re.IGNORECASE if rule["ignoreCase"] else 0
    rx = re.compile(rule["source"], flags)
    seq = lib["compile_sequence"](rule["source"], flags) if rule["sequence"] else None
    arg = re.compile(rule["argPattern"]) if rule["argPattern"] else None
    res = []
    for call in rule["calls"]:
        inp = call["input"]
        def fires():
            if arg is not None and not arg.search(json.dumps(inp, separators=(",", ":"), ensure_ascii=False)):
                return False
            command = inp.get("command", "")
            if rule["subject"] == "phrase":
                words = lib["phrase_text"](command)
                return any(lib["has_phrase"](words, p, True) for p in rule["source"].split("|"))
            subject = rule["subject"]
            if subject == "content":
                subjects = [json.dumps(inp, separators=(",", ":"), ensure_ascii=False)]
            elif subject == "command":
                subjects = [norm(command)]
            elif subject == "target":
                subjects = [norm(inp.get("file_path", ""))]
            else:
                subjects = [norm(command), norm(inp.get("file_path", ""))]
            if seq is not None:
                return any(lib["sequence_match"](seq, s) for s in subjects)
            return any(rx.search(s) for s in subjects)
        best = None
        for _ in range(3):
            t = time.process_time()
            verdict = fires()
            d = (time.process_time() - t) * 1000
            best = d if best is None else min(best, d)
        res.append([bool(verdict), best])
    out.append(res)
print(json.dumps(out))
`
  const payload = rules.map(({ p, calls }) => ({
    source: p.source,
    ignoreCase: !!p.ignoreCase,
    sequence: !!p.sequence,
    subject: p.subject ?? 'any',
    argPattern: p.argPattern ?? null,
    calls,
  }))
  const r = await run('python3', ['-c', program], JSON.stringify(payload), {
    ...process.env,
    SEQUENCE_PY: SEQUENCE_PY_SOURCE,
    PHRASES_PY: PHRASES_PY_SOURCE,
  })
  if (r.code !== 0) throw new Error(`python exited ${r.code}: ${r.err}`)
  return JSON.parse(r.out) as Array<Array<[boolean, number]>>
}

/** Whether `grep -E` (the bash gates' engine) matches the rule's source in any subject of the call. */
async function grepFires(p: GuardPattern, call: Call): Promise<boolean> {
  const command = call.input.command ?? ''
  const subjects =
    p.subject === 'content'
      ? [JSON.stringify(call.input)]
      : p.subject === 'command'
        ? [NORMALISE_CONTRACT.js(command)]
        : p.subject === 'target'
          ? [NORMALISE_CONTRACT.js(call.input.file_path ?? '')]
          : [NORMALISE_CONTRACT.js(command), NORMALISE_CONTRACT.js(call.input.file_path ?? '')]
  for (const s of subjects) {
    const r = await run('grep', [p.ignoreCase ? '-qiE' : '-qE', '--', p.source], s)
    if (r.code === 0) return true
    if (r.code !== 1) throw new Error(`grep exited ${r.code} on ${p.id}: ${r.err}`)
  }
  return false
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!)
    }),
  )
}

const RULES = allRules()
const VECTOR_RULES = buildVectors().rules

/** Every case of a rule with what the rule must decide, materialised. */
function casesOf(v: VectorRule): Array<{ label: string; call: Call; held: boolean; small?: Call }> {
  return [
    ...v.held.map((call, k) => ({ label: `held[${k}]`, call, held: true })),
    ...v.benign.map((call, k) => ({ label: `benign[${k}]`, call, held: false })),
    ...v.adversarial.map((c) => ({ label: `adversarial "${c.name}"`, call: materialise(c), held: c.held, small: materialise(c, 1) })),
  ]
}

describe('gate-rule-vectors.json', () => {
  it('is generated from the rule tables', () => {
    const all = buildVectors()
    const want = JSON.stringify({ ...all, rules: all.rules.filter(IN_FILE) }, null, 2) + '\n'
    if (process.env.INTUTIC_UPDATE_VECTORS === '1') writeFileSync(VECTORS, want)
    expect(readFileSync(VECTORS, 'utf8'), 'regenerate with INTUTIC_UPDATE_VECTORS=1').toBe(want)
  })

  it('covers every rule with held, benign and adversarial cases', () => {
    expect(VECTOR_RULES.length).toBe(RULES.length)
    for (const v of VECTOR_RULES) {
      expect(v.held.length, `${v.id} has no held case`).toBeGreaterThan(0)
      expect(v.benign.length, `${v.id} has no benign case`).toBeGreaterThan(0)
      expect(v.adversarial.length, `${v.id} has no adversarial case`).toBeGreaterThan(0)
    }
  })
})

describe('every engine decides every gate rule case as declared, in bounded time', () => {
  it('JavaScript (the JS gates): right, and in linear time', () => {
    for (const [i, p] of RULES.entries()) {
      for (const c of casesOf(VECTOR_RULES[i]!)) {
        expect(jsFires(p, c.call), `${p.id} ${c.label}`).toBe(c.held)
        const small = c.small
        if (small) expectLinearTime(`${p.id} ${c.label} in JS`, (scale) => jsFires(p, scale === 1 ? small : c.call))
      }
    }
  }, 300_000)

  it('Python (the bash gates, the Open WebUI filter): right, and in linear time', async () => {
    const all = RULES.map((p, i) => {
      const cases = casesOf(VECTOR_RULES[i]!)
      // Each adversarial case at a quarter of its length too, after the rest.
      return { p, cases, calls: [...cases.map((c) => c.call), ...cases.flatMap((c) => (c.small ? [c.small] : []))] }
    })
    const verdicts = await pythonDecide(all.map(({ p, calls }) => ({ p, calls })))
    for (const [i, { p, cases }] of all.entries()) {
      let extra = cases.length
      for (const [k, c] of cases.entries()) {
        const [fired, ms] = verdicts[i]![k]!
        expect(fired, `${p.id} ${c.label} in Python`).toBe(c.held)
        if (c.small) expectLinearTimes(`${p.id} ${c.label} in Python`, verdicts[i]![extra++]![1], ms)
      }
    }
  }, 300_000)

  it('grep -E (the bash gates): the same verdict on every rule source', async () => {
    // grep matches with an automaton, so it runs every source as written —
    // sequence rules included. The argument condition is Python's (above).
    const jobs = RULES.flatMap((p, i) =>
      p.subject === 'phrase' ? [] : casesOf(VECTOR_RULES[i]!).map((c) => ({ p, c })),
    )
    await mapLimit(jobs, 8, async ({ p, c }) => {
      const fired = await grepFires(p, c.call)
      const want = p.argPattern ? jsFires({ ...p, argPattern: undefined }, c.call) : c.held
      expect(fired, `${p.id} ${c.label} under grep -E`).toBe(want)
    })
  }, 300_000)
})

describe('sequence rules', () => {
  /** Random texts from the pieces a sequence rule's steps are made of. */
  function fuzz(p: GuardPattern, count: number): string[] {
    const pieces = [
      ...new Set(
        [...p.matches, ...p.notMatches, ...(p.adversarial ?? []).flatMap((c) => [c.prefix ?? '', c.unit, c.suffix ?? ''])]
          .join(' ')
          .split(' ')
          .filter(Boolean),
      ),
      '', '|', '-', '/', '/dev/', 'R', 'i', 'f', 'sh', '|sh', 'bash',
    ]
    let seed = 20261008
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    return Array.from({ length: count }, () => {
      const n = 1 + Math.floor(next() * 9)
      return NORMALISE_CONTRACT.js(Array.from({ length: n }, () => pieces[Math.floor(next() * pieces.length)]).join(' '))
    })
  }

  it('match exactly when their regex does, on fuzzed commands', () => {
    const sequenceRules = RULES.filter((p) => p.sequence)
    expect(sequenceRules.length).toBeGreaterThanOrEqual(8)
    for (const p of sequenceRules) {
      const re = new RegExp(p.source, p.ignoreCase ? 'i' : '')
      const seq = compileSequence(p.source, !!p.ignoreCase)
      let held = 0
      for (const text of fuzz(p, 10000)) {
        const want = re.test(text)
        if (want) held++
        expect(sequenceMatch(seq, text), `${p.id} on ${JSON.stringify(text)}`).toBe(want)
      }
      expect(held, `${p.id}: the fuzz never produced a match, so it compared nothing`).toBeGreaterThan(20)
    }
  })

  it('split at top-level | and .* only', () => {
    expect(sequenceAlternatives(' git .*reset +--hard| git .*push +.*--force')).toEqual([
      [' git ', 'reset +--hard'],
      [' git ', 'push +', '--force'],
    ])
    expect(sequenceAlternatives(' (a|b) .*[.*|]x\\.*y')).toEqual([[' (a|b) ', '[.*|]x\\.*y']])
  })

  it('sequence.py in the sync daemon is a byte-identical copy of intutic-clawde’s', () => {
    expect(SEQUENCE_PY_SOURCE).toBe(readFileSync(CLAWDE_SEQUENCE, 'utf8'))
  })
})

describe('no gate rule can backtrack super-linearly', () => {
  it('flags the constructs that do', () => {
    // The rules this branch rewrote, as they were, and the textbook forms.
    expect(backtrackingFindings(' git .*(reset +--hard|clean +-[a-zA-Z]*f|push +.*--force)')).toContain(
      'unbounded wildcard before more pattern',
    )
    expect(backtrackingFindings(' chflags .*nouchg')).toContain('unbounded wildcard before more pattern')
    expect(backtrackingFindings('(a+)+$')).toContain('nested quantifier')
    expect(backtrackingFindings('<!--[\\s\\S]*?-->')).toContain('unbounded lazy quantifier')
    expect(backtrackingFindings(' chmod +-[a-zA-Z]*R[a-zA-Z]* ')).toContain('adjacent overlapping runs')
    expect(backtrackingFindings('!?\\[[^\\]]*\\]\\(\\s*https?://[^)\\s]*\\bsecret\\b[^)]*\\)')).not.toEqual([])
    // And leaves alone what does not.
    expect(backtrackingFindings(' chmod +-[a-zA-QS-Z]*R[a-zA-Z]* +[0-7]+ +/( |\\*)')).toEqual([])
    expect(backtrackingFindings('sk-ant-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*')).toEqual([])
  })

  it('every rule is linear as its gates run it, or allowlisted with a reason', () => {
    // Also enforced at module load (assertLinearRule); asserted here so a
    // failure names the rule and the construct.
    for (const p of RULES) {
      const sources = p.subject === 'phrase' ? [] : p.sequence ? sequenceAlternatives(p.source).flat() : [p.source]
      if (p.argPattern) sources.push(p.argPattern)
      const findings = sources.flatMap((s) => backtrackingFindings(s))
      if (findings.length > 0) expect(backtrackingAllowance(p.id), `${p.id}: ${findings.join(', ')}`).toBeDefined()
    }
  })

  it('has no stale allowlist entry', () => {
    for (const key of Object.keys(BACKTRACKING_ALLOWLIST)) {
      const covered = RULES.filter((p) => (key.endsWith('.*') ? p.id.startsWith(key.slice(0, -1)) : p.id === key))
      expect(covered.length, `${key} names no rule`).toBeGreaterThan(0)
      const flagged = covered.filter((p) => {
        const sources = p.sequence ? sequenceAlternatives(p.source).flat() : [p.source]
        if (p.argPattern) sources.push(p.argPattern)
        return sources.some((s) => backtrackingFindings(s).length > 0)
      })
      expect(flagged.length, `${key} is allowlisted but nothing it covers is flagged any more`).toBeGreaterThan(0)
    }
  })
})
