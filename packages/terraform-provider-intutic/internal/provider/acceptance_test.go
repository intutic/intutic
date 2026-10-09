package provider

// Acceptance tests: real control plane, real terraform. They run only with
// TF_ACC=1 and the connection details that
// services/control-plane/scripts/terraform-acceptance-server.ts writes.
//
// Every test applies, re-plans to prove the plan is empty (no perpetual diff
// from a server-side default), imports, and checks the import matches state.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// api calls the control plane directly, to change something behind
// Terraform's back.
func api(t *testing.T, method, path string, body any) {
	t.Helper()
	c := client.New(os.Getenv("INTUTIC_CONTROL_PLANE_URL"), os.Getenv("INTUTIC_API_KEY"), "acceptance-test")
	var err error
	switch method {
	case "POST":
		err = c.Post(context.Background(), path, body, nil)
	case "PUT":
		err = c.Put(context.Background(), path, body, nil)
	default:
		t.Fatalf("unsupported method %s", method)
	}
	if err != nil {
		t.Fatal(err)
	}
}

// apiStatus calls the control plane directly and returns the HTTP status,
// for a call whose refusal is what the test is about.
func apiStatus(t *testing.T, method, path string, body any) int {
	t.Helper()
	c := client.New(os.Getenv("INTUTIC_CONTROL_PLANE_URL"), os.Getenv("INTUTIC_API_KEY"), "acceptance-test")
	var err error
	switch method {
	case "POST":
		err = c.Post(context.Background(), path, body, nil)
	case "PUT":
		err = c.Put(context.Background(), path, body, nil)
	case "DELETE":
		err = c.Delete(context.Background(), path, nil)
	default:
		t.Fatalf("unsupported method %s", method)
	}
	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	if err != nil {
		t.Fatal(err)
	}
	return 200
}

// captured records an attribute's value for a later step to compare with.
func captured(into *string) func(string) error {
	return func(v string) error { *into = v; return nil }
}

// changedFrom checks an attribute no longer has the value *prev holds, then
// records the new one.
func changedFrom(prev *string, what string) func(string) error {
	return func(v string) error {
		if v == "" || v == *prev {
			return fmt.Errorf("%s did not change", what)
		}
		*prev = v
		return nil
	}
}

// same checks an attribute still has the value *want holds.
func same(want *string, what string) func(string) error {
	return func(v string) error {
		if v != *want {
			return fmt.Errorf("%s changed from %s to %s", what, *want, v)
		}
		return nil
	}
}

// drifted plans the same config and expects a change.
func drifted(config string, preConfig func()) resource.TestStep {
	return resource.TestStep{Config: config, PreConfig: preConfig, PlanOnly: true, ExpectNonEmptyPlan: true}
}

func accTest(t *testing.T, steps ...resource.TestStep) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: protoV6Factories,
		Steps:                    steps,
	})
}

// clean re-applies the same config and asserts nothing changes.
func clean(config string) resource.TestStep {
	return resource.TestStep{
		Config: config,
		ConfigPlanChecks: resource.ConfigPlanChecks{
			PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()},
		},
	}
}

func imported(name string, ignore ...string) resource.TestStep {
	return resource.TestStep{
		ResourceName:            name,
		ImportState:             true,
		ImportStateVerify:       true,
		ImportStateVerifyIgnore: ignore,
	}
}

