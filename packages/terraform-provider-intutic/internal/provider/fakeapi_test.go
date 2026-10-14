package provider

// Unit tests against an in-process fake of the few control-plane routes they
// need: they run with the terraform binary alone, where the acceptance tests
// need a real control plane.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

const fakeWorkspaceID = "ws_fake0123"

type fakeMcpServer struct {
	ServerID      string   `json:"serverId"`
	ServerName    string   `json:"serverName"`
	Status        string   `json:"status"`
	Tools         []string `json:"tools"`
	DisabledTools []string `json:"disabledTools"`
	HeldForReview bool     `json:"heldForReview"`
}

type fakeAPI struct {
	mu       sync.Mutex
	servers  []*fakeMcpServer
	policies []apiPolicy
	// SOPs are JSON objects as the API sends them, so a test can seed the
	// nulls a real row may carry.
	sops  map[string]map[string]any
	calls []string
}

func (f *fakeAPI) record(r *http.Request, detail string) {
	f.calls = append(f.calls, strings.TrimSpace(r.Method+" "+r.URL.Path+" "+detail))
}

func (f *fakeAPI) toolCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.Contains(c, "/tools") {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/budget":
		_, _ = fmt.Fprintf(w, `{"workspace_id":%q,"daily_budget_usd":100,"daily_budget_is_default":true,`+
			`"monthly_budget_usd":1000,"alert_threshold_pct":80,"daily_enforcement":"hard","monthly_enforcement":"soft"}`, fakeWorkspaceID)
	case r.Method == http.MethodGet && r.URL.Path == mcpServersPath:
		_ = json.NewEncoder(w).Encode(map[string]any{"servers": f.servers})
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, mcpServersPath+"/"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, mcpServersPath+"/"), "/")
		var srv *fakeMcpServer
		for _, s := range f.servers {
			if s.ServerID == parts[0] {
				srv = s
			}
		}
		if srv == nil || len(parts) != 2 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
			return
		}
		var body struct {
			Status  string `json:"status"`
			Tool    string `json:"tool"`
			Enabled bool   `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch parts[1] {
		case "status":
			f.record(r, body.Status)
			srv.Status = body.Status
		case "tools":
			f.record(r, fmt.Sprintf("%s enabled=%v", body.Tool, body.Enabled))
			srv.DisabledTools = slices.DeleteFunc(srv.DisabledTools, func(t string) bool { return t == body.Tool })
			if !body.Enabled {
				srv.DisabledTools = append(srv.DisabledTools, body.Tool)
			}
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/policies":
		_ = json.NewEncoder(w).Encode(map[string]any{"policies": f.policies})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/policies":
		// The body has the response's field names; the API echoes it back.
		var p apiPolicy
		_ = json.NewDecoder(r.Body).Decode(&p)
		f.record(r, "targetToolPattern="+p.TargetToolPattern+" enforcementAction="+p.EnforcementAction)
		p.PolicyID = fmt.Sprintf("pol_fake%d", len(f.policies)+1)
		p.CurrentVersion = 1
		f.policies = append(f.policies, p)
		_ = json.NewEncoder(w).Encode(map[string]any{"policy": p})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/policies/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/policies/")
		f.policies = slices.DeleteFunc(f.policies, func(p apiPolicy) bool { return p.PolicyID == id })
		_, _ = w.Write([]byte(`{"ok":true}`))
	case strings.HasPrefix(r.URL.Path, "/api/v1/sops/"):
		f.serveSop(w, r, strings.TrimPrefix(r.URL.Path, "/api/v1/sops/"))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, `{"error":"fake API has no %s %s"}`, r.Method, r.URL.Path)
	}
}

// serveSop fakes GET, PUT (a DRAFT edit, in place) and DELETE of one SOP.
func (f *fakeAPI) serveSop(w http.ResponseWriter, r *http.Request, id string) {
	sop, ok := f.sops[id]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
		return
	}
	switch r.Method {
	case http.MethodGet:
		_ = json.NewEncoder(w).Encode(sop)
	case http.MethodPut:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		keys := make([]string, 0, len(body))
		for k, v := range body {
			keys = append(keys, fmt.Sprintf("%s=%v", k, v))
		}
		slices.Sort(keys)
		f.record(r, strings.Join(keys, " "))
		// UpdateSopSchema: version_counter is optional, at least 1.
		if vc, sent := body["version_counter"]; sent && vc.(float64) < 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"version_counter must be at least 1"}`))
			return
		}
		for from, to := range map[string]string{"title": "title", "markdown_content": "markdownContent",
			"risk_tier": "riskTier", "complexity_tier": "complexityTier", "version": "version"} {
			if v, sent := body[from]; sent {
				sop[to] = v
			}
		}
		if vc, ok := sop["versionCounter"].(float64); ok {
			sop["versionCounter"] = vc + 1
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sop": sop})
	case http.MethodDelete:
		delete(f.sops, id)
		_, _ = w.Write([]byte(`{"deleted":true}`))
	}
}

