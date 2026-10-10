package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

func TestToolSwitchesTurnTheDisabledSetIntoTheWantedOne(t *testing.T) {
	got := toolSwitches([]string{"delete_repo", "push"}, []string{"delete_repo", "create_issue"})
	want := []toolSwitch{{"create_issue", false}, {"push", true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("switches = %v, want %v", got, want)
	}
	if got := toolSwitches([]string{"a"}, []string{"a"}); len(got) != 0 {
		t.Fatalf("no change must switch nothing, got %v", got)
	}
}

func TestMaskedRoutingKeyMatchesTheAPIsMask(t *testing.T) {
	// notificationHubService.ts maskSecret: `${value.slice(0, 6)}…`
	if got := maskedRoutingKey("R0UT1NGKEY0123"); got != "R0UT1N…" {
		t.Fatalf("mask = %q", got)
	}
	if got := maskedRoutingKey("abc"); got != "abc…" {
		t.Fatalf("mask = %q", got)
	}
}

func TestNotificationRuleKeepsAConfiguredRoutingKeyBehindItsMask(t *testing.T) {
	key := "R0UT1NGKEY0123"
	masked := maskedRoutingKey(key)
	m := notificationRuleModel{PagerdutyKey: types.StringValue(key), SigningSecret: types.StringNull()}

	(&apiRule{RuleID: "nr_1", Channel: "pagerduty", ChannelConfig: apiChannelConfig{PagerdutyKey: &masked}}).applyTo(&m)
	if m.PagerdutyKey.ValueString() != key {
		t.Fatalf("a matching mask must keep the configured key, got %q", m.PagerdutyKey.ValueString())
	}

	other := "XXXXXX…"
	(&apiRule{RuleID: "nr_1", Channel: "pagerduty", ChannelConfig: apiChannelConfig{PagerdutyKey: &other}}).applyTo(&m)
	if m.PagerdutyKey.ValueString() != other {
		t.Fatalf("a key changed outside Terraform must show as a difference, got %q", m.PagerdutyKey.ValueString())
	}
}

func TestNotificationRuleEventTypeMustBeOneTheAPIDispatches(t *testing.T) {
	var resp resource.SchemaResponse
	(&notificationRuleResource{}).Schema(context.Background(), resource.SchemaRequest{}, &resp)
	attribute := resp.Schema.Attributes["event_type"].(schema.StringAttribute)
	accepts := func(v string) bool {
		var out validator.StringResponse
		for _, check := range attribute.Validators {
			check.ValidateString(context.Background(), validator.StringRequest{Path: path.Root("event_type"), ConfigValue: types.StringValue(v)}, &out)
		}
		return !out.Diagnostics.HasError()
	}
	if !accepts("decision.pending") || !accepts("governance.gate.silent") {
		t.Fatal("an event type the API dispatches must be accepted")
	}
	if accepts("policy.violaton") || accepts("") {
		t.Fatal("an event type the API does not know must fail at plan time")
	}
	if len(notificationEventTypes) < 50 {
		t.Fatalf("notification_event_types.json holds %d event types; expected the whole list", len(notificationEventTypes))
	}
}

func TestNotificationRuleSigningSecretSurvivesAListRead(t *testing.T) {
	// The list never returns the secret; the one from creation must stay.
	m := notificationRuleModel{SigningSecret: types.StringValue("whsec_1")}
	(&apiRule{RuleID: "nr_1", Channel: "webhook"}).applyTo(&m)
	if m.SigningSecret.ValueString() != "whsec_1" {
		t.Fatalf("secret = %v", m.SigningSecret)
	}
	(&apiRule{RuleID: "nr_1", Channel: "slack"}).applyTo(&m)
	if !m.SigningSecret.IsNull() {
		t.Fatalf("a rule that stopped being a webhook has no secret, got %v", m.SigningSecret)
	}
}

func TestGatewayConfigBodySendsOnlySetAndChangedFlags(t *testing.T) {
	plan := gatewayModel{RequireVk: types.BoolValue(true), RequireProvisionedKey: types.BoolNull()}
	if got := gatewayConfigBody(plan, gatewayModel{}); !reflect.DeepEqual(got, map[string]any{"requireVk": true}) {
		t.Fatalf("body = %v", got)
	}
	if got := gatewayConfigBody(plan, plan); got != nil {
		t.Fatalf("an unchanged flag must not be sent, got %v", got)
	}
}

func TestGatewayLeavesUnmanagedConfigNull(t *testing.T) {
	yes := true
	m := gatewayModel{RequireVk: types.BoolNull(), RequireProvisionedKey: types.BoolValue(false)}
	(&apiGateway{GatewayID: "gw_1", Config: &apiGatewayCfg{RequireVk: &yes, RequireProvisionedKey: &yes}}).applyTo(&m)
	if !m.RequireVk.IsNull() {
		t.Fatalf("require_vk is not managed and must stay null, got %v", m.RequireVk)
	}
	if !m.RequireProvisionedKey.ValueBool() {
		t.Fatalf("require_provisioned_key must read the server value")
	}
}

func strMap(kv ...string) types.Map {
	elems := map[string]attr.Value{}
	for i := 0; i < len(kv); i += 2 {
		elems[kv[i]] = types.StringValue(kv[i+1])
	}
	return types.MapValueMust(types.StringType, elems)
}

func TestNotificationRuleRotatesOnlyAWebhookThatStaysOne(t *testing.T) {
	webhook := func(triggers types.Map) notificationRuleModel {
		return notificationRuleModel{Channel: types.StringValue("webhook"), RotateTriggers: triggers, SigningSecret: types.StringValue("whsec_old")}
	}
	state := webhook(strMap("rotated", "1"))

	if got := webhook(strMap("rotated", "1")); !got.plannedSigningSecret(&state).Equal(types.StringValue("whsec_old")) {
		t.Fatal("unchanged triggers must keep the secret")
	}
	for name, triggers := range map[string]types.Map{
		"changed": strMap("rotated", "2"),
		"removed": types.MapNull(types.StringType),
		"unknown at plan (a time_rotating rolling over)": types.MapValueMust(types.StringType, map[string]attr.Value{"rotated": types.StringUnknown()}),
	} {
		plan := webhook(triggers)
		if !plan.plannedSigningSecret(&state).IsUnknown() || !plan.rotates(&state) {
			t.Fatalf("%s triggers must rotate", name)
		}
	}
	// The existing semantics stay: a channel change issues or drops the secret
	// itself, so it is not a rotation.
	slack := notificationRuleModel{Channel: types.StringValue("slack"), RotateTriggers: types.MapNull(types.StringType)}
	if got := slack.plannedSigningSecret(&state); !got.IsNull() {
		t.Fatalf("a rule that stops being a webhook has no secret, got %v", got)
	}
	becoming := webhook(strMap("rotated", "1"))
	if !becoming.plannedSigningSecret(&slack).IsUnknown() || becoming.rotates(&slack) {
		t.Fatal("a rule that becomes a webhook gets a new secret from the update, not a rotation")
	}
}

func TestSiemMaskMatchesTheAPIsMask(t *testing.T) {
	// siem.ts maskConfig: length > 8 ? '********' + value.slice(-4) : '********'
	for in, want := range map[string]string{
		"hec-token-0123456789": "********6789",
		"12345678":             "********",
		"123456789":            "********6789",
		"":                     "********",
	} {
		if got := siemMask(in); got != want {
			t.Errorf("siemMask(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSiemDestinationKeepsAConfiguredSecretBehindItsMask(t *testing.T) {
	token := "hec-token-0123456789"
	masked := func(v string) json.RawMessage { b, _ := json.Marshal(v); return b }
	m := siemDestinationModel{
		Config:        jsontypes.NewNormalizedValue(`{"hecUrl":"https://splunk.example.com:8088"}`),
		SecretConfig:  strMap("token", token),
		SigningSecret: types.StringNull(),
	}
	read := apiSiemDestination{DestinationID: "siemdest_1", AdapterType: "splunk_hec", Config: map[string]json.RawMessage{
		"hecUrl": json.RawMessage(`"https://splunk.example.com:8088"`),
		"token":  masked(siemMask(token)),
	}}
	read.applyTo(&m)
	if !m.SecretConfig.Equal(strMap("token", token)) {
		t.Fatalf("a matching mask must keep the configured token, got %v", m.SecretConfig)
	}
	if m.Config.ValueString() != `{"hecUrl":"https://splunk.example.com:8088"}` {
		t.Fatalf("config = %s", m.Config.ValueString())
	}

	read.Config["token"] = masked(siemMask("rotated-elsewhere-9999"))
	read.applyTo(&m)
	if !m.SecretConfig.Equal(strMap("token", "********9999")) {
		t.Fatalf("a token changed outside Terraform must show as a difference, got %v", m.SecretConfig)
	}

	// An import has no configured value: the mask is what there is.
	imported := siemDestinationModel{Config: jsontypes.NewNormalizedNull(), SecretConfig: types.MapNull(types.StringType)}
	read.applyTo(&imported)
	if !imported.SecretConfig.Equal(strMap("token", "********9999")) {
		t.Fatalf("imported secret_config = %v", imported.SecretConfig)
	}
}

func TestSiemDestinationClearsARemovedCredential(t *testing.T) {
	ctx := context.Background()
	var diags diag.Diagnostics
	state := siemDestinationModel{
		Name:         types.StringValue("hook"),
		AdapterType:  types.StringValue("webhook_https"),
		Config:       jsontypes.NewNormalizedValue(`{"webhookUrl":"https://hooks.example.com/siem"}`),
		SecretConfig: strMap("authHeaderValue", "Bearer 0123456789"),
		SourceTables: types.SetValueMust(types.StringType, []attr.Value{}),
	}
	read := func(authHeaderValue string) apiSiemDestination {
		value, _ := json.Marshal(authHeaderValue)
		return apiSiemDestination{DestinationID: "siemdest_1", AdapterType: "webhook_https", Config: map[string]json.RawMessage{
			"webhookUrl":      json.RawMessage(`"https://hooks.example.com/siem"`),
			"authHeaderValue": value,
		}}
	}

	for name, secrets := range map[string]types.Map{
		"secret_config removed":  types.MapNull(types.StringType),
		"the credential removed": types.MapValueMust(types.StringType, map[string]attr.Value{}),
	} {
		plan := state
		plan.SecretConfig = secrets
		body := plan.updateBody(ctx, &state, &diags)
		cfg, _ := json.Marshal(body["config"])
		// The API keeps a credential the config leaves out; "" is what clears it.
		if string(cfg) != `{"authHeaderValue":"","webhookUrl":"https://hooks.example.com/siem"}` {
			t.Fatalf("%s: config = %s", name, cfg)
		}
		// The cleared credential reads back empty, and the state matches the plan.
		after := read("")
		after.applyTo(&plan)
		if !plan.SecretConfig.Equal(secrets) {
			t.Fatalf("%s: secret_config after the apply = %v, planned %v", name, plan.SecretConfig, secrets)
		}
	}

	// Configured as "", it stays "".
	explicit := state
	explicit.SecretConfig = strMap("authHeaderValue", "")
	after := read("")
	after.applyTo(&explicit)
	if !explicit.SecretConfig.Equal(strMap("authHeaderValue", "")) {
		t.Fatalf(`a credential configured as "" must read back as "", got %v`, explicit.SecretConfig)
	}

	// A credential set outside Terraform still shows as a difference.
	unmanaged := state
	unmanaged.SecretConfig = types.MapNull(types.StringType)
	after = read(siemMask("Bearer set-elsewhere-7777"))
	after.applyTo(&unmanaged)
	if !unmanaged.SecretConfig.Equal(strMap("authHeaderValue", "********7777")) {
		t.Fatalf("a credential set outside Terraform must show, got %v", unmanaged.SecretConfig)
	}
	if diags.HasError() {
		t.Fatal(diags)
	}
}

func TestSiemDestinationKeepsTheSigningSecretOutOfConfig(t *testing.T) {
	m := siemDestinationModel{
		Config:        jsontypes.NewNormalizedValue(`{"webhookUrl":"https://hooks.example.com/siem"}`),
		SecretConfig:  types.MapNull(types.StringType),
		SigningSecret: types.StringValue("whsec_created"),
	}
	(&apiSiemDestination{DestinationID: "siemdest_1", AdapterType: "webhook_https", Config: map[string]json.RawMessage{
		"webhookUrl":    json.RawMessage(`"https://hooks.example.com/siem"`),
		"signingSecret": json.RawMessage(`"********abcd"`),
	}}).applyTo(&m)
	if strings.Contains(m.Config.ValueString(), "signingSecret") || !m.SecretConfig.IsNull() {
		t.Fatalf("the masked signing secret belongs to neither config nor secret_config: %s %v", m.Config.ValueString(), m.SecretConfig)
	}
	if m.SigningSecret.ValueString() != "whsec_created" {
		t.Fatalf("a read must keep the secret from creation, got %v", m.SigningSecret)
	}
}

func TestSiemPlannedSigningSecret(t *testing.T) {
	dest := func(adapter string, triggers types.Map) siemDestinationModel {
		return siemDestinationModel{AdapterType: types.StringValue(adapter), RotateTriggers: triggers, SigningSecret: types.StringValue("whsec_old")}
	}
	state := dest("webhook_https", strMap("rotated", "1"))
	cases := []struct {
		name  string
		plan  siemDestinationModel
		state *siemDestinationModel
		want  types.String
	}{
		{"a new webhook destination gets one", dest("webhook_https", types.MapNull(types.StringType)), nil, types.StringUnknown()},
		{"other adapters have none", dest("splunk_hec", types.MapNull(types.StringType)), nil, types.StringNull()},
		{"unchanged triggers keep it", dest("webhook_https", strMap("rotated", "1")), &state, types.StringValue("whsec_old")},
		{"changed triggers rotate it", dest("webhook_https", strMap("rotated", "2")), &state, types.StringUnknown()},
	}
	for _, tc := range cases {
		if got := tc.plan.plannedSigningSecret(tc.state); !got.Equal(tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSiemBodiesMergeSecretsAndSendOnlyChanges(t *testing.T) {
	ctx := context.Background()
	var diags diag.Diagnostics
	state := siemDestinationModel{
		Name:            types.StringValue("splunk"),
		AdapterType:     types.StringValue("splunk_hec"),
		Config:          jsontypes.NewNormalizedValue(`{"hecUrl":"https://splunk.example.com:8088","source":"intutic"}`),
		SecretConfig:    strMap("token", "hec-token-0123456789"),
		SourceTables:    types.SetValueMust(types.StringType, []attr.Value{}),
		BatchSize:       types.Int64Value(100),
		FlushIntervalMs: types.Int64Value(60000),
		Enabled:         types.BoolValue(true),
	}
	body := state.createBody(ctx, &diags)
	cfg, _ := json.Marshal(body["config"])
	if string(cfg) != `{"hecUrl":"https://splunk.example.com:8088","source":"intutic","token":"hec-token-0123456789"}` {
		t.Fatalf("create config = %s", cfg)
	}
	if !reflect.DeepEqual(body["sourceTables"], []string{}) {
		t.Fatalf("an empty source list is sent as [], got %#v", body["sourceTables"])
	}

	disabled := state
	disabled.Enabled = types.BoolValue(false)
	if got := disabled.updateBody(ctx, &state, &diags); !reflect.DeepEqual(got, map[string]any{"isActive": false}) {
		t.Fatalf("switching off alone must send isActive alone, got %v", got)
	}
	reformatted := state
	reformatted.Config = jsontypes.NewNormalizedValue(`{ "source": "intutic", "hecUrl": "https://splunk.example.com:8088" }`)
	if got := reformatted.updateBody(ctx, &state, &diags); got != nil {
		t.Fatalf("the same config written differently must not be sent, got %v", got)
	}
	newToken := state
	newToken.SecretConfig = strMap("token", "hec-token-new-0000")
	if got := newToken.updateBody(ctx, &state, &diags); got["config"].(map[string]any)["token"] != "hec-token-new-0000" {
		t.Fatalf("a new token must send the whole config, got %v", got)
	}
	if diags.HasError() {
		t.Fatal(diags)
	}
}

// testWasmModule is the smallest module the upload route accepts — the
// header, no imports — plus a custom section carrying tag, so each tag hashes
// differently.
func testWasmModule(tag string) []byte {
	content := append([]byte{byte(len("tf-acc"))}, "tf-acc"+tag...)
	return append([]byte("\x00asm\x01\x00\x00\x00\x00"), append([]byte{byte(len(content))}, content...)...)
}

func TestReadWasmBundleHashesAndChecksTheFile(t *testing.T) {
	dir := t.TempDir()
	rule := filepath.Join(dir, "rule.wasm")
	if err := os.WriteFile(rule, testWasmModule("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, sum, err := readWasmBundle(rule)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || !hexSHA256.MatchString(sum) || sum != strings.ToLower(sum) {
		t.Fatalf("sum = %q", sum)
	}
	if err := verifyUploaded(sum, strings.ToUpper(sum)); err != nil {
		t.Fatalf("hex case is not significant, as in the proxy's binary_matches: %v", err)
	}
	if err := verifyUploaded(sum, strings.Repeat("0", 64)); err == nil {
		t.Fatal("a different stored hash must fail")
	}

	notWasm := filepath.Join(dir, "rule.rego")
	_ = os.WriteFile(notWasm, []byte("package intutic"), 0o600)
	if _, _, err := readWasmBundle(notWasm); err == nil || !strings.Contains(err.Error(), "not a WebAssembly module") {
		t.Fatalf("err = %v", err)
	}
	big := filepath.Join(dir, "big.wasm")
	_ = os.WriteFile(big, append(testWasmModule("b"), make([]byte, wasmRuleMaxBytes)...), 0o600)
	if _, _, err := readWasmBundle(big); err == nil || !strings.Contains(err.Error(), "at most 1 MB") {
		t.Fatalf("err = %v", err)
	}
}

func TestWasmRuleUpdateBodySendsOnlyApiFields(t *testing.T) {
	state := wasmRuleModel{Name: types.StringValue("r"), Description: types.StringValue(""), Enabled: types.BoolValue(true),
		Source: types.StringValue("a/rule.wasm")}
	moved := state
	moved.Source = types.StringValue("b/rule.wasm")
	if got := moved.updateBody(&state); got != nil {
		t.Fatalf("source lives in Terraform alone, got %v", got)
	}
	off := state
	off.Enabled = types.BoolValue(false)
	if got := off.updateBody(&state); !reflect.DeepEqual(got, map[string]any{"isActive": false}) {
		t.Fatalf("body = %v", got)
	}
}
