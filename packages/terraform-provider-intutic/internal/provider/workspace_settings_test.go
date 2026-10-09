package provider

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func obj(t *testing.T, s string) settingsObject {
	t.Helper()
	o, err := parseSettings(s)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestProjectSettingsCoversOnlyManagedKeys(t *testing.T) {
	server := obj(t, `{
		"mcpDefaultPolicy": "deny",
		"egressMode": "enforce",
		"featureFlags": {"ff_shadow_enforcement": true, "ff_bandit_routing": true},
		"ssoKeyMaxIdleDays": 30
	}`)
	managed := obj(t, `{"mcpDefaultPolicy": "allow", "featureFlags": {"ff_shadow_enforcement": false}}`)

	got := projectSettings(server, managed).String()
	want := `{"featureFlags":{"ff_shadow_enforcement":true},"mcpDefaultPolicy":"deny"}`
	if got != want {
		t.Fatalf("projection = %s, want %s", got, want)
	}
}

func TestProjectSettingsReadsAMissingKeyAsNull(t *testing.T) {
	// A cleared sso_group_policy is deleted from the stored settings, so a
	// configuration that sets it to null must read back as null, not differ.
	got := projectSettings(obj(t, `{}`), obj(t, `{"sso_group_policy": null, "featureFlags": {"ff_shadow_routing": true}}`))
	if s := got.String(); s != `{"featureFlags":{"ff_shadow_routing":null},"sso_group_policy":null}` {
		t.Fatalf("projection = %s", s)
	}
}

func TestProjectSettingsKeepsConfiguredSecretsTheAPIRedacts(t *testing.T) {
	server := obj(t, `{"byocStorage": {"provider": "s3", "bucketName": "b", "secretAccessKey": "__redacted__"}}`)
	managed := obj(t, `{"byocStorage": {"provider": "s3", "bucketName": "b", "secretAccessKey": "s3cr3t"}}`)
	if diff := differingKeys(projectSettings(server, managed), managed); len(diff) != 0 {
		t.Fatalf("a redacted secret must not read as a change; differing: %v", diff)
	}

	// A real change next to the redacted secret still shows.
	server = obj(t, `{"byocStorage": {"provider": "s3", "bucketName": "other", "secretAccessKey": "__redacted__"}}`)
	if diff := differingKeys(projectSettings(server, managed), managed); !reflect.DeepEqual(diff, []string{"byocStorage"}) {
		t.Fatalf("differing = %v", diff)
	}
}

func TestChangedSettingsSendsOnlyWhatChanged(t *testing.T) {
	prior := obj(t, `{"egressMode": "monitor", "allowedModels": ["a"], "featureFlags": {"ff_bandit_routing": true, "ff_shadow_routing": false}}`)
	next := obj(t, `{"egressMode": "monitor", "allowedModels": ["a", "b"], "featureFlags": {"ff_bandit_routing": true, "ff_shadow_routing": true}, "sandboxRequirement": "warn"}`)

	got := changedSettings(prior, next).String()
	want := `{"allowedModels":["a","b"],"featureFlags":{"ff_shadow_routing":true},"sandboxRequirement":"warn"}`
	if got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}

	if body := changedSettings(next, next); len(body) != 0 {
		t.Fatalf("no change must send nothing, got %s", body)
	}
}

func TestValidateSettingsKeys(t *testing.T) {
	problems := validateSettingsKeys(obj(t, `{
		"egressMode": "enforce",
		"pcas_strict_mode": true,
		"managedJudgeModel": "x",
		"featureFlags": {"ff_shadow_enforcement": true, "ff_made_up": true}
	}`))
	joined := strings.Join(problems, "\n")
	for _, want := range []string{`"pcas_strict_mode"`, `"managedJudgeModel"`, "featureFlags.ff_made_up"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing problem for %s in:\n%s", want, joined)
		}
	}
	if len(problems) != 3 {
		t.Errorf("want 3 problems, got %d:\n%s", len(problems), joined)
	}
	if p := validateSettingsKeys(obj(t, `{"featureFlags": "on"}`)); len(p) != 1 {
		t.Errorf("a non-object featureFlags must be refused, got %v", p)
	}
}

func TestSettingsKeysFileIsWellFormed(t *testing.T) {
	if len(settingsKeys.Keys) < 20 || len(settingsKeys.FeatureFlags) < 5 {
		t.Fatalf("implausibly few keys: %d keys, %d flags", len(settingsKeys.Keys), len(settingsKeys.FeatureFlags))
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(settingsKeysJSON, &raw); err != nil || len(raw) != 2 {
		t.Fatalf("workspace_settings_keys.json must hold exactly keys and featureFlags: %v", err)
	}
}
