package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// serveOptimizerSettings fakes GET and PUT /api/v1/dream-cycle/settings. Like
// the route, a PUT without autoThreshold sets 0.85.
func (f *fakeAPI) serveOptimizerSettings(w http.ResponseWriter, r *http.Request) {
	if f.optimizerMode == "" {
		f.optimizerMode, f.optimizerThreshold = "manual", 0.85
	}
	if r.Method == http.MethodPut {
		var body struct {
			Mode          string   `json:"mode"`
			AutoThreshold *float64 `json:"autoThreshold"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		threshold := 0.85
		if body.AutoThreshold != nil {
			threshold = *body.AutoThreshold
		}
		f.record(r, fmt.Sprintf("mode=%s autoThreshold=%v", body.Mode, threshold))
		f.optimizerMode, f.optimizerThreshold = body.Mode, threshold
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "settings": map[string]any{
		"workspaceId": fakeWorkspaceID, "mode": f.optimizerMode, "autoThreshold": f.optimizerThreshold,
	}})
}

func (f *fakeAPI) optimizerPuts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "PUT "+optimizerSettingsPath+" ") {
			out = append(out, c)
		}
	}
	return out
}

// The PUT resets an omitted threshold to 0.85, so a configuration without
// auto_threshold must send the workspace's current one back, on create and on
// every later change; destroy sets the mode back to manual and keeps it.
func TestSopOptimizerSettingsKeepsAnUnconfiguredThreshold(t *testing.T) {
	api := &fakeAPI{optimizerMode: "manual", optimizerThreshold: 0.72}
	provider := startFakeAPI(t, api)
	cfg := func(mode string) string {
		return provider + fmt.Sprintf(`
resource "intutic_sop_optimizer_settings" "this" {
  mode = %q
}`, mode)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config: cfg("auto"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("intutic_sop_optimizer_settings.this", "id", fakeWorkspaceID),
					resource.TestCheckResourceAttr("intutic_sop_optimizer_settings.this", "mode", "auto"),
					resource.TestCheckResourceAttr("intutic_sop_optimizer_settings.this", "auto_threshold", "0.72"),
				),
			},
			{Config: cfg("auto"), PlanOnly: true},
			{
				Config: provider + `
resource "intutic_sop_optimizer_settings" "this" {
  mode           = "auto"
  auto_threshold = 0.9
}`,
				Check: resource.TestCheckResourceAttr("intutic_sop_optimizer_settings.this", "auto_threshold", "0.9"),
			},
			// Removing auto_threshold from the configuration keeps the last one.
			{
				Config: cfg("manual"),
				Check:  resource.TestCheckResourceAttr("intutic_sop_optimizer_settings.this", "auto_threshold", "0.9"),
			},
		},
		CheckDestroy: func(*terraform.State) error {
			api.mu.Lock()
			defer api.mu.Unlock()
			if api.optimizerMode != "manual" || api.optimizerThreshold != 0.9 {
				return fmt.Errorf("after destroy: mode %s, threshold %v; want manual, 0.9", api.optimizerMode, api.optimizerThreshold)
			}
			return nil
		},
	})
	want := []string{
		"PUT " + optimizerSettingsPath + " mode=auto autoThreshold=0.72",
		"PUT " + optimizerSettingsPath + " mode=auto autoThreshold=0.9",
		"PUT " + optimizerSettingsPath + " mode=manual autoThreshold=0.9",
		"PUT " + optimizerSettingsPath + " mode=manual autoThreshold=0.9",
	}
	if got := api.optimizerPuts(); !slices.Equal(got, want) {
		t.Fatalf("PUTs = %v, want %v", got, want)
	}
}

// The route serves the key's workspace whatever id it is given, as the budget
// route does, so an import of another workspace's id is refused.
func TestSopOptimizerSettingsImportRefusesAnotherWorkspace(t *testing.T) {
	provider := startFakeAPI(t, &fakeAPI{optimizerMode: "auto", optimizerThreshold: 0.9})
	cfg := provider + `
resource "intutic_sop_optimizer_settings" "this" {
  mode           = "auto"
  auto_threshold = 0.9
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config:        cfg,
				ResourceName:  "intutic_sop_optimizer_settings.this",
				ImportState:   true,
				ImportStateId: "ws_someone_else",
				ExpectError:   regexp.MustCompile(`Wrong workspace`),
			},
			{
				Config:             cfg,
				ResourceName:       "intutic_sop_optimizer_settings.this",
				ImportState:        true,
				ImportStateId:      fakeWorkspaceID,
				ImportStatePersist: true,
			},
			{Config: cfg, PlanOnly: true},
		},
	})
}
