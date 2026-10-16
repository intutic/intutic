#!/usr/bin/env node
// Content about products that have not shipped (the hosted cloud, the
// self-hosted distribution), and the release flags that gate it in code.
//
// Markdown has no build step, so a README passage about an unreleased product
// is wrapped in an HTML comment, which GitHub, npm and PyPI render as nothing:
//
//   <!-- UNRELEASED:cloud
//   ...the passage...
//   -->
//
// (or UNRELEASED:self-host). The opener and the closing `-->` each sit on a
// line of their own, and the passage may not contain `-->` itself.
//
//   --check            list every block by kind, check each is well formed,
//                      check the release flags agree across the TypeScript,
//                      Python and Go copies, and fail when a released kind
//                      still has blocks (a flag flipped without --unwrap)
//   --unwrap <kind>    remove the comment wrappers of every <kind> block,
//                      leaving the passages in place: the README half of a
//                      launch (flip the flags too; see
//                      packages/shared-types/src/release.ts)
//
// Scans every tracked .md and .tmpl file. Runs in both repos: a flag file a
// checkout does not have is skipped and named.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** Each kind, and the name of its flag in each language. */
const KINDS = {
  cloud: { ts: 'CLOUD_RELEASED', py: 'CLOUD_RELEASED', go: 'cloudReleased' },
  'self-host': { ts: 'SELF_HOST_RELEASED', py: 'SELF_HOST_RELEASED', go: 'selfHostReleased' },
}

/** Where each flag is defined. The first is canonical; the TS copies in packages without a runtime dependency on it carry only CLOUD_RELEASED. */
const FLAG_FILES = [
  { path: 'packages/shared-types/src/release.ts', lang: 'ts' },
  { path: 'packages/clawde-sdk/src/release.ts', lang: 'ts', only: ['cloud'] },
  { path: 'packages/gate-js/src/release.ts', lang: 'ts', only: ['cloud'] },
  { path: 'packages/intutic-clawde/intutic_clawde/release.py', lang: 'py' },
  { path: 'packages/terraform-provider-intutic/internal/provider/release.go', lang: 'go' },
]

const OPENER = /^\s*<!-- UNRELEASED:(\S+)\s*$/
// Browsers end a comment at `--!>` as well as `-->`.
const CLOSER = /^\s*--!?>\s*$/
const COMMENT_END = /--!?>/

function flagValue(text, lang, name) {
  const re = {
    ts: new RegExp(`^export const ${name}\\s*=\\s*(true|false)\\b`, 'm'),
    py: new RegExp(`^${name}\\s*(?::\\s*bool\\s*)?=\\s*(True|False)\\b`, 'm'),
    go: new RegExp(`^\\s*${name}\\s*=\\s*(true|false)\\b`, 'm'),
  }[lang]
  const m = text.match(re)
  return m ? m[1].toLowerCase() === 'true' : undefined
}

/** The UNRELEASED blocks of one file, and anything malformed about them. */
function parseBlocks(path, text) {
  const lines = text.split('\n')
  const blocks = []
  const errors = []
  let open = null
  lines.forEach((line, i) => {
    const opener = line.match(OPENER)
    if (open) {
      if (CLOSER.test(line)) {
        blocks.push({ ...open, end: i })
        open = null
      } else if (COMMENT_END.test(line)) {
        errors.push(`${path}:${i + 1}: a comment end (\`-->\` or \`--!>\`) inside the UNRELEASED:${open.kind} block opened on line ${open.start + 1} ends it early`)
      } else if (line.includes('<!--')) {
        errors.push(`${path}:${i + 1}: a comment opened inside the UNRELEASED:${open.kind} block opened on line ${open.start + 1}`)
      }
      return
    }
    if (opener) {
      if (!(opener[1] in KINDS)) errors.push(`${path}:${i + 1}: unknown kind UNRELEASED:${opener[1]} (one of ${Object.keys(KINDS).join(', ')})`)
      open = { path, kind: opener[1], start: i, first: '' }
    } else if (line.includes('<!-- UNRELEASED:')) {
      errors.push(`${path}:${i + 1}: UNRELEASED marker not on a line of its own as \`<!-- UNRELEASED:<kind>\``)
    }
  })
  if (open) errors.push(`${path}:${open.start + 1}: UNRELEASED:${open.kind} block never closed with a \`-->\` line`)
  for (const b of blocks) b.first = (lines.slice(b.start + 1, b.end).find((l) => l.trim()) ?? '').trim()
  return { blocks, errors }
}

