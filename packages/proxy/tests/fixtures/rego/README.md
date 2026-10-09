# Rego fixture for the experimental OPA shim

`deny_shell.wasm` is `deny_shell.rego` compiled by OPA 1.20.2, unmodified:

```sh
opa build -t wasm -e intutic/deny deny_shell.rego -o bundle.tar.gz
tar -xzf bundle.tar.gz /policy.wasm && mv policy.wasm deny_shell.wasm
```

`src/wasm/opa.rs` embeds it to prove that a module OPA built, not a hand-written
imitation of one, runs under the proxy's WASM host. Rebuild it with the command
above after changing the policy.
