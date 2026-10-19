---
page_title: "Policy as code: a GitOps workflow"
subcategory: ""
description: |-
  Keep SOPs, guardrails and workspace settings in a repository, plan them on every pull request, apply them on merge, and detect drift on a schedule.
---

# Policy as code: a GitOps workflow

This guide keeps a workspace's governance in a repository: SOPs as Markdown files, guardrails and settings as Terraform. A pull request shows the plan, a merge applies it, and a scheduled plan reports anything changed outside Terraform.

## Lay out the repository

```text
intutic/
  versions.tf      provider and backend
  main.tf          SOPs, guardrails, settings, budgets, MCP decisions
  backend.hcl      backend settings, passed to terraform init
  sops/
    production-deploys.md
    secrets-handling.md
```

```terraform
terraform {
  required_providers {
    intutic = {
      source  = "intutic/intutic"
      version = "~> 0.7"
    }
  }

  # State holds the keys, tokens and signing secrets the provider creates, so
  # keep it in a remote backend that encrypts it. The bucket and its settings
  # are passed at init time: terraform init -backend-config=backend.hcl
  backend "s3" {}
}
```

State holds the virtual keys, gateway tokens and webhook signing secrets the provider creates, so use a backend that encrypts state and restricts who can read it. Any backend works; `s3` is only an example.

```terraform
# INTUTIC_API_KEY comes from the CI secret store; nothing secret is in this
# repository.
provider "intutic" {}

# One Markdown file per SOP under sops/, reviewed in pull requests like code.
locals {
  sops = {
    production-deploys = { title = "Production deploys", risk_tier = "HIGH", complexity_tier = "TIER_1" }
    secrets-handling   = { title = "Secrets handling", risk_tier = "CRITICAL", complexity_tier = "TIER_0" }
  }
}

resource "intutic_sop" "this" {
  for_each = local.sops

  title            = each.value.title
  markdown_content = file("${path.module}/sops/${each.key}.md")
  risk_tier        = each.value.risk_tier
  complexity_tier  = each.value.complexity_tier
}

# Guardrails written as code. Each starts PROPOSED; approving it for shadow and
# promoting it to enforcing stay review decisions, made in the dashboard or
# with `intutic guardrails`.
resource "intutic_guardrail" "reviewed_apply" {
  name         = "Reviewed terraform apply"
  description  = "Production applies need a reviewed plan."
  kind         = "hook_rule"
  title        = "Reviewed plan before terraform apply"
  tools        = ["Bash"]
  arg_contains = ["terraform apply"]
}

resource "intutic_guardrail" "no_web_fetch_for_contractors" {
  name  = "No web fetch for contractors"
  kind  = "deny_tools"
  tools = ["WebFetch"]
  roles = ["contractor"]
}

# Only the keys named here are managed; settings changed in the dashboard
# under other keys are left alone.
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    mcpDefaultPolicy = "deny"
    egressMode       = "enforce"
    egressAllow      = ["api.github.com", "registry.npmjs.org"]
  })
}

resource "intutic_workspace_budget" "this" {
  daily_budget_usd   = 150
  monthly_budget_usd = 3000
}

# An MCP server a proxy has already reported, approved without one tool.
resource "intutic_mcp_server_decision" "github" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repository"]
}
```

Each SOP is a Markdown file reviewed like any other change; adding one is a new file and a line in `local.sops`.

## What Terraform manages, and what review decides

Terraform manages the content: a SOP's text and tiers, a guardrail's rule, the settings keys you name. Moving a SOP or a guardrail towards enforcement is a review decision made in the dashboard (or, for guardrails, with `intutic guardrails`), because each step waits on evidence. Terraform never makes those decisions, and they do not show up as drift: a guardrail approved for shadow still plans clean.

A merged change interacts with that lifecycle:

- **SOPs.** A new SOP starts in `DRAFT`. Editing a draft changes it in place. Editing a SOP that has left `DRAFT` creates a new `DRAFT` version with a new id, which the plan shows as an `id` known after apply; the approved version keeps enforcing until the new one is reviewed and promoted to `VALIDATED`, which retires it.
- **Guardrails.** A new guardrail starts `PROPOSED`. Changing `name` or `description` edits it in place and keeps its evidence. Changing the rule itself creates the next version under a new id, `PROPOSED` with no evidence, and retires the current one; the plan shows the new `version` and `status`. The plan also asks the API to validate the rule, so a guardrail the API would refuse fails the pull request's plan, not the apply.
- **Settings.** Only the keys in `settings` are managed. A key changed in the dashboard that the configuration does not name is left alone.


