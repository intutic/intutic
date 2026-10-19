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