func TestAccSop(t *testing.T) {
	v1 := `
resource "intutic_sop" "deploys" {
  title            = "tf-acc deploy approvals"
  markdown_content = "# Deploys\n\nNever run kubectl apply against production without a ticket."
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_1"
}`
	v2 := `
resource "intutic_sop" "deploys" {
  title            = "tf-acc deploy approvals"
  markdown_content = "# Deploys\n\nNever run kubectl apply or helm upgrade against production without a ticket."
  risk_tier        = "CRITICAL"
  complexity_tier  = "TIER_1"
}`
	var firstID string
	accTest(t,
		resource.TestStep{
			Config: v1,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_sop.deploys", "id", regexp.MustCompile(`^sp_`)),
				resource.TestCheckResourceAttrWith("intutic_sop.deploys", "id", func(v string) error { firstID = v; return nil }),
				resource.TestCheckResourceAttr("intutic_sop.deploys", "lifecycle_state", "DRAFT"),
				resource.TestCheckResourceAttr("intutic_sop.deploys", "version", "1.0.0"),
			),
		},
		clean(v1),
		imported("intutic_sop.deploys"),
		// A DRAFT is edited in place: same id.
		resource.TestStep{
			Config: v2,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr("intutic_sop.deploys", "risk_tier", "CRITICAL"),
				resource.TestCheckResourceAttrWith("intutic_sop.deploys", "id", func(v string) error {
					if v != firstID {
						return fmt.Errorf("a DRAFT edit must keep id %s, got %s", firstID, v)
					}
					return nil
				}),
			),
		},
		clean(v2),
		// Once the SOP leaves DRAFT, an edit forks: a new id, the patch version
		// bumped, the SOP back in DRAFT — and the plan says so before apply.
		resource.TestStep{
			Config: v1,
			PreConfig: func() {
				api(t, "POST", "/api/v1/sops/"+firstID+"/transition", map[string]string{"target_state": "PENDING_REVIEW"})
			},
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{
					plancheck.ExpectUnknownValue("intutic_sop.deploys", tfjsonpath.New("id")),
					plancheck.ExpectKnownValue("intutic_sop.deploys", tfjsonpath.New("lifecycle_state"), knownvalue.StringExact("DRAFT")),
				},
			},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr("intutic_sop.deploys", "version", "1.0.1"),
				resource.TestCheckResourceAttr("intutic_sop.deploys", "lifecycle_state", "DRAFT"),
				resource.TestCheckResourceAttrWith("intutic_sop.deploys", "id", func(v string) error {
					if v == firstID {
						return fmt.Errorf("an edit of a non-DRAFT SOP must fork a new id")
					}
					return nil
				}),
			),
		},
		clean(v1),
	)
}

func TestAccPolicy(t *testing.T) {
	cfg := func(action string) string {
		return fmt.Sprintf(`
resource "intutic_policy" "no_force_push" {
  name                = "tf-acc no force push"
  description         = "Block git push --force from agents"
  target_tool_pattern = "Bash"
  enforcement_action  = %q
  risk_category       = "DESTRUCTIVE"
  conditions          = jsonencode({ argContains = ["push --force"] })
}`, action)
	}
	accTest(t,
		resource.TestStep{
			Config: cfg("KILL"),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_policy.no_force_push", "id", regexp.MustCompile(`^pol_`)),
				resource.TestCheckResourceAttr("intutic_policy.no_force_push", "priority", "100"),
				resource.TestCheckResourceAttr("intutic_policy.no_force_push", "intervention_mode", "TRANSPARENT"),
				resource.TestCheckResourceAttr("intutic_policy.no_force_push", "current_version", "1"),
			),
		},
		clean(cfg("KILL")),
		imported("intutic_policy.no_force_push"),
		resource.TestStep{
			Config: cfg("REASK"),
			Check:  resource.TestCheckResourceAttr("intutic_policy.no_force_push", "current_version", "2"),
		},
		clean(cfg("REASK")),
		resource.TestStep{
			Config: cfg("REASK"),
			PreConfig: func() {
				// Find the id through the list, as the provider does.
				api(t, "POST", "/api/v1/policies/"+policyID(t)+"/disable", nil)
			},
			PlanOnly:           true,
			ExpectNonEmptyPlan: true,
		},
	)
}

func policyID(t *testing.T) string {
	t.Helper()
	c := client.New(os.Getenv("INTUTIC_CONTROL_PLANE_URL"), os.Getenv("INTUTIC_API_KEY"), "acceptance-test")
	var out struct {
		Policies []apiPolicy `json:"policies"`
	}
	if err := c.Get(context.Background(), "/api/v1/policies", &out); err != nil {
		t.Fatal(err)
	}
	for _, p := range out.Policies {
		if p.Name == "tf-acc no force push" {
			return p.PolicyID
		}
	}
	t.Fatal("policy not found")
	return ""
}

func TestAccWorkspaceSettings(t *testing.T) {
	cfg := func(mode string) string {
		return fmt.Sprintf(`
resource "intutic_workspace_settings" "this" {
  settings = jsonencode({
    egressMode       = %q
    egressAllow      = ["api.github.com", "registry.npmjs.org"]
    mcpDefaultPolicy = "deny"
    featureFlags     = { ff_shadow_enforcement = true }
  })
}`, mode)
	}
	accTest(t,
		resource.TestStep{
			Config: cfg("monitor"),
			Check:  resource.TestCheckResourceAttr("intutic_workspace_settings.this", "id", os.Getenv("INTUTIC_TEST_WORKSPACE_ID")),
		},
		clean(cfg("monitor")),
		resource.TestStep{Config: cfg("enforce")},
		clean(cfg("enforce")),
		// A key the configuration does not set is not Terraform's to manage,
		// and neither is a feature flag it does not name...
		resource.TestStep{
			Config: cfg("enforce"),
			PreConfig: func() {
				api(t, "PUT", "/api/v1/workspace/settings", map[string]any{
					"sandboxRequirement": "warn",
					"featureFlags":       map[string]bool{"ff_bandit_routing": true},
				})
			},
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()},
			},
		},
		// ...but a managed key changed elsewhere is drift, and so is a named flag.
		drifted(cfg("enforce"), func() {
			api(t, "PUT", "/api/v1/workspace/settings", map[string]any{"mcpDefaultPolicy": "allow"})
		}),
		resource.TestStep{Config: cfg("enforce")},
		drifted(cfg("enforce"), func() {
			api(t, "PUT", "/api/v1/workspace/settings", map[string]any{"featureFlags": map[string]bool{"ff_shadow_enforcement": false}})
		}),
		resource.TestStep{Config: cfg("enforce")},
		clean(cfg("enforce")),
	)
}

