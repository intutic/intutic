package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Authored policy guardrails: routes/policyGuardrails.ts (POST, PUT and
// DELETE /api/v1/policy-guardrails/guardrails). The IR attributes mirror
// guardrailIr.ts field for field (camelCase there, snake_case here).

const (
	guardrailsPath            = "/api/v1/policy-guardrails/guardrails"
	guardrailStatusProposed   = "PROPOSED"
	guardrailStatusRetired    = "RETIRED"
	guardrailProvenanceAuthor = "authored"
	// wasmVerdict is the only verdict the IR allows a predicate: re-ask, never block.
	wasmVerdict = 3
)

type guardrailResource struct{ client *client.Client }

type guardrailModel struct {
	ID                types.String         `tfsdk:"id"`
	Name              types.String         `tfsdk:"name"`
	Description       types.String         `tfsdk:"description"`
	Kind              types.String         `tfsdk:"kind"`
	Title             types.String         `tfsdk:"title"`
	Tools             types.List           `tfsdk:"tools"`
	Tokens            types.List           `tfsdk:"tokens"`
	ArgContains       types.List           `tfsdk:"arg_contains"`
	ArgNotContains    types.List           `tfsdk:"arg_not_contains"`
	First             types.String         `tfsdk:"first"`
	Then              types.String         `tfsdk:"then"`
	Token             types.String         `tfsdk:"token"`
	Limit             types.Int64          `tfsdk:"limit"`
	Taint             types.String         `tfsdk:"taint"`
	Roles             types.List           `tfsdk:"roles"`
	Models            types.List           `tfsdk:"models"`
	Hosts             types.List           `tfsdk:"hosts"`
	Rationale         types.String         `tfsdk:"rationale"`
	Predicate         jsontypes.Normalized `tfsdk:"predicate"`
	Target            types.String         `tfsdk:"target"`
	Status            types.String         `tfsdk:"status"`
	Version           types.Int64          `tfsdk:"version"`
	Provenance        types.String         `tfsdk:"provenance"`
	Supersedes        types.String         `tfsdk:"supersedes"`
	ShadowEvaluations types.Int64          `tfsdk:"shadow_evaluations"`
	ShadowWouldAct    types.Int64          `tfsdk:"shadow_would_act"`
	EnforcingFires    types.Int64          `tfsdk:"enforcing_fires"`
}

// irAttr pairs an IR key with its attribute and how to read and write it on
// the model, so building the IR, reading it back and comparing two of them
// walk one table.
type irAttr struct {
	key, attr string
	get       func(*guardrailModel) attr.Value
	set       func(*guardrailModel, json.RawMessage) error
}

func listAttr(key, name string, field func(*guardrailModel) *types.List) irAttr {
	return irAttr{key, name,
		func(m *guardrailModel) attr.Value { return *field(m) },
		func(m *guardrailModel, raw json.RawMessage) error {
			if raw == nil {
				*field(m) = types.ListNull(types.StringType)
				return nil
			}
			var v []string
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			if v == nil {
				v = []string{}
			}
			*field(m) = stringList(v)
			return nil
		}}
}

func stringAttr(key, name string, field func(*guardrailModel) *types.String) irAttr {
	return irAttr{key, name,
		func(m *guardrailModel) attr.Value { return *field(m) },
		func(m *guardrailModel, raw json.RawMessage) error {
			if raw == nil {
				*field(m) = types.StringNull()
				return nil
			}
			var v string
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			*field(m) = types.StringValue(v)
			return nil
		}}
}

var irAttrs = []irAttr{
	stringAttr("title", "title", func(m *guardrailModel) *types.String { return &m.Title }),
	listAttr("tools", "tools", func(m *guardrailModel) *types.List { return &m.Tools }),
	listAttr("tokens", "tokens", func(m *guardrailModel) *types.List { return &m.Tokens }),
	listAttr("argContains", "arg_contains", func(m *guardrailModel) *types.List { return &m.ArgContains }),
	listAttr("argNotContains", "arg_not_contains", func(m *guardrailModel) *types.List { return &m.ArgNotContains }),
	stringAttr("first", "first", func(m *guardrailModel) *types.String { return &m.First }),
	stringAttr("then", "then", func(m *guardrailModel) *types.String { return &m.Then }),
	stringAttr("token", "token", func(m *guardrailModel) *types.String { return &m.Token }),
	{"limit", "limit",
		func(m *guardrailModel) attr.Value { return m.Limit },
		func(m *guardrailModel, raw json.RawMessage) error {
			if raw == nil {
				m.Limit = types.Int64Null()
				return nil
			}
			var v int64
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			m.Limit = types.Int64Value(v)
			return nil
		}},
	stringAttr("taint", "taint", func(m *guardrailModel) *types.String { return &m.Taint }),
	listAttr("roles", "roles", func(m *guardrailModel) *types.List { return &m.Roles }),
	listAttr("models", "models", func(m *guardrailModel) *types.List { return &m.Models }),
	listAttr("hosts", "hosts", func(m *guardrailModel) *types.List { return &m.Hosts }),
	stringAttr("rationale", "rationale", func(m *guardrailModel) *types.String { return &m.Rationale }),
	{"predicate", "predicate",
		func(m *guardrailModel) attr.Value { return m.Predicate },
		func(m *guardrailModel, raw json.RawMessage) error {
			if raw == nil {
				m.Predicate = jsontypes.NewNormalizedNull()
				return nil
			}
			canonical, err := sortedJSON(raw)
			if err != nil {
				return err
			}
			m.Predicate = jsontypes.NewNormalizedValue(canonical)
			return nil
		}},
}

// sortedJSON re-encodes raw with object keys sorted, as jsonencode writes
// them: Postgres stores the predicate as jsonb, which keeps its own key
// order, so an imported predicate would otherwise read as a different string.
func sortedJSON(raw json.RawMessage) (string, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", err
	}
	out, err := json.Marshal(v)
	return string(out), err
}

