package provider

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
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
	QualifiedTokens   []string                      `json:"qualifiedTokens"`
	KnownHarnessTools []string                      `json:"knownHarnessTools"`
	Taints            []string                      `json:"taints"`
	HookRuleRoles     []string                      `json:"hookRuleRoles"`
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

// checkHookRuleRole says why role cannot scope a hook rule, or "". A hook
// rule's roles are matched against the member's workspace role at every
// gate, so the API refuses any other name on a create or an IR edit (the
// `workspace_roles` check); the plan refuses it first.
func checkHookRuleRole(role string) string {
	for _, r := range grammar.HookRuleRoles {
		if strings.EqualFold(role, r) {
			return ""
		}
	}
	return fmt.Sprintf("%q is not a workspace role: a hook rule's roles are %s", role, strings.Join(grammar.HookRuleRoles, ", "))
}

// checkItem says why value is not a valid item of its kind, or "".
func checkItem(item, value string) string {
	switch item {
	case "orderingFirst":
		// The left side of a requires_before: a token, or a qualified token
		// (action:run_tests[ok], met only when the latest test run passed).
		if slices.Contains(grammar.QualifiedTokens, value) {
			return ""
		}
		if strings.ContainsAny(value, "[]") {
			return fmt.Sprintf("%q: [ok] qualifies only action:run_tests, on the left of ->", value)
		}
		return checkItem("token", value)
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

// ─── decide ───────────────────────────────────────────────────────────
//
// The decide kind's validation and identity, a port of
// packages/shared-types/src/decide.ts. Every port runs decide_vectors.json
// (a copy of shared-types' fixtures/decide-vectors.json, held byte-identical
// by a test there) and must give the same answer, reason text included, so
// this follows the TypeScript step for step: JSON values as JSON.parse makes
// them (numbers are float64), lengths in code points, keys sorted as
// JavaScript sorts strings (UTF-16 code units), regexes ASCII-only, and
// numbers in the hash input written as JSON.stringify writes them.

const (
	decideMaxQuestions = 8
	decideMaxOptions   = 8
	decideMaxWhenChars = 256
	decideMinAskChars  = 8
	decideMaxAskChars  = 300
	decideMaxTools     = 8
	decideMaxTitle     = 80
	noneOfThese        = "none_of_these"
)

var (
	decideDefaultBand  = map[string]any{"yes_at": 0.85, "no_below": 0.15}
	decideToolTokenRE  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`)
	decideRuleIDRE     = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,47}$`)
	decideNameRE       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	decideWordNameRE   = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	decideKeywords     = []string{"AND", "OR", "NOT", "IN"}
	decideRuleFields   = []string{"id", "title", "on", "tools", "questions", "when", "band", "escalate", "rollout", "context"}
	decideQuestionKeys = []string{"type", "ask", "options", "band"}
	decideBandFields   = []string{"yes_at", "no_below"}
	// decideApprovalRE is DECIDE_APPROVAL_RE without its `i` flag. JavaScript
	// folds case for ASCII letters only there, and Go's (?i) folds Unicode
	// (ſ matches s), so the text is ASCII-lowered first (asciiLower) and
	// matched against the lower-case pattern. \b and \w are ASCII in both.
	decideApprovalRE = regexp.MustCompile(`\b(approv\w*|authori[sz]\w*|pre-?approv\w*|consent\w*|permi(t|ssion)\w*|sign(ed)?[- ]off)\b`)
)

const (
	decideEmptyLine = "decide: the line is empty; write one rule per line as `decide: {json}`"
	decideNotJSON   = "decide: the value is not JSON; write one rule per line as `decide: {json}`"
)

// decideExpr is a parsed `when`, with != and IN already rewritten. op is
// yes (q), eq (q == o), not (a), and or or (a, b).
type decideExpr struct {
	op, q, o string
	a, b     *decideExpr
}

// decideDecl is one `decide:` line, read or not. rule is nil when the line
// is unreadable; id is the line's id when it has a usable one.
type decideDecl struct {
	rule  map[string]any
	expr  *decideExpr
	id    *string
	error string
}

// decodeJSONValue is JSON.parse: one JSON value, objects as maps (the last of
// a repeated key wins), numbers as float64 (out of range is ±Inf or 0, as in
// JavaScript).
func decodeJSONValue(text string) (any, bool) {
	if !json.Valid([]byte(text)) {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	return jsNumbers(v), true
}

func jsNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		f, _ := strconv.ParseFloat(string(t), 64) // a range error still yields ±Inf or 0, as JSON.parse does
		return f
	case map[string]any:
		for k, x := range t {
			t[k] = jsNumbers(x)
		}
	case []any:
		for i, x := range t {
			t[i] = jsNumbers(x)
		}
	}
	return v
}

