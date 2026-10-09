package provider

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"strings"
)

// The keys `PUT /api/v1/workspace/settings` accepts. Its schema is `.strict()`,
// so any other top-level key is a 400; its `featureFlags` object is not strict
// and silently drops a flag it does not know, so those are listed too. The
// control plane's test suite asserts this file matches the route's schema.
//
//go:embed workspace_settings_keys.json
var settingsKeysJSON []byte

var settingsKeys = func() struct {
	Keys         []string `json:"keys"`
	FeatureFlags []string `json:"featureFlags"`
} {
	var k struct {
		Keys         []string `json:"keys"`
		FeatureFlags []string `json:"featureFlags"`
	}
	if err := json.Unmarshal(settingsKeysJSON, &k); err != nil {
		panic(err)
	}
	return k
}()

const featureFlagsKey = "featureFlags"

// redactedSentinel is what GET returns in place of a stored BYOC credential.
// The PUT treats it as "keep the stored secret".
const redactedSentinel = "__redacted__"

// settingsObject is a settings document as Terraform manages it: only the keys
// the configuration sets.
type settingsObject map[string]json.RawMessage

func parseSettings(s string) (settingsObject, error) {
	var obj settingsObject
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return nil, err
	}
	if obj == nil {
		return nil, fmt.Errorf("settings must be a JSON object")
	}
	return obj, nil
}

// validateSettingsKeys reports every key the PUT would refuse (top level) or
// silently drop (feature flags), so the plan fails instead of the apply — or,
// for a dropped flag, instead of a diff that never converges.
func validateSettingsKeys(obj settingsObject) []string {
	var problems []string
	for k, v := range obj {
		if !slices.Contains(settingsKeys.Keys, k) {
			problems = append(problems, fmt.Sprintf("%q is not a workspace setting the API accepts", k))
			continue
		}
		if k != featureFlagsKey {
			continue
		}
		var flags map[string]json.RawMessage
		if err := json.Unmarshal(v, &flags); err != nil || flags == nil {
			problems = append(problems, "featureFlags must be an object of booleans")
			continue
		}
		for f := range flags {
			if !slices.Contains(settingsKeys.FeatureFlags, f) {
				problems = append(problems, fmt.Sprintf("featureFlags.%s is not a feature flag the API stores", f))
			}
		}
	}
	sort.Strings(problems)
	return problems
}

// projectSettings is the server's view of exactly what `managed` covers.
//
// A top-level key is managed whole, because the PUT replaces a top-level value
// whole. `featureFlags` is the exception: the PUT merges it flag by flag, so a
// configuration manages only the flags it names, and flags set elsewhere are
// neither compared nor written. A key missing on the server reads as null,
// which is how a cleared `sso_group_policy` is stored. A redacted credential
// keeps the configured value, since the API never returns the real one.
func projectSettings(server, managed settingsObject) settingsObject {
	out := settingsObject{}
	for k, want := range managed {
		got, ok := server[k]
		if !ok {
			got = json.RawMessage("null")
		}
		if k == featureFlagsKey {
			got = projectFlags(got, want)
		}
		out[k] = keepRedacted(got, want)
	}
	return out
}

func projectFlags(server, managed json.RawMessage) json.RawMessage {
	var want, have map[string]json.RawMessage
	if json.Unmarshal(managed, &want) != nil || want == nil {
		return server
	}
	_ = json.Unmarshal(server, &have)
	out := map[string]json.RawMessage{}
	for f := range want {
		if v, ok := have[f]; ok {
			out[f] = v
		} else {
			out[f] = json.RawMessage("null")
		}
	}
	b, _ := json.Marshal(out)
	return b
}

// keepRedacted replaces each redacted string in server with the string the
// configuration holds at the same path.
func keepRedacted(server, managed json.RawMessage) json.RawMessage {
	if !strings.Contains(string(server), redactedSentinel) {
		return server
	}
	var s, m any
	if json.Unmarshal(server, &s) != nil || json.Unmarshal(managed, &m) != nil {
		return server
	}
	b, err := json.Marshal(mergeRedacted(s, m))
	if err != nil {
		return server
	}
	return b
}

func mergeRedacted(server, managed any) any {
	switch sv := server.(type) {
	case string:
		if mv, ok := managed.(string); ok && sv == redactedSentinel {
			return mv
		}
		return sv
	case map[string]any:
		mm, _ := managed.(map[string]any)
		for k, v := range sv {
			sv[k] = mergeRedacted(v, mm[k])
		}
		return sv
	case []any:
		ma, _ := managed.([]any)
		for i, v := range sv {
			var mv any
			if i < len(ma) {
				mv = ma[i]
			}
			sv[i] = mergeRedacted(v, mv)
		}
		return sv
	default:
		return server
	}
}

// changedSettings is the PUT body for moving from prior to next: the top-level
// keys whose value changed, and within featureFlags only the flags that
// changed. Sending an unchanged key is not harmless — a PUT naming a knob a
// posture governs clears that posture's label.
func changedSettings(prior, next settingsObject) settingsObject {
	out := settingsObject{}
	for k, v := range next {
		pv, ok := prior[k]
		if ok && jsonEqual(pv, v) {
			continue
		}
		if k == featureFlagsKey && ok {
			if flags := changedFlags(pv, v); flags != nil {
				out[k] = flags
			}
			continue
		}
		out[k] = v
	}
	return out
}

func changedFlags(prior, next json.RawMessage) json.RawMessage {
	var p, n map[string]json.RawMessage
	_ = json.Unmarshal(prior, &p)
	if json.Unmarshal(next, &n) != nil {
		return next
	}
	out := map[string]json.RawMessage{}
	for f, v := range n {
		if pv, ok := p[f]; ok && jsonEqual(pv, v) {
			continue
		}
		out[f] = v
	}
	if len(out) == 0 {
		return nil
	}
	b, _ := json.Marshal(out)
	return b
}

func jsonEqual(a, b json.RawMessage) bool {
	var av, bv any
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return string(a) == string(b)
	}
	return reflect.DeepEqual(av, bv)
}

// differingKeys names the managed keys whose server value is not what was sent.
func differingKeys(server, want settingsObject) []string {
	var keys []string
	for k, v := range want {
		if !jsonEqual(server[k], v) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func (o settingsObject) String() string {
	b, _ := json.Marshal(map[string]json.RawMessage(o))
	return string(b)
}
