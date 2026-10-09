package provider

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// The Guardrail IR's grammar, as packages/shared-types/src/guardrailIr.ts
// defines it: per kind, which fields it takes and their bounds, and what a
// token, literal, role, model id and egress host may be. The control plane's
// test suite derives the same table from the zod schema and runs the samples
// through it, so this file cannot drift from the API. What the grammar cannot
// say — whether the workspace has seen a tool, whether a predicate is in the
// closed DSL, credential and reserved-phrase checks — the plan asks the API
// itself (`POST /api/v1/policy-guardrails/guardrails/validate`).
//
//go:embed guardrail_ir_grammar.json
var guardrailGrammarJSON []byte

type irField struct {
	Type     string `json:"type"`
	Required bool   `json:"required"`
	Item     string `json:"item"`
	MinItems int    `json:"minItems"`
	MaxItems int    `json:"maxItems"`
	Min      int64  `json:"min"`
	Max      int64  `json:"max"`
	Value    int64  `json:"value"`
}

type irGrammar struct {
	Kinds             map[string]map[string]irField `json:"kinds"`
	ActionTokens      []string                      `json:"actionTokens"`
	KnownHarnessTools []string                      `json:"knownHarnessTools"`
	Taints            []string                      `json:"taints"`
	Patterns          map[string]string             `json:"patterns"`
	Limits            struct {
		TitleMaxChars       int `json:"titleMaxChars"`
		RationaleMaxChars   int `json:"rationaleMaxChars"`
		LiteralMaxChars     int `json:"literalMaxChars"`
		HostMaxChars        int `json:"hostMaxChars"`
		MinEgressCidrPrefix int `json:"minEgressCidrPrefix"`
	} `json:"limits"`
}

var grammar = func() irGrammar {
	var g irGrammar
	if err := json.Unmarshal(guardrailGrammarJSON, &g); err != nil {
		panic(err)
	}
	return g
}()

var (
	tokenRE = regexp.MustCompile(grammar.Patterns["token"])
	roleRE  = regexp.MustCompile(grammar.Patterns["role"])
	modelRE = regexp.MustCompile(grammar.Patterns["model"])
)

// guardrailKinds lists the IR kinds an authored guardrail may have: every
// kind but `none`, which enforces nothing.
func guardrailKinds() []string {
	kinds := make([]string, 0, len(grammar.Kinds))
	for k := range grammar.Kinds {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	return kinds
}

// jsLength is a string's length as JavaScript counts it (UTF-16 code units),
// which is what zod's .min/.max compare.
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// checkItem says why value is not a valid item of its kind, or "".
func checkItem(item, value string) string {
	switch item {
	case "token":
		if strings.HasPrefix(value, "action:") && !slices.Contains(grammar.ActionTokens, value) {
			return fmt.Sprintf("%q is not one of the action tokens (%s)", value, strings.Join(grammar.ActionTokens, ", "))
		}
		if !tokenRE.MatchString(value) {
			return fmt.Sprintf("%q is not a token: a token is a tool name (Bash, mcp__github__create_issue) or an action token, never a command", value)
		}
		for _, known := range grammar.KnownHarnessTools {
			// The API folds a known tool to its canonical spelling; written any
			// other way, every plan would show the difference again.
			if value != known && strings.EqualFold(value, known) {
				return fmt.Sprintf("write %q as %q, its canonical spelling", value, known)
			}
		}
	case "literal":
		if n := jsLength(value); n < 1 || n > grammar.Limits.LiteralMaxChars {
			return fmt.Sprintf("a literal is 1 to %d characters", grammar.Limits.LiteralMaxChars)
		}
		if strings.ContainsAny(value, "\t\r\n\"\\") {
			return "a literal may not contain a tab, newline, double quote or backslash"
		}
	case "role":
		if !roleRE.MatchString(value) {
			return fmt.Sprintf("%q is not a role: a role is lower-case, such as deployer or reviewer", value)
		}
	case "model":
		if !modelRE.MatchString(value) {
			return fmt.Sprintf("%q is not a model id: one token, such as claude-sonnet-4-5 or gpt-4o", value)
		}
	case "host":
		if !isEgressHostEntry(value) {
			return fmt.Sprintf("%q is not an egress entry: a host (api.example.com), a suffix with at least two labels (.example.com) or an IPv4 CIDR no wider than /%d", value, grammar.Limits.MinEgressCidrPrefix)
		}
	case "taint":
		if !slices.Contains(grammar.Taints, value) {
			return fmt.Sprintf("taint must be one of %s", strings.Join(grammar.Taints, ", "))
		}
	case "title":
		if n := jsLength(value); n < 1 || n > grammar.Limits.TitleMaxChars {
			return fmt.Sprintf("a title is 1 to %d characters", grammar.Limits.TitleMaxChars)
		}
	case "rationale":
		if jsLength(value) > grammar.Limits.RationaleMaxChars {
			return fmt.Sprintf("a rationale is at most %d characters", grammar.Limits.RationaleMaxChars)
		}
	}
	return ""
}

var hostLabelRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var ipv4RE = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:/(\d{1,2}))?$`)

// isEgressHostEntry is guardrailIr.ts isEgressHostEntry: a host, a dotted
// suffix, or an IPv4 address or CIDR no wider than the minimum prefix.
func isEgressHostEntry(value string) bool {
	if value != strings.TrimSpace(value) || value == "" || jsLength(value) > grammar.Limits.HostMaxChars {
		return false
	}
	v := strings.ToLower(value)
	if m := ipv4RE.FindStringSubmatch(v); m != nil {
		for _, octet := range m[1:5] {
			n, _ := strconv.Atoi(octet)
			if n > 255 || (len(octet) > 1 && octet[0] == '0') {
				return false
			}
		}
		if m[5] == "" {
			return true
		}
		prefix, _ := strconv.Atoi(m[5])
		return prefix >= grammar.Limits.MinEgressCidrPrefix && prefix <= 32
	}
	host := strings.TrimPrefix(v, ".")
	if host == "" || len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if !hostLabelRE.MatchString(l) {
			return false
		}
	}
	last := labels[len(labels)-1]
	return strings.ContainsAny(last, "abcdefghijklmnopqrstuvwxyz")
}
