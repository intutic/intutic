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
	mu      sync.Mutex
	servers []*fakeMcpServer
	calls   []string
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
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, `{"error":"fake API has no %s %s"}`, r.Method, r.URL.Path)
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