func TestAccVirtualKey(t *testing.T) {
	cfg := `
resource "intutic_virtual_key" "ci" {
  label              = "tf-acc ci"
  allowed_models     = ["claude-haiku-4-5"]
  expires_in_days    = 30
  is_service_account = true
}`
	accTest(t,
		resource.TestStep{
			Config: cfg,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_virtual_key.ci", "key", regexp.MustCompile(`^vk_`)),
				resource.TestCheckResourceAttr("intutic_virtual_key.ci", "scopes.0", "*"),
				resource.TestCheckResourceAttrSet("intutic_virtual_key.ci", "expires_at"),
			),
		},
		clean(cfg),
		// The key value and the requested lifetime are not readable after creation.
		imported("intutic_virtual_key.ci", "key", "expires_in_days"),
	)
}

func TestAccGateway(t *testing.T) {
	cfg := func(requireVk bool) string {
		return fmt.Sprintf(`
resource "intutic_gateway" "edge" {
  name              = "tf-acc edge"
  deployment_target = "kubernetes"
  require_vk        = %t
}`, requireVk)
	}
	accTest(t,
		resource.TestStep{
			Config: cfg(true),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_gateway.edge", "token", regexp.MustCompile(`^gwk_`)),
				resource.TestCheckResourceAttr("intutic_gateway.edge", "status", "pending"),
			),
		},
		clean(cfg(true)),
		resource.TestStep{Config: cfg(false)},
		clean(cfg(false)),
		// require_vk is not imported: an imported gateway manages no config
		// until the configuration names it.
		imported("intutic_gateway.edge", "token", "require_vk"),
	)
}

func TestAccNotificationRule(t *testing.T) {
	webhook := `
resource "intutic_notification_rule" "hook" {
  event_type       = "incident.created"
  channel          = "webhook"
  webhook_url      = "https://hooks.example.com/intutic"
  filter_severity  = ["critical", "high"]
  cooldown_minutes = 30
}`
	pagerduty := `
resource "intutic_notification_rule" "page" {
  event_type            = "incident.created"
  channel               = "pagerduty"
  pagerduty_routing_key = "R0UT1NGKEY0123456789"
}`
	rotated := func(v string) string {
		return strings.Replace(webhook, "cooldown_minutes = 30", fmt.Sprintf("cooldown_minutes = 30\n  secret_rotation_triggers = { rotated = %q }", v), 1)
	}
	const hook = "intutic_notification_rule.hook"
	var hookID, secret string
	rotation := func(v string) resource.TestStep {
		return resource.TestStep{
			Config: rotated(v) + pagerduty,
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(hook, plancheck.ResourceActionUpdate),
					plancheck.ExpectUnknownValue(hook, tfjsonpath.New("signing_secret")),
					plancheck.ExpectResourceAction("intutic_notification_rule.page", plancheck.ResourceActionNoop),
				},
			},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttrWith(hook, "signing_secret", changedFrom(&secret, "signing_secret")),
				resource.TestCheckResourceAttrWith(hook, "id", same(&hookID, "id")),
			),
		}
	}
	accTest(t,
		resource.TestStep{
			Config: webhook + pagerduty,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_notification_rule.hook", "id", regexp.MustCompile(`^nr_`)),
				resource.TestCheckResourceAttrWith(hook, "id", captured(&hookID)),
				resource.TestCheckResourceAttrWith(hook, "signing_secret", captured(&secret)),
				resource.TestCheckResourceAttr("intutic_notification_rule.page", "enabled", "true"),
				resource.TestCheckResourceAttr("intutic_notification_rule.page", "cooldown_minutes", "15"),
			),
		},
		// The routing key reads back masked; the plan must still be empty.
		clean(webhook+pagerduty),
		// Neither secret is ever returned after creation.
		imported("intutic_notification_rule.hook", "signing_secret"),
		imported("intutic_notification_rule.page", "pagerduty_routing_key"),
		// Adding the triggers rotates the secret in place, and so does each
		// change to them; an unchanged value plans nothing.
		rotation("1"),
		clean(rotated("1")+pagerduty),
		rotation("2"),
		clean(rotated("2")+pagerduty),
	)
}