type apiGuardrail struct {
	GuardrailID       string                     `json:"guardrailId"`
	Provenance        string                     `json:"provenance"`
	Name              *string                    `json:"name"`
	Description       *string                    `json:"description"`
	Version           int64                      `json:"version"`
	Supersedes        *string                    `json:"supersedes"`
	Target            string                     `json:"target"`
	Status            string                     `json:"status"`
	IR                map[string]json.RawMessage `json:"ir"`
	ShadowEvaluations int64                      `json:"shadowEvaluations"`
	ShadowWouldAct    int64                      `json:"shadowWouldAct"`
	EnforcingFires    int64                      `json:"enforcingFires"`
}

func newGuardrailResource() resource.Resource { return &guardrailResource{} }

var (
	_ resource.ResourceWithImportState    = (*guardrailResource)(nil)
	_ resource.ResourceWithModifyPlan     = (*guardrailResource)(nil)
	_ resource.ResourceWithValidateConfig = (*guardrailResource)(nil)
)

func (r *guardrailResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_guardrail"
}

func irList(desc string) schema.ListAttribute {
	return schema.ListAttribute{ElementType: types.StringType, Optional: true, Description: desc}
}

func irString(desc string) schema.StringAttribute {
	return schema.StringAttribute{Optional: true, Description: desc}
}

