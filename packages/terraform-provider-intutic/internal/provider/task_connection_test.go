package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
	tfresource "github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// fakeTaskToken is assembled at runtime: no credential-shaped literal in source.
var fakeTaskToken = strings.Join([]string{"fake", "task", "token"}, "-")

type fakeTaskConnection struct {
	apiTaskConnection
	token        string
	accountEmail string
}

// serveTaskConnections fakes routes/taskManagement.ts: the list, a create
// that refuses Jira without an account email, and a DELETE that answers
// `deleted: false` for an id it does not have.
func (f *fakeAPI) serveTaskConnections(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, taskConnectionPath), "/")
	switch {
	case r.Method == http.MethodGet && id == "":
		items := make([]apiTaskConnection, 0, len(f.taskConnections))
		for _, c := range f.taskConnections {
			items = append(items, c.apiTaskConnection)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items, "listProperty": "items", "rowCase": "camel"})
	case r.Method == http.MethodPost && id == "":
		var body struct {
			Provider   string `json:"provider"`
			BaseURL    string `json:"baseUrl"`
			AuthToken  string `json:"authToken"`
			ProjectKey string `json:"projectKey"`
			Metadata   struct {
				AccountEmail string `json:"accountEmail"`
			} `json:"metadata"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.record(r, fmt.Sprintf("%s %s token=%v email=%s", body.Provider, body.ProjectKey, body.AuthToken == fakeTaskToken, body.Metadata.AccountEmail))
		if body.Provider == "jira" && body.Metadata.AccountEmail == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"Validation failed"}`))
			return
		}
		c := &fakeTaskConnection{
			apiTaskConnection: apiTaskConnection{
				ConnectionID: fmt.Sprintf("cc_%d", len(f.calls)),
				Provider:     body.Provider,
				BaseURL:      body.BaseURL,
				ProjectKey:   body.ProjectKey,
				Status:       "connected",
				CreatedAt:    "2026-10-15T00:00:00.000Z",
			},
			token:        body.AuthToken,
			accountEmail: body.Metadata.AccountEmail,
		}
		f.taskConnections = append(f.taskConnections, c)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(c.apiTaskConnection)
	case r.Method == http.MethodDelete && id != "":
		f.record(r, "")
		n := len(f.taskConnections)
		f.taskConnections = slices.DeleteFunc(f.taskConnections, func(c *fakeTaskConnection) bool { return c.ConnectionID == id })
		_ = json.NewEncoder(w).Encode(map[string]bool{"deleted": len(f.taskConnections) < n})
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, `{"error":"fake API has no %s %s"}`, r.Method, r.URL.Path)
	}
}

func (f *fakeAPI) taskCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.Contains(c, taskConnectionPath) {
			out = append(out, c)
		}
	}
	return out
}

func taskConnectionConfig(provider, projectKey string) string {
	return provider + fmt.Sprintf(`
resource "intutic_task_connection" "jira" {
  task_provider = "jira"
  base_url      = "https://acme.atlassian.net"
  project_key   = %q
  account_email = "dev@example.com"
  api_token     = %q
}`, projectKey, fakeTaskToken)
}