func TestAccSiemDestination(t *testing.T) {
	webhook := func(triggers string) string {
		return fmt.Sprintf(`
resource "intutic_siem_destination" "hook" {
  name          = "tf-acc webhook"
  adapter_type  = "webhook_https"
  config        = jsonencode({ webhookUrl = "https://hooks.example.com/intutic-siem" })
  secret_config = { authHeaderValue = "Bearer tf-acc-0123456789" }
  source_tables = ["governance_incidents", "gate_decisions"]
  %s
}`, triggers)
	}
	splunkCfg := `jsonencode({ hecUrl = "https://splunk.example.com:8088/services/collector", sourcetype = "intutic" })`
	splunk := `
resource "intutic_siem_destination" "splunk" {
  name          = "tf-acc splunk"
  adapter_type  = "splunk_hec"
  config        = ` + splunkCfg + `
  secret_config = { token = "tf-acc-hec-token-0123456789" }
  batch_size    = 50
}`
	const hook, spl = "intutic_siem_destination.hook", "intutic_siem_destination.splunk"
	v1 := webhook("") + splunk
	rotated := func(v string) string {
		return webhook(fmt.Sprintf("secret_rotation_triggers = { rotated = %q }", v)) + splunk
	}
	var hookID, splunkID, secret string
	rotation := func(v string) resource.TestStep {
		return resource.TestStep{
			Config: rotated(v),
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(hook, plancheck.ResourceActionUpdate),
					plancheck.ExpectUnknownValue(hook, tfjsonpath.New("signing_secret")),
					plancheck.ExpectResourceAction(spl, plancheck.ResourceActionNoop),
				},
			},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttrWith(hook, "signing_secret", changedFrom(&secret, "signing_secret")),
				resource.TestCheckResourceAttrWith(hook, "id", same(&hookID, "id")),
			),
		}
	}
	accTest(t,
		resource.TestStep{
			Config: v1,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr(hook, "id", regexp.MustCompile(`^siemdest_`)),
				resource.TestCheckResourceAttrWith(hook, "id", captured(&hookID)),
				resource.TestCheckResourceAttrWith(spl, "id", captured(&splunkID)),
				resource.TestCheckResourceAttrWith(hook, "signing_secret", captured(&secret)),
				resource.TestCheckResourceAttrSet(hook, "signing_secret"),
				resource.TestCheckResourceAttr(hook, "enabled", "true"),
				resource.TestCheckResourceAttr(hook, "source_tables.#", "2"),
				resource.TestCheckNoResourceAttr(hook, "paused_reason"),
				resource.TestCheckNoResourceAttr(spl, "signing_secret"),
				resource.TestCheckResourceAttr(spl, "batch_size", "50"),
				resource.TestCheckResourceAttr(spl, "flush_interval_ms", "60000"),
				resource.TestCheckResourceAttr(spl, "source_tables.#", "0"),
			),
		},
		// Both credentials read back masked; the plan must still be empty.
		clean(v1),
		// No secret is ever returned unmasked after creation.
		imported(hook, "signing_secret", "secret_config"),
		imported(spl, "secret_config"),
		rotation("1"),
		clean(rotated("1")),
		rotation("2"),
		clean(rotated("2")),
		// A token changed outside Terraform shows through its mask.
		drifted(rotated("2"), func() {
			api(t, "PUT", siemPath+"/"+splunkID, map[string]any{"config": map[string]string{
				"hecUrl": "https://splunk.example.com:8088/services/collector", "sourcetype": "intutic", "token": "changed-in-the-dashboard-9999",
			}})
		}),
		resource.TestStep{Config: rotated("2")},
		clean(rotated("2")),
		// Switching a destination off is an update, not a delete.
		resource.TestStep{
			Config: strings.Replace(rotated("2"), "batch_size    = 50", "batch_size    = 50\n  enabled       = false", 1),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr(spl, "enabled", "false"),
				resource.TestCheckResourceAttrWith(spl, "id", same(&splunkID, "id")),
			),
		},
		// The plan checks source names against the API's list.
		resource.TestStep{
			Config:      strings.Replace(rotated("2"), `"gate_decisions"`, `"gate_decision"`, 1),
			PlanOnly:    true,
			ExpectError: regexp.MustCompile(`"gate_decision" is not a source`),
		},
	)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestAccWasmRule(t *testing.T) {
	dir := t.TempDir()
	write := func(name, tag string) (string, string) {
		p := filepath.Join(dir, name)
		data := testWasmModule(tag)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return p, sha256Hex(data)
	}
	v1, sum1 := write("v1.wasm", "v1")
	moved, _ := write("moved.wasm", "v1")
	v2, sum2 := write("v2.wasm", "v2")
	cfg := func(source, extra string) string {
		return fmt.Sprintf(`
resource "intutic_wasm_rule" "filter" {
  name   = "tf-acc custom filter"
  source = %q
  %s
}`, source, extra)
	}
	// The pin is case-insensitive, as the proxy's check is.
	pinned := cfg(v1, fmt.Sprintf("sha256 = %q", strings.ToUpper(sum1)))
	relabelled := cfg(v1, `description = "Blocks nothing; proves the upload."
  enabled     = false`)
	const name = "intutic_wasm_rule.filter"
	var ruleID string
	accTest(t,
		resource.TestStep{
			Config: pinned,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr(name, "id", regexp.MustCompile(`^wasm_`)),
				resource.TestCheckResourceAttrWith(name, "id", captured(&ruleID)),
				resource.TestCheckResourceAttr(name, "bundle_sha256", sum1),
				resource.TestCheckResourceAttr(name, "enabled", "true"),
				resource.TestCheckResourceAttr(name, "description", ""),
			),
		},
		clean(pinned),
		// The file and its pin live in Terraform alone.
		imported(name, "source", "sha256"),
		// Name, description and enabled change in place.
		resource.TestStep{
			Config: relabelled,
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction(name, plancheck.ResourceActionUpdate)},
			},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttrWith(name, "id", same(&ruleID, "id")),
				resource.TestCheckResourceAttr(name, "enabled", "false"),
			),
		},
		clean(relabelled),
		// The same bytes at another path upload nothing.
		resource.TestStep{
			Config: cfg(moved, ""),
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(name, plancheck.ResourceActionUpdate),
					plancheck.ExpectKnownValue(name, tfjsonpath.New("bundle_sha256"), knownvalue.StringExact(sum1)),
				},
			},
			Check: resource.TestCheckResourceAttrWith(name, "id", same(&ruleID, "id")),
		},
		// Different bytes replace the rule: the API cannot change them.
		resource.TestStep{
			Config: cfg(v2, ""),
			ConfigPlanChecks: resource.ConfigPlanChecks{
				PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(name, plancheck.ResourceActionReplace),
					plancheck.ExpectKnownValue(name, tfjsonpath.New("bundle_sha256"), knownvalue.StringExact(sum2)),
				},
			},
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttrWith(name, "id", changedFrom(&ruleID, "id")),
				resource.TestCheckResourceAttr(name, "bundle_sha256", sum2),
			),
		},
		clean(cfg(v2, "")),
		// Deleted outside Terraform: the plan uploads it again.
		drifted(cfg(v2, ""), func() {
			if got := apiStatus(t, "DELETE", wasmRulesPath+"/"+ruleID, nil); got != 200 {
				t.Fatalf("delete: HTTP %d", got)
			}
		}),
		resource.TestStep{Config: cfg(v2, "")},
		clean(cfg(v2, "")),
	)
}

