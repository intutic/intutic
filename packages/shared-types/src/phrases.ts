/**
 * Phrase matching for shell commands and SQL in linear time.
 *
 * Every command classifier asks the same question: does this text contain
 * `git push`, `drop table`, `curl --data`, whatever separates the words? The
 * separators that count are the ones the shell or the database reads as a
 * word break:
 *
 * - whitespace, a two-character escaped `\n`, `\t` or `\r`, and a backslash
 *   before whitespace (a line continuation, or an escaped space);
 * - a `/* … *\/` comment;
 * - a `-- …` comment that runs to a newline (real or escaped);
 * - a run of options starting with `--` (`git --no-pager push`,
 *   `kubectl --context prod apply`), which stops at `;`, `&`, `|` or a real
 *   newline — the end of the shell command it is in.
 *
 * The proxy's Rust classifier expresses this as a regex (`SQL_GAP` in
 * `actions.rs`), which is safe there: Rust's engine is linear. JavaScript's
 * and Python's backtrack, and that regex took seconds on a few hundred
 * kilobytes of `git -- git -- …` — text an agent can be talked into producing.
 * So here the text is cut into words in one pass, and a phrase is matched over
 * the words right to left with one array per phrase word: O(length × words).
 * No regex runs on the input.
 *
 * The two functions are self-contained on purpose — no imports, no module
 * state — because the hook gates emit them as source (`phraseText.toString()`)
 * and run them outside this package. `packages/gate-js/src/phrases.ts` is a
 * byte-identical copy and `intutic_clawde/gate/phrases.py` a transliteration;
 * all of them run `action_vectors.json` beside the proxy's `actions.rs`.
 *
 * @module
 */

/** A text cut into words, ready for any number of {@link hasPhrase} calls. */
export interface PhraseText {
  /** The whole text, lower-cased: one-word phrases are plain substrings of it. */
  raw: string
  /** The words, lower-cased, separated by single spaces: a cheap filter. */
  joined: string
  toks: string[]
  /** A separator (not a glued `--`) stands before the word. */
  sep: boolean[]
  /** A real newline stands before the word: the end of an option run. */
  nl: boolean[]
  /** A real or escaped newline stands before the word: the end of a `--` comment. */
  eol: boolean[]
  /** The word starts with `--`. */
  dash: boolean[]
  /** The word contains `;`, `&` or `|`: an option run cannot cross it. */
  bar: boolean[]
  /** A separator follows the last word. */
  tail: boolean
  /** Per-word match arrays already computed, by mode and word. */
  memo: Record<string, boolean[]>
}

/**
 * Cuts `input` into words in one pass. A `--` inside a word starts a new one
 * (`drop--why` is `drop` and `--why`), glued rather than separated, so it can
 * open a comment or an option run but cannot stand for a plain gap.
 */
export function phraseText(input: unknown): PhraseText {
  const s = String(input == null ? '' : input).toLowerCase()
  const n = s.length
  const isSpace = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' ||
    c === ' ' || c === ' ' || (c >= ' ' && c <= ' ') ||
    c === ' ' || c === ' ' || c === ' ' || c === ' ' || c === '　' || c === '﻿'
  const t: PhraseText = { raw: s, joined: '', toks: [], sep: [], nl: [], eol: [], dash: [], bar: [], tail: false, memo: {} }
  let start = -1
  let tokBar = false
  let pendSep = false
  let pendNl = false
  let pendEol = false
  // The next `*/` at or after the last search; -1 once there is none left.
  let close = -2
  const end = (at: number): void => {
    if (start < 0) return
    t.toks.push(s.slice(start, at))
    t.sep.push(pendSep)
    t.nl.push(pendNl)
    t.eol.push(pendEol)
    t.dash.push(s.charAt(start) === '-' && s.charAt(start + 1) === '-')
    t.bar.push(tokBar)
    start = -1
    tokBar = false
    pendSep = false
    pendNl = false
    pendEol = false
  }
  const gap = (newline: boolean, eol: boolean): void => {
    end(i)
    pendSep = true
    if (newline) pendNl = true
    if (eol) pendEol = true
  }
  let i = 0
  while (i < n) {
    const c = s.charAt(i)
    const d = i + 1 < n ? s.charAt(i + 1) : ''
    if (isSpace(c)) {
      gap(c === '\n', c === '\n')
      i += 1
    } else if (c === '\\' && (d === 'n' || d === 't' || d === 'r')) {
      gap(false, d === 'n')
      i += 2
    } else if (c === '\\' && d !== '' && isSpace(d)) {
      gap(false, false)
      i += 2
    } else if (c === '/' && d === '*' && close !== -1 && (close >= i + 2 || (close = s.indexOf('*/', i + 2)) !== -1)) {
      gap(false, false)
      i = close + 2
    } else {
      if (c === '-' && d === '-' && start >= 0 && s.charAt(i - 1) !== '-') end(i)
      if (start < 0) start = i
      if (c === ';' || c === '&' || c === '|') tokBar = true
      i += 1
    }
  }
  end(n)
  t.tail = pendSep
  t.joined = t.toks.join(' ')
  return t
}

