// Every harness's protected-path list must cover every harness's config.
//
// There were eleven lists and no two agreed. The Claude-family lists carried
// only Claude paths, so an agent under Claude Code could rewrite
// `.cursor/hooks.json`, `.openhands/hooks.json`, `.gemini/settings.json` or the
// governance plugin directory unopposed. The other nine omitted
// `.claude/settings.local.json` — which Claude Code loads at *higher*
// precedence than the `settings.json` they all did protect. Whichever harness
// an agent ran under, it could disarm a different one.
//
// This is a source-level test on purpose. The lists are module-private consts
// embedded into generated hook scripts via `JSON.stringify`, so there is nothing
// to import; and the failure being guarded is drift between files, which is
// exactly what reading the files can see. Same technique as
// `changeManifestParity` in the control plane.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { UNIVERSAL_PROTECTED_PATHS } from '../src/harness/protectedPaths.js'

const HARNESS_DIR = join(__dirname, '../src/harness')

/** Every harness module that declares a protected-path list. */
function harnessesWithLists(): Array<{ file: string; paths: string[]; spreads: boolean }> {
  const out: Array<{ file: string; paths: string[]; spreads: boolean }> = []
  for (const file of readdirSync(HARNESS_DIR)) {
    if (!file.endsWith('Hooks.ts')) continue
    const src = readFileSync(join(HARNESS_DIR, file), 'utf-8')
    const m = src.match(/const PROTECTED_PATHS[^=]*=\s*\[([\s\S]*?)\n\]/)
    if (!m) continue // this harness declares none — covered separately below
    const body = m[1]!
    const literals = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    // A harness may spread the shared const instead of restating it. Resolved
    // against the *imported* const, not a copy of it — so this still reads the
    // real file and the real list, and a harness that quietly stopped spreading
    // it fails here.
    const spreads = body.includes('...UNIVERSAL_PROTECTED_PATHS')
    out.push({
      file,
      paths: spreads ? [...UNIVERSAL_PROTECTED_PATHS, ...literals] : literals,
      spreads,
    })
  }
  return out
}

describe('harness protected paths', () => {
  it('finds the harness lists at all', () => {
    // Guards the regex above. If it stopped matching, every assertion below
    // would iterate nothing and report perfect coverage — a green build
    // asserting that lists nobody read are correct.
    const found = harnessesWithLists()
    expect(found.length, 'no harness lists parsed — the extraction broke').toBeGreaterThanOrEqual(8)
  })

  it.each(harnessesWithLists().map((h) => [h.file, h.paths] as const))(
    '%s covers every universal protected path',
    (file, paths) => {
      const missing = UNIVERSAL_PROTECTED_PATHS.filter(
        (u) => !paths.some((p) => p === u || p.endsWith(`/${u}`) || p.endsWith(u)),
      )
      expect(
        missing,
        `${file} does not protect: ${missing.join(', ')} — an agent under this ` +
          `harness could disarm the governance of another`,
      ).toEqual([])
    },
  )

  /**
   * The specific override that made this urgent.
   *
   * Claude Code reads `.claude/settings.local.json` *after* `.claude/settings.json`
   * and it wins. A list protecting only the latter stops the obvious edit and
   * leaves the effective one open.
   */
  it('every harness protects the higher-precedence Claude override', () => {
    for (const { file, paths } of harnessesWithLists()) {
      expect(
        paths.some((p) => p.includes('settings.local.json')),
        `${file} protects settings.json but not settings.local.json, which overrides it`,
      ).toBe(true)
    }
  })

  /**
   * And they must share the const rather than restate it.
   *
   * Eleven hand-maintained copies is how this drifted in the first place; a
   * harness that passes the superset check today by listing every path inline
   * is one edit away from being wrong again.
   */
  it('every harness spreads the shared list rather than copying it', () => {
    for (const { file, spreads } of harnessesWithLists()) {
      expect(spreads, `${file} restates the paths instead of spreading the shared const`).toBe(true)
    }
  })

  /**
   * The block reason must carry the word the severity classifier keys on.
   *
   * `hookEvents.ts` resolves severity with
   * `if (reason.toLowerCase().includes('governance-protected')) return 'CRITICAL'`.
   * Eleven harnesses emit exactly that phrase. `windsurfHooks` emitted
   * "Attempt to modify protected path" — one word short — so a Windsurf agent
   * caught tampering with governance config was filed MEDIUM rather than
   * CRITICAL, and whatever routes on CRITICAL never saw it.
   *
   * A magic substring shared between twelve generators and one classifier is
   * the same fragility as the protected-path lists above; this is the assertion
   * that keeps them honest until it is a shared constant on both sides.
   */
  it('every harness block reason carries the CRITICAL severity keyword', () => {
    const KEYWORD = 'governance-protected'
    for (const file of readdirSync(HARNESS_DIR)) {
      if (!file.endsWith('Hooks.ts')) continue
      const src = readFileSync(join(HARNESS_DIR, file), 'utf-8')
      if (!src.includes('protected path')) continue // this harness blocks no paths
      expect(
        src.includes(KEYWORD),
        `${file} emits a protected-path block reason without "${KEYWORD}" — ` +
          `hookEvents.resolveSeverity downgrades it from CRITICAL to MEDIUM`,
      ).toBe(true)
    }
  })

  /**
   * Registering a Bash matcher without a shell guard is a hook that fires and
   * does nothing.
   *
   * The protected-path check inspects file-path arguments only, so the same
   * intent expressed as a command string walks straight past it.
   * `claudeCodeHooks` registered `Bash` as a PreToolUse matcher and had no
   * bypass-pattern guard — while `claudeDesktopHooks` and `piHooks` both did.
   * Claude Code is the primary harness, so the gap was widest exactly where it
   * mattered most.
   *
   * What it left open: `chflags nouchg .intutic/hooks/pre-tool-check.js` makes
   * the hook itself immutable, and `printf '{}' > ~/.claude/settings.json`
   * empties the settings that register it. Neither touches a path argument.
   */
  it('every harness that gates Bash also guards shell bypass patterns', () => {
    for (const file of readdirSync(HARNESS_DIR)) {
      if (!file.endsWith('Hooks.ts')) continue
      const src = readFileSync(join(HARNESS_DIR, file), 'utf-8')

      // Does this generator gate shell execution at all?
      const gatesShell =
        /hookEntry\('Bash'\)/.test(src) ||
        /beforeShellExecution/.test(src) ||
        /'bash', 'shell'/.test(src)
      if (!gatesShell) continue

      expect(
        /chflags nouchg|BYPASS_PATTERNS|dangerPatterns/.test(src),
        `${file} gates shell execution but carries no bypass-pattern guard — the ` +
          `protected-path check reads path arguments only, so a command string ` +
          `expressing the same intent is unopposed`,
      ).toBe(true)
    }
  })
})
