resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    egressMode         = "enforce"
    egressAllow        = ["api.github.com", "registry.npmjs.org"]
    mcpDefaultPolicy   = "deny"
    sandboxRequirement = "warn"
    ssoKeyMaxIdleDays  = 30
    piiDetectors = {
      "pii.card"  = "block"
      "pii.email" = "redact"
    }
    upstreamRetry = {
      maxAttempts = 4
      fallbacks = {
        "claude-opus-4-1" = [{ model = "claude-sonnet-4-5" }]
      }
    }
    featureFlags = {
      ff_shadow_enforcement = true
    }
  })
}
