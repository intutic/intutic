/**
 * atomicWriteGuard.test.ts — no harness writer replaces a file with a raw
 * `writeFile`.
 *
 * Gate scripts, hook registrations, harness settings and the policy snapshot
 * are read by other processes at any moment. A raw `writeFile` truncates and
 * then fills, so a harness running the gate in between runs a truncated
 * script, and for the exit-code harnesses a crash that is not exit 2 lets the
 * tool call through. `lib/atomicWrite.ts` is the only way these modules write
 * a whole file; this test fails when one calls `writeFile`, `writeFileSync`
 * or `copyFile` (on any fs object, or destructured) instead.
 *
 * The CLI writes some of the same kind of file — the git hooks, a harness's
 * config, a local WASM rule the proxies load — and imports the same helper
 * (`@intutic/sync-daemon/lib/atomicWrite`), so its writers are scanned here
 * too.
 *
 * Appends (`appendFile`) are not whole-file writes and stay as they are.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC = path.resolve(__dirname, '../../src')
const CLI_SRC = path.resolve(__dirname, '../../../../tools/cli/src')

/**
 * The writer modules: every directory and file that writes what a harness or
 * gate reads. Daemon paths are relative to its `src`; `cli:` ones to the
 * CLI's.
 */
const SCANNED = [
  'harness',
  'watcher',
  'lib',
  'disconnect',
  'configWriter.ts',
  'skillWriter.ts',
  'cli:lib/gitHooks.ts',
  'cli:harness',
  'cli:commands/policy.ts',
]

/**
 * Raw whole-file writes that are allowed, each matched by a substring of the
 * offending line. Every entry must still match something, so one cannot
 * outlive the code it excused.
 */
const ALLOWED: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: 'lib/atomicWrite.ts',
    line: '',
    why: 'The helper itself: the temp file, and the in-place fallback when Windows keeps refusing the rename.',
  },
  {
    file: 'harness/gateBody.ts',
    line: '',
    why: 'Emits gate source as text; its writeFileSync calls run inside the gate (rollback copies), not in the daemon.',
  },
  {
    file: 'cli:commands/policy.ts',
    line: 'candidate.source',
    why: 'Writes a candidate rule\'s source of record into the rule project for compiling; nothing reads it live.',
  },
  {
    file: 'disconnect/originals.ts',
    line: "flag: 'wx'",
    why: 'Exclusive creates of ledger files (the record, its .gitignore) that must fail if the file exists; they never replace one.',
  },
]

const RAW_WRITE = /(?<![\w$])(?:[\w$]+\.)*(?:writeFile|writeFileSync|copyFile|copyFileSync)\s*\(/

/** Lines of `text` that call a raw whole-file write; whole-line comments are skipped. */
function rawWrites(text: string): string[] {
  return text.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
    return RAW_WRITE.test(line)
  })
}

/** Every scanned source file, as `[path, its name in SCANNED and ALLOWED]`. Tests are skipped. */
function sourceFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const entry of SCANNED) {
    const cli = entry.startsWith('cli:')
    const root = cli ? CLI_SRC : SRC
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e))
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
        out.push([p, (cli ? 'cli:' : '') + path.relative(root, p).split(path.sep).join('/')])
      }
    }
    walk(path.join(root, cli ? entry.slice(4) : entry))
  }
  return out
}

describe('harness writers replace files atomically', () => {
  it('recognises the raw writes it exists to catch, and not the helper', () => {
    // The Claude Code gate write as it was.
    expect(rawWrites("  await node_fs.writeFile(node_path.join(hookScriptDir, 'claude-code-check.js'), hookScriptContent, 'utf-8')")).toHaveLength(1)
    expect(rawWrites("  await fs.writeFile(tmpScript, buildHookScript(proxyUrl, workspaceRoot, workspaceId), 'utf-8')")).toHaveLength(1)
    expect(rawWrites("  fs.writeFileSync(settingsPath, text)")).toHaveLength(1)
    expect(rawWrites("  await fs.promises.writeFile(p, t)")).toHaveLength(1)
    expect(rawWrites("  await writeFile(p, t)")).toHaveLength(1)
    expect(rawWrites("  await fs.copyFile(from, to)")).toHaveLength(1)
    expect(rawWrites("  await writeFileAtomic(p, t, { mode: 0o755 })")).toEqual([])
    expect(rawWrites("  await fs.appendFile(log, line)")).toEqual([])
    expect(rawWrites("  // a plain fs.writeFile(x) truncates first")).toEqual([])
  })

  it('finds no raw whole-file write outside the allowlist', () => {
    const files = sourceFiles()
    // The scan must see the writers, or "nothing found" means nothing.
    expect(files.length).toBeGreaterThan(40)
    const names = files.map(([, rel]) => rel)
    expect(names).toContain('harness/claudeCodeHooks.ts')
    expect(names).toContain('cli:lib/gitHooks.ts')
    expect(names).toContain('cli:harness/openhands.ts')

    const used = new Set<number>()
    const offending: string[] = []
    for (const [file, rel] of files) {
      for (const line of rawWrites(fs.readFileSync(file, 'utf-8'))) {
        const i = ALLOWED.findIndex((a) => a.file === rel && line.includes(a.line))
        if (i === -1) offending.push(`${rel}: ${line.trim()}`)
        else used.add(i)
      }
    }
    expect(offending, 'use writeFileAtomic from lib/atomicWrite.ts').toEqual([])
    expect(ALLOWED.filter((_, i) => !used.has(i)).map((a) => a.file), 'stale allowlist entries').toEqual([])
  })
})
