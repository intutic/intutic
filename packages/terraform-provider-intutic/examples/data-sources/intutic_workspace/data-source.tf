data "intutic_workspace" "this" {}

output "plan" {
  value = data.intutic_workspace.this.plan_name
}
