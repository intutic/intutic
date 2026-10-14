# intutic_policy is deprecated: the policies API sunsets on 2026-12-01. A
# policy's target_tool_pattern, enforcement_action, conditions and
# risk_category are enforced nowhere, and its only effect is choosing the
# workspace's intervention mode. Write the rule a policy described as a hook
# rule guardrail, and set the intervention mode as a workspace setting.

# The harness gates block `git push --force` once this guardrail is enforcing.
# It starts PROPOSED; approve it for shadow and promote it on evidence in the
# guardrail review (or with `intutic guardrails`).
resource "intutic_guardrail" "no_force_push" {
  name         = "No force push"
  description  = "Agents may not rewrite shared history."
  kind         = "hook_rule"
  title        = "No force push"
  tools        = ["Bash"]
  arg_contains = ["push --force"]
}

# What the agent is told when a call is refused. Once set, this wins over
# every policy's intervention_mode.
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    interventionMode = "TRANSPARENT"
  })
}
