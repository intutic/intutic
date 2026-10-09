package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Custom filter routes: routes/wasmRules.ts. The upload is the only way bytes
// reach a rule; PUT changes its name, description and isActive only.
const wasmRulesPath = "/api/v1/wasm-rules"

// wasmRuleMaxBytes is the upload route's limit.
const wasmRuleMaxBytes = 1 << 20

var wasmMagic = []byte("\x00asm")

var hexSHA256 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type wasmRuleResource struct{ client *client.Client }

type wasmRuleModel struct {
	ID           types.String `tfsdk:"id"`
	Name         types.String `tfsdk:"name"`
	Description  types.String `tfsdk:"description"`
	Source       types.String `tfsdk:"source"`
	SHA256       types.String `tfsdk:"sha256"`
	BundleSHA256 types.String `tfsdk:"bundle_sha256"`
	Enabled      types.Bool   `tfsdk:"enabled"`
}

type apiWasmRule struct {
	RuleID       string `json:"ruleId"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	BundleSha256 string `json:"bundleSha256"`
	IsActive     bool   `json:"isActive"`
}

func newWasmRuleResource() resource.Resource { return &wasmRuleResource{} }

var (
	_ resource.ResourceWithImportState = (*wasmRuleResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*wasmRuleResource)(nil)
)

func (r *wasmRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_wasm_rule"
}

func (r *wasmRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A custom filter (`/api/v1/wasm-rules`): a native WebAssembly rule built with the Rules SDK, or " +
			"a Rego policy built with `intutic rules build --rego`, uploaded to the workspace and run by its proxies. " +
			"Custom filters need the Biz Org, Enterprise or Self-host plan (or a trial). The plan reads `source` " +
			"and computes its SHA-256 as `bundle_sha256`; a different file, or a rule whose bytes on the server " +
			"no longer match, replaces the rule, since the API cannot change an uploaded rule's bytes. After the " +
			"upload the provider checks the API stored the same SHA-256 the proxies verify, and fails otherwise. " +
			"Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The rule id (`wasm_…`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:   true,
				Validators: []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"description": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString(""),
			},
			"source": schema.StringAttribute{
				Required: true,
				Description: "Path to the compiled `.wasm` file, at most 1 MB. It is read at plan time. Moving the " +
					"file without changing it changes nothing in the workspace.",
				Validators: []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"sha256": schema.StringAttribute{
				Optional: true,
				Description: "The SHA-256 the file must have, as 64 hex characters: a pin, so the plan fails if " +
					"`source` is not the build you reviewed.",
				Validators: []validator.String{stringvalidator.RegexMatches(hexSHA256, "must be a SHA-256 in hex (64 characters)")},
			},
			"bundle_sha256": schema.StringAttribute{
				Computed: true,
				Description: "The lowercase hex SHA-256 of the uploaded bytes, the value the proxies check the rule " +
					"against. Computed from `source` at plan time; a change replaces the rule.",
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				Description: "Whether the proxies run the rule. Defaults to true. The API enables a rule as it is " +
					"uploaded, so with `false` it runs until the provider switches it off straight after.",
			},
		},
	}
}

func (r *wasmRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

// readWasmBundle reads a rule file and checks what the upload route checks
// before WebAssembly validation: the size limit and the module header. It
// returns the bytes and their lowercase hex SHA-256, the form wasmRules.ts
// stores as bundleSha256.
func readWasmBundle(file string) ([]byte, string, error) {
	info, err := os.Stat(file)
	if err != nil {
		return nil, "", err
	}
	if info.Size() > wasmRuleMaxBytes {
		return nil, "", fmt.Errorf("%s is %d bytes; the API accepts at most 1 MB (%d bytes)", file, info.Size(), wasmRuleMaxBytes)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, "", err
	}
	if !bytes.HasPrefix(data, wasmMagic) {
		return nil, "", fmt.Errorf("%s is not a WebAssembly module (no \\0asm header)", file)
	}
	sum := sha256.Sum256(data)
	return data, hex.EncodeToString(sum[:]), nil
}

// sameBundle compares two hex SHA-256s as the proxy's binary_matches does:
// case is not significant in hex.
func sameBundle(a, b string) bool { return strings.EqualFold(a, b) }

// verifyUploaded fails when the API stored a different hash from the bytes
// sent: the proxies would then be checking the rule against something other
// than what Terraform uploaded.
func verifyUploaded(local, server string) error {
	if !sameBundle(local, server) {
		return fmt.Errorf("the API stored bundleSha256 %q for a file whose SHA-256 is %s", server, local)
	}
	return nil
}

// ModifyPlan reads `source` and plans `bundle_sha256` from it. A hash that
// differs from state — a rebuilt file, or bytes on the server that are not
// the ones Terraform uploaded — can only be applied by uploading again.
func (r *wasmRuleResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.Plan.Raw.IsNull() {
		return
	}
	var plan wasmRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	var state *wasmRuleModel
	if !req.State.Raw.IsNull() {
		state = &wasmRuleModel{}
		resp.Diagnostics.Append(req.State.Get(ctx, state)...)
	}
	if resp.Diagnostics.HasError() {
		return
	}
	if plan.Source.IsUnknown() {
		// Known only at apply: the hash cannot be compared, so upload again.
		plan.BundleSHA256 = types.StringUnknown()
		if state != nil {
			resp.RequiresReplace = append(resp.RequiresReplace, path.Root("bundle_sha256"))
		}
		resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
		return
	}
	_, sum, err := readWasmBundle(plan.Source.ValueString())
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("source"), "Cannot use the rule file", err.Error())
		return
	}
	if !plan.SHA256.IsNull() && !plan.SHA256.IsUnknown() && !sameBundle(plan.SHA256.ValueString(), sum) {
		resp.Diagnostics.AddAttributeError(path.Root("sha256"), "Rule file does not match its pin",
			fmt.Sprintf("%s has SHA-256 %s; sha256 pins %s. Rebuild from the reviewed source, or update the pin.",
				plan.Source.ValueString(), sum, strings.ToLower(plan.SHA256.ValueString())))
		return
	}
	plan.BundleSHA256 = types.StringValue(sum)
	if state != nil && !state.BundleSHA256.IsNull() && !sameBundle(state.BundleSHA256.ValueString(), sum) {
		resp.RequiresReplace = append(resp.RequiresReplace, path.Root("bundle_sha256"))
	}
	resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
}

func (a *apiWasmRule) applyTo(m *wasmRuleModel) {
	m.ID = types.StringValue(a.RuleID)
	m.Name = types.StringValue(a.Name)
	m.Description = types.StringValue(a.Description)
	m.Enabled = types.BoolValue(a.IsActive)
	m.BundleSHA256 = types.StringValue(strings.ToLower(a.BundleSha256))
}

func (r *wasmRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan wasmRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	data, sum, err := readWasmBundle(plan.Source.ValueString())
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("source"), "Cannot use the rule file", err.Error())
		return
	}
	if !plan.BundleSHA256.IsUnknown() && !sameBundle(plan.BundleSHA256.ValueString(), sum) {
		resp.Diagnostics.AddAttributeError(path.Root("source"), "Rule file changed since the plan",
			fmt.Sprintf("The plan was made for SHA-256 %s; %s now has %s. Plan again.",
				plan.BundleSHA256.ValueString(), plan.Source.ValueString(), sum))
		return
	}
	if !plan.SHA256.IsNull() && !sameBundle(plan.SHA256.ValueString(), sum) {
		resp.Diagnostics.AddAttributeError(path.Root("sha256"), "Rule file does not match its pin",
			fmt.Sprintf("%s has SHA-256 %s; sha256 pins %s.", plan.Source.ValueString(), sum, plan.SHA256.ValueString()))
		return
	}

	var out apiWasmRule
	fields := map[string]string{"name": plan.Name.ValueString(), "description": plan.Description.ValueString()}
	if err := r.client.PostMultipart(ctx, wasmRulesPath, fields, "file", filepath.Base(plan.Source.ValueString()), data, &out); err != nil {
		resp.Diagnostics.AddError("Uploading custom filter failed", err.Error())
		return
	}
	if err := verifyUploaded(sum, out.BundleSha256); err != nil {
		// The API enables a rule as it is uploaded: take it down rather than
		// leave unverified bytes running. If that fails too, record it so it
		// is tainted and destroyed by the next apply.
		if delErr := r.client.Delete(ctx, wasmRulesPath+"/"+esc(out.RuleID), nil); delErr != nil && !client.IsNotFound(delErr) {
			plan.ID = types.StringValue(out.RuleID)
			plan.BundleSHA256 = types.StringValue(strings.ToLower(out.BundleSha256))
			resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
			resp.Diagnostics.AddError("Deleting the unverified custom filter failed", delErr.Error())
		}
		resp.Diagnostics.AddError("Uploaded custom filter does not match the file", err.Error())
		return
	}
	wantEnabled := plan.Enabled.ValueBool()
	out.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	if !wantEnabled {
		if err := r.client.Put(ctx, wasmRulesPath+"/"+esc(out.RuleID), map[string]any{"isActive": false}, nil); err != nil {
			resp.Diagnostics.AddError("Disabling the new custom filter failed", err.Error())
			return
		}
		plan.Enabled = types.BoolValue(false)
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
}

func (r *wasmRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state wasmRuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out apiWasmRule
	if err := r.client.Get(ctx, wasmRulesPath+"/"+esc(state.ID.ValueString()), &out); err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Reading custom filter failed", err.Error())
		return
	}
	out.applyTo(&state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// updateBody is the PUT body for what differs from state; nil when only
// `source` or `sha256` changed, which live in Terraform alone. Switching a
// rule off on its own is the one change the API allows on a plan without
// custom filters.
func (m *wasmRuleModel) updateBody(state *wasmRuleModel) map[string]any {
	body := map[string]any{}
	if !m.Name.Equal(state.Name) {
		body["name"] = m.Name.ValueString()
	}
	if !m.Description.Equal(state.Description) {
		body["description"] = m.Description.ValueString()
	}
	if !m.Enabled.Equal(state.Enabled) {
		body["isActive"] = m.Enabled.ValueBool()
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

func (r *wasmRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state wasmRuleModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := esc(state.ID.ValueString())
	if body := plan.updateBody(&state); body != nil {
		if err := r.client.Put(ctx, wasmRulesPath+"/"+id, body, nil); err != nil {
			resp.Diagnostics.AddError("Updating custom filter failed", err.Error())
			return
		}
	}
	var out apiWasmRule
	if err := r.client.Get(ctx, wasmRulesPath+"/"+id, &out); err != nil {
		resp.Diagnostics.AddError("Reading custom filter after update failed", err.Error())
		return
	}
	out.applyTo(&plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *wasmRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state wasmRuleModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, wasmRulesPath+"/"+esc(state.ID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Deleting custom filter failed", err.Error())
	}
}

func (r *wasmRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
