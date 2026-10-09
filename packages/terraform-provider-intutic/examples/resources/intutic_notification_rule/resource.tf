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
