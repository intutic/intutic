resource "intutic_virtual_key" "ci" {
  label              = "CI pipeline"
  allowed_models     = ["claude-haiku-4-5"]
  expires_in_days    = 90
  is_service_account = true
}

# The key is sensitive; hand it to the system that needs it, for example a
# CI secret, rather than printing it.
