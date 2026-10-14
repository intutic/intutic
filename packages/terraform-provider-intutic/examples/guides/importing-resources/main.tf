terraform {
  required_providers {
    intutic = {
      source  = "intutic/intutic"
      version = "~> 0.2"
    }
  }
}

provider "intutic" {}

data "intutic_workspace" "this" {}

# The workspace-wide resources import by workspace id, which the data source
# reads from the provider's key.
import {
  to = intutic_workspace_settings.this
  id = data.intutic_workspace.this.id
}

resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    mcpDefaultPolicy = "deny"
  })
}

import {
  to = intutic_workspace_budget.this
  id = data.intutic_workspace.this.id
}

resource "intutic_workspace_budget" "this" {
  daily_budget_usd   = 150
  monthly_budget_usd = 3000
}

# Resources the API names with an id: copy it from the dashboard or the API.
import {
  to = intutic_sop.deploys
  id = "sp_V1StGXR8_Z5jdHi6B-myT"
}

resource "intutic_sop" "deploys" {
  title            = "Production deploys"
  markdown_content = file("${path.module}/production-deploys.md")
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_1"
}

# An MCP server decision imports by the server's name, not its id.
import {
  to = intutic_mcp_server_decision.github
  id = "github"
}

resource "intutic_mcp_server_decision" "github" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repository"]
}

# The default member budget imports as `default`.
import {
  to = intutic_member_budget.default
  id = "default"
}

resource "intutic_member_budget" "default" {
  member_id        = "default"
  daily_budget_usd = 20
}

# A provider credential imports by provider id. The API never returns the
# stored secret, so the first apply after the import sends `fields` again.
import {
  to = intutic_provider_credential.anthropic
  id = "anthropic"
}

resource "intutic_provider_credential" "anthropic" {
  provider_id = "anthropic"
  fields = {
    apiKey = var.anthropic_api_key
  }
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}
