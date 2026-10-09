---
title: Manage Intutic with Terraform
description: Manage SOPs, enforcement policies, policy guardrails, workspace settings, virtual keys, gateways, notification rules, SIEM export destinations, custom filters and MCP server decisions with the Intutic Terraform provider.
---

# Manage Intutic with Terraform <Badge type="tip" text="Cloud" />

The Intutic Terraform provider manages a workspace's governance configuration as code: review it in a pull request, apply it from CI, and see drift when someone changes it in the dashboard. It talks to the control plane's REST API, so it works the same against Intutic Cloud and a self-hosted control plane.

| Resource | Manages | API |
|---|---|---|
| [`intutic_sop`](/reference/terraform/resources/sop) | SOPs (rule sets) | `/api/v1/sops` |
| [`intutic_policy`](/reference/terraform/resources/policy) | Enforcement policies: what the proxy does when an agent calls a matching tool | `/api/v1/policies` |
| [`intutic_guardrail`](/reference/terraform/resources/guardrail) | Policy guardrails you author: a rule in the Guardrail IR, held to the same checks as one extracted from a policy document | `/api/v1/policy-guardrails/guardrails` |
| [`intutic_workspace_settings`](/reference/terraform/resources/workspace_settings) | Workspace settings, only the keys you set | `/api/v1/workspace/settings` |
| [`intutic_virtual_key`](/reference/terraform/resources/virtual_key) | Virtual API keys (`vk_…`), with their spend budgets and rate limits | `/api/v1/keys` |
| [`intutic_workspace_budget`](/reference/terraform/resources/workspace_budget) | The workspace's daily and monthly spend caps, and whether each refuses requests | `/api/v1/budget` |
| [`intutic_member_budget`](/reference/terraform/resources/member_budget) | A member's spend budgets, or the default member budget (Biz Org and above) | `/api/v1/budget/members` |
| [`intutic_gateway`](/reference/terraform/resources/gateway) | Self-hosted gateway registrations and their live config | `/api/v1/gateways` |
| [`intutic_notification_rule`](/reference/terraform/resources/notification_rule) | Slack, email, webhook and PagerDuty notification rules | `/api/v1/notifications/rules` |
| [`intutic_mcp_server_decision`](/reference/terraform/resources/mcp_server_decision) | Approve or block an MCP server, and switch its tools off | `/api/v1/mcp/servers` |
| [`intutic_siem_destination`](/reference/terraform/resources/siem_destination) | [SIEM export](/guide/siem-export) destinations: syslog, webhook, Splunk, Datadog, GCS and S3 (Biz Org and above) | `/api/v1/siem/destinations` |
| [`intutic_wasm_rule`](/reference/terraform/resources/wasm_rule) | [Custom filters](/guide/wasm-rules): native WASM rules and Rego policies, uploaded to the workspace (Biz Org and above) | `/api/v1/wasm-rules` |

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