function trackedContent() {
  return execFileSync('git', ['ls-files', '*.md', '*.tmpl'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p && existsSync(join(root, p)))
}

function check() {
  const errors = []

  // Flags: every copy agrees with the canonical one.
  const values = { cloud: [], 'self-host': [] }
  for (const file of FLAG_FILES) {
    const abs = join(root, file.path)
    if (!existsSync(abs)) {
      console.log(`  (skipped: ${file.path} is not in this checkout)`)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    for (const [kind, names] of Object.entries(KINDS)) {
      if (file.only && !file.only.includes(kind)) continue
      const v = flagValue(text, file.lang, names[file.lang])
      if (v === undefined) errors.push(`${file.path}: no ${names[file.lang]} = true|false found`)
      else values[kind].push([file.path, v])
    }
  }
  const released = {}
  for (const [kind, found] of Object.entries(values)) {
    if (found.length === 0) continue
    released[kind] = found[0][1]
    const disagree = found.filter(([, v]) => v !== found[0][1])
    for (const [p, v] of disagree) errors.push(`${p}: ${kind} released = ${v}, but ${found[0][0]} says ${found[0][1]}`)
    console.log(`  ${kind}: ${found[0][1] ? 'released' : 'unreleased'} (${found.length} flag file(s) agree${disagree.length ? ' — except the ones below' : ''})`)
  }

  // Blocks: well formed, listed by kind, none left for a released kind.
  const byKind = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]))
  for (const p of trackedContent()) {
    const { blocks, errors: e } = parseBlocks(p, readFileSync(join(root, p), 'utf8'))
    errors.push(...e)
    for (const b of blocks) if (b.kind in byKind) byKind[b.kind].push(b)
  }
  for (const [kind, blocks] of Object.entries(byKind)) {
    console.log(`  UNRELEASED:${kind}: ${blocks.length} block(s)`)
    for (const b of blocks) console.log(`    ${b.path}:${b.start + 1}  ${b.first.slice(0, 90)}`)
    if (released[kind] && blocks.length > 0) {
      errors.push(`${kind} is released but ${blocks.length} UNRELEASED:${kind} block(s) remain: run node tools/scripts/release-content.js --unwrap ${kind}`)
    }
  }

  if (errors.length > 0) {
    console.error(`[FAIL] release content: ${errors.length} problem(s):`)
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }
  console.log('[OK] release content: flags agree and every UNRELEASED block is well formed')
}

function unwrap(kind) {
  if (!(kind in KINDS)) {
    console.error(`release-content: --unwrap takes one of ${Object.keys(KINDS).join(', ')} (got ${kind ?? 'nothing'})`)
    process.exit(2)
  }
  let total = 0
  for (const p of trackedContent()) {
    const abs = join(root, p)
    const text = readFileSync(abs, 'utf8')
    const { blocks, errors } = parseBlocks(p, text)
    const mine = blocks.filter((b) => b.kind === kind)
    if (mine.length === 0) continue
    if (errors.length > 0) {
      console.error(`release-content: ${p} has malformed blocks; fix them first:\n  ${errors.join('\n  ')}`)
      process.exit(1)
    }
    const drop = new Set(mine.flatMap((b) => [b.start, b.end]))
    writeFileSync(abs, text.split('\n').filter((_, i) => !drop.has(i)).join('\n'))
    total += mine.length
    console.log(`  ${p}: ${mine.length} block(s) unwrapped`)
  }
  console.log(`[OK] unwrapped ${total} UNRELEASED:${kind} block(s)`)
}

const args = process.argv.slice(2)
if (args[0] === '--check') check()
else if (args[0] === '--unwrap') unwrap(args[1])
else {
  console.error('Usage: node tools/scripts/release-content.js --check | --unwrap <cloud|self-host>')
  process.exit(2)
}
