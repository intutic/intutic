package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func TestCredentialPreviewIsTheAPIsPreviewField(t *testing.T) {
	bedrock := credentialProviderByID("bedrock")
	// pickPreviewField: the first password field with a value, in registry order.
	if k, v := bedrock.credentialPreview(map[string]string{"awsRegion": "us-east-1", "apiKey": "bedrock-key-abcd"}); k != "apiKey" || v != "abcd" {
		t.Fatalf("api key preview = %q %q", k, v)
	}
	pair := map[string]string{"awsRegion": "us-east-1", "awsAccessKeyId": "access-key-id-WXYZ", "awsSecretAccessKey": "secret-secret-1234", "apiKey": "bedrock-key-abcd"}
	if k, v := bedrock.credentialPreview(pair); k != "awsAccessKeyId" || v != "WXYZ" {
		t.Fatalf("access key preview = %q %q", k, v)
	}
	// The route trims before it stores and previews.
	if _, v := credentialProviderByID("openai").credentialPreview(map[string]string{"apiKey": " openai-key-9876\n"}); v != "9876" {
		t.Fatalf("trimmed preview = %q", v)
	}
	if k, _ := credentialProviderByID("vertex_ai").credentialPreview(map[string]string{"projectId": "p", "serviceAccountJson": "{}"}); k != "" {
		t.Fatalf("vertex_ai has no secret field to preview, got %q", k)
	}
}

func TestProviderCredentialReadKeepsFieldsBehindTheirLastFour(t *testing.T) {
	configured := strMap("awsRegion", "us-east-1", "apiKey", "bedrock-key-abcd")
	last := func(s string) *string { return &s }

	if got := (&apiProviderCredential{Provider: "bedrock", LastFour: last("abcd")}).readFields(configured); !got.Equal(configured) {
		t.Fatalf("a matching last four must keep the configured fields, got %v", got)
	}
	got := (&apiProviderCredential{Provider: "bedrock", LastFour: last("9999")}).readFields(configured)
	if want := strMap("awsRegion", "us-east-1", "apiKey", "********9999"); !got.Equal(want) {
		t.Fatalf("a credential replaced outside Terraform must show as a difference, got %v", got)
	}
	// An import has no fields to compare.
	if got := (&apiProviderCredential{Provider: "bedrock", LastFour: last("9999")}).readFields(types.MapNull(types.StringType)); !got.IsNull() {
		t.Fatalf("imported fields = %v", got)
	}
	// No secret field, no preview: the fields stay.
	vertex := strMap("projectId", "my-project", "serviceAccountJson", `{"type":"service_account"}`)
	if got := (&apiProviderCredential{Provider: "vertex_ai"}).readFields(vertex); !got.Equal(vertex) {
		t.Fatalf("vertex_ai fields = %v", got)
	}
}

func TestCredentialFieldErrorsMatchValidateFields(t *testing.T) {
	str := func(kv ...string) map[string]types.String {
		m := map[string]types.String{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = types.StringValue(kv[i+1])
		}
		return m
	}
	ok := []struct {
		provider string
		fields   map[string]types.String
	}{
		{"anthropic", str("apiKey", "anthropic-key-0123")},
		{"bedrock", str("awsRegion", "us-east-1", "awsAccessKeyId", "access-key-id-0000", "awsSecretAccessKey", "secret-secret-1234")},
		{"vertex_ai", str("projectId", "my-project", "location", "us-east5", "serviceAccountJson", `{"type":"service_account"}`)},
		{"azure_openai", str("endpoint", "https://acme.openai.azure.com:443/", "apiKey", "azure-key-0123")},
		{"ollama", str("apiBase", "http://localhost:11434")},
		{"bedrock", map[string]types.String{"awsRegion": types.StringValue("us-east-1"), "apiKey": types.StringUnknown()}},
	}
	for _, tc := range ok {
		if errs := credentialProviderByID(tc.provider).credentialFieldErrors(tc.fields); len(errs) != 0 {
			t.Errorf("%s %v: unexpected %v", tc.provider, tc.fields, errs)
		}
	}
}

