resource "intutic_gateway" "edge" {
  name              = "eu-edge"
  deployment_target = "kubernetes"
  require_vk        = true
}

# Store the token where the gateway reads INTUTIC_GATEWAY_TOKEN, for example
# a Kubernetes secret.
resource "kubernetes_secret" "gateway_token" {
  metadata {
    name = "intutic-gateway"
  }
  data = {
    INTUTIC_GATEWAY_TOKEN = intutic_gateway.edge.token
  }
}
