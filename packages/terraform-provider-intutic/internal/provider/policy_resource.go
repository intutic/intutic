package provider

import (
	"context"
	"encoding/json"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Enforcement-policy routes: routes/policies.ts (deprecated, see
// policyDeprecation). Every limit below is CreatePolicySchema's.
var (
	policyActions       = []string{"BYPASS", "ENHANCE", "HIJACK", "REASK", "KILL"}
	policyModes         = []string{"TRANSPARENT", "OPAQUE", "SILENT_LOG"}
	policyRiskCategory  = []string{"NONE", "DESTRUCTIVE", "CREDENTIAL_ACCESS"}
	policyToolPattern   = regexp.MustCompile(`^[A-Za-z0-9_\-.:/*]+$`)
	noSurroundingSpaces = regexp.MustCompile(`^\S(.*\S)?$`)
)

type policyResource struct{ client *client.Client }

type policyModel struct {
	ID                types.String         `tfsdk:"id"`
	Name              types.String         `tfsdk:"name"`
	Description       types.String         `tfsdk:"description"`
	RiskCategory      types.String         `tfsdk:"risk_category"`
	TargetToolPattern types.String         `tfsdk:"target_tool_pattern"`
	EnforcementAction types.String         `tfsdk:"enforcement_action"`
	InterventionMode  types.String         `tfsdk:"intervention_mode"`
	Priority          types.Int64          `tfsdk:"priority"`
	Conditions        jsontypes.Normalized `tfsdk:"conditions"`
	IsActive          types.Bool           `tfsdk:"is_active"`
	CurrentVersion    types.Int64          `tfsdk:"current_version"`
}

type apiPolicy struct {
	PolicyID          string          `json:"policyId"`
	Name              string          `json:"name"`
	Description       *string         `json:"description"`
	RiskCategory      string          `json:"riskCategory"`
	TargetToolPattern string          `json:"targetToolPattern"`
	EnforcementAction string          `json:"enforcementAction"`
	InterventionMode  string          `json:"interventionMode"`
	Priority          int64           `json:"priority"`
	Conditions        json.RawMessage `json:"conditions"`
	IsActive          bool            `json:"isActive"`
	CurrentVersion    int64           `json:"currentVersion"`
}

func newPolicyResource() resource.Resource { return &policyResource{} }

var _ resource.ResourceWithImportState = (*policyResource)(nil)

func (r *policyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_policy"
}

// The policies API is deprecated as of control-plane 2.5.1 and sunsets on
// 2026-12-01. No gate or proxy reads a policy's per-tool fields; the only
// effect a policy has is that the active one with the lowest priority sets the
// workspace's intervention mode, and only until the workspace sets the
// interventionMode setting (the fallback ends in control-plane 2.6.0).
const (
	policyDeprecation = "intutic_policy is deprecated: the policies API sunsets on 2026-12-01, and a policy's " +
		"per-tool fields are enforced nowhere. Write per-tool rules as intutic_guardrail with kind = \"hook_rule\", " +
		"and set the workspace's intervention mode with the interventionMode key of intutic_workspace_settings."
	policyFieldUnenforced = " is enforced nowhere: no gate or proxy reads it. Write per-tool rules as " +
		"intutic_guardrail with kind = \"hook_rule\"."
	policyPriorityDeprecation = "priority only chooses which active policy's intervention_mode applies to the " +
		"workspace (the lowest wins). The interventionMode key of intutic_workspace_settings replaces it."
	policyModeDeprecation = "Set the workspace's intervention mode with the interventionMode key of " +
		"intutic_workspace_settings. Once that setting is set it wins and every policy's intervention_mode is " +
		"ignored; until then, through control-plane 2.5.x, the active policy with the lowest priority still sets it."
)

func (r *policyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		DeprecationMessage: policyDeprecation,
		Description: "Deprecated: the policies API (`/api/v1/policies`) is deprecated as of control-plane 2.5.1 and " +
			"sunsets on 2026-12-01. Write per-tool rules as `intutic_guardrail` with `kind = \"hook_rule\"`, which " +
			"the harness gates enforce once the guardrail is promoted, and set the intervention mode with the " +
			"`interventionMode` key of `intutic_workspace_settings`. A policy's per-tool fields (`target_tool_pattern`, " +
			"`enforcement_action`, `conditions`, `risk_category`) are stored but enforced nowhere: no gate or proxy " +
			"reads them. Its one effect is that, while the workspace has not set `interventionMode`, the active policy " +
			"with the lowest `priority` sets the workspace's intervention mode; that fallback ends in control-plane " +
			"2.6.0. `intutic policy convert <id>` turns an active `KILL` or `REASK` policy into a `hook_rule` " +
			"guardrail in `SHADOW`. Every change records a new version in the policy's audit history; destroying " +
			"one soft-deletes it and keeps that history. Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The policy id (`pol_…`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:    true,
				Description: "The policy's name (1–256 characters).",
				Validators: []validator.String{
					stringvalidator.LengthBetween(1, 256),
					stringvalidator.RegexMatches(noSurroundingSpaces, "must not start or end with whitespace (the API trims it)"),
				},
			},
			"description": schema.StringAttribute{
				Optional:    true,
				Description: "What the policy is for (at most 4,000 characters).",
				Validators:  []validator.String{stringvalidator.LengthAtMost(4000)},
			},
			"risk_category": schema.StringAttribute{
				Optional:           true,
				Computed:           true,
				Default:            stringdefault.StaticString("NONE"),
				DeprecationMessage: "risk_category" + policyFieldUnenforced,
				Description: "Deprecated, enforced nowhere: stored with the policy, read by no gate or proxy. " +
					"One of `NONE` (default), `DESTRUCTIVE`, `CREDENTIAL_ACCESS`.",
				Validators: []validator.String{stringvalidator.OneOf(policyRiskCategory...)},
			},
			"target_tool_pattern": schema.StringAttribute{
				Optional:           true,
				Computed:           true,
				Default:            stringdefault.StaticString("*"),
				DeprecationMessage: "target_tool_pattern" + policyFieldUnenforced,
				Description: "Deprecated, enforced nowhere: stored with the policy, read by no gate or proxy; " +
					"name tools in an `intutic_guardrail`'s `tools` instead. A tool name or glob, letters, digits and " +
					"`_ - . : / *` only. Defaults to `*`.",
				Validators: []validator.String{
					stringvalidator.LengthBetween(1, 256),
					stringvalidator.RegexMatches(policyToolPattern, "must be a tool name or glob: letters, digits, _ - . : / * only"),
				},
			},
			"enforcement_action": schema.StringAttribute{
				Optional:           true,
				Computed:           true,
				Default:            stringdefault.StaticString("BYPASS"),
				DeprecationMessage: "enforcement_action" + policyFieldUnenforced,
				Description: "Deprecated, enforced nowhere: stored with the policy, read by no gate or proxy; use a " +
					"`hook_rule` `intutic_guardrail`, which blocks a matching call once enforcing. One of `BYPASS` " +
					"(default), `ENHANCE`, `HIJACK`, `REASK`, `KILL`.",
				Validators: []validator.String{stringvalidator.OneOf(policyActions...)},
			},
			"intervention_mode": schema.StringAttribute{
				Optional:           true,
				Computed:           true,
				Default:            stringdefault.StaticString("TRANSPARENT"),
				DeprecationMessage: policyModeDeprecation,
				Description: "Deprecated: set the `interventionMode` key of `intutic_workspace_settings` instead, which " +
					"wins once set. Until then, through control-plane 2.5.x, the active policy with the lowest `priority` " +
					"sets the intervention mode for the whole workspace. The mode is what the agent is told when a call is refused. " +
					"`TRANSPARENT` (default): the refusal names the rule and its reason. " +
					"`OPAQUE`: the same calls are refused with the same refusal codes, but the agent is told only " +
					"\"Blocked by workspace policy. Ask a workspace admin if you need this action.\"; " +
					"audit records keep the rule. " +
					"`SILENT_LOG`: the local hook gates let a call a workspace rule would block run and report it as `tool_would_block`; " +
					"built-in protections, SSO group rules and the MCP server registry still refuse, and the hosted hook gate and the proxies enforce as usual.",
				Validators: []validator.String{stringvalidator.OneOf(policyModes...)},
			},
			"priority": schema.Int64Attribute{
				Optional:           true,
				Computed:           true,
				Default:            int64default.StaticInt64(100),
				DeprecationMessage: policyPriorityDeprecation,
				Description: "Deprecated: 0–10000, defaults to 100. It only chooses which active policy's " +
					"`intervention_mode` applies (the lowest number wins), which the `interventionMode` workspace setting replaces.",
				Validators: []validator.Int64{int64validator.Between(0, 10000)},
			},
			"conditions": schema.StringAttribute{
				CustomType:         jsontypes.NormalizedType{},
				Optional:           true,
				DeprecationMessage: "conditions" + policyFieldUnenforced,
				Description: "Deprecated, enforced nowhere: a JSON object stored with the policy, read by no gate or " +
					"proxy; match arguments with an `intutic_guardrail`'s `arg_contains` and `arg_not_contains` instead.",
				Validators: []validator.String{jsonObjectValidator{}},
			},
			"is_active": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(true),
				Description: "Whether the policy is active; only an active policy's `intervention_mode` can apply. Defaults to true.",
			},
			"current_version": schema.Int64Attribute{
				Computed:    true,
				Description: "The policy's version number; each change adds one.",
			},
		},
	}
}