func (r *guardrailResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A policy guardrail written as code, managed through `/api/v1/policy-guardrails/guardrails`. " +
			"It is held to the Guardrail IR and the validator a guardrail extracted from a policy document passes, " +
			"without the checks that compare a model's output with the passage it cites. A new guardrail starts " +
			"`PROPOSED`, like an extracted one: it enforces and measures nothing until a member approves it for shadow, " +
			"and promotion to `ENFORCING` waits on shadow evidence through the same review actions (the dashboard, " +
			"`intutic guardrails approve-shadow` and `promote`). Terraform manages the rule, not its lifecycle. " +
			"Changing `name` or `description` edits the guardrail in place and keeps its evidence. Changing any IR " +
			"attribute creates the next version under a new id, `PROPOSED` with no evidence, and retires this one " +
			"(undoing what it wrote, if it was an enforcing allowed-models or egress guardrail); the plan shows the " +
			"new `version` and `status` before you apply. Destroying it retires it; its history is kept. The plan " +
			"also asks the API to run the full validator, so a rule the API would refuse fails at plan time. " +
			"Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "The guardrail id (`pgr_…`). Changes when an IR change creates the next version.",
			},
			"name": schema.StringAttribute{
				Required:    true,
				Description: "One-line label, at most 80 characters, without surrounding whitespace.",
			},
			"description": schema.StringAttribute{
				Optional: true,
				Description: "What the rule is for, at most 480 characters. A hook rule's block message carries it " +
					"where an extracted rule carries its quote (the `name` stands there when this is unset).",
			},
			"kind": schema.StringAttribute{
				Required:    true,
				Description: "The IR kind: " + strings.Join(backquote(guardrailKinds()), ", ") + ". The attributes below say which kinds take them.",
				Validators:  []validator.String{stringvalidator.OneOf(guardrailKinds()...)},
			},
			"title":            irString("`hook_rule`, `wasm_predicate` (required): the title, 1 to 80 characters, that starts the block message."),
			"tools":            irList("`hook_rule` (required, 1 to 8), `deny_tools` (required, 1 to 16): tool names (`Bash`, `mcp__github__create_issue`) or action tokens. A known harness tool is written in its canonical case (`WebFetch`, not `webfetch`)."),
			"tokens":           irList("`review_before` (required, 1 to 16): tool names or action tokens."),
			"arg_contains":     irList("`hook_rule`: fire only when the serialised tool input contains every one of these literals (at most 4, each 1 to 64 characters, no tab, newline, double quote or backslash)."),
			"arg_not_contains": irList("`hook_rule`: fire only when the tool input contains none of these literals (same limits as `arg_contains`)."),
			"first":            irString("`requires_before`, `forbid_after` (required): the first token; differs from `then`."),
			"then":             irString("`requires_before`, `forbid_after` (required): the second token."),
			"token":            irString("`max_calls`, `forbid_with` (required): the tool name or action token."),
			"limit": schema.Int64Attribute{
				Optional:    true,
				Description: "`max_calls` (required): the most calls allowed, 1 to 1000.",
			},
			"taint":     irString("`forbid_with` (required): `secrets()` or `pii()`."),
			"roles":     irList("Every kind but `allowed_models` and `egress_allow`: the lower-case roles the rule applies to (at most 8). Unset, it applies to everyone."),
			"models":    irList("`allowed_models` (required, 1 to 32): model ids, compared exactly as the proxy compares them."),
			"hosts":     irList("`egress_allow` (required, 1 to 32): hosts (`api.example.com`), suffixes (`.example.com`) or IPv4 addresses and CIDRs no wider than /8."),
			"rationale": irString("`wasm_predicate` (required): why the rule re-asks, at most 480 characters."),
			"predicate": schema.StringAttribute{
				CustomType:  jsontypes.NormalizedType{},
				Optional:    true,
				Description: "`wasm_predicate` (required): the predicate in the closed rule DSL, as JSON (`jsonencode({ all = [...] })`). Its verdict is always re-ask.",
			},
			"target": schema.StringAttribute{
				Computed:    true,
				Description: "The enforcer the rule is projected into: `hook_rule`, `sop_front_matter`, `wasm_rule` or `workspace_setting`.",
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "`PROPOSED`, `SHADOW`, `ENFORCING` or `REJECTED`. Moved by the review actions, never by Terraform.",
			},
			"version": schema.Int64Attribute{
				Computed:    true,
				Description: "1 for a new guardrail; each IR change creates the next.",
			},
			"provenance": schema.StringAttribute{
				Computed:    true,
				Description: "Always `authored`. An extracted guardrail cannot be managed or imported by this resource.",
			},
			"supersedes": schema.StringAttribute{
				Computed:    true,
				Description: "The id of the version this one replaced, or null.",
			},
			"shadow_evaluations": schema.Int64Attribute{
				Computed:    true,
				Description: "Shadow evaluations this version has accumulated; promotion needs the threshold the API reports.",
			},
			"shadow_would_act": schema.Int64Attribute{
				Computed:    true,
				Description: "Shadow evaluations on which this version would have acted.",
			},
			"enforcing_fires": schema.Int64Attribute{
				Computed:    true,
				Description: "Times this version acted while enforcing.",
			},
		},
	}
}

func backquote(values []string) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = "`" + v + "`"
	}
	return out
}

