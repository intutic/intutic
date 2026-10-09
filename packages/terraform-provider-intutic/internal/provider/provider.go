// Package provider implements the Intutic Terraform provider on the Plugin
// Framework. Every resource maps to an existing control-plane route; the
// schemas mirror that route's request validation so a value the API would
// refuse fails at plan time where the framework can check it.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// DefaultEndpoint is Intutic Cloud's control plane, the same default the CLI uses.
const DefaultEndpoint = "https://api.intutic.ai"

type intuticProvider struct {
	version string
}

type providerModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	APIKey   types.String `tfsdk:"api_key"`
}

// New returns the provider factory providerserver.Serve expects.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &intuticProvider{version: version}
	}
}

func (p *intuticProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "intutic"
	resp.Version = p.version
}

func (p *intuticProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage an Intutic workspace's SOPs, enforcement policies, policy guardrails, settings, " +
			"virtual keys, self-hosted gateways, notification rules, SIEM export destinations, custom filters " +
			"and MCP server decisions as code.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional: true,
				Description: "Control-plane base URL. Defaults to `INTUTIC_CONTROL_PLANE_URL`, then " +
					DefaultEndpoint + ". A self-hosted deployment uses its own control-plane address.",
			},
			"api_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				Description: "A workspace API key (`vk_…`), created with **This key is for automation** ticked. " +
					"Defaults to `INTUTIC_API_KEY`. The provider acts as the key's member, so the member's role " +
					"must allow every change in the configuration (OWNER or ADMIN for most resources).",
			},
		},
	}
}

func (p *intuticProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	endpoint := firstSet(cfg.Endpoint, os.Getenv("INTUTIC_CONTROL_PLANE_URL"), DefaultEndpoint)
	apiKey := firstSet(cfg.APIKey, os.Getenv("INTUTIC_API_KEY"), "")
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"), "Missing API key",
			"Set api_key in the provider block or INTUTIC_API_KEY in the environment. "+
				"Create the key under Settings › Security › Virtual API Keys and tick "+
				"\"This key is for automation\".")
		return
	}

	c := client.New(endpoint, apiKey, "terraform-provider-intutic/"+p.version)
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *intuticProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		newSopResource,
		newPolicyResource,
		newGuardrailResource,
		newWorkspaceSettingsResource,
		newVirtualKeyResource,
		newGatewayResource,
		newNotificationRuleResource,
		newMcpServerDecisionResource,
		newSiemDestinationResource,
		newWasmRuleResource,
	}
}

func (p *intuticProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		newWorkspaceDataSource,
		newMembersDataSource,
	}
}

func firstSet(v types.String, fallbacks ...string) string {
	if !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		return v.ValueString()
	}
	for _, f := range fallbacks {
		if f != "" {
			return f
		}
	}
	return ""
}
