#!/usr/bin/env node
/**
 * Code blocks in the docs must open and close the way the renderer reads
 * them, and `intutic init` samples must show what the CLI prints.
 *
 * - **Fences.** An opening fence carries nothing but a language tag (and the
 *   VitePress extras after it: `{1,3}`, `[title]`, `:line-numbers`), and a
 *   closing fence carries nothing at all. configuration.md once closed a YAML
 *   block with "``` `litellm_params.api_key`… are ignored": CommonMark reads
 *   a fence line with text after it as code, so the block never closed and
 *   the rest of the page rendered as one code block. A fence of the same
 *   kind inside an open block that is not a bare closer is the same mistake
 *   (or a nested sample that needs a longer outer fence), and so is a block
 *   still open at the end of the file.
 * - **`intutic init` samples.** The CLI prints each detected harness as
 *   `✔ <type> → <path>` with the absolute path the detector resolved
 *   (tools/cli/src/harness/detector.ts), so a sample with a relative path, or
 *   a `<type>` that is not a HarnessType value, shows output nobody gets.
 *
 * Reads every page under apps/docs (not public/ or .vitepress/) and the root
 * README. Exit 1 on any finding, naming file and line.
 *
 * Usage: node tools/scripts/check-docs-code-blocks.js [repo-root]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const DOCS = join(ROOT, 'apps/docs')
const ENUMS_TS = join(ROOT, 'packages/shared-types/src/enums.ts')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'public', '.vitepress'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

for (const required of [DOCS, ENUMS_TS]) {
  if (!existsSync(required)) {
    console.error(`[FAIL] ${required} is missing.`)
    process.exit(1)
  }
}
const harnessBody = readFileSync(ENUMS_TS, 'utf8').match(/export const HarnessType = \{([\s\S]*?)\n\} as const/)?.[1]
const harnessTypes = new Set([...(harnessBody ?? '').matchAll(/^\s*[A-Z][A-Z0-9_]*:\s*'([^']+)'/gm)].map((m) => m[1]))
if (harnessTypes.size < 30) {
  console.error(`[FAIL] read ${harnessTypes.size} HarnessType values from ${ENUMS_TS}; the parsing broke.`)
  process.exit(1)
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
// A language tag, then VitePress's line highlights, title and line-number flags.
const INFO = /^(?:[A-Za-z0-9_+#.-]+(?:\s*(?:\{[^}]*\}|\[[^\]]*\]|:[A-Za-z-]+))*)?$/
const INIT_LINE = /^\s*(?:#\s*)?✔ (\S+) → (.+)$/

const files = [...walk(DOCS), join(ROOT, 'README.md')].filter((f) => existsSync(f))
const findings = []
let blocks = 0
let initLines = 0

for (const file of files) {
  const rel = relative(ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  let open = null // { char, length, line }
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    const fence = FENCE.exec(line)
    if (!open) {
      if (!fence) return
      const info = fence[3].trim()
      // A backtick fence's info string cannot hold a backtick: CommonMark reads
      // the line as inline code, not a fence, so it opens nothing.
      if (fence[2][0] === '`' && info.includes('`')) return
      if (!INFO.test(info)) {
        findings.push(`${at}: a code fence opens with ${JSON.stringify(info)} after it; only a language tag belongs there. Put prose on its own line.`)
      }
      open = { char: fence[2][0], length: fence[2].length, line: i + 1 }
      blocks += 1
      return
    }
    if (fence && fence[2][0] === open.char && fence[2].length >= open.length) {
      if (fence[3].trim() === '') {
        open = null
        return
      }
      findings.push(
        `${at}: a fence line inside the code block opened at line ${open.line} has ${JSON.stringify(fence[3].trim().slice(0, 60))} after it. ` +
          'A closing fence must be bare; CommonMark reads this line as code and the block runs on. ' +
          '(A nested sample needs a longer outer fence.)',
      )
      return
    }
    const init = INIT_LINE.exec(line)
    if (init) {
      initLines += 1
      const [, type, path] = init
      if (!harnessTypes.has(type)) {
        findings.push(`${at}: \`intutic init\` sample names "${type}", which is not a HarnessType value.`)
      }
      if (!path.startsWith('/') && !/^[A-Za-z]:\\/.test(path)) {
        findings.push(
          `${at}: \`intutic init\` sample shows "${path}"; the CLI prints the absolute path it resolved ` +
            '(tools/cli/src/harness/detector.ts), e.g. /path/to/project/' + path.replace(/^~\//, ''),
        )
      }
    }
  })
  if (open) findings.push(`${rel}:${open.line}: this code block never closes.`)
}

if (blocks === 0) {
  console.error('[FAIL] no code block was found under apps/docs; this check asserted nothing.')
  process.exit(1)
}
if (initLines === 0) {
  console.error('[FAIL] no `intutic init` sample line (✔ <type> → <path>) was found; the pattern no longer matches the docs.')
  process.exit(1)
}
if (findings.length > 0) {
  for (const f of findings) console.error(`[FAIL] ${f}`)
  process.exit(1)
}
console.log(`[PASS] docs code blocks: ${blocks} block(s) in ${files.length} file(s) open and close cleanly; ${initLines} \`intutic init\` sample line(s) show absolute paths and real harness types.`)
