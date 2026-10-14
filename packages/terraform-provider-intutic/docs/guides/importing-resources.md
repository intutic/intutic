---
page_title: "Importing existing resources"
subcategory: ""
description: |-
  Bring SOPs, guardrails, settings and the rest of a workspace built in the dashboard under Terraform, with import blocks or terraform import.
---

# Importing existing resources

Every resource in the Intutic provider can be imported, so a workspace configured in the dashboard can move under Terraform without recreating anything. Import only reads: it needs the role a plan needs (see the [authentication guide](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/authentication)), and the API key's workspace is the one imported from.

## Import IDs

| Resource | Import ID | Notes |
|----------|-----------|-------|
| `intutic_sop` | SOP id, `sp_…` | Import the live version. A version an edit has replaced, or a deleted SOP, cannot be imported. |
| `intutic_policy` | Policy id, `pol_…` | |
| `intutic_guardrail` | Guardrail id, `pgr_…` | Authored guardrails only. A guardrail extracted from a policy document is refused, and so is a retired one. |
| `intutic_workspace_settings` | Workspace id, `ws_…` | Must be the API key's workspace. Imports with no keys managed: the first plan shows each key in your configuration as a change. |
| `intutic_workspace_budget` | Workspace id, `ws_…` | One per workspace. |
| `intutic_virtual_key` | Key id, `key_…` | Only keys of the member who owns the provider's key. `key` is null after import, since the API never returns a key again. |
| `intutic_member_budget` | Member id, `mbr_…`, or `default` | Only a member, or the default, that has a budget. |
| `intutic_gateway` | Gateway id, `gw_…` | `token` is null after import. |
| `intutic_notification_rule` | Rule id, `nr_…` | A webhook rule's `signing_secret` is null after import; a PagerDuty routing key reads back masked, so set the real one in the configuration. |
| `intutic_mcp_server_decision` | Server name, as the MCP proxy reports it | The name, not the `mcpsrv_…` id. |
| `intutic_siem_destination` | Destination id, `siemdest_…` | `secret_config` reads back masked, so set the real values; `signing_secret` is null after import. |
| `intutic_wasm_rule` | Rule id, `wasm_…` | If the file in `source` has different bytes from the uploaded rule, the next plan replaces the rule. |
| `intutic_provider_credential` | Provider id, for example `anthropic` or `bedrock` | The API never returns the credential, so the first apply after the import sends `fields` again. |

The workspace id is the `id` of the `intutic_workspace` data source, and member ids are listed by the `intutic_members` data source. Other ids come from the API's list routes, for example the SOPs:

```shell
curl -s -H "Authorization: Bearer $INTUTIC_API_KEY" https://api.intutic.ai/api/v1/sops
```

An ID that matches nothing fails with `Cannot import non-existent remote object`.

## Import with `import` blocks

`import` blocks (Terraform 1.5 and later) make the import part of a reviewed plan. Write the resource as it should be, and an `import` block naming its ID:

```terraform
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

  # Written after the settings, never at the same time (see the GitOps guide).
  depends_on = [intutic_workspace_settings.this]
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
```

`production-deploys.md` holds the SOP's current Markdown, copied from the dashboard. An `import` block's `id` can be an expression known at plan time, so the workspace-wide resources take theirs from the data source.

```shell
terraform plan
```

The plan lists each resource as imported, and shows an in-place update wherever the configuration differs from the workspace. Adjust the configuration until the plan shows only the changes you intend, then apply:

```shell
terraform apply
```

Remove the `import` blocks after the apply, or leave them: an import block for a resource already in state does nothing.

To have Terraform write the configuration for you, leave the `resource` blocks out and run:

```shell
terraform plan -generate-config-out=generated.tf
```

Review `generated.tf` before moving it into your configuration. Values the API never returns, such as a provider credential's `fields`, a SIEM destination's `secret_config` or a PagerDuty routing key, cannot appear in it; add them yourself.

## Import with `terraform import`

On an older Terraform, or for a one-off, import one resource at a time into an existing configuration:

```shell
terraform import intutic_sop.deploys sp_V1StGXR8_Z5jdHi6B-myT
terraform import intutic_workspace_settings.this ws_V1StGXR8_Z5jdHi6B-myT
terraform import intutic_mcp_server_decision.github github
terraform import intutic_member_budget.default default
```

Each resource's reference page has its import command under **Import**.

## After the import

Run `terraform plan` until it reports no changes, adjusting the configuration rather than applying differences you did not mean. From then on, a change made in the dashboard to a managed attribute shows up in the next plan. The [policy-as-code guide](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/gitops-workflow) covers running plans from CI, and what a plan shows when a SOP or guardrail was edited outside Terraform.