func (r *policyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *policyModel) body() map[string]any {
	body := map[string]any{
		"name":              m.Name.ValueString(),
		"description":       nil,
		"riskCategory":      m.RiskCategory.ValueString(),
		"targetToolPattern": m.TargetToolPattern.ValueString(),
		"enforcementAction": m.EnforcementAction.ValueString(),
		"interventionMode":  m.InterventionMode.ValueString(),
		"priority":          m.Priority.ValueInt64(),
		"conditions":        nil,
		"isActive":          m.IsActive.ValueBool(),
	}
	if !m.Description.IsNull() {
		body["description"] = m.Description.ValueString()
	}
	if !m.Conditions.IsNull() {
		body["conditions"] = json.RawMessage(m.Conditions.ValueString())
	}
	return body
}

func (p *apiPolicy) applyTo(m *policyModel) {
	m.ID = types.StringValue(p.PolicyID)
	m.Name = types.StringValue(p.Name)
	m.Description = stringOrNull(p.Description)
	m.RiskCategory = types.StringValue(p.RiskCategory)
	m.TargetToolPattern = types.StringValue(p.TargetToolPattern)
	m.EnforcementAction = types.StringValue(p.EnforcementAction)
	m.InterventionMode = types.StringValue(p.InterventionMode)
	m.Priority = types.Int64Value(p.Priority)
	if len(p.Conditions) == 0 || string(p.Conditions) == "null" {
		m.Conditions = jsontypes.NewNormalizedNull()
	} else {
		m.Conditions = jsontypes.NewNormalizedValue(string(p.Conditions))
	}
	m.IsActive = types.BoolValue(p.IsActive)
	m.CurrentVersion = types.Int64Value(p.CurrentVersion)
}

