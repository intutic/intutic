# The API key comes from INTUTIC_API_KEY, and the control plane's base URL
# from INTUTIC_CONTROL_PLANE_URL.
provider "intutic" {}

# The workspace and member the key acts as. Reading it is a quick check that
# authentication works before anything is created.
data "intutic_workspace" "this" {}

output "workspace_id" {
  value = data.intutic_workspace.this.id
}

output "acting_role" {
  value = data.intutic_workspace.this.role
}

# A first resource: a SOP. It is created as a DRAFT, so it enforces nothing
# until it passes the SOP review in the dashboard.
resource "intutic_sop" "deploys" {
  title           = "Production deploys"
  risk_tier       = "HIGH"
  complexity_tier = "TIER_1"

  markdown_content = <<-EOT
    ## Production deploys

    - Deploy to production only from the main branch, after CI passes.
    - Never run database migrations by hand against production.
    - Roll back with the previous release tag, not with a hotfix commit.
  EOT
}

output "sop_lifecycle_state" {
  value = intutic_sop.deploys.lifecycle_state
}