func (r *guardrailResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

// ValidateConfig applies the IR grammar: which attributes a kind takes and
// requires, list sizes, and what each item may be. It runs before the
// provider talks to anything.
func (r *guardrailResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m guardrailModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !m.Name.IsNull() && !m.Name.IsUnknown() {
		if msg := checkName(m.Name.ValueString()); msg != "" {
			resp.Diagnostics.AddAttributeError(path.Root("name"), "Invalid name", msg)
		}
	}
	if !m.Description.IsNull() && !m.Description.IsUnknown() {
		if n := jsLength(m.Description.ValueString()); n < 1 || n > 480 {
			resp.Diagnostics.AddAttributeError(path.Root("description"), "Invalid description", "A description is 1 to 480 characters; leave it unset for none.")
		}
	}
	if m.Kind.IsNull() || m.Kind.IsUnknown() {
		return
	}
	kind := m.Kind.ValueString()
	fields, ok := grammar.Kinds[kind]
	if !ok {
		return // the attribute's OneOf validator reports it
	}
	for _, a := range irAttrs {
		v := a.get(&m)
		f, takes := fields[a.key]
		if !takes {
			if !v.IsNull() {
				resp.Diagnostics.AddAttributeError(path.Root(a.attr), "Attribute not allowed for this kind", fmt.Sprintf("kind %q does not take %s.", kind, a.attr))
			}
			continue
		}
		if v.IsNull() {
			if f.Required {
				resp.Diagnostics.AddAttributeError(path.Root(a.attr), "Missing required attribute", fmt.Sprintf("kind %q requires %s.", kind, a.attr))
			}
			continue
		}
		if v.IsUnknown() {
			continue
		}
		for _, msg := range checkIRValue(ctx, f, v) {
			resp.Diagnostics.AddAttributeError(path.Root(a.attr), "Invalid "+a.attr, msg)
		}
	}
	if (kind == "requires_before" || kind == "forbid_after") && !m.First.IsNull() && !m.First.IsUnknown() && m.First.Equal(m.Then) {
		resp.Diagnostics.AddAttributeError(path.Root("then"), "Invalid ordering rule", "An ordering rule needs two different tokens.")
	}
}

// checkName is AuthoredGuardrailCreateSchema's name: one line, 1 to 80 characters, no surrounding whitespace.
func checkName(name string) string {
	if n := jsLength(name); n < 1 || n > 80 {
		return "A name is 1 to 80 characters."
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "A name is one line: no tab, newline or control character."
		}
	}
	if name != strings.TrimSpace(name) {
		return "A name has no leading or trailing whitespace."
	}
	return ""
}

func checkIRValue(ctx context.Context, f irField, v attr.Value) []string {
	switch f.Type {
	case "list":
		var items []string
		if diags := v.(types.List).ElementsAs(ctx, &items, false); diags.HasError() {
			return nil // an unknown element; checked once known
		}
		var out []string
		if len(items) < f.MinItems || (f.MaxItems > 0 && len(items) > f.MaxItems) {
			out = append(out, fmt.Sprintf("Takes %d to %d items; got %d.", f.MinItems, f.MaxItems, len(items)))
		}
		for _, item := range items {
			if msg := checkItem(f.Item, item); msg != "" {
				out = append(out, msg)
			}
		}
		return out
	case "string":
		if msg := checkItem(f.Item, v.(types.String).ValueString()); msg != "" {
			return []string{msg}
		}
	case "int":
		if n := v.(types.Int64).ValueInt64(); n < f.Min || n > f.Max {
			return []string{fmt.Sprintf("Must be between %d and %d; got %d.", f.Min, f.Max, n)}
		}
	}
	return nil
}

