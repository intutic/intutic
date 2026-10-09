package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
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

// Self-hosted gateway routes: routes/gateways.ts. Only the user-registrable
// deployment targets; managed cells are created by the platform.
var gatewayTargets = []string{"docker", "kubernetes", "bare_metal"}

type gatewayResource struct{ client *client.Client }

type gatewayModel struct {
	ID                    types.String `tfsdk:"id"`
	Name                  types.String `tfsdk:"name"`
	DeploymentTarget      types.String `tfsdk:"deployment_target"`
	RequireVk             types.Bool   `tfsdk:"require_vk"`
	RequireProvisionedKey types.Bool   `tfsdk:"require_provisioned_key"`
	Token                 types.String `tfsdk:"token"`
	KeyPrefix             types.String `tfsdk:"key_prefix"`
	Status                types.String `tfsdk:"status"`
	CreatedAt             types.String `tfsdk:"created_at"`
}

type apiGateway struct {
	GatewayID        string         `json:"gatewayId"`
	Name             string         `json:"name"`
	DeploymentTarget string         `json:"deploymentTarget"`
	Status           string         `json:"status"`
	KeyPrefix        string         `json:"keyPrefix"`
	CreatedAt        string         `json:"createdAt"`
	Config           *apiGatewayCfg `json:"config"`
	Token            string         `json:"token"`
}

type apiGatewayCfg struct {
	RequireVk             *bool `json:"requireVk"`
	RequireProvisionedKey *bool `json:"requireProvisionedKey"`
}

func newGatewayResource() resource.Resource { return &gatewayResource{} }

var _ resource.ResourceWithImportState = (*gatewayResource)(nil)

func (r *gatewayResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_gateway"
}

func (r *gatewayResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		Description: "A self-hosted gateway registered with `POST /api/v1/gateways` (Enterprise and Self-host plans). " +
			"Gateways belong to the workspace's organization. Registration returns the gateway's `gwk_…` token " +
			"once; it is stored in state as a sensitive value for `INTUTIC_GATEWAY_TOKEN`. Destroying the resource " +
			"revokes the gateway and its token at once. Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The gateway id (`gw_…`).",
				PlanModifiers: keep,
			},
			"name": schema.StringAttribute{
				Required: true,
				Validators: []validator.String{
					stringvalidator.LengthBetween(1, 128),
					stringvalidator.RegexMatches(noSurroundingSpaces, "must not start or end with whitespace (the API trims it)"),
				},
				PlanModifiers: replace,
			},
			"deployment_target": schema.StringAttribute{
				Required:      true,
				Description:   "One of `docker`, `kubernetes`, `bare_metal`.",
				Validators:    []validator.String{stringvalidator.OneOf(gatewayTargets...)},
				PlanModifiers: replace,
			},
			"require_vk": schema.BoolAttribute{
				Optional: true,
				Description: "Pushed to the gateway's proxy as live config: require a virtual key on every request. " +
					"Unset leaves the gateway's current value alone.",
			},
			"require_provisioned_key": schema.BoolAttribute{
				Optional: true,
				Description: "Pushed to the gateway's proxy as live config: require the caller's own provider key. " +
					"Unset leaves the gateway's current value alone.",
			},
			"token": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "The gateway's `gwk_…` token. Only known for a gateway Terraform registered.",
				PlanModifiers: keep,
			},
			"key_prefix": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: keep,
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Registration status (`pending` until the gateway first reports in).",
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: keep,
			},
		},
	}
}

func (r *gatewayResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (r *gatewayResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan gatewayModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var created apiGateway
	err := r.client.Post(ctx, "/api/v1/gateways", map[string]any{
		"name":             plan.Name.ValueString(),
		"deploymentTarget": plan.DeploymentTarget.ValueString(),
	}, &created)
	if err != nil {
		resp.Diagnostics.AddError("Registering gateway failed", err.Error())
		return
	}
	// Record the token before anything else can fail: it is never shown again.
	plan.ID = types.StringValue(created.GatewayID)
	plan.Token = types.StringValue(created.Token)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)

	if cfg := gatewayConfigBody(plan, gatewayModel{}); cfg != nil {
		if err := r.client.Patch(ctx, "/api/v1/gateways/"+esc(created.GatewayID)+"/config", cfg, nil); err != nil {
			resp.Diagnostics.AddError("Setting gateway config failed", err.Error())
			return
		}
	}
	r.refresh(ctx, &plan, resp.State.Set, &resp.Diagnostics)
}