func TestProviderCredentialLifecycleAgainstAFakeControlPlane(t *testing.T) {
	cp := newFakeCredentialAPI(t)
	defer cp.srv.Close()

	providerBlock := fmt.Sprintf(`
provider "intutic" {
  endpoint = %q
  api_key  = "vk_test"
}
`, cp.srv.URL)
	bedrock := func(key string) string {
		return providerBlock + fmt.Sprintf(`
resource "intutic_provider_credential" "bedrock" {
  provider_id = "bedrock"
  fields = {
    awsRegion = "us-east-1"
    apiKey    = %q
  }
}
`, key)
	}
	const res = "intutic_provider_credential.bedrock"

	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{
			{
				Config: bedrock("bedrock-key-0001"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr(res, "id", "bedrock"),
					resource.TestCheckResourceAttr(res, "last_four", "0001"),
					resource.TestCheckResourceAttr(res, "routing_live", "true"),
					resource.TestCheckResourceAttrSet(res, "updated_at"),
					cp.expectLastPut("bedrock", map[string]string{"awsRegion": "us-east-1", "apiKey": "bedrock-key-0001"}),
				),
			},
			{
				// Changing fields rotates in place.
				Config: bedrock("bedrock-key-0002"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr(res, "id", "bedrock"),
					resource.TestCheckResourceAttr(res, "last_four", "0002"),
					cp.expectLastPut("bedrock", map[string]string{"awsRegion": "us-east-1", "apiKey": "bedrock-key-0002"}),
				),
			},
			{
				// Rotated in the dashboard: the last four differ, so the plan sends fields again.
				PreConfig:          func() { cp.set("bedrock", map[string]string{"awsRegion": "us-east-1", "apiKey": "dashboard-key-9999"}) },
				Config:             bedrock("bedrock-key-0002"),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{
				Config: bedrock("bedrock-key-0002"),
				Check:  resource.TestCheckResourceAttr(res, "last_four", "0002"),
			},
			{
				// Removed outside Terraform: provisioned=false drops it from state.
				PreConfig:          func() { cp.remove("bedrock") },
				Config:             bedrock("bedrock-key-0002"),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{
				Config: bedrock("bedrock-key-0002"),
				Check:  cp.expectLastPut("bedrock", map[string]string{"awsRegion": "us-east-1", "apiKey": "bedrock-key-0002"}),
			},
			{
				ResourceName:            res,
				ImportState:             true,
				ImportStateId:           "bedrock",
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"fields"},
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if !cp.deleted("bedrock") {
				return fmt.Errorf("destroy sent no DELETE %s/bedrock", providerCredentialPath)
			}
			return nil
		},
	})
}

// fakeCredentialAPI is the three provider-credential routes over a map.
type fakeCredentialAPI struct {
	t       *testing.T
	srv     *httptest.Server
	mu      sync.Mutex
	stored  map[string]map[string]string
	lastPut map[string]map[string]string
	deletes map[string]int
}

func newFakeCredentialAPI(t *testing.T) *fakeCredentialAPI {
	f := &fakeCredentialAPI{t: t, stored: map[string]map[string]string{}, lastPut: map[string]map[string]string{}, deletes: map[string]int{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *fakeCredentialAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer vk_test" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	id, one := strings.CutPrefix(r.URL.Path, providerCredentialPath+"/")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == providerCredentialPath:
		data := []map[string]any{}
		for _, p := range credentialProviders {
			data = append(data, f.status(p.ID))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	case r.Method == http.MethodPut && one:
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"Invalid JSON body"}`))
			return
		}
		f.stored[id], f.lastPut[id] = body, body
		_ = json.NewEncoder(w).Encode(f.status(id))
	case r.Method == http.MethodDelete && one:
		delete(f.stored, id)
		f.deletes[id]++
		_ = json.NewEncoder(w).Encode(map[string]any{"provider": id, "provisioned": false})
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeCredentialAPI) status(id string) map[string]any {
	values, ok := f.stored[id]
	if !ok {
		return map[string]any{"provider": id, "routingLive": true, "provisioned": false, "lastFour": nil, "updatedAt": nil}
	}
	var lastFour any
	if _, v := credentialProviderByID(id).credentialPreview(values); v != "" {
		lastFour = v
	}
	return map[string]any{"provider": id, "routingLive": true, "provisioned": true, "lastFour": lastFour, "updatedAt": "2026-10-09T00:00:00.000Z"}
}

func (f *fakeCredentialAPI) set(id string, values map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stored[id] = values
}

func (f *fakeCredentialAPI) remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.stored, id)
}

func (f *fakeCredentialAPI) deleted(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, stored := f.stored[id]
	return f.deletes[id] > 0 && !stored
}

func (f *fakeCredentialAPI) expectLastPut(id string, want map[string]string) resource.TestCheckFunc {
	return func(*terraform.State) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		if got := f.lastPut[id]; !reflect.DeepEqual(got, want) {
			return fmt.Errorf("PUT %s/%s body = %v, want %v", providerCredentialPath, id, got, want)
		}
		return nil
	}
}
