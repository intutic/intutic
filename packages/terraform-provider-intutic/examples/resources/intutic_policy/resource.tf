resource "intutic_policy" "no_force_push" {
  name                = "No force push"
  description         = "Agents may not rewrite shared history."
  target_tool_pattern = "Bash"
  enforcement_action  = "KILL"
  risk_category       = "DESTRUCTIVE"
  priority            = 10
  conditions          = jsonencode({ argContains = ["push --force"] })
}
