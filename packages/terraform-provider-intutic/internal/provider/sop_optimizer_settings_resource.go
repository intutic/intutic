package provider

import (
	"context"
	"fmt"
	"math"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/float64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// The SOP Optimizer's approval mode: routes/dreamCycle.ts, GET and PUT
// /api/v1/dream-cycle/settings (OWNER/ADMIN to write). One per workspace. The
// PUT takes mode and threshold every time and sets an omitted threshold to
// 0.85, so every write sends both.

const optimizerSettingsPath = "/api/v1/dream-cycle/settings"

type sopOptimizerSettingsResource struct{ client *client.Client }

type sopOptimizerSettingsModel struct {
	ID            types.String  `tfsdk:"id"`
	Mode          types.String  `tfsdk:"mode"`
	AutoThreshold types.Float64 `tfsdk:"auto_threshold"`
}

type apiOptimizerSettings struct {
	WorkspaceID   string  `json:"workspaceId"`
	Mode          string  `json:"mode"`
	AutoThreshold float64 `json:"autoThreshold"`
}

type apiOptimizerSettingsResponse struct {
	Settings apiOptimizerSettings `json:"settings"`
}

func newSopOptimizerSettingsResource() resource.Resource { return &sopOptimizerSettingsResource{} }

var _ resource.ResourceWithImportState = (*sopOptimizerSettingsResource)(nil)

func (r *sopOptimizerSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sop_optimizer_settings"
}

func (r *sopOptimizerSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The SOP Optimizer's approval mode (Labs › SOP Optimizer › Approval mode): whether a manually " +
			"triggered optimizer run may apply a strengthening proposal without review. It replaces the removed " +
			"`featureFlags.ff_metaclaw_auto_apply` key of `intutic_workspace_settings`. One per workspace; the OWNER or " +
			"ADMIN role writes it, and only a run on a plan that includes the SOP Optimizer (Biz Org and up) applies " +
			"anything. Destroying the resource sets the mode back to `manual` and keeps the threshold.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The workspace id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"mode": schema.StringAttribute{
				Required: true,
				Description: "`manual`: nothing is applied automatically; every proposal waits for review. `auto`: a " +
					"manually triggered run applies a proposal without review when its score reaches `auto_threshold` " +
					"and its change classification is `STRENGTHEN`; every other proposal still waits for review.",
				Validators: []validator.String{stringvalidator.OneOf("manual", "auto")},
			},
			"auto_threshold": schema.Float64Attribute{
				Optional: true,
				Computed: true,
				Description: "The score (0–1, at most three decimal places) a proposal must reach to be auto-applied in " +
					"`auto`. Omit it to keep the workspace's current threshold (0.85 when it never set one).",
				Validators:    []validator.Float64{float64validator.Between(0, 1), threeDecimals{}},
				PlanModifiers: []planmodifier.Float64{float64planmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *sopOptimizerSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (s *apiOptimizerSettings) applyTo(m *sopOptimizerSettingsModel) {
	m.ID = types.StringValue(s.WorkspaceID)
	m.Mode = types.StringValue(s.Mode)
	m.AutoThreshold = types.Float64Value(s.AutoThreshold)
}

func (r *sopOptimizerSettingsResource) get(ctx context.Context) (apiOptimizerSettings, error) {
	var out apiOptimizerSettingsResponse
	err := r.client.Get(ctx, optimizerSettingsPath, &out)
	return out.Settings, err
}

// write sends the mode and the threshold; an unknown threshold (omitted from
// a configuration with no state yet) is the workspace's current one.
func (r *sopOptimizerSettingsResource) write(ctx context.Context, m *sopOptimizerSettingsModel) error {
	threshold := m.AutoThreshold.ValueFloat64()
	if m.AutoThreshold.IsNull() || m.AutoThreshold.IsUnknown() {
		current, err := r.get(ctx)
		if err != nil {
			return err
		}
		threshold = current.AutoThreshold
	}
	body := map[string]any{"mode": m.Mode.ValueString(), "autoThreshold": threshold}
	if err := r.client.Put(ctx, optimizerSettingsPath, body, nil); err != nil {
		return err
	}
	out, err := r.get(ctx)
	if err != nil {
		return err
	}
	out.applyTo(m)
	return nil
}

func (r *sopOptimizerSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sopOptimizerSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Setting the SOP Optimizer approval mode failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *sopOptimizerSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sopOptimizerSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	out, err := r.get(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Reading the SOP Optimizer approval mode failed", err.Error())
		return
	}
	// The API serves the key's workspace whatever id is in state, so an import
	// of another workspace's id would otherwise manage this one's mode.
	if state.ID.ValueString() != out.WorkspaceID {
		resp.Diagnostics.AddError("Wrong workspace",
			fmt.Sprintf("This resource manages workspace %s, but the provider's API key belongs to %s.",
				state.ID.ValueString(), out.WorkspaceID))
		return
	}
	out.applyTo(&state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *sopOptimizerSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan sopOptimizerSettingsModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Updating the SOP Optimizer approval mode failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete sets the mode back to `manual`, the default, so a destroyed resource
// stops auto-applying; the threshold is kept.
func (r *sopOptimizerSettingsResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state sopOptimizerSettingsModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	state.Mode = types.StringValue("manual")
	if err := r.write(ctx, &state); err != nil {
		resp.Diagnostics.AddError("Setting the SOP Optimizer approval mode back to manual failed", err.Error())
	}
}

// ImportState takes the workspace id, which must be the provider key's
// workspace: Read refuses any other.
func (r *sopOptimizerSettingsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

// threeDecimals refuses a value with more than three decimal places: the
// control plane stores the threshold as numeric(4,3), so 0.8555 would read
// back as 0.856 and never match the configuration.
type threeDecimals struct{}

func (threeDecimals) Description(context.Context) string {
	return "must have at most three decimal places"
}

func (v threeDecimals) MarkdownDescription(ctx context.Context) string { return v.Description(ctx) }

func (threeDecimals) ValidateFloat64(_ context.Context, req validator.Float64Request, resp *validator.Float64Response) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	scaled := req.ConfigValue.ValueFloat64() * 1000
	if math.Abs(scaled-math.Round(scaled)) > 1e-6 {
		resp.Diagnostics.AddAttributeError(req.Path, "Too many decimal places",
			fmt.Sprintf("%v has more than three decimal places; the control plane stores the threshold to three.", req.ConfigValue.ValueFloat64()))
	}
}
