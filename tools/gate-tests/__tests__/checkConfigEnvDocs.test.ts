/**
 * The configuration-reference gate reads env vars out of source text, so the
 * parsing is the thing that can quietly stop working: a missed read is an
 * undocumented knob, a phantom read hides a documented variable nothing uses.
 */
import { describe, it, expect } from 'vitest'
import { readsIn, documentedIn } from '../../scripts/check-config-env-docs.js'

describe('readsIn', () => {
  it('finds Rust reads by literal, by const and through an array of names', () => {
    const src = [
      'let a = std::env::var("CONFIG_PATH");',
      'const SOPS_DIR_ENV: &str = "INTUTIC_SOPS_DIR";',
      'let m = ["LITELLM_LOCAL_TYPED_JUDGE_MODEL", "LITELLM_LOCAL_JUDGE_MODEL"].iter().filter_map(|k| std::env::var(k).ok());',
      'tracing_subscriber::EnvFilter::try_from_default_env();',
      '// std::env::var("IN_A_COMMENT")',
      '#[cfg(test)]',
      'mod tests { fn t() { std::env::var("ONLY_IN_TESTS"); } }',
    ].join('\n')
    expect([...readsIn(src, 'rust')].sort()).toEqual([
      'CONFIG_PATH',
      'INTUTIC_SOPS_DIR',
      'LITELLM_LOCAL_JUDGE_MODEL',
      'LITELLM_LOCAL_TYPED_JUDGE_MODEL',
      'RUST_LOG',
    ])
  })

  it('finds Rust names read through a lookup closure handed to a function', () => {
    const src = [
      'fn resolve(p: &P, var: impl Fn(&str) -> Option<String>) -> String {',
      '    let specific = match p { P::A => "A_UPSTREAM_URL" };',
      '    var(specific).or_else(|| var("UPSTREAM_URL")).unwrap_or_default()',
      '}',
      'fn base(p: &P) -> String { resolve(p, |name| std::env::var(name).ok()) }',
    ].join('\n')
    expect([...readsIn(src, 'rust')].sort()).toEqual(['A_UPSTREAM_URL', 'UPSTREAM_URL'])
  })

  it('counts TypeScript reads, not assignments or comments', () => {
    const src = [
      "const a = process.env.INTUTIC_PROXY_URL ?? 'http://localhost:4000'",
      "const b = process.env['MCP_DAEMON_SOCKET']",
      'const c = env.INTUTIC_FC_KERNEL ?? ""',
      "process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'",
      "process.env.INTUTIC_PROXY_URL_SET ??= 'x'",
      'if (process.env.INTUTIC_DEV === "1") {}',
      '/** process.env.IN_A_DOC_COMMENT */',
    ].join('\n')
    expect([...readsIn(src, 'ts')].sort()).toEqual(['INTUTIC_DEV', 'INTUTIC_FC_KERNEL', 'INTUTIC_PROXY_URL', 'MCP_DAEMON_SOCKET'])
  })
})

describe('documentedIn', () => {
  it('collects table rows only under the component headings', () => {
    const doc = [
      '### Proxy',
      '| `PORT` | `4000` | x |',
      '#### Egress',
      '| `INTUTIC_EGRESS_MODE` | off | x |',
      '### Control plane',
      '| `DATABASE_URL` | — | x |',
      'Prose naming `OTHER_VAR`.',
    ].join('\n')
    const { mentioned, tabled } = documentedIn(doc)
    expect([...tabled.keys()]).toEqual(['PORT', 'INTUTIC_EGRESS_MODE'])
    expect(mentioned.has('OTHER_VAR')).toBe(true)
    expect(mentioned.has('DATABASE_URL')).toBe(true)
  })
})
