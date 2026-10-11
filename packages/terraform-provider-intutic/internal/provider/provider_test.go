package provider

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
		"intutic_sop", "intutic_policy", "intutic_guardrail", "intutic_workspace_settings", "intutic_virtual_key",
		"intutic_gateway", "intutic_notification_rule", "intutic_mcp_server_decision", "intutic_siem_destination",
		"intutic_wasm_rule", "intutic_provider_credential",
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
	dir := t.TempDir()
	rule := filepath.Join(dir, "rule.wasm")
	big := filepath.Join(dir, "big.wasm")
	if err := os.WriteFile(rule, testWasmModule("pin"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(big, append(testWasmModule("big"), make([]byte, wasmRuleMaxBytes)...), 0o600); err != nil {
		t.Fatal(err)
	}
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
		{"a budget enforcement the API does not know", `
resource "intutic_virtual_key" "k" {
  label                    = "x"
  daily_budget_usd         = 5
  daily_budget_enforcement = "warn"
}`, `value must be one of`},
		{"a zero budget", `
resource "intutic_member_budget" "m" {
  member_id        = "default"
  daily_budget_usd = 0
}`, `between`},
		{"a rate limit of zero", `
resource "intutic_virtual_key" "k" {
  label          = "x"
  rate_limit_rpm = 0
}`, `between 1 and 100000`},
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
		{"guardrail: a kind's required attribute", `
resource "intutic_guardrail" "g" {
  name = "x"
  kind = "hook_rule"
  tools = ["Bash"]
}`, `kind "hook_rule" requires title`},
		{"guardrail: an attribute the kind does not take", `
resource "intutic_guardrail" "g" {
  name   = "x"
  kind   = "deny_tools"
  tools  = ["WebFetch"]
  models = ["gpt-4o"]
}`, `kind "deny_tools" does not take models`},
		{"guardrail: none is not a kind you can author", `
resource "intutic_guardrail" "g" {
  name = "x"
  kind = "none"
}`, `value must be one of`},
		{"guardrail: a hook rule names at most 8 tools", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "hook_rule"
  title = "t"
  tools = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "WebFetch", "WebSearch"]
}`, `Takes 1 to 8 items; got 9`},
		{"guardrail: a shell command is not a tool", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "deny_tools"
  tools = ["terraform apply"]
}`, `is not a token`},
		{"guardrail: a known tool in its canonical case", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "deny_tools"
  tools = ["bash"]
}`, `write "bash" as "Bash"`},
		{"guardrail: a literal with a double quote", `
