# A Rego policy compiled with `intutic rules build --rego`, pinned to the
# reviewed build.
resource "intutic_wasm_rule" "no_prod_deploys" {
  name        = "Hold production deploys"
  description = "Holds kubectl and helm against the production context for review."
  source      = "${path.module}/rules/hold_prod_deploys.wasm"
  sha256      = "3f5a0c9e7b1d24e8a6c0f9b2d47e15a83c6b9d0e2f714a58c3e6b1d9a07f42c1"
}

# A native rule built from the Rules SDK, uploaded switched off.
resource "intutic_wasm_rule" "deep_graphs" {
  name    = "Re-ask deep agent graphs"
  source  = "${path.module}/rules/deep_graphs.wasm"
  enabled = false
}