func (r *policyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan policyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out struct {
		Policy apiPolicy `json:"policy"`
	}
	if err := r.client.Post(ctx, "/api/v1/policies", plan.body(), &out); err != nil {
		resp.Diagnostics.AddError("Creating policy failed", err.Error())
		return
	}
	out.Policy.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *policyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state policyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// There is no single-policy GET; the list returns every live policy.
	var out struct {
		Policies []apiPolicy `json:"policies"`
	}
	if err := r.client.Get(ctx, "/api/v1/policies", &out); err != nil {
		resp.Diagnostics.AddError("Reading policies failed", err.Error())
		return
	}
	for i := range out.Policies {
		if out.Policies[i].PolicyID == state.ID.ValueString() {
			out.Policies[i].applyTo(&state)
			resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
			return
		}
	}
	resp.State.RemoveResource(ctx)
}

func (r *policyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state policyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out struct {
		Policy apiPolicy `json:"policy"`
	}
	if err := r.client.Put(ctx, "/api/v1/policies/"+esc(state.ID.ValueString()), plan.body(), &out); err != nil {
		resp.Diagnostics.AddError("Updating policy failed", err.Error())
		return
	}
	out.Policy.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *policyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state policyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, "/api/v1/policies/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Deleting policy failed", err.Error())
	}
}

func (r *policyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