// buildIR is the IR the attributes describe, or ok=false while any is unknown.
func (m *guardrailModel) buildIR() (map[string]any, bool) {
	if m.Kind.IsUnknown() || m.Kind.IsNull() {
		return nil, false
	}
	ir := map[string]any{"kind": m.Kind.ValueString()}
	for _, a := range irAttrs {
		v := a.get(m)
		if v.IsUnknown() {
			return nil, false
		}
		if v.IsNull() {
			continue
		}
		switch tv := v.(type) {
		case types.String:
			ir[a.key] = tv.ValueString()
		case types.Int64:
			ir[a.key] = tv.ValueInt64()
		case types.List:
			items := make([]string, 0, len(tv.Elements()))
			for _, e := range tv.Elements() {
				s, ok := e.(types.String)
				if !ok || s.IsUnknown() {
					return nil, false
				}
				items = append(items, s.ValueString())
			}
			ir[a.key] = items
		case jsontypes.Normalized:
			ir[a.key] = json.RawMessage(tv.ValueString())
		}
	}
	if m.Kind.ValueString() == "wasm_predicate" {
		ir["verdict"] = wasmVerdict
	}
	return ir, true
}

// sameIR reports whether two models describe the same rule.
func sameIR(a, b *guardrailModel) bool {
	if !a.Kind.Equal(b.Kind) {
		return false
	}
	for _, x := range irAttrs {
		av, bv := x.get(a), x.get(b)
		// A predicate is the same rule however its JSON is spaced.
		if an, ok := av.(jsontypes.Normalized); ok && !av.IsNull() && !bv.IsNull() {
			if eq, _ := an.StringSemanticEquals(context.Background(), bv.(jsontypes.Normalized)); !eq {
				return false
			}
			continue
		}
		if !av.Equal(bv) {
			return false
		}
	}
	return true
}

func (m *guardrailModel) authoredBody() map[string]any {
	body := map[string]any{"name": m.Name.ValueString()}
	if !m.Description.IsNull() {
		body["description"] = m.Description.ValueString()
	}
	return body
}

// ModifyPlan says what an apply will do to the computed identity, and runs
// the API's validator on the planned rule so a refusal is a plan error. A
// label edit keeps the id, version, status and evidence; an IR change creates
// the next version: a new id, the version bumped, PROPOSED, no evidence.
func (r *guardrailResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.Plan.Raw.IsNull() {
		return
	}
	var plan guardrailModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	var state *guardrailModel
	if !req.State.Raw.IsNull() {
		state = &guardrailModel{}
		resp.Diagnostics.Append(req.State.Get(ctx, state)...)
	}
	if resp.Diagnostics.HasError() {
		return
	}
	ir, known := plan.buildIR()
	if !known || plan.Name.IsUnknown() || plan.Description.IsUnknown() {
		return
	}
	irChanged := state == nil || !sameIR(&plan, state)
	if state != nil && !irChanged && plan.Name.Equal(state.Name) && plan.Description.Equal(state.Description) {
		return
	}

	if r.client != nil {
		body := plan.authoredBody()
		body["ir"] = ir
		var v struct {
			Valid      bool   `json:"valid"`
			Target     string `json:"target"`
			Validation []struct {
				Name   string `json:"name"`
				Passed bool   `json:"passed"`
				Detail string `json:"detail"`
			} `json:"validation"`
		}
		if err := r.client.Post(ctx, guardrailsPath+"/validate", body, &v); err != nil {
			resp.Diagnostics.AddError("Validating the guardrail failed", err.Error())
			return
		}
		if !v.Valid {
			for _, c := range v.Validation {
				if !c.Passed {
					resp.Diagnostics.AddError("The API would refuse this guardrail", fmt.Sprintf("Check %s: %s", c.Name, c.Detail))
				}
			}
			return
		}
		plan.Target = types.StringValue(v.Target)
	}

	switch {
	case state == nil:
		plan.ID = types.StringUnknown()
		plan.Version = types.Int64Value(1)
		plan.Supersedes = types.StringNull()
	case irChanged:
		plan.ID = types.StringUnknown()
		plan.Version = types.Int64Value(state.Version.ValueInt64() + 1)
		plan.Supersedes = state.ID
	default:
		plan.ID, plan.Version, plan.Supersedes, plan.Target = state.ID, state.Version, state.Supersedes, state.Target
		plan.Status, plan.Provenance = state.Status, state.Provenance
		plan.ShadowEvaluations, plan.ShadowWouldAct, plan.EnforcingFires = state.ShadowEvaluations, state.ShadowWouldAct, state.EnforcingFires
		resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
		return
	}
	plan.Status = types.StringValue(guardrailStatusProposed)
	plan.Provenance = types.StringValue(guardrailProvenanceAuthor)
	plan.ShadowEvaluations, plan.ShadowWouldAct, plan.EnforcingFires = types.Int64Value(0), types.Int64Value(0), types.Int64Value(0)
	resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
}

