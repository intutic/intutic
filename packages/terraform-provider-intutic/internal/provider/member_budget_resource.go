package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Member budget routes: routes/budget.ts — PUT and DELETE
// /api/v1/budget/members/:memberId, read back from GET /api/v1/budget/members.
// OWNER/ADMIN, on a plan with member budgets (Biz Org and up).

type memberBudgetResource struct{ client *client.Client }

type memberBudgetModel struct {
	ID                       types.String  `tfsdk:"id"`
	MemberID                 types.String  `tfsdk:"member_id"`
	DailyBudgetUsd           types.Float64 `tfsdk:"daily_budget_usd"`
	DailyBudgetEnforcement   types.String  `tfsdk:"daily_budget_enforcement"`
	MonthlyBudgetUsd         types.Float64 `tfsdk:"monthly_budget_usd"`
	MonthlyBudgetEnforcement types.String  `tfsdk:"monthly_budget_enforcement"`
}

type memberBudgetsList struct {
	DefaultBudgets []spendBudget `json:"defaultBudgets"`
	Members        []struct {
		MemberID string        `json:"memberId"`
		Budgets  []spendBudget `json:"budgets"`
	} `json:"members"`
}

func newMemberBudgetResource() resource.Resource { return &memberBudgetResource{} }

var _ resource.ResourceWithImportState = (*memberBudgetResource)(nil)

func (r *memberBudgetResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_member_budget"
}

func (r *memberBudgetResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	attrs := map[string]schema.Attribute{
		"id": schema.StringAttribute{
			Computed:      true,
			Description:   "The member id, or `default`.",
			PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
		},
		"member_id": schema.StringAttribute{
			Required: true,
			Description: "The member whose spend this limits — across the virtual keys they own — or `default` for " +
				"the budget every member without their own gets for that period.",
			Validators:    []validator.String{stringvalidator.LengthBetween(1, 64)},
			PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
		},
	}
	for name, attr := range budgetAttributes("the member") {
		attrs[name] = attr
	}
	resp.Schema = schema.Schema{
		Description: "A member's LLM spend budgets per UTC day and month, or the default member budget " +
			"(`member_id = \"default\"`). A member's own budget for a period replaces the default's for that period. " +
			"Needs a plan with member budgets (Biz Org and up) and the OWNER or ADMIN role. Destroying the resource " +
			"removes the budgets.",
		Attributes: attrs,
	}
}

func (r *memberBudgetResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (m *memberBudgetModel) fields() budgetFields {
	return budgetFields{m.DailyBudgetUsd, m.DailyBudgetEnforcement, m.MonthlyBudgetUsd, m.MonthlyBudgetEnforcement}
}

func (m *memberBudgetModel) apply(list []spendBudget) {
	f := fieldsFrom(list)
	m.DailyBudgetUsd, m.DailyBudgetEnforcement = f.DailyUsd, f.DailyEnforcement
	m.MonthlyBudgetUsd, m.MonthlyBudgetEnforcement = f.MonthlyUsd, f.MonthlyEnforcement
}

func (r *memberBudgetResource) put(ctx context.Context, m *memberBudgetModel) error {
	var out struct {
		Budgets []spendBudget `json:"budgets"`
	}
	err := r.client.Put(ctx, "/api/v1/budget/members/"+esc(m.MemberID.ValueString()), map[string]any{"budgets": m.fields().budgets()}, &out)
	if err == nil {
		m.ID = m.MemberID
		m.apply(out.Budgets)
	}
	return err
}

func (r *memberBudgetResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan memberBudgetModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.put(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Setting member budgets failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *memberBudgetResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state memberBudgetModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out memberBudgetsList
	if err := r.client.Get(ctx, "/api/v1/budget/members", &out); err != nil {
		resp.Diagnostics.AddError("Reading member budgets failed", err.Error())
		return
	}
	id := state.ID.ValueString()
	var budgets []spendBudget
	found := id == "default"
	if found {
		budgets = out.DefaultBudgets
	}
	for _, m := range out.Members {
		if m.MemberID == id {
			budgets, found = m.Budgets, true
		}
	}
	// A member no longer in the workspace, or budgets removed outside
	// Terraform: nothing left to manage.
	if !found || len(budgets) == 0 {
		resp.State.RemoveResource(ctx)
		return
	}
	state.MemberID = state.ID
	state.apply(budgets)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *memberBudgetResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan memberBudgetModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.put(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Updating member budgets failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *memberBudgetResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state memberBudgetModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, "/api/v1/budget/members/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Removing member budgets failed", err.Error())
	}
}

func (r *memberBudgetResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
