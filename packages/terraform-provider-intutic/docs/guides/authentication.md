---
page_title: "Authentication and key scoping"
subcategory: ""
description: |-
  Which keys the Intutic provider accepts, the least role each job needs, keys in CI, and rotating keys.
---

# Authentication and key scoping

The provider calls the control plane's REST API with a workspace API key, sent as `Authorization: Bearer <key>`. This guide covers which keys work, what role the key's member needs, how to supply the key in CI without putting it in configuration, and how to rotate keys.

## Which keys the provider accepts

A workspace API key, which starts with `vk_`. Create one in the dashboard under **Settings › Security › Virtual API Keys**, or with the [`intutic_virtual_key`](https://registry.terraform.io/providers/intutic/intutic/latest/docs/resources/virtual_key) resource. Other credentials, such as a self-hosted gateway's `gwk_…` token, are refused.

The key decides everything else:

- **The workspace.** Every route resolves the workspace from the key, so the provider has no workspace argument, and one provider configuration manages one workspace. To manage a second one, add a provider alias with that workspace's key, as below.
- **The member.** The provider acts as the member who owns the key, with that member's role. What the key may change is decided by the role alone: a key's `scopes` do not narrow what it may do through the API.

A key stops working when it is revoked, when it expires, or when its member is deactivated. Create the key Terraform uses as a member whose account outlives any one person's role, so that offboarding someone does not stop your pipeline.

### Mark it as an automation key

Tick **This key is for automation (CI, scripts, a service)** when you create the key (`is_service_account = true` on `intutic_virtual_key`). In a workspace with SSO, a key is refused once its member has not signed in through SSO within the recency window, 30 days unless the workspace changed it. A pipeline never signs in, so its key must be exempt; an automation key is exempt from that window only, and is still refused once its member is deactivated. See [automation keys](https://docs.intutic.ai/guide/security#automation-keys).

## The least role each job needs

| Job | Role | Why |
|-----|------|-----|
| `terraform apply` and `terraform destroy` | OWNER or ADMIN | The API refuses the provider's writes from any other role, with one exception: any member may create a virtual key without budgets or rate limits, and revoke their own. |
| `terraform plan` and `terraform import` of a configuration with `intutic_policy`, `intutic_guardrail` or `intutic_member_budget` | EM, ADMIN or OWNER | Reading policies and guardrails, and the guardrail check a plan runs, need EM or above; below EM, the API shows a member only their own budget. |
| `terraform plan` and `terraform import` of any other configuration, and the data sources | Any role | The other reads are open to every member. |

Two things narrow this:

- **Virtual keys are per member.** `intutic_virtual_key` creates keys for the member who owns the provider's key, and the API shows a member only their own keys. A plan run with another member's key sees none of them and proposes to create them all again. If the configuration manages virtual keys, plan and apply with keys of the same member.
- **Some resources depend on the workspace's Intutic plan.** Member budgets, SIEM destinations, custom filters and self-hosted gateways are refused on a plan without them, whatever the role; the reference page of each names the plans.

A key whose role is too low gets `HTTP 403: Forbidden` from the API, for example:

```text
Error: Reading guardrail failed

GET /api/v1/policy-guardrails/guardrails/pgr_…: HTTP 403: Forbidden
```

The configuration below reports the role at every plan, and warns before an apply that would be refused.

## Supply the key from the environment

```terraform
terraform {
  required_providers {
    intutic = {
      source  = "intutic/intutic"
      version = "~> 0.2"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.14"
    }
  }
}

# No api_key here: the provider reads INTUTIC_API_KEY from the environment, so
# the key never appears in configuration, plan files or version control.
provider "intutic" {
  # Null falls back to INTUTIC_CONTROL_PLANE_URL, then to Intutic Cloud.
  endpoint = var.intutic_endpoint
}

variable "intutic_endpoint" {
  type        = string
  default     = null
  description = "Control-plane URL of a self-hosted deployment. Leave null for Intutic Cloud."
}

# A key belongs to one workspace. To manage a second workspace from the same
# configuration, give it its own provider with its own key, read from
# TF_VAR_staging_api_key so it stays out of the code.
variable "staging_api_key" {
  type      = string
  sensitive = true
}

provider "intutic" {
  alias   = "staging"
  api_key = var.staging_api_key
}

data "intutic_workspace" "staging" {
  provider = intutic.staging
}

# Every plan reports the role the key acts as, and warns when it cannot make
# the changes this configuration manages.
data "intutic_workspace" "this" {}

check "provider_key_role" {
  assert {
    condition     = contains(["OWNER", "ADMIN"], data.intutic_workspace.this.role)
    error_message = "The provider's key acts as ${data.intutic_workspace.this.email} (${data.intutic_workspace.this.role}); most resources need an OWNER or ADMIN member's key."
  }
}

# A key Terraform issues to another system, replaced every 60 days. The new key
# is created before the old one is revoked, so whatever reads the key is
# updated in the same apply.
resource "time_rotating" "pipeline_key" {
  rotation_days = 60
}

# When the rotation time passes, time_rotating is planned as a new resource,
# which does not trigger replace_triggered_by on its own; time_static turns
# that into a replacement that does.
resource "time_static" "pipeline_key" {
  rfc3339 = time_rotating.pipeline_key.rfc3339
}

resource "intutic_virtual_key" "pipeline" {
  label              = "Nightly evaluation pipeline"
  is_service_account = true
  expires_in_days    = 90

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [time_static.pipeline_key]
  }
}

# Pass the key on to the system that uses it, for example a CI secret resource,
# rather than printing it.
output "pipeline_key" {
  value     = intutic_virtual_key.pipeline.key
  sensitive = true
}
```

The provider block sets neither `api_key` nor a literal endpoint:

- The key comes from `INTUTIC_API_KEY`. In CI, store it as a secret and expose it to the Terraform step as that variable; GitHub Actions, for example, uses `env: INTUTIC_API_KEY: ${{ secrets.INTUTIC_API_KEY }}`. Terraform records neither the environment nor the key in state or in a saved plan file.
- A second workspace's key comes from a sensitive variable, set with `TF_VAR_staging_api_key`, never from a `.tfvars` file in the repository. Terraform does record variable values in a saved plan file (`terraform plan -out`), so treat such a file as a secret, or apply without one.
- `endpoint` is an ordinary variable. Null falls back to `INTUTIC_CONTROL_PLANE_URL`, then to `https://api.intutic.ai`.

State is the other place a secret can land. Keys, gateway tokens and webhook signing secrets the provider creates, and the provider credentials you configure, are stored in state as sensitive values. Keep state in a remote backend that encrypts it, and limit who can read it.

The provider retries a request the API answered with 429, 502, 503 or 504 up to three times, waiting as long as `Retry-After` says when that is 60 seconds or less, and 1, 2 and 4 seconds otherwise. Each request times out after 60 seconds.

## Rotate the provider's own key

Rotate the key Terraform authenticates with outside Terraform, since a configuration cannot safely replace the key it is running on:

1. As the same member, create a new automation key under **Settings › Security › Virtual API Keys**. Keeping the member keeps every virtual key Terraform manages visible to the new key.
2. Replace the CI secret with the new key.
3. Run `terraform plan`. It should report no changes, and the `intutic_workspace` data source should show the same member.
4. Revoke the old key in the dashboard.

A revoked or expired key makes every request fail with `HTTP 401: Unauthorized`.

## Rotate keys Terraform issues

For a key Terraform creates and hands to another system, let Terraform rotate it. In the configuration above, `time_rotating` comes due every 60 days, `time_static` turns that into a replacement, and `replace_triggered_by` replaces the key. `create_before_destroy` creates the new key before the old one is revoked, so whatever reads `intutic_virtual_key.pipeline.key` gets the new value in the same apply.

The rotation happens on the first apply after the date passes, so run applies at least as often as the gap between `rotation_days` and `expires_in_days`. If your Intutic plan limits the number of active keys, leave room for one more during the swap.

To rotate one key now, replace it explicitly:

```shell
terraform apply -replace=intutic_virtual_key.pipeline
```
