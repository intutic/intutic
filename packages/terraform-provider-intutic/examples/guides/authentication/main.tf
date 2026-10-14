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
