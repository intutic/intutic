# A hook rule: the harness gates block `terraform apply` once the guardrail
# is enforcing. It starts PROPOSED; approve it for shadow and promote it on
# evidence in the guardrail review (or with `intutic guardrails`).
resource "intutic_guardrail" "reviewed_apply" {
  name         = "Reviewed terraform apply"
  description  = "Production applies need a reviewed plan."
  kind         = "hook_rule"
  title        = "Reviewed plan before terraform apply"
  tools        = ["Bash"]
  arg_contains = ["terraform apply"]
}

# A front-matter rule the proxy enforces, for contractors only.
resource "intutic_guardrail" "no_web_fetch" {
  name  = "No web fetch for contractors"
  kind  = "deny_tools"
  tools = ["WebFetch"]
  roles = ["contractor"]
}

# A workspace setting: on promotion it narrows the workspace's allowed models.
resource "intutic_guardrail" "approved_models" {
  name   = "Approved models"
  kind   = "allowed_models"
  models = ["claude-sonnet-4-5", "gpt-4o"]
}

# A decide rule: a self-hosted model answers each question about a Bash call
# with a probability, `band` reads it as yes, no or unknown, and `when`
# combines the answers. True refuses, false allows, unknown asks the
# developer. `rollout = "shadow"` only logs what the rule would have done.
resource "intutic_guardrail" "prod_data_export" {
  name    = "Production data export"
  kind    = "decide"
  rule_id = "prod-data-export"
  on      = "tool_call"
  tools   = ["Bash"]
  questions = jsonencode({
    exports = {
      type = "yes_no"
      ask  = "Does this command copy customer data out of the production database?"
    }
    dest = {
      type    = "choice"
      ask     = "Where does the data go?"
      options = ["local_file", "cloud_bucket", "external_host"]
    }
  })
  when     = "exports AND dest != none_of_these"
  band     = jsonencode({ yes_at = 0.85, no_below = 0.15 })
  escalate = "ask"
  rollout  = "shadow"
}