/**
 * Whether `t` contains `needle`, a phrase whose words are separated by single
 * spaces. A one-word needle is a plain substring. In a longer one the first
 * word may end a word of the text (`digit push` contains `git push`, as a
 * substring would), the last may begin one, and the words between must be
 * whole; a trailing space (`'update '`) asks for a separator after the last
 * word. `bounded` additionally requires a non-word character (or the edge of
 * the word) before the first word and after the last, where `.` also counts
 * as part of a word (`table.log` is not `table`).
 */
export function hasPhrase(t: PhraseText, needle: string, bounded?: boolean): boolean {
  const words = needle.toLowerCase().split(' ')
  if (words.length === 1) return t.raw.indexOf(words[0]!) !== -1
  const trailingGap = words[words.length - 1] === ''
  if (trailingGap) words.pop()
  for (const w of words) if (w === '' || t.joined.indexOf(w) === -1) return false
  const T = t.toks.length
  const k = words.length
  const isWord = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_'
  // Whether word `i` of the phrase can be the word at `q`, by its position.
  const matches = (i: number): boolean[] => {
    const w = words[i]!
    const first = i === 0
    const last = i === k - 1 && !trailingGap
    const key = (first ? 'f' : '') + (last ? 'l' : '') + (bounded ? 'b' : '') + ':' + w
    const hit = t.memo[key]
    if (hit) return hit
    const out: boolean[] = new Array(T)
    for (let q = 0; q < T; q++) {
      const tok = t.toks[q]!
      let ok: boolean
      if (first && last) ok = tok.indexOf(w) !== -1
      else if (first) ok = tok.length >= w.length && tok.lastIndexOf(w) === tok.length - w.length
      else if (last) ok = tok.lastIndexOf(w, 0) === 0
      else ok = tok === w
      if (ok && bounded && first) ok = tok.length === w.length || !isWord(tok.charAt(tok.length - w.length - 1))
      if (ok && bounded && last) ok = tok.length === w.length || !(isWord(tok.charAt(w.length)) || tok.charAt(w.length) === '.')
      out[q] = ok
    }
    t.memo[key] = out
    return out
  }
  // nextBar[x]: first word at or after x containing `;&|`; nextNl[x]: first
  // word at or after x with a real newline before it; nextEol likewise for any
  // newline. T when there is none.
  const nextBar: number[] = new Array(T + 1)
  const nextNl: number[] = new Array(T + 1)
  const nextEol: number[] = new Array(T + 1)
  nextBar[T] = T
  nextNl[T] = T
  nextEol[T] = T
  for (let x = T - 1; x >= 0; x--) {
    nextBar[x] = t.bar[x] ? x : nextBar[x + 1]!
    nextNl[x] = t.nl[x] ? x : nextNl[x + 1]!
    nextEol[x] = t.eol[x] ? x : nextEol[x + 1]!
  }
  // ok[q]: the rest of the phrase, from the current word on, matches with
  // that word at q. Start with the last word and walk back.
  let ok: boolean[] = new Array(T + 1)
  const lastHits = matches(k - 1)
  for (let q = 0; q < T; q++) {
    let v = lastHits[q]!
    if (v && trailingGap) {
      const r = q + 1
      v = r < T ? t.sep[r]! || (t.dash[r]! && !t.bar[r]! && (r + 1 < T || t.tail)) : t.tail
    }
    ok[q] = v
  }
  ok[T] = false
  for (let i = k - 2; i >= 0; i--) {
    // nextOk[x]: first word at or after x where the rest matches after a separator.
    const nextOk: number[] = new Array(T + 2)
    nextOk[T] = T
    nextOk[T + 1] = T
    for (let x = T - 1; x >= 0; x--) nextOk[x] = ok[x] && t.sep[x] ? x : nextOk[x + 1]!
    // reach[r]: the gap that starts at word r leads into the rest of the phrase.
    const reach: boolean[] = new Array(T + 1)
    reach[T] = false
    for (let r = T - 1; r >= 0; r--) {
      let v = t.sep[r]! && ok[r]!
      if (!v && t.dash[r]) {
        // A `--` comment runs to the next newline; more gap may follow it.
        const after = nextEol[r + 1]!
        if (after < T && reach[after]) v = true
        // An option run reaches any word before a `;&|` word or a real newline.
        const limit = Math.min(nextBar[r]!, nextNl[r + 1]!, T - 1)
        if (!v && nextOk[r + 1]! <= limit) v = true
      }
      reach[r] = v
    }
    const hits = matches(i)
    const prev: boolean[] = new Array(T + 1)
    for (let p = 0; p < T; p++) prev[p] = hits[p]! && reach[p + 1]!
    prev[T] = false
    ok = prev
  }
  for (let p = 0; p < T; p++) if (ok[p]) return true
  return false
}

/**
 * Both functions as JavaScript source, for a hook gate to emit: the gates run
 * this exact code, not a retyped copy.
 */
export const PHRASES_JS_SOURCE = `${phraseText.toString()}\n${hasPhrase.toString()}`
