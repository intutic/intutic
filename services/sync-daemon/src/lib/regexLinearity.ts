/**
 * A static check for the regex constructs that make a backtracking engine
 * super-linear, run on every pattern the gates evaluate against a command or
 * a tool's arguments.
 *
 * The JavaScript gates run rule sources as `RegExp`s and the Python ones as
 * `re` patterns; both backtrack. A rule like ` git .*(…)` was correct and took
 * 9.5 s on 200 KB of crafted command, long enough for a harness that treats a
 * hook timeout as "allow" to run the call. The constructs below are the ones
 * that cost time growing faster than the text:
 *
 * - **nested quantifier**: a repeated group that contains a repeated element,
 *   `(a+)+` — the classic catastrophic form;
 * - **unbounded wildcard before more pattern**: `.*`, `[\s\S]*`, a negated
 *   class or `\S`/`\W`/`\D` repeated without bound and followed by anything —
 *   every start rescans to the end of the text;
 * - **unbounded lazy quantifier**: `*?`, `+?`, `{n,}?` — the same rescan, one
 *   character at a time;
 * - **adjacent overlapping runs**: two unbounded repetitions whose character
 *   sets overlap, with nothing between them that only one can match —
 *   `[a-z]*R[a-z]*` tries every split of `RRRR…`.
 *
 * A pattern that needs one of these anyway goes on {@link BACKTRACKING_ALLOWLIST}
 * by rule id, with the reason a reviewer accepted it; the test that walks
 * every gate rule fails on anything else. A rule marked `sequence` is checked
 * step by step, since that is how the JS and Python gates run it.
 *
 * It parses the JS ∩ Python `re` dialect the rules use. Character sets are
 * modelled over ASCII; a class with anything beyond ASCII counts as
 * overlapping everything, which errs toward a finding.
 */

/** A set of ASCII characters, as a 128-entry membership array. */
type CharSet = boolean[]

interface Item {
  /** The set a single-character atom matches, or null for a group or an anchor. */
  set: CharSet | null
  /** A group's alternatives, parsed. */
  group: Item[][] | null
  /** Minimum and maximum repetitions; max Infinity is unbounded. */
  min: number
  max: number
  lazy: boolean
  /** `.`, a negated class, `\S`/`\W`/`\D`, or a class covering a whole escape and its negation. */
  wide: boolean
}

const range = (from: number, to: number): CharSet => {
  const s: CharSet = new Array(128).fill(false)
  for (let c = from; c <= to; c++) s[c] = true
  return s
}
const union = (a: CharSet, b: CharSet): CharSet => a.map((v, i) => v || b[i]!)
const invert = (a: CharSet): CharSet => a.map((v) => !v)
const SPACE: CharSet = (() => {
  const s: CharSet = new Array(128).fill(false)
  for (const c of [9, 10, 11, 12, 13, 32]) s[c] = true
  return s
})()
const DIGIT = range(48, 57)
const WORD = union(union(union(range(48, 57), range(65, 90)), range(97, 122)), (() => {
  const s: CharSet = new Array(128).fill(false)
  s[95] = true
  return s
})())
const ALL = range(0, 127)
const single = (ch: string): CharSet => {
  const s: CharSet = new Array(128).fill(false)
  const c = ch.charCodeAt(0)
  if (c < 128) s[c] = true
  else s.fill(true) // beyond ASCII: assume it overlaps everything
  return s
}

/** The set an escape names, and whether it is one of the wide negations. */
function escapeSet(ch: string): { set: CharSet; wide: boolean } {
  switch (ch) {
    case 's': return { set: SPACE, wide: false }
    case 'S': return { set: invert(SPACE), wide: true }
    case 'd': return { set: DIGIT, wide: false }
    case 'D': return { set: invert(DIGIT), wide: true }
    case 'w': return { set: WORD, wide: false }
    case 'W': return { set: invert(WORD), wide: true }
    case 'n': return { set: single('\n'), wide: false }
    case 't': return { set: single('\t'), wide: false }
    case 'r': return { set: single('\r'), wide: false }
    default: return { set: single(ch), wide: false }
  }
}

