resource "intutic_virtual_key" "ci" {
  label              = "CI pipeline"
  allowed_models     = ["claude-haiku-4-5"]
  expires_in_days    = 90
  is_service_account = true
  # Agent traffic only (the proxy, hook gates, SDKs): the least-privilege scope
  # for a pipeline. Omit for "*", everything the owner's role allows.
  scopes = ["gateway:use"]

  # Spend budgets and rate limits change in place; an OWNER or ADMIN sets them.
  daily_budget_usd           = 25
  monthly_budget_usd         = 400
  monthly_budget_enforcement = "soft"
  rate_limit_rpm             = 120
}

# The key is sensitive; hand it to the system that needs it, for example a
# CI secret, rather than printing it.
