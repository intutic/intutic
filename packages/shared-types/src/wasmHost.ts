/**
 * The host functions a WASM governance rule may import — one definition.
 *
 * The Rust source of truth is `HOST_IMPORTS` in
 * `packages/proxy/src/wasm/host.rs`; this is its TypeScript mirror, kept honest
 * by `tools/scripts/check-wasm-host-imports.js`, which reads both from source
 * and fails the build if they disagree.
 *
 * ## Why there is a mirror at all
 *
 * Three TypeScript surfaces have to know this list — the CLI's validation
 * sandbox, the control plane's rule-upload endpoint, and the SDK's own test
 * harness — and each of them had its own copy. That is exactly how the original
 * defect happened: the CLI offered a fourth import, `seed`, that the proxy had
 * never registered, so a rule reaching `Math.random()` passed
 * `intutic policy test`, passed `intutic policy install`, and then failed to
 * link inside the proxy. The WASM runner fails **open**, so the rule enforced
 * nothing and nothing said so.
 *
 * Adding a copy is the failure mode. Import this.
 *
 * ## Why `seed` is absent, permanently
 *
 * AssemblyScript emits `env.seed` for anything reaching `Math.random()`. It is
 * refused on purpose rather than registered: a governance verdict that can
 * differ on identical input cannot be audited, and the replay and mutation
 * corpus gates both assume determinism.
 *
 * @module
 */

/**
 * ## Why `read_referenced_file` is present
 *
 * It is not a filesystem import, and the distinction is the whole design. The
 * proxy resolves and reads the file **before** the sandbox is instantiated,
 * from paths derived from the tool call under evaluation, confined to a
 * configured root, extension-allowlisted and size-capped. The guest passes a
 * path as a *lookup key* into that fixed table; there is no code path from a
 * guest string to an `open(2)`. WASI stays unavailable, and a rule still cannot
 * name a file the agent did not.
 *
 * `packages/proxy/src/wasm/referenced_files.rs` documents every guard and what
 * each one costs.
 */

/** Exactly what `env` provides to a rule. Nothing else resolves. */
export const WASM_HOST_IMPORTS = ['log_info', 'abort', 'trace', 'read_referenced_file'] as const

export type WasmHostImport = (typeof WASM_HOST_IMPORTS)[number]

/**
 * Names every function a compiled rule imports that the host will not provide.
 *
 * Returns `[]` for a rule that links. Callers should refuse anything else:
 * loading such a rule produces a plugin that is listed, counted, and silently
 * bypassed on every request.
 */
export function unsupportedWasmImports(module: WebAssembly.Module): string[] {
  const allowed = new Set<string>(WASM_HOST_IMPORTS)
  return WebAssembly.Module.imports(module)
    .filter((i) => i.kind === 'function')
    .filter((i) => i.module !== 'env' || !allowed.has(i.name))
    .map((i) => `${i.module}.${i.name}`)
}

/** A remedy for the imports authors actually hit, not just a refusal. */
export function explainWasmImport(name: string): string {
  if (name === 'env.seed') {
    return (
      'env.seed — emitted by Math.random(). Randomness is refused on purpose: a ' +
      'verdict that can differ on identical input cannot be audited. Derive any ' +
      'variation you need from the request context instead.'
    )
  }
  if (name.startsWith('wasi_') || name.includes('fd_') || name.includes('clock_')) {
    return (
      `${name} — WASI is not available. A rule that needs to look inside a file a tool ` +
      'call references should import env.read_referenced_file, which the host resolves, ' +
      'confines to a configured root and reads on the rule’s behalf.'
    )
  }
  return `${name} — not provided by the proxy sandbox.`
}
