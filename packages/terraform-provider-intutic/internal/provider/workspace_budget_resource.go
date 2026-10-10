package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// The workspace's caps: routes/budget.ts, GET and PUT /api/v1/budget
// (OWNER/ADMIN to write). One per workspace.

type workspaceBudgetResource struct{ client *client.Client }

type workspaceBudgetModel struct {
	ID                 types.String  `tfsdk:"id"`
	DailyBudgetUsd     types.Float64 `tfsdk:"daily_budget_usd"`
	MonthlyBudgetUsd   types.Float64 `tfsdk:"monthly_budget_usd"`
	AlertThresholdPct  types.Int64   `tfsdk:"alert_threshold_pct"`
	DailyEnforcement   types.String  `tfsdk:"daily_enforcement"`
	MonthlyEnforcement types.String  `tfsdk:"monthly_enforcement"`
}

type apiWorkspaceBudget struct {
	WorkspaceID        string  `json:"workspace_id"`
	DailyBudgetUsd     float64 `json:"daily_budget_usd"`
	DailyIsDefault     bool    `json:"daily_budget_is_default"`
	MonthlyBudgetUsd   float64 `json:"monthly_budget_usd"`
	AlertThresholdPct  int64   `json:"alert_threshold_pct"`
	DailyEnforcement   string  `json:"daily_enforcement"`
	MonthlyEnforcement string  `json:"monthly_enforcement"`
}

func newWorkspaceBudgetResource() resource.Resource { return &workspaceBudgetResource{} }

var _ resource.ResourceWithImportState = (*workspaceBudgetResource)(nil)

func (r *workspaceBudgetResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace_budget"
}

func (r *workspaceBudgetResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	mode := func(period, dflt string) schema.StringAttribute {
		return schema.StringAttribute{
			Optional: true,
			Computed: true,
			Default:  stringdefault.StaticString(dflt),
			Description: "`hard`: the proxy refuses a request the rest of the " + period + "'s cap does not cover, with " +
				"`429 BUDGET_EXCEEDED`. `soft`: the cap only raises alerts. Defaults to `" + dflt + "`.",
			Validators: []validator.String{stringvalidator.OneOf("hard", "soft")},
		}
	}
	resp.Schema = schema.Schema{
		Description: "The workspace's daily and monthly LLM spend caps and budget alert threshold " +
			"(Settings › Billing › Budget Limits). One per workspace; the OWNER or ADMIN role writes it. Destroying " +
			"the resource leaves the caps as they are.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The workspace id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"daily_budget_usd": schema.Float64Attribute{
				Optional: true,
				Description: "Daily cap in USD (0–100,000); 0 is no daily cap. A UTC day. Omit it to hold the workspace to " +
					"the $100 default daily cap; removing it from a configuration returns a saved cap to that default.",
				Validators:  []validator.Float64{float64validator.Between(0, 100_000)},
			},
			"monthly_budget_usd": schema.Float64Attribute{
				Required:    true,
				Description: "Monthly cap in USD (0–1,000,000); 0 is no monthly cap. A UTC calendar month.",
				Validators:  []validator.Float64{float64validator.Between(0, 1_000_000)},
			},
			"alert_threshold_pct": schema.Int64Attribute{
				Optional:    true,
				Computed:    true,
				Default:     int64default.StaticInt64(80),
				Description: "Raise a budget alert at this percentage of each cap, and of every key and member budget (1–100).",
				Validators:  []validator.Int64{int64validator.Between(1, 100)},
			},
			"daily_enforcement":   mode("day", "hard"),
			"monthly_enforcement": mode("month", "soft"),
		},
	}
}

func (r *workspaceBudgetResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (b *apiWorkspaceBudget) applyTo(m *workspaceBudgetModel) {
	m.ID = types.StringValue(b.WorkspaceID)
	if b.DailyIsDefault {
		m.DailyBudgetUsd = types.Float64Null()
	} else {
		m.DailyBudgetUsd = types.Float64Value(b.DailyBudgetUsd)
	}
	m.MonthlyBudgetUsd = types.Float64Value(b.MonthlyBudgetUsd)
	m.AlertThresholdPct = types.Int64Value(b.AlertThresholdPct)
	m.DailyEnforcement = types.StringValue(b.DailyEnforcement)
	m.MonthlyEnforcement = types.StringValue(b.MonthlyEnforcement)
}

func (r *workspaceBudgetResource) write(ctx context.Context, m *workspaceBudgetModel) error {
	// A null daily cap is sent as null: the workspace stays on, or returns
	// to, the default rather than saving it as its own.
	var daily any
	if !m.DailyBudgetUsd.IsNull() && !m.DailyBudgetUsd.IsUnknown() {
		daily = m.DailyBudgetUsd.ValueFloat64()
	}
	body := map[string]any{
		"daily_budget_usd":    daily,
		"monthly_budget_usd":  m.MonthlyBudgetUsd.ValueFloat64(),
		"alert_threshold_pct": m.AlertThresholdPct.ValueInt64(),
		"daily_enforcement":   m.DailyEnforcement.ValueString(),
		"monthly_enforcement": m.MonthlyEnforcement.ValueString(),
	}
	if err := r.client.Put(ctx, "/api/v1/budget", body, nil); err != nil {
		return err
	}
	var out apiWorkspaceBudget
	if err := r.client.Get(ctx, "/api/v1/budget", &out); err != nil {
		return err
	}
	out.applyTo(m)
	return nil
}

func (r *workspaceBudgetResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan workspaceBudgetModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Setting the workspace budget failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *workspaceBudgetResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state workspaceBudgetModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out apiWorkspaceBudget
	if err := r.client.Get(ctx, "/api/v1/budget", &out); err != nil {
		resp.Diagnostics.AddError("Reading the workspace budget failed", err.Error())
		return
	}
	out.applyTo(&state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *workspaceBudgetResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan workspaceBudgetModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.write(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Updating the workspace budget failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete leaves the caps as they are: a workspace always has caps, and
// guessing values to reset them to would be a change nobody configured.
func (r *workspaceBudgetResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {}

func (r *workspaceBudgetResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