func startFakeAPI(t *testing.T, api *fakeAPI) string {
	t.Helper()
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	return fmt.Sprintf(`
provider "intutic" {
  endpoint = %q
  api_key  = "vk_fake"
}
`, srv.URL)
}

// The budget route serves the key's workspace whatever id it is given, so an
// import of any id used to succeed and silently manage the key's workspace.
func TestWorkspaceBudgetImportRefusesAnotherWorkspace(t *testing.T) {
	provider := startFakeAPI(t, &fakeAPI{})
	cfg := provider + `
resource "intutic_workspace_budget" "this" {
  monthly_budget_usd = 1000
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:        cfg,
				ResourceName:  "intutic_workspace_budget.this",
				ImportState:   true,
				ImportStateId: "ws_someone_else",
				ExpectError:   regexp.MustCompile(`Wrong workspace`),
			},
			{
				Config:             cfg,
				ResourceName:       "intutic_workspace_budget.this",
				ImportState:        true,
				ImportStateId:      fakeWorkspaceID,
				ImportStatePersist: true,
			},
			{
				Config:   cfg,
				PlanOnly: true,
			},
		},
	})
}

// An imported decision whose configuration leaves disabled_tools unset used
// to plan an in-place update on its first plan: import recorded the server's
// switches as managed, and the unset attribute planned them away.
func TestMcpServerDecisionImportWithoutDisabledToolsPlansClean(t *testing.T) {
	api := &fakeAPI{servers: []*fakeMcpServer{{
		ServerID: "mcpsrv_1", ServerName: "github", Status: "approved",
		Tools: []string{"create_issue", "delete_repo"}, DisabledTools: []string{"delete_repo"},
	}}}
	provider := startFakeAPI(t, api)
	cfg := provider + `
resource "intutic_mcp_server_decision" "gh" {
  server_name = "github"
  status      = "approved"
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:             cfg,
				ResourceName:       "intutic_mcp_server_decision.gh",
				ImportState:        true,
				ImportStateId:      "github",
				ImportStatePersist: true,
			},
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()},
				},
				Check: resource.TestCheckResourceAttr("intutic_mcp_server_decision.gh", "disabled_tools.#", "1"),
			},
		},
	})
	if calls := api.toolCalls(); len(calls) != 0 {
		t.Fatalf("an unset disabled_tools changed tool switches: %v", calls)
	}
}

