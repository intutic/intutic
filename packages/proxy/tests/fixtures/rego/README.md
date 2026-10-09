# Rego fixtures

OPA builds of Rego policies, shared by every host's tests: the Rust proxy
(`src/wasm/opa.rs`, `tests/rego_*`), the TypeScript host
(`packages/shared-types`), the MCP proxy and the CLI.

| File | What it is |
|---|---|
| `examples/*.rego` | The three example policies the docs show, with `*.cases.json` for `intutic rules test` |
| `examples/*.wasm` | Built by `intutic rules build`, with the `intutic.rule` metadata section |
| `conformance.rego` | Calls every host-provided builtin over the cases in `conformance.input.json` |
| `conformance.expected.json` | `opa eval` on those cases: the oracle both hosts must reproduce |
| `unsupported_builtin.*` | Needs `crypto.md5`, which no host provides: refused at load |

Rebuild everything with `./build.sh` (needs OPA and a built CLI). It records the
OPA version it used; these were built with OPA 1.20.2.
