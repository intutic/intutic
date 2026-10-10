# Every member without a budget of their own: $20 a day, refused past it, and
# $300 a month, alert only.
resource "intutic_member_budget" "default" {
  member_id                  = "default"
  daily_budget_usd           = 20
  monthly_budget_usd         = 300
  monthly_budget_enforcement = "soft"
}

# One member's own month budget replaces the default month budget for them;
# the default day budget still applies.
resource "intutic_member_budget" "lead" {
  member_id          = "mem_0123456789abcdef"
  monthly_budget_usd = 1000
}