// jsCompare orders strings as JavaScript's default sort does: by UTF-16 code units.
func jsCompare(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

func jsSortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, jsCompare)
	return keys
}

func codePoints(s string) int { return len([]rune(s)) }

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func hasTabOrNewline(s string) bool { return strings.ContainsAny(s, "\t\r\n") }

func decideUnknownField(obj map[string]any, allowed []string) (string, bool) {
	for _, k := range jsSortedKeys(obj) {
		if !slices.Contains(allowed, k) {
			return k, true
		}
	}
	return "", false
}

func decideBandShape(v any, path string) string {
	obj, ok := v.(map[string]any)
	if !ok {
		return path + " must be an object"
	}
	if extra, ok := decideUnknownField(obj, decideBandFields); ok {
		return path + ": unknown field " + extra
	}
	yes, present := obj["yes_at"]
	if !present {
		return path + ".yes_at is required"
	}
	if f, ok := yes.(float64); !ok || !(f > 0.5 && f < 1) {
		return path + ".yes_at must be above 0.5 and below 1"
	}
	no, present := obj["no_below"]
	if !present {
		return path + ".no_below is required"
	}
	if f, ok := no.(float64); !ok || !(f > 0) {
		return path + ".no_below must be above 0"
	}
	return ""
}

func decideQuestionShape(name string, v any) string {
	path := "questions." + name
	obj, ok := v.(map[string]any)
	if !ok {
		return path + " must be an object"
	}
	if extra, ok := decideUnknownField(obj, decideQuestionKeys); ok {
		return path + ": unknown field " + extra
	}
	typ, present := obj["type"]
	if !present {
		return path + ".type is required"
	}
	if typ != "yes_no" && typ != "choice" {
		return path + ".type must be yes_no or choice"
	}
	ask, present := obj["ask"]
	if !present {
		return path + ".ask is required"
	}
	if s, ok := ask.(string); !ok || codePoints(s) < decideMinAskChars || codePoints(s) > decideMaxAskChars || hasTabOrNewline(s) {
		return fmt.Sprintf("%s.ask must be %d to %d characters with no tab or newline", path, decideMinAskChars, decideMaxAskChars)
	}
	rawOptions, hasOptions := obj["options"]
	if typ == "yes_no" {
		if hasOptions {
			return path + ".options applies to choice questions only"
		}
	} else {
		if !hasOptions {
			return path + ".options is required for a choice question"
		}
		options, ok := rawOptions.([]any)
		if !ok {
			return path + ".options must be a list"
		}
		if len(options) < 2 || len(options) > decideMaxOptions {
			return fmt.Sprintf("%s.options lists 2 to %d options", path, decideMaxOptions)
		}
		for i, o := range options {
			s, ok := o.(string)
			if !ok || !decideNameRE.MatchString(s) {
				return fmt.Sprintf("%s.options[%d] is not an option name", path, i)
			}
			if slices.Index(options, o) != i {
				return fmt.Sprintf("%s.options[%d] repeats %s", path, i, s)
			}
		}
	}
	if band, present := obj["band"]; present {
		return decideBandShape(band, path+".band")
	}
	return ""
}

