terraform {
  required_providers {
    intutic = {
      source = "intutic/intutic"
    }
  }
}

# Reads INTUTIC_API_KEY and INTUTIC_CONTROL_PLANE_URL (the control plane's
# base URL) from the environment when the arguments are omitted.
provider "intutic" {
  # endpoint = "https://intutic.example.internal"
}
