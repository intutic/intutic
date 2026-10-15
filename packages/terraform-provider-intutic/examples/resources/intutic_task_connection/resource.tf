# Jira Cloud: a branch or commit naming PROJ-123 picks up that ticket's
# context. Jira signs an API token in as its account, so account_email is
# required. Changing any argument replaces the connection.
resource "intutic_task_connection" "jira" {
  task_provider = "jira"
  base_url      = "https://acme.atlassian.net"
  project_key   = "PROJ"
  account_email = "platform@acme.com"
  api_token     = var.jira_api_token
}

# Linear: project_key is the team key (eng-123 matches ENG).
resource "intutic_task_connection" "linear" {
  task_provider = "linear"
  base_url      = "https://api.linear.app"
  project_key   = "ENG"
  api_token     = var.linear_api_key
}

variable "jira_api_token" {
  type      = string
  sensitive = true
}

variable "linear_api_key" {
  type      = string
  sensitive = true
}
