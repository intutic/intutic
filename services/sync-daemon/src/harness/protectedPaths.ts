/**
 * The config files an agent must never write, whichever harness it runs under.
 *
 * # Why this is one list
 *
 * It was eleven lists, and no two agreed. Measured on 2026-08-04:
 *
 * | path | harnesses protecting it |
 * |---|---|
 * | `.claude/settings.local.json` | 3 of 11 |
 * | `.gemini/settings.json` | 5 of 11 |
 * | `.intutic/events` | 5 of 11 |
 * | `.codeium/windsurf/hooks.json` | 8 of 11 |
 * | `.cursor/hooks.json` | 8 of 11 |
 *
 * That is not eleven partial views of one intent, it is a **cross-harness
 * tamper matrix**. The Claude-family lists carried only Claude paths, so an
 * agent under Claude Code could rewrite `.cursor/hooks.json`,
 * `.openhands/hooks.json`, `.gemini/settings.json` or the governance plugin
 * directory unopposed; the other nine could write `.claude/settings.local.json`,
 * which Claude Code loads at *higher* precedence than the `settings.json` they
 * all did protect. Whichever harness the agent was running under, it could
 * disarm a different one.
 *
 * A protected-path list is a security control. Eleven copies of a security
 * control is eleven chances for one to be wrong, and every one of them was.
 *
 * # Scope
 *
 * Universal by design. A Cursor agent has no legitimate reason to edit Claude
 * Code's settings, and the reverse holds for every pair — so the union is the
 * correct list for all of them, not a Cursor list plus a Claude list.
 * Harness-specific additions spread this and append; `harnessProtectedPaths.test.ts`
 * asserts each is a superset.
 *
 * @module
 */

/** Governance config that must hold still, for every harness. */
export const UNIVERSAL_PROTECTED_PATHS: readonly string[] = [
  // Intutic's own enforcement surface.
  '.intutic/hooks',
  '.intutic/integrity.json',
  '.intutic/events',

  // Claude Code / Claude Desktop. `settings.local.json` loads at higher
  // precedence than `settings.json`, so protecting only the latter leaves the
  // override unguarded — which was the case in eight of eleven lists.
  '.claude/settings.json',
  '.claude/settings.local.json',

  // Every other harness's hook surface. Present here even for harnesses that
  // are not the one generating the script: the threat is an agent under
  // harness A disabling harness B.
  '.cursor/hooks.json',
  '.cline/hooks',
  '.codeium/windsurf/hooks.json',
  '.windsurf/hooks.json',
  '.openhands/hooks.json',
  '.gemini/settings.json',
  '.agents/plugins/intutic-governance',
]