## Run it from CI

```yaml
# .github/workflows/intutic.yml: plan on pull requests, apply on merge to main,
# and look for drift every morning. The configuration lives in intutic/.
name: intutic

on:
  pull_request:
    paths: ["intutic/**"]
  push:
    branches: [main]
    paths: ["intutic/**"]
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:

permissions:
  contents: read

# One run at a time, so an apply never races a plan for the state lock.
concurrency:
  group: intutic
  cancel-in-progress: false

defaults:
  run:
    working-directory: intutic

env:
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "false"
  # The provider has no default endpoint: the control plane's base URL, from a
  # repository variable.
  INTUTIC_CONTROL_PLANE_URL: ${{ vars.INTUTIC_CONTROL_PLANE_URL }}

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    env:
      INTUTIC_API_KEY: ${{ secrets.INTUTIC_PLAN_API_KEY }}
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - run: terraform fmt -check -recursive
      - run: terraform init -backend-config=backend.hcl
      - run: terraform validate
      - run: terraform plan

  apply:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    # Protect this environment (required reviewers, main only) and keep the
    # apply key in its secrets, out of reach of pull-request jobs.
    environment: intutic
    env:
      INTUTIC_API_KEY: ${{ secrets.INTUTIC_API_KEY }}
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - run: terraform init -backend-config=backend.hcl
      - run: terraform plan -out=tfplan
      - run: terraform apply tfplan

  drift:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    env:
      INTUTIC_API_KEY: ${{ secrets.INTUTIC_PLAN_API_KEY }}
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - run: terraform init -backend-config=backend.hcl
      # Exit code 2 means the workspace no longer matches main: the job fails
      # and the plan in its log shows what changed.
      - run: terraform plan -detailed-exitcode
```

Three jobs:

- **plan**, on every pull request that touches `intutic/`: format check, `validate`, and a `plan` whose output reviewers read next to the diff.
- **apply**, on merge to `main`: plans again against the current state and applies that plan.
- **drift**, every morning and on demand: `terraform plan -detailed-exitcode` exits 0 when the workspace matches `main`, 1 on an error, and 2 when it does not match, which fails the job.

Anyone who can push a branch can change the workflow its pull request runs, so the key a pull request can reach should not be able to write. The workflow uses two keys:

- `INTUTIC_API_KEY`, an OWNER or ADMIN automation key, lives in the secrets of a protected `intutic` environment that only the apply job uses.
- `INTUTIC_PLAN_API_KEY`, a repository secret for the plan and drift jobs, can belong to a member with the EM role: a plan only reads, and EM can read everything this configuration manages. An EM sees the `intutic_virtual_key` resources in state too: the API lists every live key in the workspace to an OWNER, ADMIN or EM. Create the plan key with read scopes only (for this configuration `sops:read`, `policies:read`, `settings:read`, `billing:read` and `inventory:read`, plus `keys:read` for virtual keys), so the API refuses its writes whatever its role.

Every job also reads the control plane's base URL from the repository variable `INTUTIC_CONTROL_PLANE_URL`: the provider has no default endpoint.

Each job also needs whatever credentials your backend reads, which the example leaves out. GitHub does not pass secrets to workflows run from forks, so a pull request from a fork gets a failed plan rather than a key. The [authentication guide](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/authentication) explains the roles.

## Respond to drift

A drift run's plan names what changed. For example, after someone sets `mcpDefaultPolicy` to `allow` in the dashboard:

```text
  # intutic_workspace_settings.this will be updated in-place
  ~ resource "intutic_workspace_settings" "this" {
      ~ settings = jsonencode(
          ~ {
              ~ mcpDefaultPolicy = "allow" -> "deny"
                # (2 unchanged attributes hidden)
            }
        )
    }
```

Then either:

- **Revert it:** run the apply job (or merge any change), and Terraform writes the configured value back.
- **Keep it:** change the configuration to match in a pull request, and the next plan is clean.

A SOP or guardrail edited in the dashboard is different. If the edit replaced it with a new version, the version in state is retired (a SOP's once the new version is promoted to `VALIDATED`), and the plan proposes to create it again, which would leave two. To keep the dashboard's version instead, remove the old one from state and import the new one:

```shell
terraform state rm 'intutic_sop.this["production-deploys"]'
terraform import 'intutic_sop.this["production-deploys"]' sp_V1StGXR8_Z5jdHi6B-myT
```

Then copy its Markdown into `sops/production-deploys.md` so the next plan is clean. The [import guide](https://registry.terraform.io/providers/intutic/intutic/latest/docs/guides/importing-resources) lists every resource's import ID.