func TestAccMcpServerDecision(t *testing.T) {
	server := os.Getenv("INTUTIC_TEST_MCP_SERVER")
	if server == "" {
		t.Skip("INTUTIC_TEST_MCP_SERVER is not set")
	}
	cfg := func(status, tools string) string {
		return fmt.Sprintf(`
resource "intutic_mcp_server_decision" "gh" {
  server_name    = %q
  status         = %q
  disabled_tools = %s
}`, server, status, tools)
	}
	accTest(t,
		resource.TestStep{
			Config: cfg("approved", `["delete_repo"]`),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_mcp_server_decision.gh", "id", regexp.MustCompile(`^mcpsrv_`)),
				resource.TestCheckResourceAttr("intutic_mcp_server_decision.gh", "held_for_review", "false"),
				resource.TestCheckResourceAttr("intutic_mcp_server_decision.gh", "tools.#", "3"),
			),
		},
		clean(cfg("approved", `["delete_repo"]`)),
		resource.TestStep{
			ResourceName:                         "intutic_mcp_server_decision.gh",
			ImportState:                          true,
			ImportStateId:                        server,
			ImportStateVerify:                    true,
			ImportStateVerifyIdentifierAttribute: "server_name",
		},
		resource.TestStep{
			Config: cfg("blocked", `["delete_repo", "create_issue"]`),
			Check:  resource.TestCheckResourceAttr("intutic_mcp_server_decision.gh", "disabled_tools.#", "2"),
		},
		clean(cfg("blocked", `["delete_repo", "create_issue"]`)),
	)
}

