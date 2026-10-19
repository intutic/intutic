package provider

import (
	"encoding/json"
	"slices"
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
	if len(kinds) != 11 || !slices.Contains(kinds, "decide") {
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
			Hosts: types.ListNull(types.StringType), Context: types.ListNull(types.StringType)}
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

func TestHookRuleRolesAreWorkspaceRoles(t *testing.T) {
	for _, role := range []string{"owner", "admin", "em", "developer", "viewer", "DEVELOPER"} {
		if msg := checkHookRuleRole(role); msg != "" {
			t.Errorf("%q refused: %s", role, msg)
		}
	}
	for _, role := range []string{"contractor", "deployer", "dev"} {
		if checkHookRuleRole(role) == "" {
			t.Errorf("%q accepted as a workspace role", role)
		}
	}
}

// A decide guardrail's attributes build the IR every port of the rule
// validates, with rule_id as the IR's id; a band respaced or reordered is the
// same rule, a band moved is not.
func TestDecideIRBuildsFromItsAttributes(t *testing.T) {
	base := func(band string) guardrailModel {
		return guardrailModel{
			Kind:      types.StringValue("decide"),
			RuleID:    types.StringValue("prod-data-export"),
			On:        types.StringValue("tool_call"),
			Tools:     stringList([]string{"Bash"}),
			Questions: jsontypes.NewNormalizedValue(`{"exports":{"type":"yes_no","ask":"Does this command copy customer data out of the production database?"},"dest":{"type":"choice","ask":"Where does the data go?","options":["local_file","cloud_bucket","external_host"]}}`),
			When:      types.StringValue("exports AND dest != none_of_these"),
			Band:      jsontypes.NewNormalizedValue(band),
			Rollout:   types.StringValue("shadow"),
			// A list's zero value has no element type and equals nothing.
			Tokens: types.ListNull(types.StringType), ArgContains: types.ListNull(types.StringType), ArgNotContains: types.ListNull(types.StringType),
			Roles: types.ListNull(types.StringType), Models: types.ListNull(types.StringType), Hosts: types.ListNull(types.StringType),
			Context: types.ListNull(types.StringType),
		}
	}
	m := base(`{"yes_at":0.85,"no_below":0.15}`)
	ir, ok := m.buildIR()
	if !ok {
		t.Fatal("known model must build")
	}
	if ir["id"] != "prod-data-export" || ir["kind"] != "decide" {
		t.Fatalf("ir = %v", ir)
	}
	if reason := validateDecideIR(ir); reason != "" {
		t.Fatal(reason)
	}
	// The IR the API is sent hashes as the vectors' worked example does.
	delete(ir, "kind")
	text, _ := json.Marshal(ir)
	d := parseDecideLine(string(text))
	if hash, _ := decideRuleHash(d.rule); hash != "be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291" {
		t.Fatalf("ruleHash = %s", hash)
	}

	a, b := base(`{"yes_at":0.85,"no_below":0.15}`), base(`{ "no_below": 0.15, "yes_at": 0.85 }`)
	if !sameIR(&a, &b) {
		t.Fatal("a respaced, reordered band is the same rule")
	}
	c := base(`{"yes_at":0.9,"no_below":0.15}`)
	if sameIR(&a, &c) {
		t.Fatal("a moved band is a different rule")
	}

	w := base(`{"yes_at":0.85,"no_below":0.15}`)
	w.Questions = jsontypes.NewNormalizedValue(`{"exports":{"type":"yes_no","ask":"Does this command need permission?"}}`)
	w.When = types.StringValue("exports")
	ir, _ = w.buildIR()
	if reason := validateDecideIR(ir); reason != "decide: exports asks about approval; approval comes from the harness ask or the review queue, never from a question" {
		t.Fatalf("reason = %q", reason)
	}
}

// The vocabulary the reversibility lanes add: thirteen action tokens, and the one qualified
// token, accepted only on the left of a requires_before.
func TestActionTokensAndTheQualifiedToken(t *testing.T) {
	for _, tok := range []string{"action:migrate", "action:prod_write", "action:destroy", "action:force_push", "action:payment"} {
		if msg := checkItem("token", tok); msg != "" {
			t.Errorf("%s: %s", tok, msg)
		}
	}
	if len(grammar.ActionTokens) != 13 {
		t.Fatalf("action tokens = %v", grammar.ActionTokens)
	}
	if !slices.Equal(grammar.QualifiedTokens, []string{"action:run_tests[ok]"}) {
		t.Fatalf("qualified tokens = %v", grammar.QualifiedTokens)
	}
	if msg := checkItem("token", "action:run_tests[ok]"); msg == "" {
		t.Fatal("the qualified token is refused anywhere but the left of requires_before")
	}
	// Samples for the left side of a requires_before stay here: the control
	// plane's grammar parity test runs the file's samples through other kinds.
	for _, v := range []string{"action:run_tests[ok]", "action:run_tests", "Bash", "action:destroy"} {
		if msg := checkItem("orderingFirst", v); msg != "" {
			t.Errorf("%q should be a valid first side: %s", v, msg)
		}
	}
	for _, v := range []string{"action:deploy[ok]", "action:run_tests[OK]", "action:run_tests[failed]", "Bash[ok]", "npm test"} {
		if checkItem("orderingFirst", v) == "" {
			t.Errorf("%q should be refused as a first side", v)
		}
	}
	if msg := checkItem("orderingFirst", "action:deploy[ok]"); !strings.Contains(msg, "[ok] qualifies only action:run_tests") {
		t.Fatalf("action:deploy[ok]: %q", msg)
	}
	if grammar.Kinds["requires_before"]["first"].Item != "orderingFirst" || grammar.Kinds["forbid_after"]["first"].Item != "token" {
		t.Fatal("only requires_before's first side takes a qualified token")
	}
}
