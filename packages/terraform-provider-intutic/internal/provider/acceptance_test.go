package provider

// Acceptance tests: real control plane, real terraform. They run only with
// TF_ACC=1 and the connection details that
// services/control-plane/scripts/terraform-acceptance-server.ts writes.
//
// Every test applies, re-plans to prove the plan is empty (no perpetual diff
// from a server-side default), imports, and checks the import matches state.

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
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
	accTest(t,
		resource.TestStep{
			Config: webhook + pagerduty,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestMatchResourceAttr("intutic_notification_rule.hook", "id", regexp.MustCompile(`^nr_`)),
				resource.TestCheckResourceAttrSet("intutic_notification_rule.hook", "signing_secret"),
				resource.TestCheckResourceAttr("intutic_notification_rule.page", "enabled", "true"),
				resource.TestCheckResourceAttr("intutic_notification_rule.page", "cooldown_minutes", "15"),
			),
		},
		// The routing key reads back masked; the plan must still be empty.
		clean(webhook+pagerduty),
		// Neither secret is ever returned after creation.
		imported("intutic_notification_rule.hook", "signing_secret"),
		imported("intutic_notification_rule.page", "pagerduty_routing_key"),
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