// A server a high-risk tool change returned to review is not re-approved by
// Terraform; blocking it still works.
func TestAccMcpServerDecisionRespectsAReviewHold(t *testing.T) {
	const name = "tf-acc-filesystem"
	readFile := map[string]string{"name": "read_file", "description": "Read a file."}
	execShell := map[string]string{"name": "exec_shell", "description": "Run shell commands and download their output."}
	cfg := func(status string) string {
		return fmt.Sprintf(`
resource "intutic_mcp_server_decision" "fs" {
  server_name = %q
  status      = %q
}`, name, status)
	}
	accTest(t,
		resource.TestStep{
			PreConfig: func() {
				api(t, "PUT", "/api/v1/workspace/settings", map[string]any{"mcpHighRiskToolChange": "hold"})
				api(t, "POST", "/api/v1/mcp/servers/observe", map[string]any{"serverName": name, "toolDefinitions": []any{readFile}})
			},
			Config: cfg("approved"),
			Check:  resource.TestCheckResourceAttr("intutic_mcp_server_decision.fs", "status", "approved"),
		},
		resource.TestStep{
			PreConfig: func() {
				api(t, "POST", "/api/v1/mcp/servers/observe", map[string]any{"serverName": name, "toolDefinitions": []any{readFile, execShell}})
			},
			Config:      cfg("approved"),
			ExpectError: regexp.MustCompile(`Server held for review`),
		},
		resource.TestStep{
			Config: cfg("blocked"),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr("intutic_mcp_server_decision.fs", "status", "blocked"),
				resource.TestCheckResourceAttr("intutic_mcp_server_decision.fs", "held_for_review", "false"),
			),
		},
		clean(cfg("blocked")),
	)
}

func TestAccMcpServerDecisionNeedsASightedServer(t *testing.T) {
	accTest(t, resource.TestStep{
		Config: `
resource "intutic_mcp_server_decision" "unknown" {
  server_name = "tf-acc-never-seen"
  status      = "approved"
}`,
		ExpectError: regexp.MustCompile(`mcpAllowedServers`),
	})
}

func TestAccDataSources(t *testing.T) {
	accTest(t, resource.TestStep{
		Config: `
data "intutic_workspace" "this" {}
data "intutic_members" "all" {}`,
		Check: resource.ComposeAggregateTestCheckFunc(
			resource.TestCheckResourceAttr("data.intutic_workspace.this", "id", os.Getenv("INTUTIC_TEST_WORKSPACE_ID")),
			resource.TestCheckResourceAttr("data.intutic_workspace.this", "role", "OWNER"),
			resource.TestCheckResourceAttrSet("data.intutic_workspace.this", "plan_tier"),
			resource.TestCheckResourceAttrSet("data.intutic_workspace.this", "org_id"),
			resource.TestCheckResourceAttrSet("data.intutic_members.all", "members.0.member_id"),
			resource.TestCheckResourceAttrSet("data.intutic_members.all", "members.0.email"),
		),
	})
}

// planCheck runs fn against the plan, for a check whose expected value is
// only known once an earlier step has run.
type planCheck func(context.Context, plancheck.CheckPlanRequest, *plancheck.CheckPlanResponse)

func (f planCheck) CheckPlan(ctx context.Context, req plancheck.CheckPlanRequest, resp *plancheck.CheckPlanResponse) {
	f(ctx, req, resp)
}

func guardrailAttr(t *testing.T, id, attribute string) string {
	t.Helper()
	c := client.New(os.Getenv("INTUTIC_CONTROL_PLANE_URL"), os.Getenv("INTUTIC_API_KEY"), "acceptance-test")
	var out struct {
		Guardrail map[string]any `json:"guardrail"`
	}
	if err := c.Get(context.Background(), guardrailsPath+"/"+id, &out); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprint(out.Guardrail[attribute])
}