// Create sends the token and the Jira account email; nothing reads them back,
// so a re-plan is empty. With no update route, a changed argument replaces
// the connection; one deleted outside Terraform leaves state; an import has no
// token, so the next apply replaces it.
func TestTaskConnectionLifecycle(t *testing.T) {
	api := &fakeAPI{}
	provider := startFakeAPI(t, api)
	const name = "intutic_task_connection.jira"
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []tfresource.TestStep{
			{
				Config: taskConnectionConfig(provider, "PROJ"),
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttrSet(name, "id"),
					tfresource.TestCheckResourceAttr(name, "status", "connected"),
					tfresource.TestCheckResourceAttr(name, "created_at", "2026-10-15T00:00:00.000Z"),
					tfresource.TestCheckResourceAttr(name, "api_token", fakeTaskToken),
					tfresource.TestCheckResourceAttr(name, "account_email", "dev@example.com"),
				),
			},
			{
				Config:           taskConnectionConfig(provider, "PROJ"),
				ConfigPlanChecks: tfresource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: taskConnectionConfig(provider, "OPS"),
				ConfigPlanChecks: tfresource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(name, plancheck.ResourceActionDestroyBeforeCreate),
				}},
				Check: tfresource.TestCheckResourceAttr(name, "project_key", "OPS"),
			},
			{
				Config:                  taskConnectionConfig(provider, "OPS"),
				ResourceName:            name,
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"api_token", "account_email"},
			},
			{
				Config: taskConnectionConfig(provider, "OPS"),
				PreConfig: func() {
					api.mu.Lock()
					api.taskConnections = nil
					api.mu.Unlock()
				},
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
		},
		CheckDestroy: func(*terraform.State) error {
			api.mu.Lock()
			defer api.mu.Unlock()
			if len(api.taskConnections) != 0 {
				return fmt.Errorf("%d task connection(s) left after destroy", len(api.taskConnections))
			}
			return nil
		},
	})
	calls := api.taskCalls()
	want := []string{
		"POST " + taskConnectionPath + " jira PROJ token=true email=dev@example.com",
		"POST " + taskConnectionPath + " jira OPS token=true email=dev@example.com",
	}
	var posts []string
	for _, c := range calls {
		if strings.HasPrefix(c, "POST ") {
			posts = append(posts, c)
		}
	}
	if !slices.Equal(posts, want) {
		t.Fatalf("POSTs = %v, want %v", posts, want)
	}
}

// An imported connection has no token in state; the configured one is sent
// by replacing it, since the API has no update.
func TestTaskConnectionImportReplacesOnFirstApply(t *testing.T) {
	api := &fakeAPI{taskConnections: []*fakeTaskConnection{{apiTaskConnection: apiTaskConnection{
		ConnectionID: "cc_existing", Provider: "jira", BaseURL: "https://acme.atlassian.net", ProjectKey: "PROJ",
		Status: "connected", CreatedAt: "2026-10-01T00:00:00.000Z",
	}}}}
	provider := startFakeAPI(t, api)
	const name = "intutic_task_connection.jira"
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []tfresource.TestStep{
			{
				Config:             taskConnectionConfig(provider, "PROJ"),
				ResourceName:       name,
				ImportState:        true,
				ImportStateId:      "cc_existing",
				ImportStatePersist: true,
			},
			{
				Config: taskConnectionConfig(provider, "PROJ"),
				ConfigPlanChecks: tfresource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(name, plancheck.ResourceActionDestroyBeforeCreate),
				}},
				Check: tfresource.TestCheckResourceAttr(name, "api_token", fakeTaskToken),
			},
		},
	})
}

// The API answers `deleted: false` (200) for a connection that is already
// gone; destroy treats that as done.
func TestTaskConnectionDeleteOfAGoneConnectionSucceeds(t *testing.T) {
	ctx := context.Background()
	srv := httptest.NewServer(&fakeAPI{})
	t.Cleanup(srv.Close)
	r := &taskConnectionResource{client: client.New(srv.URL, "vk_fake", "test")}
	var s resource.SchemaResponse
	r.Schema(ctx, resource.SchemaRequest{}, &s)
	state := tfsdk.State{Schema: s.Schema, Raw: tftypes.NewValue(s.Schema.Type().TerraformType(ctx), nil)}
	if d := state.Set(ctx, &taskConnectionModel{
		ID: types.StringValue("cc_gone"), Provider: types.StringValue("linear"), BaseURL: types.StringValue("https://api.linear.app"),
		ProjectKey: types.StringValue("ENG"), AccountEmail: types.StringNull(), APIToken: types.StringValue(fakeTaskToken),
		Status: types.StringValue("connected"), CreatedAt: types.StringValue("2026-10-15T00:00:00.000Z"),
	}); d.HasError() {
		t.Fatal(d)
	}
	var resp resource.DeleteResponse
	r.Delete(ctx, resource.DeleteRequest{State: state}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("Delete of a gone connection failed: %v", resp.Diagnostics)
	}
}
