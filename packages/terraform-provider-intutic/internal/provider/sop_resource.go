package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// SOP routes: routes/sops.ts. Limits are CreateSopSchema / UpdateSopSchema's.
var (
	sopRiskTiers       = []string{"LOW", "MEDIUM", "HIGH", "CRITICAL"}
	sopComplexityTiers = []string{"TIER_0", "TIER_1", "TIER_2"}
)

const sopLifecycleDraft = "DRAFT"

type sopResource struct{ client *client.Client }

type sopModel struct {
	ID              types.String `tfsdk:"id"`
	Title           types.String `tfsdk:"title"`
	MarkdownContent types.String `tfsdk:"markdown_content"`
	RiskTier        types.String `tfsdk:"risk_tier"`
	ComplexityTier  types.String `tfsdk:"complexity_tier"`
	Version         types.String `tfsdk:"version"`
	LifecycleState  types.String `tfsdk:"lifecycle_state"`
	VersionCounter  types.Int64  `tfsdk:"version_counter"`
	ContentHash     types.String `tfsdk:"content_hash"`
}

type apiSop struct {
	SopID           string `json:"sopId"`
	Title           string `json:"title"`
	Version         string `json:"version"`
	MarkdownContent string `json:"markdownContent"`
	RiskTier        string `json:"riskTier"`
	ComplexityTier  string `json:"complexityTier"`
	IsActive        bool   `json:"isActive"`
	LifecycleState  string `json:"lifecycleState"`
	VersionCounter  int64  `json:"versionCounter"`
	ContentHash     string `json:"contentHash"`
}

func newSopResource() resource.Resource { return &sopResource{} }

var (
	_ resource.ResourceWithImportState = (*sopResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*sopResource)(nil)
)

func (r *sopResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sop"
}

func (r *sopResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A workspace SOP (rule set), managed through `/api/v1/sops`. A new SOP starts in `DRAFT`. " +
			"Promotion through review, shadow and `VALIDATED` stays in the SOP review workflow, because each step " +
			"is gated on evidence (the Gödel score, shadow results). Editing a SOP that is not a draft forks a new " +
			"`DRAFT` version with a new id and retires the old one, exactly as an edit in the dashboard does; the " +
			"plan shows `lifecycle_state` returning to `DRAFT` when that will happen.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:    true,
				Description: "The SOP id (`sp_…`). Changes when an edit forks a new version.",
			},
			"title": schema.StringAttribute{
				Required:   true,
				Validators: []validator.String{stringvalidator.LengthBetween(1, 256)},
			},
			"markdown_content": schema.StringAttribute{
				Required:    true,
				Description: "The SOP body in Markdown (at most 100,000 characters).",
				Validators:  []validator.String{stringvalidator.LengthBetween(1, 100_000)},
			},
			"risk_tier": schema.StringAttribute{
				Required:    true,
				Description: "One of `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.",
				Validators:  []validator.String{stringvalidator.OneOf(sopRiskTiers...)},
			},
			"complexity_tier": schema.StringAttribute{
				Required:    true,
				Description: "One of `TIER_0`, `TIER_1`, `TIER_2`.",
				Validators:  []validator.String{stringvalidator.OneOf(sopComplexityTiers...)},
			},
			"version": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Description: "Version label (at most 16 characters). The API sets `1.0.0` on create and bumps the " +
					"patch number when an edit forks a new version, unless you set it.",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 16)},
			},
			"lifecycle_state": schema.StringAttribute{
				Computed:    true,
				Description: "Where the SOP is in its review lifecycle (`DRAFT` … `VALIDATED`, `INVALIDATED`).",
			},
			"version_counter": schema.Int64Attribute{
				Computed:    true,
				Description: "Optimistic-lock token; an update sends it so a concurrent edit is refused, not overwritten.",
			},
			"content_hash": schema.StringAttribute{
				Computed:    true,
				Description: "SHA-256 of `markdown_content`, as `intutic sops status` compares it.",
			},
		},
	}
}

func (r *sopResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

// ModifyPlan states what an update will do to the computed identity. An edit
// of a DRAFT happens in place; an edit of anything else forks (sopService.ts
// updateSop → forkSopVersion), so the id is new and the version is bumped.
// Either way the result is a DRAFT.
func (r *sopResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var plan, state sopModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var configVersion types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("version"), &configVersion)...)

	changed := !plan.Title.Equal(state.Title) || !plan.MarkdownContent.Equal(state.MarkdownContent) ||
		!plan.RiskTier.Equal(state.RiskTier) || !plan.ComplexityTier.Equal(state.ComplexityTier) ||
		(!configVersion.IsNull() && !configVersion.Equal(state.Version))
	if !changed {
		return
	}

	plan.LifecycleState = types.StringValue(sopLifecycleDraft)
	if state.LifecycleState.ValueString() == sopLifecycleDraft {
		plan.ID = state.ID
		if configVersion.IsNull() {
			plan.Version = state.Version
		}
	} else {
		plan.ID = types.StringUnknown()
		if configVersion.IsNull() {
			plan.Version = types.StringUnknown()
		}
	}
	resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
}