func decideRuleShape(v any) string {
	obj, ok := v.(map[string]any)
	if !ok {
		return "a rule is a JSON object"
	}
	if extra, ok := decideUnknownField(obj, decideRuleFields); ok {
		return "unknown field " + extra
	}

	id, present := obj["id"]
	if !present {
		return "id is required"
	}
	if s, ok := id.(string); !ok || !decideRuleIDRE.MatchString(s) {
		return "id must be a lower-case letter, then up to 47 of a-z, 0-9, _ or -"
	}

	if title, present := obj["title"]; present {
		if s, ok := title.(string); !ok || codePoints(s) < 1 || codePoints(s) > decideMaxTitle || hasTabOrNewline(s) {
			return fmt.Sprintf("title must be 1 to %d characters with no tab or newline", decideMaxTitle)
		}
	}

	on, present := obj["on"]
	if !present {
		return "on is required"
	}
	if on != "tool_call" && on != "response" {
		return "on must be tool_call or response"
	}

	if rawTools, present := obj["tools"]; present {
		tools, ok := rawTools.([]any)
		if !ok {
			return "tools must be a list"
		}
		if len(tools) < 1 || len(tools) > decideMaxTools {
			return fmt.Sprintf("tools names 1 to %d tools", decideMaxTools)
		}
		for i, t := range tools {
			if s, ok := t.(string); !ok || !decideToolTokenRE.MatchString(s) {
				return fmt.Sprintf("tools[%d] is not a tool name", i)
			}
		}
	}

	rawQuestions, present := obj["questions"]
	if !present {
		return "questions is required"
	}
	questions, ok := rawQuestions.(map[string]any)
	if !ok {
		return "questions must be an object"
	}
	for _, name := range jsSortedKeys(questions) {
		if !decideNameRE.MatchString(name) {
			return "questions: " + name + " is not a question name"
		}
		if slices.Contains(decideKeywords, strings.ToUpper(name)) {
			return "questions: " + name + " is a when keyword"
		}
		if why := decideQuestionShape(name, questions[name]); why != "" {
			return why
		}
	}

	when, present := obj["when"]
	if !present {
		return "when is required"
	}
	w, ok := when.(string)
	if !ok {
		return "when must be a string"
	}
	if codePoints(w) < 1 || codePoints(w) > decideMaxWhenChars {
		return fmt.Sprintf("when must be 1 to %d characters", decideMaxWhenChars)
	}

	if band, present := obj["band"]; present {
		if why := decideBandShape(band, "band"); why != "" {
			return why
		}
	}
	if e, present := obj["escalate"]; present && e != "ask" && e != "review" && e != "refuse" {
		return "escalate must be ask, review or refuse"
	}
	if r, present := obj["rollout"]; present && r != "shadow" && r != "enforce" {
		return "rollout must be shadow or enforce"
	}
	if rawContext, present := obj["context"]; present {
		c, ok := rawContext.([]any)
		if !ok {
			return "context must be a list"
		}
		if len(c) > 1 || (len(c) == 1 && c[0] != "last_user_turn") {
			return "context may list last_user_turn, once"
		}
	}
	return ""
}

// ─── `when` ───────────────────────────────────────────────────────────

type whenTok struct {
	t, v string // t: name, kw, (, ), ",", ==, !=, end
	col  int
}

type whenError struct {
	message string
	column  int
}

func isWordChar(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

func tokenizeWhen(src string) []whenTok {
	cs := []rune(src)
	var out []whenTok
	for i := 0; i < len(cs); {
		c := cs[i]
		col := i + 1
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')' || c == ',':
			out = append(out, whenTok{string(c), string(c), col})
			i++
		case (c == '=' || c == '!') && i+1 < len(cs) && cs[i+1] == '=':
			out = append(out, whenTok{string(c) + "=", string(c) + "=", col})
			i += 2
		case isWordChar(c):
			j := i
			for j < len(cs) && isWordChar(cs[j]) {
				j++
			}
			w := string(cs[i:j])
			switch {
			case slices.Contains(decideKeywords, w):
				out = append(out, whenTok{"kw", w, col})
			case decideWordNameRE.MatchString(w):
				out = append(out, whenTok{"name", w, col})
			default:
				panic(whenError{"unknown word " + w, col})
			}
			i = j
		default:
			panic(whenError{"unexpected character " + string(c), col})
		}
	}
	return append(out, whenTok{"end", "", len(cs) + 1})
}

