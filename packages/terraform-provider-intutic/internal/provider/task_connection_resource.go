package provider

import (
	"context"
	"regexp"
	"strings"

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

// Task-management connection routes: routes/taskManagement.ts
// (CreateConnectionSchema). There is no update route and no single-connection
// GET: a connection is created, listed, tested or deleted. The API token is
// tested with the provider before the connection is saved, stored encrypted,
// and never returned; the Jira account email is stored but not returned
// either.
const taskConnectionPath = "/api/v1/task-management/connections"

var taskProviders = []string{"jira", "linear", "pagerduty"}

// taskAccountEmail is a plausible address; the API applies zod's email check
// to the trimmed value.
var taskAccountEmail = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type taskConnectionResource struct{ client *client.Client }

type taskConnectionModel struct {
	ID           types.String `tfsdk:"id"`
	Provider     types.String `tfsdk:"task_provider"`
	BaseURL      types.String `tfsdk:"base_url"`
	ProjectKey   types.String `tfsdk:"project_key"`
	AccountEmail types.String `tfsdk:"account_email"`
	APIToken     types.String `tfsdk:"api_token"`
	Status       types.String `tfsdk:"status"`
	CreatedAt    types.String `tfsdk:"created_at"`
}

type apiTaskConnection struct {
	ConnectionID string `json:"connectionId"`
	Provider     string `json:"provider"`
	BaseURL      string `json:"baseUrl"`
	ProjectKey   string `json:"projectKey"`
	Status       string `json:"status"`
	CreatedAt    string `json:"createdAt"`
}

func newTaskConnectionResource() resource.Resource { return &taskConnectionResource{} }

var (
	_ resource.ResourceWithImportState    = (*taskConnectionResource)(nil)
	_ resource.ResourceWithValidateConfig = (*taskConnectionResource)(nil)
)

func (r *taskConnectionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_task_connection"
}

func (r *taskConnectionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		Description: "A task-management connection (`/api/v1/task-management/connections`): Jira Cloud, Linear or " +
			"PagerDuty, which Intutic reads tickets and incidents through to attach task context to sessions. It " +
			"never creates or updates them. The control plane tests the credentials with the provider and saves " +
			"the connection only if they are accepted, so an apply with a token the provider refuses fails. The API " +
			"never returns `api_token` or `account_email`, so they are kept in Terraform state as configured; " +
			"protect the state accordingly. The API has no update: changing any argument replaces the connection " +
			"(a new id). An imported connection has no `api_token` or `account_email` in state, so the first apply " +
			"after an import replaces it with the configured values. Destroying it removes the connection and its " +
			"token. Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The connection id (`cc_…`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"task_provider": schema.StringAttribute{
				Required: true,
				Description: "The task manager: one of `jira`, `linear`, `pagerduty` (the API's `provider`; `provider` " +
					"is a Terraform meta-argument). Changing it replaces the connection.",
				Validators:    []validator.String{stringvalidator.OneOf(taskProviders...)},
				PlanModifiers: replace,
			},
			"base_url": schema.StringAttribute{
				Required: true,
				Description: "The provider's base URL, for example `https://acme.atlassian.net` for Jira Cloud. " +
					"Changing it replaces the connection.",
				Validators:    []validator.String{stringvalidator.LengthAtLeast(1)},
				PlanModifiers: replace,
			},
			"project_key": schema.StringAttribute{
				Required: true,
				Description: "The Jira project key, Linear team key or PagerDuty service key a ticket or incident " +
					"is matched on. Changing it replaces the connection.",
				Validators:    []validator.String{stringvalidator.LengthAtLeast(1)},
				PlanModifiers: replace,
			},
			"account_email": schema.StringAttribute{
				Optional: true,
				Description: "Jira only, and required for Jira: the Atlassian account the API token belongs to " +
					"(Jira Cloud signs a token in as that account). Not returned by the API. Changing it replaces " +
					"the connection.",
				PlanModifiers: replace,
			},
			"api_token": schema.StringAttribute{
				Required:  true,
				Sensitive: true,
				Description: "The provider API token: a Jira API token, a Linear API key or a PagerDuty REST API " +
					"token. The API never returns it; it is kept in state as configured. Changing it replaces the " +
					"connection.",
				Validators:    []validator.String{stringvalidator.LengthAtLeast(1)},
				PlanModifiers: replace,
			},
			"status": schema.StringAttribute{
				Computed: true,
				Description: "Always `connected`: the API saves a connection only once the provider accepts its " +
					"credentials. A token revoked later still reads `connected`; `intutic tasks test` checks it.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				Description:   "When the connection was created (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *taskConnectionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

// ValidateConfig repeats CreateConnectionSchema's Jira check: a Jira
// connection needs the token's account email, and no other provider takes one.
func (r *taskConnectionResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg taskConnectionModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.Provider.IsUnknown() || cfg.Provider.IsNull() || cfg.AccountEmail.IsUnknown() {
		return
	}
	provider := cfg.Provider.ValueString()
	if provider != "jira" {
		if !cfg.AccountEmail.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("account_email"), "Jira only",
				"account_email is the Atlassian account a Jira API token belongs to; a "+provider+" connection takes none. Remove it.")
		}
		return
	}
	email := strings.TrimSpace(cfg.AccountEmail.ValueString())
	if cfg.AccountEmail.IsNull() || email == "" {
		resp.Diagnostics.AddAttributeError(path.Root("account_email"), "Missing Jira account email",
			"A Jira connection needs account_email: the Atlassian account the API token belongs to, since Jira Cloud "+
				"signs a token in as that account.")
		return
	}
	if !taskAccountEmail.MatchString(email) {
		resp.Diagnostics.AddAttributeError(path.Root("account_email"), "Invalid Jira account email",
			"account_email must be an email address, got "+email+".")
	}
}

// applyTo copies the server's view onto m. api_token and account_email are
// the configuration's (or the state's): the API returns neither.
func (a *apiTaskConnection) applyTo(m *taskConnectionModel) {
	m.ID = types.StringValue(a.ConnectionID)
	m.Provider = types.StringValue(a.Provider)
	m.BaseURL = types.StringValue(a.BaseURL)
	m.ProjectKey = types.StringValue(a.ProjectKey)
	m.Status = types.StringValue(a.Status)
	m.CreatedAt = types.StringValue(a.CreatedAt)
}

func (r *taskConnectionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan taskConnectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"provider":   plan.Provider.ValueString(),
		"baseUrl":    plan.BaseURL.ValueString(),
		"authToken":  plan.APIToken.ValueString(),
		"projectKey": plan.ProjectKey.ValueString(),
	}
	if !plan.AccountEmail.IsNull() {
		body["metadata"] = map[string]any{"accountEmail": plan.AccountEmail.ValueString()}
	}
	var out apiTaskConnection
	if err := r.client.Post(ctx, taskConnectionPath, body, &out); err != nil {
		resp.Diagnostics.AddError("Creating task connection failed", err.Error())
		return
	}
	out.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Read finds the connection in the list, the only read the API has; one that
// is gone is removed from state.
func (r *taskConnectionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state taskConnectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out struct {
		Items []apiTaskConnection `json:"items"`
	}
	if err := r.client.Get(ctx, taskConnectionPath, &out); err != nil {
		resp.Diagnostics.AddError("Reading task connections failed", err.Error())
		return
	}
	for i := range out.Items {
		if c := &out.Items[i]; c.ConnectionID == state.ID.ValueString() {
			c.applyTo(&state)
			resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
			return
		}
	}
	resp.State.RemoveResource(ctx)
}

// Update is never called with a change the API would have to make: every
// configurable attribute requires replacement. It only records the plan.
func (r *taskConnectionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan taskConnectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete answers `deleted: false` for a connection that is already gone, which
// is what destroy wants too.
func (r *taskConnectionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state taskConnectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, taskConnectionPath+"/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Deleting task connection failed", err.Error())
	}
}

// ImportState takes the connection id. As with intutic_provider_credential's
// `fields`, the stored secret cannot be read, so api_token (and account_email)
// stay null; with no update route, the first apply after an import replaces
// the connection with the configured ones.
func (r *taskConnectionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