/** Parses `source` into alternatives of items. Throws on syntax it does not know. */
function parse(source: string): Item[][] {
  let i = 0
  const alternatives = (): Item[][] => {
    const alts: Item[][] = [[]]
    while (i < source.length) {
      const c = source[i]!
      if (c === ')') break
      if (c === '|') {
        i++
        alts.push([])
        continue
      }
      const item = atom()
      if (item) {
        quantifier(item)
        alts[alts.length - 1]!.push(item)
      }
    }
    return alts
  }
  const atom = (): Item | null => {
    const c = source[i]!
    const base = { group: null, min: 1, max: 1, lazy: false, wide: false }
    if (c === '(') {
      i++
      if (source[i] === '?') {
        // (?: (?= (?! (?<= (?<! — the group's kind does not change the check.
        i++
        if (source[i] === '<') i++
        i++
      }
      const group = alternatives()
      if (source[i] !== ')') throw new Error(`unclosed group in ${source}`)
      i++
      return { ...base, set: null, group }
    }
    if (c === '[') return { ...base, ...charClass(), group: null }
    if (c === '\\') {
      const e = source[i + 1] ?? ''
      i += 2
      if (e === 'b' || e === 'B') return null // an assertion, not a character
      if (/[1-9]/.test(e)) return { ...base, set: ALL } // a backreference: counts as one wide character
      const { set, wide } = escapeSet(e)
      return { ...base, set, wide }
    }
    i++
    if (c === '^' || c === '$') return null
    if (c === '.') return { ...base, set: invert(single('\n')), wide: true }
    return { ...base, set: single(c) }
  }
  const charClass = (): { set: CharSet; wide: boolean } => {
    i++ // [
    let negated = false
    if (source[i] === '^') {
      negated = true
      i++
    }
    let set: CharSet = new Array(128).fill(false)
    let first = true
    while (i < source.length && (source[i] !== ']' || first)) {
      first = false
      let lo: CharSet
      let loChar = ''
      if (source[i] === '\\') {
        const e = source[i + 1] ?? ''
        i += 2
        lo = escapeSet(e).set
        if (!/[sSdDwW]/.test(e)) loChar = e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e
      } else {
        loChar = source[i]!
        lo = single(loChar)
        i++
      }
      if (loChar && source[i] === '-' && source[i + 1] !== ']' && i + 1 < source.length) {
        i++
        let hiChar = source[i]!
        if (hiChar === '\\') {
          hiChar = source[i + 1] ?? ''
          i++
        }
        i++
        set = union(set, range(loChar.charCodeAt(0), Math.min(127, hiChar.charCodeAt(0))))
        if (hiChar.charCodeAt(0) > 127) set = ALL.slice()
        continue
      }
      set = union(set, lo)
    }
    i++ // ]
    const full = set.every(Boolean)
    return { set: negated ? invert(set) : set, wide: negated || full }
  }
  const quantifier = (item: Item): void => {
    const c = source[i]
    if (c === '*') [item.min, item.max] = [0, Infinity]
    else if (c === '+') [item.min, item.max] = [1, Infinity]
    else if (c === '?') [item.min, item.max] = [0, 1]
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))
      if (!m) return
      item.min = Number(m[1])
      item.max = m[2] === undefined ? item.min : m[3] === '' ? Infinity : Number(m[3])
      i += m[0].length - 1
    } else return
    i++
    if (source[i] === '?') {
      item.lazy = true
      i++
    }
  }
  const alts = alternatives()
  if (i !== source.length) throw new Error(`unbalanced ) in ${source}`)
  return alts
}

const unbounded = (it: Item): boolean => it.max === Infinity
const hasUnbounded = (alts: Item[][]): boolean =>
  alts.some((seq) => seq.some((it) => unbounded(it) || (it.group !== null && hasUnbounded(it.group))))
const overlaps = (a: CharSet, b: CharSet): boolean => a.some((v, i) => v && b[i]!)

/** Every construct in `source` that can make a backtracking engine super-linear. */
export function backtrackingFindings(source: string): string[] {
  const findings: string[] = []
  const subset = (a: CharSet, b: CharSet): boolean => a.every((v, c) => !v || b[c]!)
  const walk = (alts: Item[][], topLevel: boolean): void => {
    for (const seq of alts) {
      seq.forEach((it, k) => {
        if (it.group && unbounded(it) && hasUnbounded(it.group)) findings.push('nested quantifier')
        if (it.lazy && unbounded(it)) findings.push('unbounded lazy quantifier')
        // A wide run is harmless only as the very last thing a match needs.
        if (it.wide && unbounded(it) && !(topLevel && k === seq.length - 1)) {
          findings.push('unbounded wildcard before more pattern')
        }
        if (it.set && unbounded(it)) {
          // Past the fixed characters this run could also have taken, is the
          // next repetition one whose set overlaps it?
          for (let j = k + 1; j < seq.length; j++) {
            const next = seq[j]!
            if (!next.set) break
            if (unbounded(next)) {
              if (overlaps(it.set, next.set)) findings.push('adjacent overlapping runs')
              break
            }
            if (!subset(next.set, it.set)) break
          }
        }
        if (it.group) walk(it.group, false)
      })
    }
  }
  walk(parse(source), true)
  return [...new Set(findings)]
}

/**
 * Rules allowed a construct {@link backtrackingFindings} reports, by rule id,
 * with the reason a reviewer accepted it. Each entry must still trip the
 * check (a stale entry fails the test), and each such rule has adversarial
 * vectors that every reader must decide in linear time.
 */
export const BACKTRACKING_ALLOWLIST: Readonly<Record<string, string>> = {
  'destructive.rm_rf_root':
    '`( +-[a-zA-Z-]+)+`: every repetition must begin with a space and the inner run cannot ' +
    'contain one, so there is one way to split the flags; each ` rm` start does work linear in ' +
    'its own flag list and stops at the next ` rm`.',
  'skill_content.*':
    'The argPattern wrapper `"key":"(?:[^"\\\\]|\\\\.)*?(?:P)` scans one JSON string lazily and ' +
    'tries P at each position. It starts only at a key, which can appear unescaped in ' +
    'the serialized input only as a key; the two alternatives begin with different ' +
    'characters, so the scan is single-pass; and each P is bounded per position ' +
    '(`{0,40}`-style windows, a lookahead-committed URL in markdown-exfil-link, a 600-character ' +
    'close check in html-comment-hidden-instruction).',
}

/** The allowlist entry that covers a rule id, if any (`prefix.*` entries match a family). */
export function backtrackingAllowance(id: string): string | undefined {
  if (BACKTRACKING_ALLOWLIST[id]) return BACKTRACKING_ALLOWLIST[id]
  const family = Object.keys(BACKTRACKING_ALLOWLIST).find((k) => k.endsWith('.*') && id.startsWith(k.slice(0, -1)))
  return family ? BACKTRACKING_ALLOWLIST[family] : undefined
}
