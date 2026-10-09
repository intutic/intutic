resource "intutic_notification_rule" "incidents_to_slack" {
  event_type         = "incident.created"
  channel            = "slack"
  slack_channel_name = "#agent-incidents"
  filter_severity    = ["critical", "high"]
}

resource "intutic_notification_rule" "incidents_to_pagerduty" {
  event_type            = "incident.created"
  channel               = "pagerduty"
  pagerduty_routing_key = var.pagerduty_routing_key
  filter_severity       = ["critical"]
  cooldown_minutes      = 60
}

variable "pagerduty_routing_key" {
  type      = string
  sensitive = true
}

# A webhook rule whose signing secret is replaced every 30 days. The receiver
# reads the new secret from the output after each apply.
resource "time_rotating" "webhook" {
  rotation_days = 30
}

resource "intutic_notification_rule" "incidents_to_webhook" {
  event_type  = "incident.created"
  channel     = "webhook"
  webhook_url = "https://hooks.example.com/intutic"

  secret_rotation_triggers = {
    rotated = time_rotating.webhook.id
  }
}

output "incident_webhook_signing_secret" {
  value     = intutic_notification_rule.incidents_to_webhook.signing_secret
  sensitive = true
}
