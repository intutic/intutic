package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-jsontypes/jsontypes"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

const settingsPath = "/api/v1/workspace/settings"

type workspaceSettingsResource struct{ client *client.Client }

type workspaceSettingsModel struct {
	ID       types.String         `tfsdk:"id"`
	Settings jsontypes.Normalized `tfsdk:"settings"`
}

type settingsResponse struct {
	WorkspaceID string         `json:"workspaceId"`
	Settings    settingsObject `json:"settings"`
}

func newWorkspaceSettingsResource() resource.Resource { return &workspaceSettingsResource{} }

var (
	_ resource.ResourceWithImportState    = (*workspaceSettingsResource)(nil)
	_ resource.ResourceWithValidateConfig = (*workspaceSettingsResource)(nil)
)

func (r *workspaceSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace_settings"
}

func (r *workspaceSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The workspace's governance settings, written through `PUT /api/v1/workspace/settings`. " +
			"Declare one per workspace. Terraform manages only the keys you set: each top-level key is compared " +
			"and written whole (the API replaces it whole), except `featureFlags`, which is managed flag by flag. " +
			"Keys you do not set are never sent, so values set in the dashboard or by another tool are left alone. " +
			"Removing a key from the configuration stops managing it and leaves its value in place; destroying the " +
			"resource changes nothing in the workspace. Spend caps are not settings and are not managed here: a " +
			"workspace that has not saved a daily cap is held to $100 a day; set caps on Settings › Billing › Budget " +
			"Limits or with `PUT /api/v1/budget`. Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The workspace id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"settings": schema.StringAttribute{
				CustomType: jsontypes.NormalizedType{},
				Required:   true,
				Description: "A JSON object of the settings to manage, usually `jsonencode({ ... })`. Keys and value " +
					"shapes are those of the settings API; an unknown key fails the plan. Write values the way the " +
					"API stores them (bandit keywords in lower case, for example), or the next plan shows the " +
					"stored form as a change. Every key, its values and bounds, and the feature flags are listed in " +
					"[Workspace Settings](https://docs.intutic.ai/reference/workspace-settings).",
				Validators: []validator.String{jsonObjectValidator{}},
			},
		},
	}
}

func (r *workspaceSettingsResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg workspaceSettingsModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.Settings.IsNull() || cfg.Settings.IsUnknown() {
		return
	}
	obj, err := parseSettings(cfg.Settings.ValueString())
	if err != nil {
		return // jsonObjectValidator reports it
	}
	if len(obj) == 0 {
		resp.Diagnostics.AddAttributeError(path.Root("settings"), "No settings",
			"Set at least one key; the API refuses an empty update.")
	}
	if problems := validateSettingsKeys(obj); len(problems) > 0 {
		resp.Diagnostics.AddAttributeError(path.Root("settings"), "Unknown workspace setting",
			strings.Join(problems, "\n")+"\n\nAccepted keys: "+strings.Join(settingsKeys.Keys, ", "))
	}
}

func (r *workspaceSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (r *workspaceSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan workspaceSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	want, err := parseSettings(plan.Settings.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid settings", err.Error())
		return
	}
	r.write(ctx, want, want, &plan, resp.State.Set, &resp.Diagnostics)
}

func (r *workspaceSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state workspaceSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	want, err := parseSettings(plan.Settings.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Invalid settings", err.Error())
		return
	}
	prior, err := parseSettings(state.Settings.ValueString())
	if err != nil {
		prior = settingsObject{}
	}
	r.write(ctx, changedSettings(prior, want), want, &plan, resp.State.Set, &resp.Diagnostics)
}

// write PUTs body and records want, warning when the API stored something
// other than what was sent for a managed key.
func (r *workspaceSettingsResource) write(ctx context.Context, body, want settingsObject, plan *workspaceSettingsModel,
	set func(context.Context, any) diag.Diagnostics, diags *diag.Diagnostics) {
	var out settingsResponse
	if len(body) > 0 {
		if err := r.client.Put(ctx, settingsPath, body, &out); err != nil {
			diags.AddError("Updating workspace settings failed", err.Error())
			return
		}
	} else if err := r.client.Get(ctx, settingsPath, &out); err != nil {
		diags.AddError("Reading workspace settings failed", err.Error())
		return
	}
	if keys := differingKeys(projectSettings(out.Settings, want), want); len(keys) > 0 {
		diags.AddAttributeWarning(path.Root("settings"), "The API stored a different value",
			fmt.Sprintf("The workspace now holds a different value than configured for: %s. "+
				"Change the configuration to the stored form, or the next plan shows it as a change.",
				strings.Join(keys, ", ")))
	}
	plan.ID = types.StringValue(out.WorkspaceID)
	diags.Append(set(ctx, plan)...)
}

func (r *workspaceSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state workspaceSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out settingsResponse
	if err := r.client.Get(ctx, settingsPath, &out); err != nil {
		resp.Diagnostics.AddError("Reading workspace settings failed", err.Error())
		return
	}
	if state.ID.ValueString() != out.WorkspaceID {
		resp.Diagnostics.AddError("Wrong workspace",
			fmt.Sprintf("This resource manages workspace %s, but the provider's API key belongs to %s.",
				state.ID.ValueString(), out.WorkspaceID))
		return
	}
	managed := settingsObject{}
	if !state.Settings.IsNull() {
		if m, err := parseSettings(state.Settings.ValueString()); err == nil {
			managed = m
		}
	}
	state.Settings = jsontypes.NewNormalizedValue(projectSettings(out.Settings, managed).String())
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Delete changes nothing in the workspace: the API has no "unset", and putting
// back what was there before Terraform is not knowable. It only stops managing.
func (r *workspaceSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	resp.Diagnostics.AddWarning("Workspace settings left in place",
		"Destroying intutic_workspace_settings stops Terraform managing these keys; their values stay as they are.")
}

// ImportState takes the workspace id, which must be the provider key's workspace.
// The imported resource manages no keys until the configuration names some.
func (r *workspaceSettingsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("settings"), jsontypes.NewNormalizedValue("{}"))...)
}
