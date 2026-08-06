#!/usr/bin/env node
/**
 * No tracked source file may contain a NUL byte.
 *
 * ## Why this exists
 *
 * `proposeRuleCandidates` joins a field name and a value with NUL, so that
 * `harness` + `"a b"` cannot collide with a value that merely begins `a`. The
 * separator is correct. What went in was four *literal* 0x00 bytes rather than
 * the six-character escape, because the edit that wrote them interpreted the
 * escape one layer too early.
 *
 * It compiled. It linted. Its tests passed. A real NUL and an escaped one are
 * the same character at runtime, so nothing behavioural could have caught it.
 *
 * What it broke is everything that reads the file as text. Git classifies a
 * blob containing NUL as binary, so:
 *
 * - `git diff` prints "Binary files differ" — the change is invisible in review
 * - `git grep` skips it, so every security sweep this repo runs silently
 *   excludes it while reporting success over everything else
 * - `grep -r` reports "Binary file matches" instead of the line
 *
 * A file that cannot be searched is a file nothing can be verified about, and
 * it fails silently in precisely the direction that reads as clean. That is the
 * same shape as every inert control this repository has had to repair, which is
 * why it gets a gate rather than a note.
 *
 * ## What it checks
 *
 * Every tracked file with a source or config extension, read as bytes. Binary
 * assets are excluded by extension rather than by content sniffing — sniffing
 * would have to decide what "looks like" source, and a rule with a judgement
 * call in it is a rule that can be argued past.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? process.cwd()

/** Extensions whose contents a human reads and a grep must reach. */
const TEXT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.go', '.sh', '.bash',
  '.md', '.json', '.yml', '.yaml', '.toml', '.sql',
  '.css', '.scss', '.html', '.svg', '.txt',
]

let tracked
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
} catch (err) {
  console.error(`[FAIL] could not list tracked files in ${ROOT}: ${err.message}`)
  process.exit(1)
}

const candidates = tracked.filter((f) => TEXT_EXTENSIONS.some((ext) => f.endsWith(ext)))

const offenders = []
for (const rel of candidates) {
  let buf
  try {
    buf = readFileSync(join(ROOT, rel))
  } catch {
    // Listed but absent: a stale index entry is not this gate's business.
    continue
  }
  const at = buf.indexOf(0)
  if (at !== -1) {
    // Report the line, because "somewhere in a 600-line file" is not actionable.
    const line = buf.subarray(0, at).toString('utf8').split('\n').length
    offenders.push({ rel, line, count: buf.filter((b) => b === 0).length })
  }
}

if (offenders.length > 0) {
  console.error(`✖ ${offenders.length} tracked source file(s) contain a NUL byte:\n`)
  for (const o of offenders) {
    console.error(`    ${o.rel}:${o.line}  (${o.count} NUL byte${o.count === 1 ? '' : 's'})`)
  }
  console.error(
    '\nGit classifies these as binary. They will not diff in review, `git grep`\n' +
      'will skip them, and every security sweep that walks the tree will report\n' +
      'success while never having opened them.\n\n' +
      'If a NUL is deliberate — a separator, a test fixture — write it as the\n' +
      'escape sequence rather than the byte. The runtime behaviour is identical\n' +
      'and the file stays readable.',
  )
  process.exit(1)
}

console.log(`[PASS] ${candidates.length} tracked source file(s) are text; none contains a NUL byte`)