resource "intutic_guardrail" "g" {
  name         = "x"
  kind         = "hook_rule"
  title        = "t"
  tools        = ["Bash"]
  arg_contains = ["say \"hi\""]
}`, `double quote`},
		{"guardrail: an upper-case role", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "deny_tools"
  tools = ["WebFetch"]
  roles = ["Deployer"]
}`, `is not a role`},
		{"guardrail: a catch-all egress entry", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "egress_allow"
  hosts = ["0.0.0.0/0"]
}`, `is not an egress entry`},
		{"guardrail: an ordering rule on one token", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "requires_before"
  first = "action:run_tests"
  then  = "action:run_tests"
}`, `two different tokens`},
		{"guardrail: a count bound out of range", `
resource "intutic_guardrail" "g" {
  name  = "x"
  kind  = "max_calls"
  token = "Bash"
  limit = 0
}`, `between 1 and 1000`},
		{"guardrail: a name with surrounding whitespace", `
resource "intutic_guardrail" "g" {
  name  = " x "
  kind  = "deny_tools"
  tools = ["WebFetch"]
}`, `leading or trailing whitespace`},
		{"rotation triggers on a rule with no signing secret", `
resource "intutic_notification_rule" "r" {
  event_type               = "incident.created"
  channel                  = "email"
  email_recipients         = ["a@example.com"]
  secret_rotation_triggers = { rotated = "1" }
}`, `Only a webhook rule has a signing secret`},
		{"siem: an adapter's required setting", `
resource "intutic_siem_destination" "d" {
  name         = "x"
  adapter_type = "webhook_https"
  config       = jsonencode({ url = "https://hooks.example.com/siem" })
}`, `The webhook_https adapter needs webhookUrl in config`},
		{"siem: an adapter's required credential", `
resource "intutic_siem_destination" "d" {
  name         = "x"
  adapter_type = "splunk_hec"
  config       = jsonencode({ hecUrl = "https://splunk.example.com:8088" })
}`, `The splunk_hec adapter needs token in secret_config`},
		{"siem: a credential in the readable config", `
resource "intutic_siem_destination" "d" {
  name          = "x"
  adapter_type  = "datadog_logs"
  config        = jsonencode({ apiKey = "dd-key" })
  secret_config = { apiKey = "dd-key" }
}`, `apiKey is a credential the API masks`},
		{"siem: a credential the adapter does not take", `
resource "intutic_siem_destination" "d" {
  name          = "x"
  adapter_type  = "s3"
  config        = jsonencode({ bucketName = "b", accessKeyId = "AKIAEXAMPLE" })
  secret_config = { secretAccessKey = "s", token = "t" }
}`, `The s3 adapter has no credential token`},
		{"siem: the signing secret is the API's", `
resource "intutic_siem_destination" "d" {
  name         = "x"
  adapter_type = "webhook_https"
  config       = jsonencode({ webhookUrl = "https://hooks.example.com/siem", signingSecret = "mine" })
}`, `signingSecret is generated by the API`},
		{"siem: rotation triggers on an adapter with no signing secret", `
resource "intutic_siem_destination" "d" {
  name                     = "x"
  adapter_type             = "syslog_cef"
  config                   = jsonencode({ host = "siem.example.com", port = 6514 })
  secret_rotation_triggers = { rotated = "1" }
}`, `Only a webhook_https destination has a signing secret`},
		{"siem: unknown adapter", `
resource "intutic_siem_destination" "d" {
  name         = "x"
  adapter_type = "kafka"
  config       = jsonencode({})
}`, `value must be one of`},
		{"custom filter: the file does not match its pin", fmt.Sprintf(`
resource "intutic_wasm_rule" "w" {
  name   = "x"
  source = %q
  sha256 = "%s"
}`, rule, strings.Repeat("ab", 32)), `Rule file does not match its pin`},
		{"custom filter: over the upload limit", fmt.Sprintf(`
resource "intutic_wasm_rule" "w" {
  name   = "x"
  source = %q
}`, big), `at most 1 MB`},
		{"custom filter: a missing file", fmt.Sprintf(`
resource "intutic_wasm_rule" "w" {
  name   = "x"
  source = %q
}`, filepath.Join(dir, "missing.wasm")), `Cannot use the rule file`},
		{"custom filter: a pin that is not a SHA-256", fmt.Sprintf(`
resource "intutic_wasm_rule" "w" {
  name   = "x"
  source = %q
  sha256 = "abc"
}`, rule), `must be a SHA-256 in hex`},
		{"provider credential: unknown provider", `
resource "intutic_provider_credential" "c" {
  provider_id = "groq"
  fields      = { apiKey = "groq-key-0123" }
}`, `value must be one of`},
		{"provider credential: a required field", `
resource "intutic_provider_credential" "c" {
  provider_id = "azure_openai"
  fields      = { apiKey = "azure-key-0123" }
}`, `azure_openai needs endpoint in fields`},
		{"provider credential: neither Bedrock credential set", `
resource "intutic_provider_credential" "c" {
  provider_id = "bedrock"
  fields      = { awsRegion = "us-east-1", awsAccessKeyId = "access-key-id-0000" }
}`, `bedrock needs awsAccessKeyId and awsSecretAccessKey, or apiKey in fields`},
		{"provider credential: a field the provider does not take", `
resource "intutic_provider_credential" "c" {
  provider_id = "openai"
  fields      = { apiKey = "openai-key-0123", organization = "org" }
}`, `openai takes no field organization`},
		{"provider credential: a key too short to be real", `
resource "intutic_provider_credential" "c" {
  provider_id = "anthropic"
  fields      = { apiKey = "short" }
}`, `apiKey must be between 8 and 512 characters`},
		{"provider credential: an endpoint that is not an Azure resource", `
resource "intutic_provider_credential" "c" {
  provider_id = "azure_openai"
  fields      = { endpoint = "https://llm.example.com", apiKey = "azure-key-0123" }
}`, `Resource Endpoint must be https://<resource>.openai.azure.com`},
		{"provider credential: a service account that is not JSON", `
resource "intutic_provider_credential" "c" {
  provider_id = "vertex_ai"
  fields      = { projectId = "my-project", serviceAccountJson = "not json" }
}`, `Service Account JSON is not valid JSON`},
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