// Setting disabled_tools to what the server already has also imports clean.
func TestMcpServerDecisionImportWithMatchingDisabledToolsPlansClean(t *testing.T) {
	api := &fakeAPI{servers: []*fakeMcpServer{{
		ServerID: "mcpsrv_1", ServerName: "github", Status: "approved",
		Tools: []string{"create_issue", "delete_repo"}, DisabledTools: []string{"delete_repo"},
	}}}
	provider := startFakeAPI(t, api)
	cfg := provider + `
resource "intutic_mcp_server_decision" "gh" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repo"]
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:             cfg,
				ResourceName:       "intutic_mcp_server_decision.gh",
				ImportState:        true,
				ImportStateId:      "github",
				ImportStatePersist: true,
			},
			{Config: cfg, PlanOnly: true},
		},
	})
}

// Destroy re-enables what the configuration switched off and nothing else: a
// tool switched off elsewhere stays off, and an unset disabled_tools switches
// nothing at create.
func TestMcpServerDecisionDestroyReEnablesOnlyItsOwnTools(t *testing.T) {
	api := &fakeAPI{servers: []*fakeMcpServer{
		{ServerID: "mcpsrv_1", ServerName: "github", Status: "candidate",
			Tools: []string{"create_issue", "delete_repo", "push"}, DisabledTools: []string{"push"}},
		{ServerID: "mcpsrv_2", ServerName: "slack", Status: "candidate",
			Tools: []string{"post", "delete_channel"}, DisabledTools: []string{"delete_channel"}},
	}}
	provider := startFakeAPI(t, api)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config: provider + `
resource "intutic_mcp_server_decision" "gh" {
  server_name    = "github"
  status         = "approved"
  disabled_tools = ["delete_repo", "push"]
}
resource "intutic_mcp_server_decision" "slack" {
  server_name = "slack"
  status      = "approved"
}`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("intutic_mcp_server_decision.gh", "disabled_tools.#", "2"),
					resource.TestCheckResourceAttr("intutic_mcp_server_decision.slack", "disabled_tools.#", "1"),
				),
			},
		},
	})
	got := api.toolCalls()
	want := []string{
		"POST /api/v1/mcp/servers/mcpsrv_1/tools delete_repo enabled=false",
		"POST /api/v1/mcp/servers/mcpsrv_1/tools delete_repo enabled=true",
		"POST /api/v1/mcp/servers/mcpsrv_1/tools push enabled=true",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("tool switches = %v, want %v", got, want)
	}
}

// target_tool_pattern and enforcement_action are enforced nowhere, so they are
// optional; the API still requires both on create, so the provider sends the
// defaults, which match everything and do nothing.
func TestPolicyWithoutDeprecatedFieldsSendsTheDefaults(t *testing.T) {
	api := &fakeAPI{}
	provider := startFakeAPI(t, api)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config: provider + `
resource "intutic_policy" "mode" {
  name              = "Workspace intervention mode"
  intervention_mode = "OPAQUE"
}`,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("intutic_policy.mode", "target_tool_pattern", "*"),
					resource.TestCheckResourceAttr("intutic_policy.mode", "enforcement_action", "BYPASS"),
					resource.TestCheckResourceAttr("intutic_policy.mode", "intervention_mode", "OPAQUE"),
				),
			},
		},
	})
	api.mu.Lock()
	defer api.mu.Unlock()
	want := "POST /api/v1/policies targetToolPattern=* enforcementAction=BYPASS"
	if !slices.Contains(api.calls, want) {
		t.Fatalf("calls = %v, want %q", api.calls, want)
	}
}

// jsonObject decodes a JSON object the way the fake serves it back.
func jsonObject(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// nullAttrs checks that an imported resource has each attribute null. The
// testing state omits a null attribute; an empty string or zero is present.
func nullAttrs(names ...string) resource.ImportStateCheckFunc {
	return func(states []*terraform.InstanceState) error {
		if len(states) != 1 {
			return fmt.Errorf("imported %d resources, want 1", len(states))
		}
		for _, name := range names {
			if v, ok := states[0].Attributes[name]; ok {
				return fmt.Errorf("%s = %q, want null", name, v)
			}
		}
		return nil
	}
}

// A SOP written without tiers (the SOP health check writes none) reads them as
// null, not as empty strings; the configured tiers are set on the next apply.
func TestSopWithoutTiersReadsThemAsNull(t *testing.T) {
	api := &fakeAPI{sops: map[string]map[string]any{"sp_1": jsonObject(t, `{
		"sopId": "sp_1", "workspaceId": "ws_fake0123", "title": "Deploys", "version": "1.0.0",
		"markdownContent": "# Deploys", "riskTier": null, "complexityTier": null, "isActive": true,
		"lifecycleState": "DRAFT", "contentHash": "abc", "versionCounter": 3, "priorVersionId": null}`)}}
	provider := startFakeAPI(t, api)
	cfg := provider + `
resource "intutic_sop" "deploys" {
  title            = "Deploys"
  markdown_content = "# Deploys"
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_1"
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:             cfg,
				ResourceName:       "intutic_sop.deploys",
				ImportState:        true,
				ImportStateId:      "sp_1",
				ImportStatePersist: true,
				ImportStateCheck:   nullAttrs("risk_tier", "complexity_tier"),
			},
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{
					PreApply: []plancheck.PlanCheck{
						plancheck.ExpectResourceAction("intutic_sop.deploys", plancheck.ResourceActionUpdate),
					},
				},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("intutic_sop.deploys", "id", "sp_1"),
					resource.TestCheckResourceAttr("intutic_sop.deploys", "risk_tier", "HIGH"),
					resource.TestCheckResourceAttr("intutic_sop.deploys", "complexity_tier", "TIER_1"),
				),
			},
			{Config: cfg, PlanOnly: true},
		},
	})
	api.mu.Lock()
	defer api.mu.Unlock()
	want := "PUT /api/v1/sops/sp_1 complexity_tier=TIER_1 risk_tier=HIGH version_counter=3"
	if !slices.Contains(api.calls, want) {
		t.Fatalf("calls = %v, want %q", api.calls, want)
	}
}

// versionCounter and contentHash are optional in the API's SOP. Absent, they
// read as null, and an update sends no version_counter rather than 0, which
// the API refuses.
func TestSopWithoutVersionCounterUpdatesWithoutOne(t *testing.T) {
	api := &fakeAPI{sops: map[string]map[string]any{"sp_1": jsonObject(t, `{
		"sopId": "sp_1", "workspaceId": "ws_fake0123", "title": "Deploys", "version": "1.0.0",
		"markdownContent": "# Deploys", "riskTier": "LOW", "complexityTier": "TIER_0", "isActive": true,
		"lifecycleState": "DRAFT"}`)}}
	provider := startFakeAPI(t, api)
	cfg := provider + `
resource "intutic_sop" "deploys" {
  title            = "Deploys"
  markdown_content = "# Deploys"
  risk_tier        = "HIGH"
  complexity_tier  = "TIER_0"
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:             cfg,
				ResourceName:       "intutic_sop.deploys",
				ImportState:        true,
				ImportStateId:      "sp_1",
				ImportStatePersist: true,
				ImportStateCheck:   nullAttrs("version_counter", "content_hash"),
			},
			{
				Config: cfg,
				Check:  resource.TestCheckResourceAttr("intutic_sop.deploys", "risk_tier", "HIGH"),
			},
		},
	})
	api.mu.Lock()
	defer api.mu.Unlock()
	want := "PUT /api/v1/sops/sp_1 risk_tier=HIGH"
	if !slices.Contains(api.calls, want) {
		t.Fatalf("calls = %v, want %q", api.calls, want)
	}
}
