package provider

import (
	"reflect"
	"testing"

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
