package provider

import (
	"context"
	"fmt"
	"slices"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
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

// MCP server registry routes: routes/mcpServers.ts (StatusSchema, ToolSchema).
var mcpStatuses = []string{"approved", "blocked", "candidate"}

const mcpServersPath = "/api/v1/mcp/servers"

type mcpServerDecisionResource struct{ client *client.Client }

type mcpServerDecisionModel struct {
	ID            types.String `tfsdk:"id"`
	ServerName    types.String `tfsdk:"server_name"`
	Status        types.String `tfsdk:"status"`
	DisabledTools types.Set    `tfsdk:"disabled_tools"`
	Tools         types.List   `tfsdk:"tools"`
	HeldForReview types.Bool   `tfsdk:"held_for_review"`
}

type apiMcpServer struct {
	ServerID       string            `json:"serverId"`
	ServerName     string            `json:"serverName"`
	Status         string            `json:"status"`
	Tools          []string          `json:"tools"`
	DisabledTools  []string          `json:"disabledTools"`
	HeldForReview  bool              `json:"heldForReview"`
	LastToolChange *apiMcpToolChange `json:"lastToolChange"`
}

type apiMcpToolChange struct {
	RiskLevel string   `json:"riskLevel"`
	Added     []string `json:"added"`
	Removed   []string `json:"removed"`
	Changed   []string `json:"changed"`
}

func newMcpServerDecisionResource() resource.Resource { return &mcpServerDecisionResource{} }

var _ resource.ResourceWithImportState = (*mcpServerDecisionResource)(nil)

func (r *mcpServerDecisionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_mcp_server_decision"
}

func (r *mcpServerDecisionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The operator decision on one MCP server in the workspace's registry: approve or block it, and " +
			"switch individual tools off. The server must already be in the registry, which happens when an MCP " +
			"proxy first reports it; to allow a server before any proxy has seen it, list it in the " +
			"`mcpAllowedServers` workspace setting instead. Terraform never approves a server that a high-risk " +
			"tool-set change returned to review: approve that one after reviewing the change, and the next plan " +
			"is clean. Destroying the resource returns the server to the approval queue and re-enables the tools " +
			"it disabled. Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The registry's server id (`mcpsrv_…`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"server_name": schema.StringAttribute{
				Required:      true,
				Description:   "The server's name as the MCP proxy reports it.",
				Validators:    []validator.String{stringvalidator.LengthBetween(1, 256)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"status": schema.StringAttribute{
				Required:    true,
				Description: "One of `approved`, `blocked`, `candidate` (back in the approval queue).",
				Validators:  []validator.String{stringvalidator.OneOf(mcpStatuses...)},
			},
			"disabled_tools": schema.SetAttribute{
				ElementType: types.StringType,
				Optional:    true,
				Description: "Exactly the tools to switch off on this server; every other tool is switched on. " +
					"Unset leaves the tool switches alone.",
				Validators: []validator.Set{setvalidator.ValueStringsAre(stringvalidator.LengthBetween(1, 256))},
			},
			"tools": schema.ListAttribute{
				ElementType: types.StringType,
				Computed:    true,
				Description: "The tools a proxy last saw the server declare.",
			},
			"held_for_review": schema.BoolAttribute{
				Computed:    true,
				Description: "Whether a high-risk tool-set change returned the server to review.",
			},
		},
	}
}