// parseWhen is decide.ts parseWhen: the `when` grammar, names unchecked.
// It returns the expression, or nil with the parser's message and column.
func parseWhen(src string) (expr *decideExpr, message string, column int) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(whenError)
			if !ok {
				panic(r)
			}
			expr, message, column = nil, e.message, e.column
		}
	}()
	toks := tokenizeWhen(src)
	k := 0
	peek := func() whenTok { return toks[k] }
	next := func() whenTok {
		t := toks[k]
		if k < len(toks)-1 {
			k++
		}
		return t
	}
	isKw := func(w string) bool { return peek().t == "kw" && peek().v == w }
	option := func() string {
		t := next()
		if t.t != "name" {
			panic(whenError{"expected an option", t.col})
		}
		return t.v
	}
	var parseOr, parseAnd, parseUnary, parseAtom func() *decideExpr
	parseOr = func() *decideExpr {
		a := parseAnd()
		for isKw("OR") {
			next()
			a = &decideExpr{op: "or", a: a, b: parseAnd()}
		}
		return a
	}
	parseAnd = func() *decideExpr {
		a := parseUnary()
		for isKw("AND") {
			next()
			a = &decideExpr{op: "and", a: a, b: parseUnary()}
		}
		return a
	}
	parseUnary = func() *decideExpr {
		if isKw("NOT") {
			next()
			return &decideExpr{op: "not", a: parseUnary()}
		}
		return parseAtom()
	}
	parseAtom = func() *decideExpr {
		t := next()
		if t.t == "(" {
			e := parseOr()
			if c := next(); c.t != ")" {
				panic(whenError{"expected )", c.col})
			}
			return e
		}
		if t.t != "name" {
			panic(whenError{"expected a question name, NOT or (", t.col})
		}
		q := t.v
		switch {
		case peek().t == "==":
			next()
			return &decideExpr{op: "eq", q: q, o: option()}
		case peek().t == "!=":
			next()
			return &decideExpr{op: "not", a: &decideExpr{op: "eq", q: q, o: option()}}
		case isKw("IN"):
			next()
			if open := next(); open.t != "(" {
				panic(whenError{"expected (", open.col})
			}
			e := &decideExpr{op: "eq", q: q, o: option()}
			for {
				sep := next()
				if sep.t == ")" {
					return e
				}
				if sep.t != "," {
					panic(whenError{"expected , or )", sep.col})
				}
				e = &decideExpr{op: "or", a: e, b: &decideExpr{op: "eq", q: q, o: option()}}
			}
		}
		return &decideExpr{op: "yes", q: q}
	}
	expr = parseOr()
	if peek().t != "end" {
		panic(whenError{"expected AND, OR or the end", peek().col})
	}
	return expr, "", 0
}

// canonicalWhen is the canonical form: fully parenthesised, != and IN rewritten.
func canonicalWhen(e *decideExpr) string {
	switch e.op {
	case "yes":
		return e.q
	case "eq":
		return "(" + e.q + " == " + e.o + ")"
	case "not":
		return "(NOT " + canonicalWhen(e.a) + ")"
	case "and":
		return "(" + canonicalWhen(e.a) + " AND " + canonicalWhen(e.b) + ")"
	default:
		return "(" + canonicalWhen(e.a) + " OR " + canonicalWhen(e.b) + ")"
	}
}

// whenAtoms lists every atom, left to right as written.
func whenAtoms(e *decideExpr, out []*decideExpr) []*decideExpr {
	switch e.op {
	case "yes", "eq":
		return append(out, e)
	case "not":
		return whenAtoms(e.a, out)
	default:
		return whenAtoms(e.b, whenAtoms(e.a, out))
	}
}

// ─── Validation ───────────────────────────────────────────────────────

// decideOptions is a choice question's options as asked: none_of_these
// appended when absent and moved last when present.
func decideOptions(q map[string]any) []any {
	raw, _ := q["options"].([]any)
	out := make([]any, 0, len(raw))
	for _, o := range raw {
		if o != noneOfThese {
			out = append(out, o)
		}
	}
	return append(out, noneOfThese)
}

func bandBelow(b map[string]any) bool {
	return b["no_below"].(float64) < b["yes_at"].(float64)
}

