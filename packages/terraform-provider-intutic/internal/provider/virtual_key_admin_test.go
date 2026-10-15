package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func writeJSON(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }

func fakeKeyJSON(id string) map[string]any {
	return map[string]any{
		"keyId": id, "keyPrefix": "vk_fake" + id[len(id)-2:], "label": "ci", "scopes": []string{"*"}, "allowedModels": nil,
		"expiresAt": nil, "revokedAt": nil, "createdAt": "2026-10-15T00:00:00.000Z", "isServiceAccount": false,
		"budgets": []any{}, "rateLimit": map[string]any{"rpm": nil, "tpm": nil},
	}
}

// serveKeys fakes the virtual-key routes a key resource calls.
func (f *fakeAPI) serveKeys(w http.ResponseWriter, r *http.Request) {
	if f.keys == nil {
		f.keys = map[string]bool{}
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/keys":
		id := fmt.Sprintf("key_fake%02d", len(f.keys)+1)
		f.keys[id] = true
		f.record(r, id)
		body := fakeKeyJSON(id)
		body["key"] = "vk_" + strings.Repeat("x", 8) + id
		w.WriteHeader(http.StatusCreated)
		writeJSON(w, body)
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/keys":
		data := []any{}
		if !f.keysOwnedByAnother {
			for id, live := range f.keys {
				k := fakeKeyJSON(id)
				if !live {
					k["revokedAt"] = "2026-10-15T01:00:00.000Z"
				}
				data = append(data, k)
			}
		}
		writeJSON(w, map[string]any{"data": data})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/budget/keys":
		rows := []any{}
		for id, live := range f.keys {
			if live {
				k := fakeKeyJSON(id)
				rows = append(rows, map[string]any{
					"keyId": id, "keyPrefix": k["keyPrefix"], "label": "ci", "memberId": "mbr_other", "memberEmail": "dev@example.com",
					"budgets": []any{}, "rateLimit": map[string]any{"rpm": nil, "tpm": nil}, "spendTodayUsd": 0, "spendThisMonthUsd": 0,
				})
			}
		}
		writeJSON(w, map[string]any{"keys": rows})
	case r.Method == http.MethodDelete:
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/keys/")
		f.record(r, "")
		if !f.keys[id] {
			w.WriteHeader(http.StatusNotFound)
			writeJSON(w, map[string]any{"error": "API key not found", "code": "E_NOT_FOUND"})
			return
		}
		f.keys[id] = false
		writeJSON(w, map[string]any{"revoked": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// A key another member's credentials created is still in the workspace: an
// admin running Terraform keeps it in state on refresh (it used to drop it,
// since GET /api/v1/keys lists only the caller's keys) and revokes it on
// destroy.
func TestVirtualKeyAnotherAdminKeepsAndRevokesIt(t *testing.T) {
	api := &fakeAPI{}
	provider := startFakeAPI(t, api)
	cfg := provider + `
resource "intutic_virtual_key" "k" {
  label = "ci"
}`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		CheckDestroy: func(*terraform.State) error {
			api.mu.Lock()
			defer api.mu.Unlock()
			if !slices.Contains(api.calls, "DELETE /api/v1/keys/key_fake01") {
				return fmt.Errorf("destroy sent no revoke; calls: %v", api.calls)
			}
			if api.keys["key_fake01"] {
				return fmt.Errorf("the key is still live after destroy")
			}
			return nil
		},
		Steps: []resource.TestStep{
			{Config: cfg, Check: resource.TestCheckResourceAttr("intutic_virtual_key.k", "id", "key_fake01")},
			{
				PreConfig: func() {
					api.mu.Lock()
					api.keysOwnedByAnother = true
					api.mu.Unlock()
				},
				Config:   cfg,
				PlanOnly: true,
			},
		},
	})
}
