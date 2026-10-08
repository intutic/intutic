terraform {
  required_providers {
    intutic = {
      source = "intutic/intutic"
    }
  }
}

# Reads INTUTIC_API_KEY (and INTUTIC_CONTROL_PLANE_URL for a self-hosted
# control plane) from the environment when the arguments are omitted.
provider "intutic" {
  # endpoint = "https://intutic.example.internal"
}
