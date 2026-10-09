# Import by rule id. bundle_sha256 comes from the API; the next plan replaces
# the rule if the file in source has different bytes.
terraform import intutic_wasm_rule.no_prod_deploys wasm_0123456789abcdef
