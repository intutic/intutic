package provider

import (
	_ "embed"
	"encoding/json"
	"math"
	"slices"
	"testing"
)

// decide_vectors.json is a copy of packages/shared-types/fixtures/
// decide-vectors.json, which shared-types' decideVectorsTerraformCopy test
// holds byte-identical. The TypeScript, Python and Rust ports run the same
// file; this runs every group whose layers name "go".
//
//go:embed decide_vectors.json
var decideVectorsJSON []byte

type decideVectors struct {
	Layers   map[string][]string `json:"layers"`
	Validate []struct {
		Name   string          `json:"name"`
		Raw    *string         `json:"raw"`
		Rule   json.RawMessage `json:"rule"`
		Expect struct {
			OK    bool    `json:"ok"`
			When  string  `json:"when"`
			ID    *string `json:"id"`
			Error string  `json:"error"`
		} `json:"expect"`
	} `json:"validate"`
	Hash []struct {
		Name        string          `json:"name"`
		Rule        json.RawMessage `json:"rule"`
		Input       string          `json:"input"`
		RuleHash    string          `json:"ruleHash"`
		SameAs      string          `json:"sameAs"`
		DiffersFrom string          `json:"differsFrom"`
	} `json:"hash"`
}

func loadDecideVectors(t *testing.T) decideVectors {
	t.Helper()
	var v decideVectors
	if err := json.Unmarshal(decideVectorsJSON, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The Go layer claims validate and hash, and each has cases: a group that
// lost its tag, or its cases, would pass here by running nothing.
func TestDecideVectorsClaimValidateAndHash(t *testing.T) {
	v := loadDecideVectors(t)
	for _, group := range []string{"validate", "hash"} {
		if !slices.Contains(v.Layers[group], "go") {
			t.Errorf("layers.%s does not name go", group)
		}
	}
	for group, layers := range v.Layers {
		if slices.Contains(layers, "go") && group != "validate" && group != "hash" {
			t.Errorf("layers.%s names go, which this test does not run", group)
		}
	}
	if len(v.Validate) < 100 || len(v.Hash) == 0 {
		t.Fatalf("validate has %d cases, hash %d", len(v.Validate), len(v.Hash))
	}
}

func TestDecideValidateVectors(t *testing.T) {
	for _, c := range loadDecideVectors(t).Validate {
		t.Run(c.Name, func(t *testing.T) {
			// The raw line, or the rule as JSON: its bytes parse to the value
			// JSON.stringify(rule) would.
			line := string(c.Rule)
			if c.Raw != nil {
				line = *c.Raw
			}
			d := parseDecideLine(line)
			if c.Expect.OK {
				if d.rule == nil {
					t.Fatalf("refused: %s", d.error)
				}
				if got := canonicalWhen(d.expr); got != c.Expect.When {
					t.Fatalf("when = %q, want %q", got, c.Expect.When)
				}
				return
			}
			if d.rule != nil {
				t.Fatalf("accepted; want %q", c.Expect.Error)
			}
			if d.error != c.Expect.Error {
				t.Fatalf("error = %q\n want %q", d.error, c.Expect.Error)
			}
			if (d.id == nil) != (c.Expect.ID == nil) || (d.id != nil && *d.id != *c.Expect.ID) {
				t.Fatalf("id = %v, want %v", deref(d.id), deref(c.Expect.ID))
			}
		})
	}
}

func TestDecideHashVectors(t *testing.T) {
	v := loadDecideVectors(t)
	byName := map[string]string{}
	for _, c := range v.Hash {
		byName[c.Name] = c.RuleHash
	}
	for _, c := range v.Hash {
		t.Run(c.Name, func(t *testing.T) {
			d := parseDecideLine(string(c.Rule))
			if d.rule == nil {
				t.Fatalf("refused: %s", d.error)
			}
			input, err := decideHashInput(d.rule)
			if err != nil {
				t.Fatal(err)
			}
			if input != c.Input {
				t.Fatalf("hash input\n got %s\nwant %s", input, c.Input)
			}
			hash, _ := decideRuleHash(d.rule)
			if hash != c.RuleHash {
				t.Fatalf("ruleHash = %s, want %s", hash, c.RuleHash)
			}
			if c.SameAs != "" && hash != byName[c.SameAs] {
				t.Fatalf("differs from %q", c.SameAs)
			}
			if c.DiffersFrom != "" && hash == byName[c.DiffersFrom] {
				t.Fatalf("same as %q", c.DiffersFrom)
			}
		})
	}
	if byName["the LLD example"] != "be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291" {
		t.Fatal("the LLD worked example's hash moved")
	}
}

// The hash input writes numbers as JSON.stringify does; the vectors' bands
// only reach a few of its branches.
func TestJSNumberMatchesJSONStringify(t *testing.T) {
	tenth := 0.1 // a variable, so 0.1 + 0.2 is float64 arithmetic, not an exact constant
	for _, c := range []struct {
		x    float64
		want string
	}{
		{0.85, "0.85"}, {0.15, "0.15"}, {tenth + 2*tenth, "0.30000000000000004"}, {1, "1"}, {-2.5, "-2.5"},
		{math.Copysign(0, -1), "0"}, {1e-6, "0.000001"}, {1e-7, "1e-7"}, {1.5e-7, "1.5e-7"},
		{123456789012345680000, "123456789012345680000"}, {1e21, "1e+21"}, {1.25e22, "1.25e+22"},
		{5e-324, "5e-324"}, {math.Inf(1), "null"},
	} {
		if got := jsNumber(c.x); got != c.want {
			t.Errorf("jsNumber(%v) = %q, want %q", c.x, got, c.want)
		}
	}
}

// What JSON.stringify leaves alone, encoding/json escapes, and the other way round.
func TestJSStringMatchesJSONStringify(t *testing.T) {
	for in, want := range map[string]string{
		`a<b>&c`:       `"a<b>&c"`,
		"  ":           "\"  \"",
		"q\"b\\":       `"q\"b\\"`,
		"\b\f\n\r\t":   `"\b\f\n\r\t"`,
		"\x01\x1f\x7f": "\"\\u0001\\u001f\x7f\"",
	} {
		if got := jsString(in); got != want {
			t.Errorf("jsString(%q) = %s, want %s", in, got, want)
		}
	}
}

// JavaScript's i flag folds ASCII letters only; Go's (?i) would also fold
// the long s and the Kelvin sign.
func TestApprovalWordingFoldsASCIIOnly(t *testing.T) {
	if !decideApprovalRE.MatchString(asciiLower("Was this APPROVED by a lead?")) {
		t.Fatal("upper-case approval wording must match")
	}
	if decideApprovalRE.MatchString(asciiLower("Does the permiſſion file change?")) {
		t.Fatal("ſ is not s to JavaScript's i flag")
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
