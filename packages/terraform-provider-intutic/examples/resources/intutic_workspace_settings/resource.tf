resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    egressMode         = "enforce"
    egressAllow        = ["api.github.com", "registry.npmjs.org"]
    mcpDefaultPolicy   = "deny"
    sandboxRequirement = "warn"
    ssoKeyMaxIdleDays  = 30
    featureFlags = {
      ff_shadow_enforcement = true
    }
  })
}
