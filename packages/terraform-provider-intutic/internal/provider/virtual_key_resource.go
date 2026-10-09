package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Virtual-key routes: routes/keys.ts, validated by CreateApiKeyInputSchema.
// There is no update route, so every input replaces the key.

type virtualKeyResource struct{ client *client.Client }

type virtualKeyModel struct {
	ID               types.String `tfsdk:"id"`
	Label            types.String `tfsdk:"label"`
	Scopes           types.List   `tfsdk:"scopes"`
	ExpiresInDays    types.Int64  `tfsdk:"expires_in_days"`
	AllowedModels    types.List   `tfsdk:"allowed_models"`
	IsServiceAccount types.Bool   `tfsdk:"is_service_account"`
	Key              types.String `tfsdk:"key"`
	KeyPrefix        types.String `tfsdk:"key_prefix"`
	ExpiresAt        types.String `tfsdk:"expires_at"`
	CreatedAt        types.String `tfsdk:"created_at"`
}

type apiKey struct {
	KeyID            string   `json:"keyId"`
	Key              string   `json:"key"`
	KeyPrefix        string   `json:"keyPrefix"`
	Label            string   `json:"label"`
	Scopes           []string `json:"scopes"`
	AllowedModels    []string `json:"allowedModels"`
	ExpiresAt        *string  `json:"expiresAt"`
	RevokedAt        *string  `json:"revokedAt"`
	CreatedAt        string   `json:"createdAt"`
	IsServiceAccount *bool    `json:"isServiceAccount"`
}

func newVirtualKeyResource() resource.Resource { return &virtualKeyResource{} }

var _ resource.ResourceWithImportState = (*virtualKeyResource)(nil)

func (r *virtualKeyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_virtual_key"
}

func (r *virtualKeyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replaceString := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		Description: "A virtual API key (`vk_…`), created through `POST /api/v1/keys` for the member that owns the " +
			"provider's own key. The key value is returned once, at creation, and stored in Terraform state as a " +
			"sensitive value; protect the state accordingly. Keys cannot be edited, so any change replaces the key. " +
			"Destroying the resource revokes it.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The key id (`key_…`).",
				PlanModifiers: keep,
			},
			"label": schema.StringAttribute{
				Required:      true,
				Validators:    []validator.String{stringvalidator.LengthBetween(1, 128)},
				PlanModifiers: replaceString,
			},
			"scopes": schema.ListAttribute{
				ElementType: types.StringType,
				Optional:    true,
				Computed:    true,
				Description: "Scopes recorded on the key; defaults to `[\"*\"]`. Attenuated child keys can only narrow them.",
				PlanModifiers: []planmodifier.List{
					listplanmodifier.RequiresReplaceIfConfigured(),
					listplanmodifier.UseStateForUnknown(),
				},
			},
			"expires_in_days": schema.Int64Attribute{
				Optional:      true,
				Description:   "Days until the key expires (1–365). Omit for a key that does not expire.",
				Validators:    []validator.Int64{int64validator.Between(1, 365)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"allowed_models": schema.ListAttribute{
				ElementType: types.StringType,
				Optional:    true,
				Description: "Models this key may call, intersected with the workspace's approved list (at most 64). " +
					"Omit to inherit the workspace list.",
				Validators: []validator.List{
					listvalidator.SizeBetween(1, 64),
					listvalidator.ValueStringsAre(
						stringvalidator.LengthBetween(1, 128),
						stringvalidator.RegexMatches(noSurroundingSpaces, "must not start or end with whitespace"),
					),
				},
				PlanModifiers: []planmodifier.List{listplanmodifier.RequiresReplace()},
			},
			"is_service_account": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				Description: "Marks an automation key (CI, scripts, a service): exempt from the SSO-recency window, " +
					"still revoked when its member is deactivated. Defaults to false, as in the API.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.RequiresReplace()},
			},
			"key": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "The plaintext key. Only known for a key Terraform created; null after an import.",
				PlanModifiers: keep,
			},
			"key_prefix": schema.StringAttribute{
				Computed:      true,
				Description:   "The key's first 12 characters, as the dashboard shows them.",
				PlanModifiers: keep,
			},
			"expires_at": schema.StringAttribute{
				Computed:      true,
				Description:   "Expiry time (RFC 3339), or null.",
				PlanModifiers: keep,
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: keep,
			},
		},
	}
}

func (r *virtualKeyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (r *virtualKeyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan virtualKeyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"label":            plan.Label.ValueString(),
		"isServiceAccount": plan.IsServiceAccount.ValueBool(),
	}
	if scopes := listStrings(ctx, plan.Scopes, &resp.Diagnostics); scopes != nil {
		body["scopes"] = scopes
	}
	if !plan.ExpiresInDays.IsNull() {
		body["expiresInDays"] = plan.ExpiresInDays.ValueInt64()
	}
	if models := listStrings(ctx, plan.AllowedModels, &resp.Diagnostics); models != nil {
		body["allowedModels"] = models
	}
	var out apiKey
	if err := r.client.Post(ctx, "/api/v1/keys", body, &out); err != nil {
		resp.Diagnostics.AddError("Creating virtual key failed", err.Error())
		return
	}
	plan.Key = types.StringValue(out.Key)
	out.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (k *apiKey) applyTo(m *virtualKeyModel) {
	m.ID = types.StringValue(k.KeyID)
	m.Label = types.StringValue(k.Label)
	m.Scopes = stringList(k.Scopes)
	m.AllowedModels = stringList(k.AllowedModels)
	m.KeyPrefix = types.StringValue(k.KeyPrefix)
	m.ExpiresAt = stringOrNull(k.ExpiresAt)
	m.CreatedAt = types.StringValue(k.CreatedAt)
	if k.IsServiceAccount != nil {
		m.IsServiceAccount = types.BoolValue(*k.IsServiceAccount)
	}
}

func (r *virtualKeyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state virtualKeyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// The list holds the calling member's keys, revoked ones included.
	var out struct {
		Data []apiKey `json:"data"`
	}
	if err := r.client.Get(ctx, "/api/v1/keys", &out); err != nil {
		resp.Diagnostics.AddError("Reading virtual keys failed", err.Error())
		return
	}
	for i := range out.Data {
		k := &out.Data[i]
		if k.KeyID != state.ID.ValueString() {
			continue
		}
		if k.RevokedAt != nil {
			break
		}
		k.applyTo(&state)
		if state.IsServiceAccount.IsNull() || state.IsServiceAccount.IsUnknown() {
			state.IsServiceAccount = types.BoolValue(false)
		}
		if state.Key.IsUnknown() {
			state.Key = types.StringNull()
		}
		resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
		return
	}
	resp.State.RemoveResource(ctx)
}

func (r *virtualKeyResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError("Virtual keys cannot be updated",
		"Every attribute of intutic_virtual_key forces replacement; this is a provider bug.")
}

func (r *virtualKeyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state virtualKeyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, "/api/v1/keys/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Revoking virtual key failed", err.Error())
	}
}

func (r *virtualKeyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
