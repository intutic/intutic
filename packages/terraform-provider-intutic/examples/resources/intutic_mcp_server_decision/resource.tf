resource "intutic_mcp_server_decision" "github" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repository"]
}