type guardrailWrite struct {
	Guardrail apiGuardrail `json:"guardrail"`
}

func (r *guardrailResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan guardrailModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ir, _ := plan.buildIR()
	body := plan.authoredBody()
	body["ir"] = ir
	var out guardrailWrite
	if err := r.client.Post(ctx, guardrailsPath, body, &out); err != nil {
		resp.Diagnostics.AddError("Creating guardrail failed", err.Error())
		return
	}
	resp.Diagnostics.Append(out.Guardrail.applyTo(&plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *guardrailResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state guardrailModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out struct {
		Guardrail apiGuardrail `json:"guardrail"`
	}
	err := r.client.Get(ctx, guardrailsPath+"/"+esc(state.ID.ValueString()), &out)
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Reading guardrail failed", err.Error())
		return
	}
	g := out.Guardrail
	if g.Provenance != guardrailProvenanceAuthor {
		resp.Diagnostics.AddError("Not an authored guardrail",
			fmt.Sprintf("%s was extracted from a policy document. It changes when its document does and moves through the guardrail review; intutic_guardrail manages authored guardrails only.", g.GuardrailID))
		return
	}
	// Retired — deleted, or replaced by a newer version — is gone, as a
	// soft-deleted SOP is: Terraform plans to create it again.
	if g.Status == guardrailStatusRetired {
		resp.State.RemoveResource(ctx)
		return
	}
	resp.Diagnostics.Append(g.applyTo(&state)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *guardrailResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state guardrailModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Only what changed: a label edit must not send the IR, or it would read
	// as a rule change to anyone reading the history.
	body := map[string]any{}
	if !plan.Name.Equal(state.Name) {
		body["name"] = plan.Name.ValueString()
	}
	if !plan.Description.Equal(state.Description) {
		if plan.Description.IsNull() {
			body["description"] = nil
		} else {
			body["description"] = plan.Description.ValueString()
		}
	}
	if !sameIR(&plan, &state) {
		ir, _ := plan.buildIR()
		body["ir"] = ir
	}
	var out guardrailWrite
	if err := r.client.Put(ctx, guardrailsPath+"/"+esc(state.ID.ValueString()), body, &out); err != nil {
		resp.Diagnostics.AddError("Updating guardrail failed", err.Error())
		return
	}
	resp.Diagnostics.Append(out.Guardrail.applyTo(&plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *guardrailResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state guardrailModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, guardrailsPath+"/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Deleting guardrail failed", err.Error())
	}
}

func (r *guardrailResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

// applyTo writes the API's view of the guardrail into m: every IR attribute
// the IR has, null for every one it does not.
func (g *apiGuardrail) applyTo(m *guardrailModel) diag.Diagnostics {
	var diags diag.Diagnostics
	m.ID = types.StringValue(g.GuardrailID)
	m.Name = stringOrNull(g.Name)
	m.Description = stringOrNull(g.Description)
	var kind string
	if err := json.Unmarshal(g.IR["kind"], &kind); err != nil {
		diags.AddError("Unreadable guardrail", fmt.Sprintf("%s: the IR has no kind: %v", g.GuardrailID, err))
		return diags
	}
	m.Kind = types.StringValue(kind)
	for _, a := range irAttrs {
		if err := a.set(m, g.IR[a.key]); err != nil {
			diags.AddError("Unreadable guardrail", fmt.Sprintf("%s: IR field %s: %v", g.GuardrailID, a.key, err))
		}
	}
	m.Target = types.StringValue(g.Target)
	m.Status = types.StringValue(g.Status)
	m.Version = types.Int64Value(g.Version)
	m.Provenance = types.StringValue(g.Provenance)
	m.Supersedes = stringOrNull(g.Supersedes)
	m.ShadowEvaluations = types.Int64Value(g.ShadowEvaluations)
	m.ShadowWouldAct = types.Int64Value(g.ShadowWouldAct)
	m.EnforcingFires = types.Int64Value(g.EnforcingFires)
	return diags
}
