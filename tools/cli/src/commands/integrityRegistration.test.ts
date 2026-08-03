// That `intutic integrity` exists in the binary at all.
//
// `integrity.test.ts` imports `runIntegrityRoots`/`runIntegrityVerify`/
// `runIntegrityChain` and exercises them directly — 21 tests, all good, none of
// which touch `cli.ts`. Measured: deleting the entire 37-line `integrity`
// registration block from `cli.ts` leaves `tsc --noEmit` clean and all 57 CLI
// tests passing. The command would vanish from the shipped binary in silence
// while `apps/docs/reference/cli.md` kept telling users to type it.
//
// That is the same defect the integrity feature exists to remove, one layer out:
// the handlers are correct, tested, and unreachable. A caller nothing pins is a
// caller that can disappear.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(here, '../cli.ts')

/**
 * Read the source rather than import it.
 *
 * `cli.ts` ends in `program.parse()`, so importing it runs the CLI against the
 * test runner's own argv. Commander's tree would be the better assertion and
 * this is the cheaper one that does not require restructuring the entrypoint —
 * a trade worth naming rather than hiding.
 */
const source = readFileSync(CLI, 'utf8')

describe('integrity command registration', () => {
  it('registers the integrity command group', () => {
    expect(
      source,
      'the integrity command group is gone from cli.ts, so `intutic integrity` no longer ' +
        'exists in the binary — while the handlers it dispatches to stay fully tested',
    ).toMatch(/\.command\(\s*['"]integrity['"]\s*\)/)
  })

  // `verify` takes an argument, so its registration reads `verify <root_id>` —
  // matched loosely enough to survive a rename of the placeholder but not the
  // disappearance of the subcommand.
  it.each([
    ['roots', 'runIntegrityRoots'],
    ['verify', 'runIntegrityVerify'],
    ['chain', 'runIntegrityChain'],
    // `config-chain` is the TD-259 case: the walker exists, is tested, and
    // without this registration is reachable only by curl.
    ['config-chain', 'runIntegrityConfigChain'],
  ])('wires the %s subcommand to its handler', (subcommand, handler) => {
    // Both halves matter. The subcommand can exist while dispatching to the
    // wrong handler, and the handler can be imported without a subcommand ever
    // reaching it.
    expect(source, `subcommand '${subcommand}' is not registered`).toMatch(
      new RegExp(`\\.command\\(\\s*['"]${subcommand}(\\s+<[^>]+>)?['"]`),
    )
    expect(source, `'${subcommand}' does not dispatch to ${handler}`).toContain(handler)
  })

  it('exits non-zero when verification fails', () => {
    // The reason a customer would put this in CI. A command that prints
    // "mismatch" and exits 0 is a check no pipeline will ever fail on, which is
    // indistinguishable from not running it. The exit lives in the handler
    // rather than the registration, so this reads the handler.
    const handler = readFileSync(resolve(here, './integrity.ts'), 'utf8')
    expect(handler).toMatch(/process\.exit\(1\)/)
  })
})