// The lifecycle an authored guardrail keeps: created PROPOSED; approval and
// promotion are review actions Terraform never takes, and promotion stays
// refused until there is evidence; a label edit keeps the id and evidence; an
// IR edit creates the next version and the plan says so first.
func TestAccGuardrail(t *testing.T) {
	cfg := func(description, literal string) string {
		return fmt.Sprintf(`
resource "intutic_guardrail" "apply" {
  name         = "tf-acc reviewed terraform apply"
  description  = %q
  kind         = "hook_rule"
  title        = "Reviewed plan before terraform apply"
  tools        = ["Bash"]
  arg_contains = [%q]
}`, description, literal)
	}
	v1 := cfg("Production applies need a reviewed plan.", "terraform apply")
	relabelled := cfg("Production applies need a reviewed plan and a ticket.", "terraform apply")
	v2 := cfg("Production applies need a reviewed plan and a ticket.", "terraform apply -auto-approve")
	const name = "intutic_guardrail.apply"
	var firstID string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: protoV6Factories,
		CheckDestroy: func(*terraform.State) error {
			// Destroy retires; the history stays readable.
			if got := guardrailAttr(t, firstID, "status"); got != "RETIRED" {
				return fmt.Errorf("version 1 after destroy: status %s, want RETIRED", got)
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: v1,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{
						plancheck.ExpectKnownValue(name, tfjsonpath.New("status"), knownvalue.StringExact("PROPOSED")),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("version"), knownvalue.Int64Exact(1)),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("target"), knownvalue.StringExact("hook_rule")),
					},
				},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestMatchResourceAttr(name, "id", regexp.MustCompile(`^pgr_`)),
					resource.TestCheckResourceAttrWith(name, "id", func(v string) error { firstID = v; return nil }),
					resource.TestCheckResourceAttr(name, "provenance", "authored"),
					resource.TestCheckResourceAttr(name, "status", "PROPOSED"),
					resource.TestCheckResourceAttr(name, "shadow_evaluations", "0"),
					resource.TestCheckNoResourceAttr(name, "supersedes"),
				),
			},
			clean(v1),
			imported(name),
			// Approval for shadow is a review action, taken outside Terraform;
			// the plan stays empty, and promotion is refused without evidence.
			{
				Config: v1,
				PreConfig: func() {
					api(t, "POST", guardrailsPath+"/"+firstID+"/approve-shadow", nil)
					if got := apiStatus(t, "POST", guardrailsPath+"/"+firstID+"/promote", map[string]bool{"acknowledgeNoTraffic": true}); got != 409 {
						t.Fatalf("promote without evidence: HTTP %d, want 409", got)
					}
				},
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
				Check:            resource.TestCheckResourceAttr(name, "status", "SHADOW"),
			},
			// A description edit happens in place: same id, still in shadow.
			{
				Config: relabelled,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{
						plancheck.ExpectResourceAction(name, plancheck.ResourceActionUpdate),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("status"), knownvalue.StringExact("SHADOW")),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("version"), knownvalue.Int64Exact(1)),
					},
				},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrWith(name, "id", func(v string) error {
						if v != firstID {
							return fmt.Errorf("a label edit must keep id %s, got %s", firstID, v)
						}
						return nil
					}),
					resource.TestCheckResourceAttr(name, "status", "SHADOW"),
				),
			},
			clean(relabelled),
			// A rename behind Terraform's back is drift.
			drifted(relabelled, func() {
				api(t, "PUT", guardrailsPath+"/"+firstID, map[string]string{"name": "renamed in the dashboard"})
			}),
			{Config: relabelled},
			// An IR edit creates the next version, and the plan says so: a new id,
			// version 2, back in PROPOSED with no evidence, replacing version 1.
			{
				Config: v2,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{
						plancheck.ExpectResourceAction(name, plancheck.ResourceActionUpdate),
						plancheck.ExpectUnknownValue(name, tfjsonpath.New("id")),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("version"), knownvalue.Int64Exact(2)),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("status"), knownvalue.StringExact("PROPOSED")),
						plancheck.ExpectKnownValue(name, tfjsonpath.New("shadow_evaluations"), knownvalue.Int64Exact(0)),
						planCheck(func(ctx context.Context, req plancheck.CheckPlanRequest, resp *plancheck.CheckPlanResponse) {
							plancheck.ExpectKnownValue(name, tfjsonpath.New("supersedes"), knownvalue.StringExact(firstID)).CheckPlan(ctx, req, resp)
						}),
					},
				},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrWith(name, "id", func(v string) error {
						if v == firstID {
							return fmt.Errorf("an IR edit must create a new version with a new id")
						}
						if got := guardrailAttr(t, firstID, "status"); got != "RETIRED" {
							return fmt.Errorf("version 1 after the edit: status %s, want RETIRED", got)
						}
						return nil
					}),
					resource.TestCheckResourceAttr(name, "version", "2"),
					resource.TestCheckResourceAttr(name, "status", "PROPOSED"),
				),
			},
			clean(v2),
			imported(name),
			// Retired behind Terraform's back: the plan creates it again.
			drifted(v2, func() {
				c := client.New(os.Getenv("INTUTIC_CONTROL_PLANE_URL"), os.Getenv("INTUTIC_API_KEY"), "acceptance-test")
				var out struct {
					Guardrails []struct {
						GuardrailID string `json:"guardrailId"`
						Supersedes  string `json:"supersedes"`
					} `json:"guardrails"`
				}
				if err := c.Get(context.Background(), guardrailsPath+"?provenance=authored&status=PROPOSED", &out); err != nil {
					t.Fatal(err)
				}
				for _, g := range out.Guardrails {
					if g.Supersedes == firstID {
						if got := apiStatus(t, "DELETE", guardrailsPath+"/"+g.GuardrailID, nil); got != 200 {
							t.Fatalf("delete: HTTP %d", got)
						}
						return
					}
				}
				t.Fatal("version 2 not found")
			}),
			{Config: v2},
			clean(v2),
		},
	})
}

