package provider

import (
	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Spend budgets as the API carries them (shared-types spendBudgets.ts): at
// most one per period, `day` or `month`, each `hard` (the proxy refuses what
// it does not cover) or `soft` (alerts only). Key budgets travel on
// PATCH /api/v1/keys/:id, member budgets on PUT /api/v1/budget/members/:id;
// both replace the subject's budgets whole.

type spendBudget struct {
	Period      string  `json:"period"`
	LimitUsd    float64 `json:"limitUsd"`
	Enforcement string  `json:"enforcement"`
}

// budgetFields are the four attributes a key or member budget is written as:
// one amount and one enforcement per period.
type budgetFields struct {
	DailyUsd           types.Float64
	DailyEnforcement   types.String
	MonthlyUsd         types.Float64
	MonthlyEnforcement types.String
}

func (f budgetFields) budgets() []spendBudget {
	out := []spendBudget{}
	if !f.DailyUsd.IsNull() && !f.DailyUsd.IsUnknown() {
		out = append(out, spendBudget{"day", f.DailyUsd.ValueFloat64(), enforcementOr(f.DailyEnforcement)})
	}
	if !f.MonthlyUsd.IsNull() && !f.MonthlyUsd.IsUnknown() {
		out = append(out, spendBudget{"month", f.MonthlyUsd.ValueFloat64(), enforcementOr(f.MonthlyEnforcement)})
	}
	return out
}

func enforcementOr(v types.String) string {
	if v.IsNull() || v.IsUnknown() || v.ValueString() == "" {
		return "hard"
	}
	return v.ValueString()
}

// fieldsFrom reads the API's budgets back into the four attributes. A period
// with no budget reads as a null amount and the default enforcement.
func fieldsFrom(list []spendBudget) budgetFields {
	f := budgetFields{
		DailyUsd:           types.Float64Null(),
		DailyEnforcement:   types.StringValue("hard"),
		MonthlyUsd:         types.Float64Null(),
		MonthlyEnforcement: types.StringValue("hard"),
	}
	for _, b := range list {
		switch b.Period {
		case "day":
			f.DailyUsd = types.Float64Value(b.LimitUsd)
			f.DailyEnforcement = types.StringValue(b.Enforcement)
		case "month":
			f.MonthlyUsd = types.Float64Value(b.LimitUsd)
			f.MonthlyEnforcement = types.StringValue(b.Enforcement)
		}
	}
	return f
}

// budgetAttributes is the schema for the four attributes, with `whose`
// naming the subject in the descriptions ("the key", "the member").
func budgetAttributes(whose string) map[string]schema.Attribute {
	amount := func(period string) schema.Float64Attribute {
		return schema.Float64Attribute{
			Optional: true,
			Description: "Spend " + whose + " may run up per UTC " + period + ", in USD (above 0, at most 1,000,000). " +
				"Omit for no " + period + " budget.",
			Validators: []validator.Float64{float64validator.Between(0.0001, 1_000_000)},
		}
	}
	mode := func(period string) schema.StringAttribute {
		return schema.StringAttribute{
			Optional: true,
			Computed: true,
			Default:  stringdefault.StaticString("hard"),
			Description: "`hard` (the default): the proxy refuses a request the rest of the " + period +
				" budget does not cover, with `429 BUDGET_EXCEEDED`. `soft`: the budget only raises alerts.",
			Validators: []validator.String{stringvalidator.OneOf("hard", "soft")},
		}
	}
	return map[string]schema.Attribute{
		"daily_budget_usd":           amount("day"),
		"daily_budget_enforcement":   mode("day"),
		"monthly_budget_usd":         amount("month"),
		"monthly_budget_enforcement": mode("month"),
	}
}
