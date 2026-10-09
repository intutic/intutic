package provider

import (
	"context"
	"os"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

var protoV6Factories = map[string]func() (tfprotov6.ProviderServer, error){
	"intutic": providerserver.NewProtocol6WithError(New("test")()),
}

func TestProviderSchemasAreValid(t *testing.T) {
	server, err := protoV6Factories["intutic"]()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := server.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range resp.Diagnostics {
		t.Errorf("%s: %s", d.Summary, d.Detail)
	}
	for _, name := range []string{
		"intutic_sop", "intutic_policy", "intutic_workspace_settings", "intutic_virtual_key",
		"intutic_gateway", "intutic_notification_rule", "intutic_mcp_server_decision",
	} {
		if _, ok := resp.ResourceSchemas[name]; !ok {
			t.Errorf("missing resource %s", name)
		}
	}
	for _, name := range []string{"intutic_workspace", "intutic_members"} {
		if _, ok := resp.DataSourceSchemas[name]; !ok {
			t.Errorf("missing data source %s", name)
		}
	}
}

// Validation runs before the provider talks to anything, so these need only
// the terraform binary, not a control plane.
const offlineProvider = `
provider "intutic" {
  endpoint = "http://127.0.0.1:9"
  api_key  = "vk_offline"
}
`

func TestPlanTimeValidationMirrorsTheAPI(t *testing.T) {
	cases := []struct {
		name   string
		config string
		err    string
	}{
		{"unknown settings key (the PUT schema is strict)", `
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({ pcas_strict_mode = true })
}`, `"pcas_strict_mode" is not a workspace setting`},
		{"unknown feature flag (silently dropped by the API)", `
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({ featureFlags = { ff_nope = true } })
}`, `featureFlags.ff_nope`},
		{"settings must be an object", `
resource "intutic_workspace_settings" "this" {
  settings = jsonencode(["egressMode"])
}`, `Not a JSON object`},
		{"slack rule without a channel", `
resource "intutic_notification_rule" "r" {
  event_type = "incident.created"
  channel    = "slack"
}`, `slack_channel_id or slack_channel_name`},
		{"pagerduty rule without a routing key", `
resource "intutic_notification_rule" "r" {
  event_type = "incident.created"
  channel    = "pagerduty"
}`, `pagerduty_routing_key`},
		{"cooldown out of range", `
resource "intutic_notification_rule" "r" {
  event_type       = "incident.created"
  channel          = "email"
  email_recipients = ["a@example.com"]
  cooldown_minutes = 0
}`, `between 1 and 1440`},
		{"shell metacharacters in a tool pattern", `
resource "intutic_policy" "p" {
  name                = "x"
  target_tool_pattern = "Bash; rm"
  enforcement_action  = "KILL"
}`, `tool name or glob`},
		{"creatable actions exclude OBSERVED", `
resource "intutic_policy" "p" {
  name                = "x"
  target_tool_pattern = "Bash"
  enforcement_action  = "OBSERVED"
}`, `value must be one of`},
		{"untrimmed policy name", `
resource "intutic_policy" "p" {
  name                = " padded "
  target_tool_pattern = "Bash"
  enforcement_action  = "KILL"
}`, `whitespace`},
		{"managed cells are not user-registrable", `
resource "intutic_gateway" "g" {
  name              = "edge"
  deployment_target = "managed_cell"
}`, `value must be one of`},
		{"key expiry over a year", `
resource "intutic_virtual_key" "k" {
  label           = "ci"
  expires_in_days = 400
}`, `between 1 and 365`},
		{"empty SOP title", `
resource "intutic_sop" "s" {
  title            = ""
  markdown_content = "x"
  risk_tier        = "LOW"
  complexity_tier  = "TIER_0"
}`, `length must be between 1 and 256`},
		{"unknown MCP status", `
resource "intutic_mcp_server_decision" "m" {
  server_name = "github"
  status      = "allowed"
}`, `value must be one of`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: protoV6Factories,
				Steps: []resource.TestStep{{
					Config:      offlineProvider + tc.config,
					PlanOnly:    true,
					ExpectError: regexp.MustCompile(regexp.QuoteMeta(tc.err)),
				}},
			})
		})
	}
}

func TestMissingAPIKeyIsExplained(t *testing.T) {
	t.Setenv("INTUTIC_API_KEY", "")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{{
			Config:      `data "intutic_workspace" "this" {}`,
			ExpectError: regexp.MustCompile(`Missing API key`),
		}},
	})
}

func testAccPreCheck(t *testing.T) {
	for _, v := range []string{"INTUTIC_CONTROL_PLANE_URL", "INTUTIC_API_KEY"} {
		if os.Getenv(v) == "" {
			t.Fatalf("%s must be set for acceptance tests; see services/control-plane/scripts/terraform-acceptance-server.ts", v)
		}
	}
}
