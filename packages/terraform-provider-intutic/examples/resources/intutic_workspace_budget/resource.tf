resource "intutic_workspace_budget" "this" {
  daily_budget_usd    = 150
  monthly_budget_usd  = 3000
  alert_threshold_pct = 80
  monthly_enforcement = "hard"
}
