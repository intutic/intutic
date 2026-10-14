---
page_title: "Getting started"
subcategory: ""
description: |-
  Install the Intutic provider, authenticate with a workspace API key, and create a first resource.
---

# Getting started

This guide installs the Intutic provider, points it at a workspace, and creates a first resource with `terraform plan` and `terraform apply`.

You need Terraform 1.0 or later, and an Intutic workspace in which you are an OWNER or ADMIN.

## Install the provider

Declare the provider in a `versions.tf`:

```terraform
terraform {
  required_providers {
    intutic = {
      source  = "intutic/intutic"
      version = "~> 0.2"
    }
  }
}
```

`terraform init` downloads it from the Registry and checks its signature. Commit the `.terraform.lock.hcl` it writes, so every run uses the same build.

Before 1.0, a minor release can change behaviour you rely on: 0.2.0 did. `~> 0.2` takes every later 0.x release, so read the [changelog](https://github.com/intutic/intutic/blob/main/packages/terraform-provider-intutic/CHANGELOG.md) before `terraform init -upgrade` moves the lock file to a new release.

## Authenticate

The provider authenticates with a workspace API key (`vk_…`):

1. In the dashboard, open **Settings › Security › Virtual API Keys** and create a key.
2. Tick **This key is for automation (CI, scripts, a service)**. An automation key keeps working without anyone signing in through SSO; it still stops working when its member is deactivated.
3. Copy the key; it is shown once.

Give it to the provider through the environment, not the configuration:

```shell
export INTUTIC_API_KEY="vk_..."
```

| Argument   | Environment variable        | Default                  |
|------------|-----------------------------|--------------------------|
| `api_key`  | `INTUTIC_API_KEY`           | none: the provider fails without a key |
| `endpoint` | `INTUTIC_CONTROL_PLANE_URL` | `https://api.intutic.ai` |

An argument in the `provider "intutic"` block wins over its environment variable. Set the endpoint only for a self-hosted control plane.

The provider acts as the member who owns the key, in that member's workspace: there is no workspace argument, because the key decides it. Creating and changing most resources needs the OWNER or ADMIN role. The [authentication guide](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/authentication) covers roles, CI and key rotation.

## Write a first configuration

```terraform
# The API key comes from INTUTIC_API_KEY. Intutic Cloud is the default
# endpoint; a self-hosted control plane is set with INTUTIC_CONTROL_PLANE_URL.
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
```

The `intutic_workspace` data source reads the workspace, plan and member behind the key, so the first plan shows which workspace you are about to change. The SOP is the first resource: a new SOP starts in `DRAFT` and enforces nothing until it passes the SOP review, which makes it a safe thing to create first.

## Plan and apply

```shell
terraform init
terraform plan
```

The plan reads the data source and shows one resource to add, with `workspace_id` and `acting_role` already known. If `acting_role` is not `OWNER` or `ADMIN`, the apply will be refused; use another member's key.

```shell
terraform apply
```

After the apply, `sop_lifecycle_state` is `DRAFT`, and the SOP is listed in the dashboard. Run `terraform plan` again: it reports no changes, because the workspace now matches the configuration.

Change the SOP's `markdown_content` and plan again to see an update. A draft is edited in place. Once a SOP has left `DRAFT`, an edit creates a new draft version with a new id and retires the old one, as an edit in the dashboard does, and the plan shows the `id` as known after apply.

`terraform destroy` deletes the SOP. The API keeps its version history.

## Next steps

- [Authentication and key scoping](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/authentication): least-privilege roles, keys in CI, rotation.
- [Importing existing resources](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/importing-resources): bring what you built in the dashboard under Terraform.
- [Policy as code](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/gitops-workflow): plan on pull request, apply on merge, detect drift.
- [Manage Intutic with Terraform](https://docs.intutic.ai/guide/terraform) on docs.intutic.ai: what each resource manages and how it behaves on update and destroy.