// validateDecideRule is decide.ts validateDecideRule: the shape, then the
// eight ordered checks; the first failure is the reason. It returns the
// parsed `when`, or nil and the reason.
func validateDecideRule(v any) (*decideExpr, string) {
	if shape := decideRuleShape(v); shape != "" {
		return nil, "decide: " + shape
	}
	rule := v.(map[string]any)
	questions := rule["questions"].(map[string]any)
	names := jsSortedKeys(questions)

	_, hasTools := rule["tools"]
	if (rule["on"] == "tool_call") != hasTools {
		return nil, "decide: tools is required for on: tool_call and not allowed for on: response"
	}
	if _, hasContext := rule["context"]; rule["on"] != "tool_call" && hasContext {
		return nil, "decide: context applies to on: tool_call only"
	}
	if len(names) < 1 || len(names) > decideMaxQuestions {
		return nil, fmt.Sprintf("decide: a rule asks 1 to %d questions", decideMaxQuestions)
	}
	if b, ok := rule["band"].(map[string]any); ok && !bandBelow(b) {
		return nil, "decide: band: no_below must be below yes_at"
	}
	for _, n := range names {
		if b, ok := questions[n].(map[string]any)["band"].(map[string]any); ok && !bandBelow(b) {
			return nil, "decide: " + n + ": no_below must be below yes_at"
		}
	}

	expr, message, column := parseWhen(rule["when"].(string))
	if expr == nil {
		return nil, fmt.Sprintf("decide: when: %s at column %d", message, column)
	}
	used := map[string]bool{}
	for _, atom := range whenAtoms(expr, nil) {
		raw, ok := questions[atom.q]
		if !ok {
			return nil, "decide: when: unknown question " + atom.q
		}
		q := raw.(map[string]any)
		if atom.op == "yes" && q["type"] != "yes_no" {
			return nil, "decide: when: " + atom.q + " is not a yes_no question"
		}
		if atom.op == "eq" {
			if q["type"] != "choice" {
				return nil, "decide: when: " + atom.q + " is not a choice question"
			}
			if !slices.Contains(decideOptions(q), any(atom.o)) {
				return nil, "decide: when: unknown option " + atom.o + " for " + atom.q
			}
		}
		used[atom.q] = true
	}
	for _, n := range names {
		if !used[n] {
			return nil, "decide: question " + n + " is never used in when"
		}
	}
	for _, n := range names {
		if decideApprovalRE.MatchString(asciiLower(questions[n].(map[string]any)["ask"].(string))) {
			return nil, "decide: " + n + " asks about approval; approval comes from the harness ask or the review queue, never from a question"
		}
	}
	return expr, ""
}

// parseDecideLine is decide.ts parseDecideLine: the value of one `decide:` line.
func parseDecideLine(raw string) decideDecl {
	text := jsTrim(raw)
	if text == "" {
		return decideDecl{error: decideEmptyLine}
	}
	value, ok := decodeJSONValue(text)
	if !ok {
		return decideDecl{error: decideNotJSON}
	}
	var id *string
	if obj, ok := value.(map[string]any); ok {
		if s, ok := obj["id"].(string); ok && s != "" {
			id = &s
		}
	}
	expr, reason := validateDecideRule(value)
	if reason != "" {
		return decideDecl{id: id, error: reason}
	}
	return decideDecl{rule: value.(map[string]any), expr: expr}
}

// validateDecideIR is validateGuardrailIr's answer for a decide IR: the rule
// without `kind`, through validateDecideRule. It returns the reason, or "".
func validateDecideIR(ir map[string]any) string {
	rule := make(map[string]any, len(ir))
	for k, v := range ir {
		if k != "kind" {
			rule[k] = v
		}
	}
	text, err := json.Marshal(rule)
	if err != nil {
		return "decide: " + err.Error()
	}
	value, ok := decodeJSONValue(string(text))
	if !ok {
		return decideNotJSON
	}
	_, reason := validateDecideRule(value)
	return reason
}

// ─── Identity ─────────────────────────────────────────────────────────

