# INTUTIC_API_KEY comes from the CI secret store; nothing secret is in this
# repository.
provider "intutic" {}

# One Markdown file per SOP under sops/, reviewed in pull requests like code.
locals {
  sops = {
    production-deploys = { title = "Production deploys", risk_tier = "HIGH", complexity_tier = "TIER_1" }
    secrets-handling   = { title = "Secrets handling", risk_tier = "CRITICAL", complexity_tier = "TIER_0" }
  }
}

resource "intutic_sop" "this" {
  for_each = local.sops

  title            = each.value.title
  markdown_content = file("${path.module}/sops/${each.key}.md")
  risk_tier        = each.value.risk_tier
  complexity_tier  = each.value.complexity_tier
}

# Guardrails written as code. Each starts PROPOSED; approving it for shadow and
# promoting it to enforcing stay review decisions, made in the dashboard or
# with `intutic guardrails`.
resource "intutic_guardrail" "reviewed_apply" {
  name         = "Reviewed terraform apply"
  description  = "Production applies need a reviewed plan."
  kind         = "hook_rule"
  title        = "Reviewed plan before terraform apply"
  tools        = ["Bash"]
  arg_contains = ["terraform apply"]
}

resource "intutic_guardrail" "no_web_fetch_for_contractors" {
  name  = "No web fetch for contractors"
  kind  = "deny_tools"
  tools = ["WebFetch"]
  roles = ["contractor"]
}

# Only the keys named here are managed; settings changed in the dashboard
# under other keys are left alone.
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    mcpDefaultPolicy = "deny"
    egressMode       = "enforce"
    egressAllow      = ["api.github.com", "registry.npmjs.org"]
  })
}

resource "intutic_workspace_budget" "this" {
  daily_budget_usd   = 150
  monthly_budget_usd = 3000
}

# An MCP server a proxy has already reported, approved without one tool.
resource "intutic_mcp_server_decision" "github" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repository"]
}
