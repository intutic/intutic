// The pre-execution hook classifies commands, and so does the proxy.
//
// `claudeCodeHooks` embeds its own command→action map so a `review_before:`
// SOP can hold a tool call *before* it runs. The proxy's `actions.rs` has the
// authoritative lists. Two hand-maintained copies of a security-relevant
// vocabulary, in two languages, with nothing tying them together — and they had
// drifted:
//
//   action:deploy   10 needles in the hook, 14 in the proxy
//                   (missing: serverless deploy, aws deploy, aws s3 sync, eb deploy)
//   action:publish   7 vs 8   (missing: docker manifest push)
//   action:release   4 vs 6   (missing: cargo release, goreleaser release)
//
// The hook's comment says anything it cannot classify "falls through to the
// proxy's own gate". For a *blocking* decision that is not the same thing: the
// hook is what runs before the tool executes, while the proxy sees the call in
// the next request's history — after it happened. So an SOP declaring
// `review_before: action:deploy` did not hold `aws s3 sync ./dist s3://prod`,
// it observed it.
//
// Read from the Rust source rather than restated here, so this cannot become a
// third copy. Same technique as `changeManifestParity` and `valkeyKeyParity` in
// the control plane.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUST = readFileSync(
  join(__dirname, '../../../packages/proxy/src/plugins/anomaly/actions.rs'),
  'utf-8',
)
const HOOK = readFileSync(join(__dirname, '../src/harness/claudeCodeHooks.ts'), 'utf-8')

/** The string literals of a `const NAME: &[&str] = &[...]` in the Rust source. */
function rustPatterns(name: string): string[] {
  const m = RUST.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`))
  expect(m, `${name} not found in actions.rs`).not.toBeNull()
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)
}

/** The needles the hook maps to a given action token. */
function hookNeedles(action: string): string[] {
  const m = HOOK.match(new RegExp(`\\['${action}', \\[([^\\]]*)\\]\\]`))
  if (!m) return []
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

describe('hook and proxy classify the same commands', () => {
  it('the extraction finds both sides', () => {
    // Guards the two regexes. If either stopped matching, every case below
    // would compare empty against empty and report perfect agreement.
    expect(rustPatterns('DEPLOY_PATTERNS').length).toBeGreaterThan(5)
    expect(hookNeedles('action:deploy').length).toBeGreaterThan(5)
  })

  it.each([
    ['action:deploy', 'DEPLOY_PATTERNS'],
    ['action:publish', 'PUBLISH_PATTERNS'],
    ['action:release', 'RELEASE_PATTERNS'],
    ['action:db_write', 'DB_WRITE_PATTERNS'],
  ])('%s covers every pattern the proxy recognises', (action, constName) => {
    const proxy = rustPatterns(constName)
    const hook = hookNeedles(action)
    const missing = proxy.filter((p) => !hook.includes(p))
    expect(
      missing,
      `the hook does not recognise ${missing.join(', ')} as ${action}, so a ` +
        `review_before SOP naming it cannot hold the call before it executes`,
    ).toEqual([])
  })

  /**
   * And the hook must not invent a classification the proxy does not share.
   *
   * A needle only the hook knows would hold a call the proxy then allows,
   * which reads to an operator as the hold being spurious.
   */
  it.each([
    ['action:deploy', 'DEPLOY_PATTERNS'],
    ['action:publish', 'PUBLISH_PATTERNS'],
    ['action:release', 'RELEASE_PATTERNS'],
    ['action:db_write', 'DB_WRITE_PATTERNS'],
  ])('%s recognises nothing the proxy does not', (action, constName) => {
    const proxy = rustPatterns(constName)
    const extra = hookNeedles(action).filter((h) => !proxy.includes(h))
    expect(extra, `the hook classifies ${extra.join(', ')} as ${action} and the proxy does not`).toEqual([])
  })
})