// Every other kind applies, re-plans empty and imports: lists, a count, a
// taint, settings values and a predicate read back exactly as written.
func TestAccGuardrailKinds(t *testing.T) {
	cfg := `
resource "intutic_guardrail" "deny" {
  name  = "tf-acc no web fetch"
  kind  = "deny_tools"
  tools = ["WebFetch"]
  roles = ["contractor"]
}

resource "intutic_guardrail" "review" {
  name   = "tf-acc review deploys"
  kind   = "review_before"
  tokens = ["action:deploy"]
}

resource "intutic_guardrail" "order" {
  name  = "tf-acc tests before deploy"
  kind  = "requires_before"
  first = "action:run_tests"
  then  = "action:deploy"
}

resource "intutic_guardrail" "count" {
  name  = "tf-acc bounded shell"
  kind  = "max_calls"
  token = "Bash"
  limit = 200
}

resource "intutic_guardrail" "taint" {
  name  = "tf-acc no secrets out"
  kind  = "forbid_with"
  taint = "secrets()"
  token = "action:http_post"
}

resource "intutic_guardrail" "models" {
  name   = "tf-acc approved models"
  kind   = "allowed_models"
  models = ["claude-sonnet-4-5", "gpt-4o"]
}

resource "intutic_guardrail" "egress" {
  name  = "tf-acc egress"
  kind  = "egress_allow"
  hosts = ["api.github.com", ".npmjs.org", "10.0.0.0/8"]
}

resource "intutic_guardrail" "wasm" {
  name      = "tf-acc deep graphs re-ask"
  kind      = "wasm_predicate"
  title     = "Deep agent graphs re-ask"
  rationale = "Deep graphs burn budget."
  predicate = jsonencode({ all = [{ field = "depth", op = "atLeast", value = 4 }] })
}`
	all := []string{"deny", "review", "order", "count", "taint", "models", "egress", "wasm"}
	targets := map[string]string{"deny": "sop_front_matter", "review": "sop_front_matter", "order": "sop_front_matter", "count": "sop_front_matter", "taint": "sop_front_matter", "models": "workspace_setting", "egress": "workspace_setting", "wasm": "wasm_rule"}
	var checks []resource.TestCheckFunc
	steps := []resource.TestStep{}
	for _, r := range all {
		checks = append(checks,
			resource.TestCheckResourceAttr("intutic_guardrail."+r, "status", "PROPOSED"),
			resource.TestCheckResourceAttr("intutic_guardrail."+r, "target", targets[r]))
	}
	steps = append(steps, resource.TestStep{Config: cfg, Check: resource.ComposeAggregateTestCheckFunc(checks...)}, clean(cfg))
	for _, r := range all {
		steps = append(steps, imported("intutic_guardrail."+r))
	}
	accTest(t, steps...)
}

// The plan asks the API's validator: a rule on a tool no harness in the
// workspace has called is refused before anything is written.
func TestAccGuardrailRefusedAtPlan(t *testing.T) {
	accTest(t, resource.TestStep{
		Config: `
resource "intutic_guardrail" "kubectl" {
  name  = "tf-acc kubectl"
  kind  = "deny_tools"
  tools = ["kubectl"]
}`,
		PlanOnly:    true,
		ExpectError: regexp.MustCompile(`(?s)The API would refuse this guardrail.*token_observable`),
	})
}