func (r *mcpServerDecisionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (r *mcpServerDecisionResource) list(ctx context.Context) ([]apiMcpServer, error) {
	var out struct {
		Servers []apiMcpServer `json:"servers"`
	}
	if err := r.client.Get(ctx, mcpServersPath, &out); err != nil {
		return nil, err
	}
	return out.Servers, nil
}

func (r *mcpServerDecisionResource) byName(ctx context.Context, name string) (*apiMcpServer, error) {
	servers, err := r.list(ctx)
	if err != nil {
		return nil, err
	}
	for i := range servers {
		if servers[i].ServerName == name {
			return &servers[i], nil
		}
	}
	return nil, nil
}

func (r *mcpServerDecisionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan mcpServerDecisionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	srv, err := r.byName(ctx, plan.ServerName.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Reading the MCP server registry failed", err.Error())
		return
	}
	if srv == nil {
		resp.Diagnostics.AddAttributeError(path.Root("server_name"), "MCP server not in the registry",
			fmt.Sprintf("No MCP proxy in this workspace has reported %q yet, so there is nothing to decide on. "+
				"To allow it before it is seen, add it to the mcpAllowedServers workspace setting.",
				plan.ServerName.ValueString()))
		return
	}
	r.apply(ctx, srv, plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	r.refresh(ctx, srv.ServerName, &plan, resp.State.Set, &resp.Diagnostics)
}

// apply moves srv to the plan's status and tool switches.
func (r *mcpServerDecisionResource) apply(ctx context.Context, srv *apiMcpServer, plan mcpServerDecisionModel,
	diags *diag.Diagnostics) {
	status := plan.Status.ValueString()
	if status == "approved" && srv.HeldForReview {
		diags.AddAttributeError(path.Root("status"), "Server held for review", heldMessage(srv))
		return
	}
	if status != srv.Status || (srv.HeldForReview && status != "approved") {
		err := r.client.Post(ctx, mcpServersPath+"/"+esc(srv.ServerID)+"/status", map[string]string{"status": status}, nil)
		if err != nil {
			diags.AddError("Setting MCP server status failed", err.Error())
			return
		}
	}
	if plan.DisabledTools.IsNull() || plan.DisabledTools.IsUnknown() {
		return
	}
	want := listStrings(ctx, plan.DisabledTools, diags)
	for _, sw := range toolSwitches(srv.DisabledTools, want) {
		err := r.client.Post(ctx, mcpServersPath+"/"+esc(srv.ServerID)+"/tools",
			map[string]any{"tool": sw.tool, "enabled": sw.enabled}, nil)
		if err != nil {
			diags.AddError("Switching MCP tool failed", fmt.Sprintf("%s: %v", sw.tool, err))
			return
		}
	}
}

type toolSwitch struct {
	tool    string
	enabled bool
}

// toolSwitches is the calls that turn the server's disabled set into want:
// disable what is missing, enable what is extra. Sorted, for a stable order.
func toolSwitches(current, want []string) []toolSwitch {
	var out []toolSwitch
	for _, t := range want {
		if !slices.Contains(current, t) {
			out = append(out, toolSwitch{t, false})
		}
	}
	for _, t := range current {
		if !slices.Contains(want, t) {
			out = append(out, toolSwitch{t, true})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].tool < out[j].tool })
	return out
}

func heldMessage(srv *apiMcpServer) string {
	msg := fmt.Sprintf("A high-risk change to %q's tool set returned it to review. Terraform does not "+
		"approve it over that hold: review the change in the dashboard's MCP registry and approve it there "+
		"(the next plan is then clean), or set status to \"blocked\".", srv.ServerName)
	if c := srv.LastToolChange; c != nil {
		msg += fmt.Sprintf("\n\nLatest change (risk %s): added %v, removed %v, changed %v.", c.RiskLevel, c.Added, c.Removed, c.Changed)
	}
	return msg
}

func (r *mcpServerDecisionResource) refresh(ctx context.Context, name string, m *mcpServerDecisionModel,
	set func(context.Context, any) diag.Diagnostics, diags *diag.Diagnostics) {
	srv, err := r.byName(ctx, name)
	if err != nil || srv == nil {
		diags.AddError("Reading MCP server after write failed", errText(err, name+" not in the registry"))
		return
	}
	srv.applyTo(m)
	diags.Append(set(ctx, m)...)
}

func (s *apiMcpServer) applyTo(m *mcpServerDecisionModel) {
	m.ID = types.StringValue(s.ServerID)
	m.ServerName = types.StringValue(s.ServerName)
	m.Status = types.StringValue(s.Status)
	if s.Tools == nil {
		s.Tools = []string{}
	}
	m.Tools = stringList(s.Tools)
	m.HeldForReview = types.BoolValue(s.HeldForReview)
	if !m.DisabledTools.IsNull() {
		disabled := s.DisabledTools
		if disabled == nil {
			disabled = []string{}
		}
		m.DisabledTools = stringSet(disabled)
	}
}

func (r *mcpServerDecisionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state mcpServerDecisionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	srv, err := r.byName(ctx, state.ServerName.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Reading the MCP server registry failed", err.Error())
		return
	}
	if srv == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	srv.applyTo(&state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *mcpServerDecisionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state mcpServerDecisionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	srv, err := r.byName(ctx, state.ServerName.ValueString())
	if err != nil || srv == nil {
		resp.Diagnostics.AddError("Reading the MCP server registry failed", errText(err, state.ServerName.ValueString()+" is gone"))
		return
	}
	r.apply(ctx, srv, plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	r.refresh(ctx, srv.ServerName, &plan, resp.State.Set, &resp.Diagnostics)
}

// Delete returns the server to the approval queue and re-enables the tools
// this resource disabled: the decision is withdrawn, not reversed.
func (r *mcpServerDecisionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state mcpServerDecisionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	srv, err := r.byName(ctx, state.ServerName.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Reading the MCP server registry failed", err.Error())
		return
	}
	if srv == nil {
		return
	}
	for _, t := range listStrings(ctx, state.DisabledTools, &resp.Diagnostics) {
		if !slices.Contains(srv.DisabledTools, t) {
			continue
		}
		err := r.client.Post(ctx, mcpServersPath+"/"+esc(srv.ServerID)+"/tools", map[string]any{"tool": t, "enabled": true}, nil)
		if err != nil {
			resp.Diagnostics.AddError("Re-enabling MCP tool failed", fmt.Sprintf("%s: %v", t, err))
			return
		}
	}
	if srv.Status != "candidate" {
		err := r.client.Post(ctx, mcpServersPath+"/"+esc(srv.ServerID)+"/status", map[string]string{"status": "candidate"}, nil)
		if err != nil {
			resp.Diagnostics.AddError("Returning MCP server to the queue failed", err.Error())
		}
	}
}

// ImportState takes the server name, the identity a configuration uses, and
// imports the server's current tool switches as managed.
func (r *mcpServerDecisionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("server_name"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("disabled_tools"), stringSet([]string{}))...)
}
