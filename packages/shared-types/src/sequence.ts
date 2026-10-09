/**
 * Sequence rules: a gate rule `A.*B` run as "find A, then find B after it" in
 * linear time.
 *
 * A rule like ` git .*reset +--hard` is a regex. `grep -E` runs it as an
 * automaton, in time linear in the command. JavaScript's and Python's engines
 * backtrack: for every ` git ` they try every end of `.*`, so 200 KB of
 * ` git git git …` took 9.5 s, which is past the point where a harness that
 * treats a hook timeout as "allow" runs the call. A rule marked `sequence`
 * (`s` in a `.rules` line's flags column) is the same regex, read differently:
 *
 * - its top-level `|` alternatives are tried in turn;
 * - each alternative is cut at its top-level `.*` into steps;
 * - each step is searched for once, starting where the previous one ended.
 *
 * Each search is one pass over the text, so a rule costs at most its number of
 * steps times the length of the text. It means the same as the regex provided
 * the first match of every step but the last also ends first, which holds for
 * every step the rule tables use: a step that starts and ends at a space with
 * no space inside, or a fixed word. `.` does not match a newline and neither
 * does a step search cross one in the regex, but the gates normalise every
 * command subject to single spaces first, so there is none. A test fuzzes each
 * sequence rule against its own regex.
 *
 * Self-contained on purpose — no imports, no module state — because the
 * JavaScript gates emit it as source ({@link SEQUENCE_JS_SOURCE}).
 * `packages/gate-js/src/sequence.ts` is a byte-identical copy and
 * `intutic_clawde/gate/sequence.py` a transliteration; all of them run
 * `fixtures/gate-rule-vectors.json`.
 *
 * @module
 */

/**
 * A sequence rule's source as alternatives of steps: split at every top-level
 * `|`, then each alternative at every top-level `.*`. ` a .*b| c .*d` is
 * `[[' a ', 'b'], [' c ', 'd']]`. Outside a group or a class only, so `(x|y)`
 * stays inside its step. Empty steps are dropped.
 */
export function sequenceAlternatives(source: string): string[][] {
  const alternatives: string[][] = []
  let steps: string[] = []
  let current = ''
  let depth = 0
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i)
    if (c === '\\') {
      current += c + source.charAt(i + 1)
      i++
      continue
    }
    if (inClass) {
      current += c
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      current += c
      if (source.charAt(i + 1) === '^') current += source.charAt(++i)
      if (source.charAt(i + 1) === ']') current += source.charAt(++i)
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth--
    if (depth === 0 && c === '|') {
      steps.push(current)
      alternatives.push(steps.filter((step) => step !== ''))
      steps = []
      current = ''
      continue
    }
    if (depth === 0 && c === '.' && source.charAt(i + 1) === '*') {
      steps.push(current)
      current = ''
      i++
      continue
    }
    current += c
  }
  steps.push(current)
  alternatives.push(steps.filter((step) => step !== ''))
  return alternatives
}

/**
 * Compiles a sequence rule's source for {@link sequenceMatch}: each step with
 * the `g` flag, which is what lets a search start at `lastIndex`.
 */
export function compileSequence(source: string, ignoreCase: boolean): RegExp[][] {
  return sequenceAlternatives(source).map((steps) => steps.map((step) => new RegExp(step, ignoreCase ? 'gi' : 'g')))
}

/** Whether `text` matches a compiled sequence rule: some alternative's steps occur in order. */
export function sequenceMatch(alternatives: RegExp[][], text: string): boolean {
  for (const steps of alternatives) {
    let pos = 0
    let ok = true
    for (const step of steps) {
      step.lastIndex = pos
      const m = step.exec(text)
      if (!m) {
        ok = false
        break
      }
      pos = m.index + m[0].length
    }
    if (ok) return true
  }
  return false
}

/**
 * The three functions as JavaScript source, for a gate to emit: the gates run
 * this exact code, not a retyped copy.
 */
export const SEQUENCE_JS_SOURCE = `${sequenceAlternatives.toString()}\n${compileSequence.toString()}\n${sequenceMatch.toString()}`
