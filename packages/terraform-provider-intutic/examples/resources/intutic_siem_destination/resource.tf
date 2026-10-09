# A signed webhook that receives incidents and every gate decision, with a
# signing secret replaced every 90 days.
resource "time_rotating" "siem_webhook" {
  rotation_days = 90
}

resource "intutic_siem_destination" "webhook" {
  name          = "SOC webhook"
  adapter_type  = "webhook_https"
  config        = jsonencode({ webhookUrl = "https://siem.example.com/intutic" })
  secret_config = { authHeaderValue = "Bearer ${var.soc_webhook_token}" }
  source_tables = ["governance_incidents", "gate_decisions"]

  secret_rotation_triggers = {
    rotated = time_rotating.siem_webhook.id
  }
}

# Splunk HTTP Event Collector, default sources.
resource "intutic_siem_destination" "splunk" {
  name          = "Splunk"
  adapter_type  = "splunk_hec"
  config        = jsonencode({ hecUrl = "https://splunk.example.com:8088/services/collector", sourcetype = "intutic" })
  secret_config = { token = var.splunk_hec_token }
}

# The receiver verifies each delivery with this secret.
output "siem_webhook_signing_secret" {
  value     = intutic_siem_destination.webhook.signing_secret
  sensitive = true
}

variable "soc_webhook_token" {
  type      = string
  sensitive = true
}

variable "splunk_hec_token" {
  type      = string
  sensitive = true
}
