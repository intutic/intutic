package provider

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// The samples in guardrail_ir_grammar.json are classified by the control
// plane's test suite through the zod schema (and isEgressHostEntry); this
// test classifies the same samples through the Go checks. Together they pin
// the two implementations to one answer per sample.
func TestGrammarSamplesAgreeWithTheIR(t *testing.T) {
	var file struct {
		Samples map[string]struct {
			Valid   []string `json:"valid"`
			Invalid []string `json:"invalid"`
		} `json:"samples"`
	}
	if err := json.Unmarshal(guardrailGrammarJSON, &file); err != nil {
		t.Fatal(err)
	}
	for _, item := range []string{"token", "literal", "role", "model", "host"} {
		s, ok := file.Samples[item]
		if !ok || len(s.Valid) == 0 || len(s.Invalid) == 0 {
			t.Fatalf("no samples for %s", item)
		}
		for _, v := range s.Valid {
			if msg := checkItem(item, v); msg != "" {
				t.Errorf("%s %q should be valid: %s", item, v, msg)
			}
		}
		for _, v := range s.Invalid {
			if checkItem(item, v) == "" {
				t.Errorf("%s %q should be refused", item, v)
			}
		}
	}
}

func TestTokensAreHeldToTheValidatorsVocabulary(t *testing.T) {
	// A made-up action is refused by the validator's ir_vocabulary check, not by the shape.
	if msg := checkItem("token", "action:launch"); !strings.Contains(msg, "action tokens") {
		t.Fatalf("action:launch: %q", msg)
	}
	// The API folds a known tool's case; Terraform cannot, so the plan asks for the canonical spelling.
	if msg := checkItem("token", "webfetch"); !strings.Contains(msg, `"WebFetch"`) {
		t.Fatalf("webfetch: %q", msg)
	}
	if msg := checkItem("token", "mcp__github__create_issue"); msg != "" {
		t.Fatal(msg)
	}
}

func TestEveryKindButNoneIsAuthorable(t *testing.T) {
	kinds := guardrailKinds()
	if len(kinds) != 10 {
		t.Fatalf("kinds = %v", kinds)
	}
	for _, k := range kinds {
		if k == "none" {
			t.Fatal("none enforces nothing and is not authorable")
		}
	}
}

func TestBuildIRSendsOnlySetFieldsAndPinsTheWasmVerdict(t *testing.T) {
	m := guardrailModel{
		Kind:           types.StringValue("hook_rule"),
		Title:          types.StringValue("T"),
		Tools:          stringList([]string{"Bash"}),
		ArgContains:    stringList([]string{"terraform apply"}),
		ArgNotContains: types.ListNull(types.StringType),
		Tokens:         types.ListNull(types.StringType),
		Roles:          types.ListNull(types.StringType),
		Models:         types.ListNull(types.StringType),
		Hosts:          types.ListNull(types.StringType),
		Predicate:      jsontypes.NewNormalizedNull(),
	}
	ir, ok := m.buildIR()
	if !ok {
		t.Fatal("known model must build")
	}
	got, _ := json.Marshal(ir)
	if string(got) != `{"argContains":["terraform apply"],"kind":"hook_rule","title":"T","tools":["Bash"]}` {
		t.Fatalf("ir = %s", got)
	}

	w := guardrailModel{Kind: types.StringValue("wasm_predicate"), Title: types.StringValue("T"), Rationale: types.StringValue("R"),
		Predicate: jsontypes.NewNormalizedValue(`{"all":[]}`), Tools: types.ListNull(types.StringType), Tokens: types.ListNull(types.StringType),
		ArgContains: types.ListNull(types.StringType), ArgNotContains: types.ListNull(types.StringType), Roles: types.ListNull(types.StringType),
		Models: types.ListNull(types.StringType), Hosts: types.ListNull(types.StringType)}
	ir, _ = w.buildIR()
	if ir["verdict"] != wasmVerdict {
		t.Fatalf("verdict = %v", ir["verdict"])
	}

	m.Tools = types.ListUnknown(types.StringType)
	if _, ok := m.buildIR(); ok {
		t.Fatal("an unknown attribute must defer the IR")
	}
}

func TestSameIRReadsPredicatesSemantically(t *testing.T) {
	base := func(pred string) guardrailModel {
		return guardrailModel{Kind: types.StringValue("wasm_predicate"), Predicate: jsontypes.NewNormalizedValue(pred),
			Tools: types.ListNull(types.StringType), Tokens: types.ListNull(types.StringType), ArgContains: types.ListNull(types.StringType),
			ArgNotContains: types.ListNull(types.StringType), Roles: types.ListNull(types.StringType), Models: types.ListNull(types.StringType),
			Hosts: types.ListNull(types.StringType)}
	}
	a, b := base(`{"all":[{"field":"depth","op":"atLeast","value":3}]}`), base("{ \"all\": [ { \"value\": 3, \"op\": \"atLeast\", \"field\": \"depth\" } ] }")
	if !sameIR(&a, &b) {
		t.Fatal("respaced and reordered JSON is the same predicate")
	}
	c := base(`{"all":[{"field":"depth","op":"atLeast","value":4}]}`)
	if sameIR(&a, &c) {
		t.Fatal("a different value is a different rule")
	}
	d := base(`{"all":[]}`)
	d.Roles = stringList([]string{"deployer"})
	e := base(`{"all":[]}`)
	if sameIR(&d, &e) {
		t.Fatal("a role is part of the rule")
	}
}
