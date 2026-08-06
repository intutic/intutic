/**
 * Do the writers, run together, produce a coherent installation?
 *
 * A separate FILE, not merely a separate test, and the reason is mechanical:
 * this is the only check that runs every writer into ONE shared root, and
 * several writers bind their output directory from `os.homedir()` at **module
 * scope**. Re-invoking them under a different HOME inside the sibling suite
 * rewrote artifacts that suite was still asserting on, and re-applied goose's
 * `chflags uchg` to a tree its cleanup no longer knew about. A fresh file gets a
 * fresh module registry, so the module-scope reads happen once, here, against
 * this root.
 *
 * The per-gate roots the sibling uses are right for asking "is this gate
 * correct". They are exactly wrong for asking "do these writers agree", because
 * a disagreement *between* writers is what separate roots hide — and with
 * HOME == workspaceRoot inside a per-gate root, a registration pointing at the
 * home copy resolves by coincidence.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { GATES } from './gateRegistry.js'

const shared = mkdtempSync(join(tmpdir(), 'intutic-partition-'))

afterAll(() => {
  spawnSync('chflags', ['-R', 'nouchg', shared])
  try {
    rmSync(shared, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

/** Every file under the shared root, relative. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

describe('writers run together', () => {
  let files: string[] = []

  it('runs every writer into one shared root', async () => {
    process.env.HOME = shared
    process.env.USERPROFILE = shared
    for (const g of GATES) {
      const mod = await import(g.module)
      await g.invoke(mod, shared)
    }
    files = walk(shared)
    // Not vacuous: if the writers produced nothing, every assertion below would
    // pass over an empty set.
    expect(files.length, 'no writer produced anything').toBeGreaterThan(20)
  }, 120_000)

  it('registers no command that does not exist on disk', () => {
    // The assertion whose absence let a real defect ship. `cursorHooksJson`
    // registered `~/.intutic/hooks/cursor-check.js` — a path no writer produced —
    // and, disagreeing with `cursorHooks` about the file's schema, also replaced
    // that writer's entries and dropped their `failClosed` flag. Every other test
    // passed throughout: the gates were right, the artifacts were right, and the
    // thing pointing at them was not.
    const dangling: string[] = []
    for (const cfg of files.filter((f) => /\.(json|ya?ml)$/.test(f))) {
      let text: string
      try {
        text = readFileSync(cfg, 'utf8')
      } catch {
        continue
      }
      // The token is captured WHOLE and the extension checked after. Folding the
      // extension into the pattern makes it match a *prefix*, so a registration
      // pointing at `cursor-check.js.missing` matches the existing
      // `cursor-check.js` inside it and passes. Backslash is excluded because
      // writers emitting `node "path"` leave a trailing `\` inside the JSON
      // string — with it included the extension test fails and the registration
      // is skipped entirely, which is how the first version of this check went
      // green against a deliberately broken path.
      for (const m of text.matchAll(/(?:^|[\s"'`])(\/[^\s"'`,\\]+)/g)) {
        const target = m[1]!
        if (!/\.(js|sh|py)$/.test(target)) continue
        if (!target.startsWith(shared)) continue
        if (!existsSync(target)) {
          dangling.push(`${cfg.slice(shared.length + 1)} -> ${target.slice(shared.length + 1)}`)
        }
      }
    }
    expect(
      dangling,
      'A generated config registers a command that no writer produces. The ' +
        'harness will try to run it and fail, which reads to the user as a ' +
        'broken install rather than as an ungoverned one.',
    ).toEqual([])
  })

  it('produces every gate artifact the registry declares', () => {
    const missing = GATES.filter((g) => !existsSync(join(shared, g.artifact))).map((g) => g.name)
    expect(missing, 'a writer did not produce its declared artifact under a shared root').toEqual([])
  })

  it('leaves no zero-byte artifact', () => {
    // A writer that fails mid-write leaves a truncated file that still satisfies
    // an existsSync check.
    const empty = files.filter((f) => statSync(f).size === 0).map((f) => f.slice(shared.length + 1))
    expect(empty, 'a writer produced an empty file').toEqual([])
  })
})