resource "intutic_guardrail" "reviewed_apply" {
  name         = "Reviewed terraform apply"
  description  = "Production applies need a reviewed plan."
  kind         = "hook_rule"
  title        = "Reviewed plan before terraform apply"
  tools        = ["Bash"]
  arg_contains = ["terraform apply"]
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

**Guardrails: the rule is code, its lifecycle stays in review.** An `intutic_guardrail` starts `PROPOSED`, exactly as a guardrail extracted from a policy document does: it enforces and measures nothing until an owner or admin approves it for shadow, and promotion to enforcing waits on the same shadow evidence, through the [guardrail review](/guide/policy-guardrails#authoring-guardrails-directly) or `intutic guardrails promote`. Terraform never approves or promotes; `status` and the shadow counters are read-only attributes, so a promotion in the dashboard leaves the next plan empty. Changing `name` or `description` edits the guardrail in place and keeps its evidence. Changing the rule itself (any IR attribute) creates the next version with a new id, back in `PROPOSED` with no evidence, and retires the old one; the plan shows the new `version` and `status` before you apply. The plan also runs the API's validator, so a rule the API would refuse, such as one naming a tool no harness in the workspace has called, fails at plan time. Write a known harness tool in its canonical case (`WebFetch`, not `webfetch`): the API would store the canonical spelling, and the difference would never converge.

**MCP review holds are respected.** When a high-risk change to a server's tool set returns it to review, Terraform does not approve it again over the hold: the apply stops and names the change. Review it in the MCP registry and approve it there, and the next plan is clean. Blocking a held server works. An MCP server must have been reported by a proxy before it can be decided on; to allow one in advance, list it in the `mcpAllowedServers` setting.

**Secrets.** A virtual key, a gateway token and a webhook signing secret are returned once, when created, and kept in state as sensitive values for you to pass on, for example into a CI secret or a Kubernetes secret. Keep the state in an encrypted backend. An imported key, token or secret is null, since the API cannot return it again. Credentials you supply (a PagerDuty routing key, a SIEM destination's `secret_config`) read back masked; the plan compares them through the mask, so it stays empty until one is changed outside Terraform.

**Destroy.** Destroying a SOP or a policy soft-deletes it, keeping its version history. Destroying a guardrail retires it, undoing what it wrote if it was an enforcing allowed-models or egress guardrail, and keeps its history. Destroying a virtual key or a gateway revokes it. Destroying an MCP server decision returns the server to the approval queue and switches its tools back on. Destroying a SIEM destination deactivates it: the API keeps every destination, so it stays listed, switched off. Destroying a custom filter deletes it.

## Rotating a webhook signing secret

Webhook notification rules and `webhook_https` SIEM destinations sign every delivery with a secret the API generates; Terraform cannot set one. To replace it, give the resource `secret_rotation_triggers`, a map of any values: when a value changes, the next apply replaces the secret in place (the resource keeps its id) and stores the new one in `signing_secret`. Tie the map to a [`time_rotating`](https://registry.terraform.io/providers/hashicorp/time/latest/docs/resources/rotating) resource to rotate on a schedule:

```hcl
resource "time_rotating" "webhook" {
  rotation_days = 30
}

resource "intutic_notification_rule" "incidents_to_webhook" {
  event_type  = "incident.created"
  channel     = "webhook"
  webhook_url = "https://hooks.example.com/intutic"

  secret_rotation_triggers = {
    rotated = time_rotating.webhook.id
  }
}

output "incident_webhook_signing_secret" {
  value     = intutic_notification_rule.incidents_to_webhook.signing_secret
  sensitive = true
}
```

Deliveries switch to the new secret as soon as it is issued, so update the receiver in the same apply, for example by writing `signing_secret` into the secret store it reads. Creating a resource does not rotate: the create already issued a secret. A rule or destination that is not a webhook has no signing secret, and setting the triggers on one fails the plan.

## Uploading a custom filter

`intutic_wasm_rule` uploads a [custom filter](/guide/wasm-rules): a native rule built with the Rules SDK, or a Rego policy built with `intutic rules build --rego`. The plan reads the file and computes its SHA-256 as `bundle_sha256`. Set `sha256` to pin the build you reviewed; a file that does not match fails the plan.

```hcl
resource "intutic_wasm_rule" "no_prod_deploys" {
  name        = "Hold production deploys"
  description = "Holds kubectl and helm against the production context for review."
  source      = "${path.module}/rules/hold_prod_deploys.wasm"
  sha256      = "3f5a0c9e7b1d24e8a6c0f9b2d47e15a83c6b9d0e2f714a58c3e6b1d9a07f42c1"
}
```

The API cannot change an uploaded rule's bytes, so a rebuilt file replaces the rule, and so does a rule whose stored hash no longer matches the file. Name, description and `enabled` change in place. After each upload the provider checks that the API stored the hash of the bytes it sent, the hash the proxies verify the rule against, and fails the apply if it did not.

## Limits

- `intutic_guardrail` manages guardrails you author. A guardrail extracted from a policy document cannot be managed or imported: it changes when its document does, and you move it through the [guardrail review](/guide/policy-guardrails).
- Approving a guardrail for shadow and promoting it are review decisions, not Terraform actions.
- Org-wide SOPs, members and roles, SSO and SCIM are managed in the dashboard.
- A virtual key belongs to the member whose key runs Terraform, and Terraform sees only that member's keys.