// gatewayConfigBody is the PATCH body for the config flags the plan sets and
// that differ from state; nil when there is nothing to send.
func gatewayConfigBody(plan, state gatewayModel) map[string]any {
	body := map[string]any{}
	if !plan.RequireVk.IsNull() && !plan.RequireVk.Equal(state.RequireVk) {
		body["requireVk"] = plan.RequireVk.ValueBool()
	}
	if !plan.RequireProvisionedKey.IsNull() && !plan.RequireProvisionedKey.Equal(state.RequireProvisionedKey) {
		body["requireProvisionedKey"] = plan.RequireProvisionedKey.ValueBool()
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

func (r *gatewayResource) find(ctx context.Context, id string) (*apiGateway, error) {
	var out struct {
		Data []apiGateway `json:"data"`
	}
	if err := r.client.Get(ctx, "/api/v1/gateways", &out); err != nil {
		return nil, err
	}
	for i := range out.Data {
		if out.Data[i].GatewayID == id {
			return &out.Data[i], nil
		}
	}
	return nil, nil
}

func (r *gatewayResource) refresh(ctx context.Context, m *gatewayModel,
	set func(context.Context, any) diag.Diagnostics, diags *diag.Diagnostics) {
	gw, err := r.find(ctx, m.ID.ValueString())
	if err != nil || gw == nil {
		diags.AddError("Reading gateway after write failed", errText(err, "gateway "+m.ID.ValueString()+" not listed"))
		return
	}
	gw.applyTo(m)
	diags.Append(set(ctx, m)...)
}

// applyTo copies the server's view. A config flag the configuration leaves
// unset stays null: Terraform does not manage it.
func (g *apiGateway) applyTo(m *gatewayModel) {
	m.ID = types.StringValue(g.GatewayID)
	m.Name = types.StringValue(g.Name)
	m.DeploymentTarget = types.StringValue(g.DeploymentTarget)
	m.KeyPrefix = types.StringValue(g.KeyPrefix)
	m.Status = types.StringValue(g.Status)
	m.CreatedAt = types.StringValue(g.CreatedAt)
	cfg := g.Config
	if cfg == nil {
		cfg = &apiGatewayCfg{}
	}
	if !m.RequireVk.IsNull() {
		m.RequireVk = types.BoolValue(cfg.RequireVk != nil && *cfg.RequireVk)
	}
	if !m.RequireProvisionedKey.IsNull() {
		m.RequireProvisionedKey = types.BoolValue(cfg.RequireProvisionedKey != nil && *cfg.RequireProvisionedKey)
	}
}

func (r *gatewayResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state gatewayModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	gw, err := r.find(ctx, state.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Reading gateways failed", err.Error())
		return
	}
	if gw == nil { // revoked, or never in this org
		resp.State.RemoveResource(ctx)
		return
	}
	gw.applyTo(&state)
	if state.Token.IsUnknown() {
		state.Token = types.StringNull()
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *gatewayResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state gatewayModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if cfg := gatewayConfigBody(plan, state); cfg != nil {
		if err := r.client.Patch(ctx, "/api/v1/gateways/"+esc(state.ID.ValueString())+"/config", cfg, nil); err != nil {
			resp.Diagnostics.AddError("Updating gateway config failed", err.Error())
			return
		}
	}
	r.refresh(ctx, &plan, resp.State.Set, &resp.Diagnostics)
}

func (r *gatewayResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state gatewayModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, "/api/v1/gateways/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Revoking gateway failed", err.Error())
	}
}

func (r *gatewayResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