func (r *sopResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sopModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	body := map[string]any{
		"title":            plan.Title.ValueString(),
		"markdown_content": plan.MarkdownContent.ValueString(),
		"risk_tier":        plan.RiskTier.ValueString(),
		"complexity_tier":  plan.ComplexityTier.ValueString(),
	}
	if !plan.Version.IsNull() && !plan.Version.IsUnknown() {
		body["version"] = plan.Version.ValueString()
	}
	var created apiSop
	if err := r.client.Post(ctx, "/api/v1/sops", body, &created); err != nil {
		resp.Diagnostics.AddError("Creating SOP failed", err.Error())
		return
	}
	r.readInto(ctx, created.SopID, &plan, resp.State.Set, &resp.Diagnostics)
}

func (r *sopResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sopModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	sop, err := r.get(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Reading SOP failed", err.Error())
		return
	}
	// A deleted SOP is soft-deleted (isActive false), and so is the prior
	// version an edit forked away from: either way this id is no longer the
	// live SOP, and Terraform should plan to create it.
	if sop == nil || !sop.IsActive {
		resp.State.RemoveResource(ctx)
		return
	}
	sop.applyTo(&state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *sopResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state sopModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Only the fields that changed: the API's anti-gaming analysis compares the
	// markdown it is sent against the stored copy.
	body := map[string]any{"version_counter": state.VersionCounter.ValueInt64()}
	if !plan.Title.Equal(state.Title) {
		body["title"] = plan.Title.ValueString()
	}
	if !plan.MarkdownContent.Equal(state.MarkdownContent) {
		body["markdown_content"] = plan.MarkdownContent.ValueString()
	}
	if !plan.RiskTier.Equal(state.RiskTier) {
		body["risk_tier"] = plan.RiskTier.ValueString()
	}
	if !plan.ComplexityTier.Equal(state.ComplexityTier) {
		body["complexity_tier"] = plan.ComplexityTier.ValueString()
	}
	if !plan.Version.IsUnknown() && !plan.Version.Equal(state.Version) {
		body["version"] = plan.Version.ValueString()
	}

	var updated struct {
		Sop apiSop `json:"sop"`
	}
	if err := r.client.Put(ctx, "/api/v1/sops/"+esc(state.ID.ValueString()), body, &updated); err != nil {
		resp.Diagnostics.AddError("Updating SOP failed", err.Error())
		return
	}
	// The PUT answers with a partial SOP (no content hash), and with a new id
	// when the edit forked; read the result back in full.
	r.readInto(ctx, updated.Sop.SopID, &plan, resp.State.Set, &resp.Diagnostics)
}

func (r *sopResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state sopModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, "/api/v1/sops/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Deleting SOP failed", err.Error())
	}
}

func (r *sopResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

func (r *sopResource) get(ctx context.Context, id string) (*apiSop, error) {
	var sop apiSop
	if err := r.client.Get(ctx, "/api/v1/sops/"+esc(id), &sop); err != nil {
		if client.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &sop, nil
}

func (r *sopResource) readInto(ctx context.Context, id string, m *sopModel,
	set func(context.Context, any) diag.Diagnostics, diags *diag.Diagnostics) {
	sop, err := r.get(ctx, id)
	if err != nil || sop == nil {
		diags.AddError("Reading SOP after write failed", fmt.Sprintf("SOP %s: %v", id, err))
		return
	}
	sop.applyTo(m)
	diags.Append(set(ctx, m)...)
}

func (s *apiSop) applyTo(m *sopModel) {
	m.ID = types.StringValue(s.SopID)
	m.Title = types.StringValue(s.Title)
	m.MarkdownContent = types.StringValue(s.MarkdownContent)
	m.RiskTier = types.StringValue(s.RiskTier)
	m.ComplexityTier = types.StringValue(s.ComplexityTier)
	m.Version = types.StringValue(s.Version)
	m.LifecycleState = types.StringValue(s.LifecycleState)
	m.VersionCounter = types.Int64Value(s.VersionCounter)
	m.ContentHash = types.StringValue(s.ContentHash)
}
