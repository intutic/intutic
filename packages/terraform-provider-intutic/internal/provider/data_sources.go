package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// ─── intutic_workspace ──────────────────────────────────────────────

type workspaceDataSource struct{ client *client.Client }

type workspaceDataModel struct {
	ID       types.String `tfsdk:"id"`
	OrgID    types.String `tfsdk:"org_id"`
	PlanTier types.String `tfsdk:"plan_tier"`
	PlanName types.String `tfsdk:"plan_name"`
	MemberID types.String `tfsdk:"member_id"`
	Email    types.String `tfsdk:"email"`
	Role     types.String `tfsdk:"role"`
}

func newWorkspaceDataSource() datasource.DataSource { return &workspaceDataSource{} }

func (d *workspaceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (d *workspaceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	computed := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, Description: desc}
	}
	resp.Schema = schema.Schema{
		Description: "The workspace the provider's API key belongs to, its plan, and the member the key acts as " +
			"(`GET /api/v1/auth/me` and `GET /api/v1/trial/status`).",
		Attributes: map[string]schema.Attribute{
			"id":        computed("The workspace id."),
			"org_id":    computed("The workspace's organization id."),
			"plan_tier": computed("The plan tier, for example `biz_org` or `ent_lic`."),
			"plan_name": computed("The plan's display name."),
			"member_id": computed("The member the API key acts as."),
			"email":     computed("That member's email address."),
			"role":      computed("That member's role: `OWNER`, `ADMIN`, `EM`, `DEVELOPER` or `VIEWER`."),
		},
	}
}

func (d *workspaceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (d *workspaceDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	var me struct {
		MemberID    string `json:"memberId"`
		WorkspaceID string `json:"workspaceId"`
		Email       string `json:"email"`
		Role        string `json:"role"`
		OrgID       string `json:"orgId"`
	}
	if err := d.client.Get(ctx, "/api/v1/auth/me", &me); err != nil {
		resp.Diagnostics.AddError("Reading the API key's member failed", err.Error())
		return
	}
	var plan struct {
		Tier     string `json:"tier"`
		PlanName string `json:"planName"`
	}
	if err := d.client.Get(ctx, "/api/v1/trial/status", &plan); err != nil {
		resp.Diagnostics.AddError("Reading the workspace plan failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &workspaceDataModel{
		ID:       types.StringValue(me.WorkspaceID),
		OrgID:    types.StringValue(me.OrgID),
		PlanTier: types.StringValue(plan.Tier),
		PlanName: types.StringValue(plan.PlanName),
		MemberID: types.StringValue(me.MemberID),
		Email:    types.StringValue(me.Email),
		Role:     types.StringValue(me.Role),
	})...)
}

// ─── intutic_members ────────────────────────────────────────────────

type membersDataSource struct{ client *client.Client }

type memberModel struct {
	MemberID    types.String `tfsdk:"member_id"`
	Email       types.String `tfsdk:"email"`
	DisplayName types.String `tfsdk:"display_name"`
	Role        types.String `tfsdk:"role"`
	IsActive    types.Bool   `tfsdk:"is_active"`
	LastLoginAt types.String `tfsdk:"last_login_at"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

type membersDataModel struct {
	ID      types.String  `tfsdk:"id"`
	Members []memberModel `tfsdk:"members"`
}

func newMembersDataSource() datasource.DataSource { return &membersDataSource{} }

func (d *membersDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_members"
}

func (d *membersDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Every member of the workspace, deactivated ones included (`GET /api/v1/members`). " +
			"Filter with a `for` expression, for example on `is_active` or `role`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, Description: "The workspace id."},
			"members": schema.ListNestedAttribute{
				Computed: true,
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"member_id":     schema.StringAttribute{Computed: true},
						"email":         schema.StringAttribute{Computed: true},
						"display_name":  schema.StringAttribute{Computed: true},
						"role":          schema.StringAttribute{Computed: true},
						"is_active":     schema.BoolAttribute{Computed: true},
						"last_login_at": schema.StringAttribute{Computed: true, Description: "RFC 3339, or null."},
						"created_at":    schema.StringAttribute{Computed: true},
					},
				},
			},
		},
	}
}

func (d *membersDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

func (d *membersDataSource) Read(ctx context.Context, _ datasource.ReadRequest, resp *datasource.ReadResponse) {
	var out struct {
		Data []struct {
			MemberID    string  `json:"memberId"`
			WorkspaceID string  `json:"workspaceId"`
			Email       string  `json:"email"`
			DisplayName string  `json:"displayName"`
			Role        string  `json:"role"`
			IsActive    bool    `json:"isActive"`
			LastLoginAt *string `json:"lastLoginAt"`
			CreatedAt   string  `json:"createdAt"`
		} `json:"data"`
	}
	if err := d.client.Get(ctx, "/api/v1/members", &out); err != nil {
		resp.Diagnostics.AddError("Reading members failed", err.Error())
		return
	}
	model := membersDataModel{Members: []memberModel{}}
	for _, m := range out.Data {
		model.ID = types.StringValue(m.WorkspaceID)
		model.Members = append(model.Members, memberModel{
			MemberID:    types.StringValue(m.MemberID),
			Email:       types.StringValue(m.Email),
			DisplayName: types.StringValue(m.DisplayName),
			Role:        types.StringValue(m.Role),
			IsActive:    types.BoolValue(m.IsActive),
			LastLoginAt: stringOrNull(m.LastLoginAt),
			CreatedAt:   types.StringValue(m.CreatedAt),
		})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &model)...)
}