// jsNumber writes a number as JavaScript's JSON.stringify does: the shortest
// round-trip digits, in plain notation from 1e-6 up to 1e21 and in exponent
// notation outside it; null for NaN and the infinities.
func jsNumber(x float64) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return "null"
	}
	if x == 0 {
		return "0"
	}
	if x < 0 {
		return "-" + jsNumber(-x)
	}
	mantissa, exp, _ := strings.Cut(strconv.FormatFloat(x, 'e', -1, 64), "e") // d.ddde±XX
	e, _ := strconv.Atoi(exp)
	ds := strings.TrimRight(strings.Replace(mantissa, ".", "", 1), "0")
	if ds == "" {
		ds = "0"
	}
	k, n := len(ds), e+1 // x = 0.d1d2... × 10^n
	switch {
	case k <= n && n <= 21:
		return ds + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return ds[:n] + "." + ds[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + ds
	}
	m := ds
	if k > 1 {
		m = ds[:1] + "." + ds[1:]
	}
	if n-1 < 0 {
		return m + "e-" + strconv.Itoa(1-n)
	}
	return m + "e+" + strconv.Itoa(n-1)
}

// jsString is JSON.stringify on a string: only ", \ and the C0 controls are
// escaped (\b \t \n \f \r by name, the rest as \u00xx); <, >, & and
// U+2028/U+2029 are written as they are, unlike encoding/json.
func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// canonicalJSON is decide.ts canonicalJson: keys sorted at every level, no
// whitespace, numbers and strings as JSON.stringify writes them.
func canonicalJSON(v any) string {
	switch t := v.(type) {
	case []any:
		parts := make([]string, len(t))
		for i, x := range t {
			parts[i] = canonicalJSON(x)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := jsSortedKeys(t)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = jsString(k) + ":" + canonicalJSON(t[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	case string:
		return jsString(t)
	case float64:
		return jsNumber(t)
	case bool:
		return strconv.FormatBool(t)
	default:
		return "null"
	}
}

// uniqueSortedStrings is a list's strings, deduplicated and in JavaScript's
// sort order; [] when the list is absent.
func uniqueSortedStrings(v any) []any {
	xs, _ := v.([]any)
	var seen []string
	for _, x := range xs {
		if s, ok := x.(string); ok && !slices.Contains(seen, s) {
			seen = append(seen, s)
		}
	}
	slices.SortFunc(seen, jsCompare)
	out := make([]any, len(seen))
	for i, s := range seen {
		out[i] = s
	}
	return out
}

// decideHashInput is what the rule hash covers: on, tools (sorted), the
// questions with their bands made explicit and none_of_these placed, when
// in canonical form and context (sorted), as canonical JSON. id, title,
// escalate and rollout are left out, so flipping shadow to enforce keeps a
// rule's evidence while a changed word, option or band starts it over.
// rule must be valid (validateDecideRule).
func decideHashInput(rule map[string]any) (string, error) {
	expr, message, _ := parseWhen(rule["when"].(string))
	if expr == nil {
		return "", fmt.Errorf("decideHashInput: when does not parse (%s)", message)
	}
	questions := map[string]any{}
	for name, raw := range rule["questions"].(map[string]any) {
		q := raw.(map[string]any)
		band, ok := q["band"].(map[string]any)
		if !ok {
			if band, ok = rule["band"].(map[string]any); !ok {
				band = decideDefaultBand
			}
		}
		out := map[string]any{
			"type": q["type"],
			"ask":  q["ask"],
			"band": map[string]any{"yes_at": band["yes_at"], "no_below": band["no_below"]},
		}
		if q["type"] == "choice" {
			out["options"] = decideOptions(q)
		}
		questions[name] = out
	}
	return canonicalJSON(map[string]any{
		"on":        rule["on"],
		"tools":     uniqueSortedStrings(rule["tools"]),
		"questions": questions,
		"when":      canonicalWhen(expr),
		"context":   uniqueSortedStrings(rule["context"]),
	}), nil
}

// decideRuleHash is ruleHash: lower-case hex SHA-256 of decideHashInput's UTF-8 bytes.
func decideRuleHash(rule map[string]any) (string, error) {
	input, err := decideHashInput(rule)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:]), nil
}
