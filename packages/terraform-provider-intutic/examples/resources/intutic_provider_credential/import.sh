# Import by provider id. The API never returns the stored credential, so the
# first apply after an import sends the configured fields again.
terraform import intutic_provider_credential.bedrock bedrock
