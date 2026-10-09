---
title: Manage Intutic with Terraform
description: Manage SOPs, enforcement policies, workspace settings, virtual keys, gateways, notification rules and MCP server decisions with the Intutic Terraform provider.
---

# Manage Intutic with Terraform <Badge type="tip" text="Cloud" />

The Intutic Terraform provider manages a workspace's governance configuration as code: review it in a pull request, apply it from CI, and see drift when someone changes it in the dashboard. It talks to the control plane's REST API, so it works the same against Intutic Cloud and a self-hosted control plane.

| Resource | Manages | API |
|---|---|---|
| [`intutic_sop`](/reference/terraform/resources/sop) | SOPs (rule sets) | `/api/v1/sops` |
| [`intutic_policy`](/reference/terraform/resources/policy) | Enforcement policies: what the proxy does when an agent calls a matching tool | `/api/v1/policies` |
| [`intutic_workspace_settings`](/reference/terraform/resources/workspace_settings) | Workspace settings, only the keys you set | `/api/v1/workspace/settings` |
| [`intutic_virtual_key`](/reference/terraform/resources/virtual_key) | Virtual API keys (`vk_…`) | `/api/v1/keys` |
| [`intutic_gateway`](/reference/terraform/resources/gateway) | Self-hosted gateway registrations and their live config | `/api/v1/gateways` |
| [`intutic_notification_rule`](/reference/terraform/resources/notification_rule) | Slack, email, webhook and PagerDuty notification rules | `/api/v1/notifications/rules` |
| [`intutic_mcp_server_decision`](/reference/terraform/resources/mcp_server_decision) | Approve or block an MCP server, and switch its tools off | `/api/v1/mcp/servers` |

Two data sources read the [workspace](/reference/terraform/data-sources/workspace) the key belongs to and its [members](/reference/terraform/data-sources/members). Every resource supports `terraform import`.

## Install

The provider's source is in the open-core repository, under `packages/terraform-provider-intutic`. Until it is published to the Terraform Registry, build it and point Terraform at the binary:

```sh
git clone https://github.com/intutic/intutic.git
cd intutic/packages/terraform-provider-intutic
go build -o "$HOME/.terraform.d/intutic-provider/terraform-provider-intutic" .
```

```hcl
# ~/.terraformrc
provider_installation {
  dev_overrides {
    "intutic/intutic" = "/Users/you/.terraform.d/intutic-provider"
  }
  direct {}
}
```

With a development override in place, skip `terraform init` for this provider and run `terraform plan` directly. Once the provider is on the Registry, remove the override and declare it as usual:

```hcl
terraform {
  required_providers {
    intutic = {
      source = "intutic/intutic"
    }
  }
}
```

## Authenticate

The provider uses a workspace API key. Create one under **Settings › Security › Virtual API Keys** and tick **This key is for automation (CI, scripts, a service)**: an automation key is exempt from the [SSO-recency window](/guide/security#automation-keys), so a pipeline keeps working without anyone signing in, and it still stops working the moment its owner is deactivated.

The provider acts as the key's member. Most resources need an OWNER or ADMIN role; reading the workspace and its members works for any role.

```sh
export INTUTIC_API_KEY=vk_...
# A self-hosted control plane:
export INTUTIC_CONTROL_PLANE_URL=https://intutic.example.internal
```

Both can also be set in the `provider "intutic"` block (`api_key`, `endpoint`).

## Example

```hcl
provider "intutic" {}

resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    egressMode       = "enforce"
    egressAllow      = ["api.github.com", "registry.npmjs.org"]
    mcpDefaultPolicy = "deny"
    featureFlags     = { ff_shadow_enforcement = true }
  })
}

resource "intutic_policy" "no_force_push" {
  name                = "No force push"
  target_tool_pattern = "Bash"
  enforcement_action  = "KILL"
  risk_category       = "DESTRUCTIVE"
  conditions          = jsonencode({ argContains = ["push --force"] })
}

resource "intutic_sop" "deploys" {
  title            = "Production deploys"
  markdown_content = file("${path.module}/sops/production-deploys.md")
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_1"
}

resource "intutic_mcp_server_decision" "github" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repository"]
}

resource "intutic_notification_rule" "incidents" {
  event_type         = "incident.created"
  channel            = "slack"
  slack_channel_name = "#agent-incidents"
  filter_severity    = ["critical", "high"]
}
```

## How the provider behaves

**Plans fail where the API would.** Each resource's schema carries the route's own validation: enum values, lengths, the tool-pattern character set, the channel each notification rule needs. A setting the API does not know fails the plan instead of the apply.

**Workspace settings: only the keys you set.** `intutic_workspace_settings` sends and compares only the top-level keys in its `settings`, each one whole, because the API replaces a top-level value whole. `featureFlags` is the exception and is managed flag by flag. A key you do not set is never sent, so settings changed in the dashboard or by another tool stay as they are. Removing a key from the configuration stops managing it; destroying the resource changes nothing in the workspace.

**SOP lifecycle stays in review.** A new SOP starts as a draft. Moving it through review and shadow to validated is gated on evidence, so it stays in the [SOP workflow](/guide/sops). Editing a SOP that is no longer a draft creates a new draft version with a new id, exactly as an edit in the dashboard does; the plan shows `lifecycle_state` going back to `DRAFT` before you apply.

**MCP review holds are respected.** When a high-risk change to a server's tool set returns it to review, Terraform does not approve it again over the hold: the apply stops and names the change. Review it in the MCP registry and approve it there, and the next plan is clean. Blocking a held server works. An MCP server must have been reported by a proxy before it can be decided on; to allow one in advance, list it in the `mcpAllowedServers` setting.

**Secrets.** A virtual key, a gateway token and a webhook signing secret are returned once, when created, and kept in state as sensitive values for you to pass on, for example into a CI secret or a Kubernetes secret. Keep the state in an encrypted backend. An imported key, token or secret is null, since the API cannot return it again.

**Destroy.** Destroying a SOP or a policy soft-deletes it, keeping its version history. Destroying a virtual key or a gateway revokes it. Destroying an MCP server decision returns the server to the approval queue and switches its tools back on.

## Limits

- Policy guardrails extracted from your policy documents are not a resource: they move between proposed, shadow and enforcing on evidence, through the [guardrail review](/guide/policy-guardrails).
- Org-wide SOPs, members and roles, SSO and SCIM are managed in the dashboard.
- A virtual key belongs to the member whose key runs Terraform, and Terraform sees only that member's keys.
