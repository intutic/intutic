# AWS Bedrock with a Bedrock API key; requests name models as bedrock/<model id>.
resource "intutic_provider_credential" "bedrock" {
  provider_id = "bedrock"
  fields = {
    awsRegion = "us-east-1"
    apiKey    = var.bedrock_api_key
  }
}

# Google Vertex AI with a service-account key file; models are vertex/<model>.
resource "intutic_provider_credential" "vertex" {
  provider_id = "vertex_ai"
  fields = {
    projectId          = "acme-ml-prod"
    location           = "us-east5"
    serviceAccountJson = file("${path.module}/sa.json")
  }
}

# Azure OpenAI; requests name a deployment as azure/<deployment>.
resource "intutic_provider_credential" "azure" {
  provider_id = "azure_openai"
  fields = {
    endpoint = "https://acme.openai.azure.com"
    apiKey   = var.azure_openai_api_key
  }
}

variable "bedrock_api_key" {
  type      = string
  sensitive = true
}

variable "azure_openai_api_key" {
  type      = string
  sensitive = true
}
