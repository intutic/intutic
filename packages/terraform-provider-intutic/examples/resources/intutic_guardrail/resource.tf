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
