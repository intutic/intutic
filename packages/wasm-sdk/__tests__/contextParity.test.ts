/**
 * The guest SDK must be able to see every field the host sends.
 *
 * The host builds `RequestContext` in `packages/proxy/src/wasm/context.rs` and
 * serialises all of it. The guest parses it by hand in `assembly/index.ts` —
 * there is no codegen — so a field added to the host reaches a rule author only
 * if somebody also adds it here. Nobody did: 13 of 37 fields were unreachable,
 * including every SOP-derived policy field and `tool_contract_changed`, which
 * is the tool-poisoning signal.
 *
 * A rule author copying the template got no error for a field the SDK cannot
 * see. It simply reads as absent, which for most of these is indistinguishable
 * from "no policy declared" — so the rule silently does nothing.
 *
 * Both sides are read from source, so a field added to the host fails here
 * rather than being quietly invisible.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const guestSrc = readFileSync(join(here, '..', 'assembly', 'index.ts'), 'utf8')

/**
 * The host struct, read from the Rust source rather than restated here.
 *
 * `NodeIdentity` is `#[serde(flatten)]`-ed onto the top level, so its fields
 * arrive as siblings — `node_id`, not `node.node_id` — and the guest must parse
 * them the same way.
 */
function hostFields(): string[] {
  const rs = readFileSync(
    join(here, '..', '..', 'proxy', 'src', 'wasm', 'context.rs'),
    'utf8',
  )
  const structBody = (name: string) => {
    const i = rs.indexOf(`pub struct ${name}`)
    if (i < 0) throw new Error(`${name} not found in context.rs`)
    return rs.slice(i, rs.indexOf('\n}', i))
  }
  const fieldsOf = (body: string) =>
    [...body.matchAll(/^\s*pub ([a-z_0-9]+):/gm)].map((m) => m[1])

  return [
    ...fieldsOf(structBody('RequestContext')).filter((f) => f !== 'node'),
    ...fieldsOf(structBody('NodeIdentity')),
  ]
}

/**
 * Fields the guest deliberately does not parse. Each needs a reason — an
 * unexplained entry is how the other twelve went missing.
 */
const DELIBERATELY_UNPARSED = new Map([
  [
    'transition_baseline',
    'a HashMap<String, f64> the guest would have to walk under a 5 ms budget, ' +
      'for a statistic a rule should not be re-deriving. Read it host-side.',
  ],
])

describe('guest SDK context parity', () => {
  const fields = hostFields()

  it('reads a plausible field list from the host struct', () => {
    // Guard against the extraction silently matching nothing, which would make
    // every assertion below vacuous.
    expect(fields.length).toBeGreaterThanOrEqual(30)
    expect(fields).toContain('session_id')
    expect(fields).toContain('node_id') // proves the flatten is handled
  })

  for (const field of hostFields()) {
    const skip = DELIBERATELY_UNPARSED.get(field)
    it(`the guest parses ${field}${skip ? ' — deliberately not' : ''}`, () => {
      const parsed = guestSrc.includes(`"${field}"`)
      if (skip) {
        expect(parsed, `${field} is listed as deliberately unparsed but IS parsed — remove the exemption`).toBe(false)
        return
      }
      expect(
        parsed,
        `the host sends ${field} and assembly/index.ts never reads it, so a rule ` +
          `author cannot see it and gets no error saying so`,
      ).toBe(true)
    })
  }
})

/**
 * The parity test above reads `assembly/index.ts` as text, so it passes whether
 * or not that file compiles — and it did exactly that, green, while the SDK had
 * a duplicate field declaration and `asc` refused to build it.
 *
 * Source-text parity is the right shape for the host/guest contract, but it has
 * to be paired with something that actually invokes the compiler, or "the field
 * is mentioned" gets mistaken for "a rule can use it".
 */
describe('the SDK compiles', () => {
  it('asc builds assembly/index.ts', () => {
    const out = join(tmpdir(), `wasm-sdk-compile-check-${process.pid}.wasm`)
    const res = spawnSync(
      'npx',
      ['--no-install', 'asc', 'assembly/index.ts', '-o', out, '--optimize', '--exportRuntime'],
      { cwd: join(here, '..'), encoding: 'utf8' },
    )
    try {
      expect(
        res.status,
        `asc failed — a rule author copying this template cannot build it:\n${res.stderr}`,
      ).toBe(0)
      expect(existsSync(out), 'asc reported success but emitted no module').toBe(true)
    } finally {
      if (existsSync(out)) rmSync(out)
    }
  }, 120_000)
})
