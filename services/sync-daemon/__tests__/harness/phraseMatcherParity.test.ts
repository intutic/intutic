/**
 * The phrase matcher's two implementations — `@intutic/shared-types`
 * phrases.ts, which the JS gates, `@intutic/gate` and the MCP proxy run, and
 * phrases.py, which the bash gates, the Open WebUI filter and intutic-clawde
 * run — must cut every text into the same words and answer every phrase the
 * same way.
 *
 * They replaced byte-identical copies of one regex, whose test compared the
 * strings. Two hand-written implementations can only be compared by running
 * them: the shared vectors check behaviour that matters, and this checks
 * everything else on a few thousand seeded random texts built from the
 * characters the matcher treats specially.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { hasPhrase, phraseText } from '@intutic/shared-types'
import { PHRASES_PY_SOURCE } from '../../src/lib/phrasesPy.js'

const PIECES = [
  'a', 'b', 'git', 'push', 'drop', 'table', 'D', 'T', 'x=1', '.', '_',
  ' ', '  ', '\t', '\n', '\r', ' ',
  '\\', '\\n', '\\t', '\\r', '\\ ',
  '-', '--', '---', '/', '*', '/*', '*/', ';', '&', '|',
]
const NEEDLES = ['git push', 'drop table', 'push ', 'a b', 'git -- push', 'b --x', 'a b push']

/** A seeded linear congruential generator: the same texts on every run. */
function texts(count: number): string[] {
  let seed = 20261009
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const out: string[] = []
  for (let k = 0; k < count; k++) {
    let s = ''
    const len = 1 + Math.floor(next() * 14)
    for (let j = 0; j < len; j++) s += PIECES[Math.floor(next() * PIECES.length)]
    out.push(s)
  }
  return out
}

function describeText(text: string) {
  const t = phraseText(text)
  return {
    toks: t.toks, sep: t.sep, nl: t.nl, eol: t.eol, dash: t.dash, bar: t.bar, tail: t.tail,
    hits: NEEDLES.map((n) => [hasPhrase(t, n), hasPhrase(t, n, true)]),
  }
}

function pythonDescribe(inputs: string[]): Promise<unknown[]> {
  const program = [
    'import json, os, sys',
    'lib = {}',
    'exec(os.environ["PHRASES_PY"], lib)',
    `needles = ${JSON.stringify(NEEDLES)}`,
    'out = []',
    'for text in json.load(sys.stdin):',
    '    t = lib["phrase_text"](text)',
    '    out.append({"toks": t.toks, "sep": t.sep, "nl": t.nl, "eol": t.eol, "dash": t.dash, "bar": t.bar, "tail": t.tail,',
    '                "hits": [[lib["has_phrase"](t, n), lib["has_phrase"](t, n, True)] for n in needles]})',
    'print(json.dumps(out))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', program], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PHRASES_PY: PHRASES_PY_SOURCE } })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as unknown[]) : reject(new Error(`python exited ${code}: ${err}`))))
    child.stdin.end(JSON.stringify(inputs))
  })
}

describe('the phrase matcher in JavaScript and in Python', () => {
  it('cuts the same words and answers the same phrases on 3000 random texts', async () => {
    const inputs = texts(3000)
    const py = await pythonDescribe(inputs)
    const mismatches = inputs
      .map((text, i) => ({ text, js: describeText(text), py: py[i] }))
      .filter((r) => JSON.stringify(r.js) !== JSON.stringify(r.py))
    expect(mismatches.slice(0, 3)).toEqual([])
  })
})
