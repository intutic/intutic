package provider

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// Provider-credential routes: routes/providerCredentials.ts (validateFields,
// pickPreviewField) over PROVIDER_REGISTRY and checkCloudCredentialFields in
// packages/shared-types/src/providers.ts. The API never returns a stored
// value, only whether one is provisioned and the last four characters of its
// first secret field.
const providerCredentialPath = "/api/v1/workspace/provider-credentials"

// The registry's credential shapes: each provider's fields, in registry
// order (which decides the preview field), and its alternative credential sets.
//
//go:embed provider_credential_registry.json
var credentialRegistryJSON []byte

type credentialField struct {
	Key      string `json:"key"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type credentialProvider struct {
	ID            string            `json:"id"`
	Fields        []credentialField `json:"fields"`
	RequiresOneOf [][]string        `json:"requiresOneOf"`
}

var credentialProviders = func() []credentialProvider {
	var r struct {
		Providers []credentialProvider `json:"providers"`
	}
	if err := json.Unmarshal(credentialRegistryJSON, &r); err != nil {
		panic(err)
	}
	return r.Providers
}()

func credentialProviderByID(id string) *credentialProvider {
	for i := range credentialProviders {
		if credentialProviders[i].ID == id {
			return &credentialProviders[i]
		}
	}
	return nil
}

func credentialProviderIDs() []string {
	ids := make([]string, len(credentialProviders))
	for i, p := range credentialProviders {
		ids[i] = p.ID
	}
	return ids
}

func (p *credentialProvider) fieldKeys() []string {
	keys := make([]string, len(p.Fields))
	for i, f := range p.Fields {
		keys[i] = f.Key
	}
	return keys
}

// jsTrim is String.prototype.trim, which the route applies to every value.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == '\uFEFF' || (unicode.IsSpace(r) && r != '\u0085')
	})
}

// jsLen measures a string as JavaScript does, in UTF-16 code units.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// credentialPreview is pickPreviewField: the field whose last four characters
// the API reports (the first secret field with a value, in registry order)
// and those characters. The key is empty when no field qualifies.
func (p *credentialProvider) credentialPreview(values map[string]string) (key, lastFour string) {
	for _, f := range p.Fields {
		v := jsTrim(values[f.Key])
		if f.Type != "password" || v == "" {
			continue
		}
		u := utf16.Encode([]rune(v))
		return f.Key, string(utf16.Decode(u[max(len(u)-4, 0):]))
	}
	return "", ""
}

// credentialFieldErrors repeats validateFields and checkCloudCredentialFields
// for the configured fields. An unknown value passes every check that needs it.
func (p *credentialProvider) credentialFieldErrors(fields map[string]types.String) []string {
	var errs []string
	for _, k := range sortedKeys(fields) {
		if !slices.ContainsFunc(p.Fields, func(f credentialField) bool { return f.Key == k }) {
			errs = append(errs, fmt.Sprintf("%s takes no field %s; its fields are %s.", p.ID, k, strings.Join(p.fieldKeys(), ", ")))
		}
	}
	values := map[string]string{}
	present := map[string]bool{}
	allKnown := true
	for _, f := range p.Fields {
		v, ok := fields[f.Key]
		if ok && v.IsUnknown() {
			present[f.Key], allKnown = true, false
			continue
		}
		trimmed := jsTrim(v.ValueString())
		if !ok || v.IsNull() || trimmed == "" {
			if f.Required {
				errs = append(errs, fmt.Sprintf("%s needs %s in fields.", p.ID, f.Key))
			}
			continue
		}
		minLen, maxLen := 2, 512
		if f.Type == "password" {
			minLen = 8
		}
		if f.Type == "textarea" {
			maxLen = 8192
		}
		if n := jsLen(trimmed); n < minLen || n > maxLen {
			errs = append(errs, fmt.Sprintf("%s must be between %d and %d characters, got %d.", f.Key, minLen, maxLen, n))
		}
		values[f.Key], present[f.Key] = trimmed, true
	}
	if len(p.RequiresOneOf) > 0 && !slices.ContainsFunc(p.RequiresOneOf, func(set []string) bool {
		return !slices.ContainsFunc(set, func(k string) bool { return !present[k] })
	}) {
		options := make([]string, len(p.RequiresOneOf))
		for i, set := range p.RequiresOneOf {
			options[i] = strings.Join(set, " and ")
		}
		errs = append(errs, fmt.Sprintf("%s needs %s in fields.", p.ID, strings.Join(options, ", or ")))
	}
	if allKnown && len(errs) == 0 {
		if msg := checkCloudCredentialFields(p.ID, values); msg != "" {
			errs = append(errs, msg+".")
		}
	}
	return errs
}

var (
	cloudName       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	gcpProjectID    = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	azureLabel      = regexp.MustCompile(`^[a-z0-9-]+$`)
	azureHostSuffix = []string{".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"}
)

// checkCloudCredentialFields is the shared-types function of that name: the
// checks the proxy applies when it reads a stored cloud credential.
func checkCloudCredentialFields(providerID string, values map[string]string) string {
	switch providerID {
	case "bedrock":
		if !cloudName.MatchString(values["awsRegion"]) {
			return "AWS Region must be a region name such as us-east-1"
		}
	case "vertex_ai":
		if !gcpProjectID.MatchString(values["projectId"]) {
			return "GCP Project ID must be a project id or number"
		}
		if loc, ok := values["location"]; ok && !cloudName.MatchString(loc) {
			return "Location must be a location name such as us-east5 or global"
		}
		var doc struct {
			Type any `json:"type"`
		}
		if json.Unmarshal([]byte(values["serviceAccountJson"]), &doc) != nil {
			return "Service Account JSON is not valid JSON"
		}
		if doc.Type != "service_account" && doc.Type != "authorized_user" {
			return "Service Account JSON must be a service_account (or authorized_user) credential file"
		}
	case "azure_openai":
		u, err := url.Parse(values["endpoint"])
		if err != nil {
			return "Resource Endpoint must be a URL"
		}
		host := strings.ToLower(u.Hostname())
		label := ""
		for _, sfx := range azureHostSuffix {
			if strings.HasSuffix(host, sfx) {
				label = strings.TrimSuffix(host, sfx)
				break
			}
		}
		// The WHATWG URL parser drops a default port, so :443 is no port.
		if u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") || u.User != nil || !azureLabel.MatchString(label) {
			return "Resource Endpoint must be https://<resource>.openai.azure.com, .services.ai.azure.com or .cognitiveservices.azure.com"
		}
	}
	return ""
}

// credentialMask marks a configured secret the API reports differently: the
// mask the SIEM and notification resources read back, made of the API's last
// four characters.
func credentialMask(lastFour string) string { return "********" + lastFour }

type providerCredentialResource struct{ client *client.Client }

type providerCredentialModel struct {
	ID          types.String `tfsdk:"id"`
	ProviderID  types.String `tfsdk:"provider_id"`
	Fields      types.Map    `tfsdk:"fields"`
	RoutingLive types.Bool   `tfsdk:"routing_live"`
	LastFour    types.String `tfsdk:"last_four"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

type apiProviderCredential struct {
	Provider    string  `json:"provider"`
	RoutingLive bool    `json:"routingLive"`
	Provisioned bool    `json:"provisioned"`
	LastFour    *string `json:"lastFour"`
	UpdatedAt   *string `json:"updatedAt"`
}

func newProviderCredentialResource() resource.Resource { return &providerCredentialResource{} }

var (
	_ resource.ResourceWithImportState    = (*providerCredentialResource)(nil)
	_ resource.ResourceWithValidateConfig = (*providerCredentialResource)(nil)
)

func (r *providerCredentialResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_provider_credential"
}

func (r *providerCredentialResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	ids := credentialProviderIDs()
	resp.Schema = schema.Schema{
		Description: "The workspace's own credential for an upstream LLM provider (bring your own key), stored through " +
			"`PUT /api/v1/workspace/provider-credentials/{provider}`. The gateway calls that provider with it instead " +
			"of the platform's key. The API never returns a stored value, so `fields` is kept in Terraform state as " +
			"a sensitive value; protect the state accordingly. A credential replaced or removed outside Terraform " +
			"shows as a difference when the last four characters the API reports change, and the next apply sends " +
			"`fields` again. Changing `fields` rotates the credential in place; changing `provider_id` replaces the " +
			"resource. Destroying it removes the credential, and the workspace goes back to the platform key (or is " +
			"refused, where the gateway requires a provisioned key). Needs an OWNER or ADMIN key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "The provider id, as `provider_id`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"provider_id": schema.StringAttribute{
				Required:      true,
				Description:   "The upstream provider: one of `" + strings.Join(ids, "`, `") + "`. Changing it replaces the resource.",
				Validators:    []validator.String{stringvalidator.OneOf(ids...)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"fields": schema.MapAttribute{
				ElementType: types.StringType,
				Required:    true,
				Sensitive:   true,
				Description: "The credential's fields, which the API never returns. `anthropic`, `openai`, `gemini`, " +
					"`mistral`, `openrouter`, `deepseek` and `cohere` take `apiKey`; `azure_openai` takes `endpoint` " +
					"(`https://<resource>.openai.azure.com`, `.services.ai.azure.com` or `.cognitiveservices.azure.com`) " +
					"and `apiKey`; `bedrock` takes `awsRegion` and either `awsAccessKeyId` with `awsSecretAccessKey`, or " +
					"`apiKey`; `vertex_ai` takes `projectId`, optionally `location`, and `serviceAccountJson` (the key " +
					"file's contents); `ollama` takes `apiBase`. Secret fields are 8 to 512 characters. An imported " +
					"credential has no `fields` in state, so the first apply after an import sends them.",
			},
			"routing_live": schema.BoolAttribute{
				Computed: true,
				Description: "Whether the gateway routes requests to this provider today. A credential for a provider " +
					"that is not live is stored, but nothing calls it yet.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"last_four": schema.StringAttribute{
				Computed: true,
				Description: "The last four characters of the first secret field set (for `bedrock`, `awsAccessKeyId` " +
					"before `apiKey`), as the dashboard shows them; null for `vertex_ai` and `ollama`.",
			},
			"updated_at": schema.StringAttribute{
				Computed:    true,
				Description: "When the credential was last saved (RFC 3339).",
			},
		},
	}
}

func (r *providerCredentialResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = configuredClient(req.ProviderData, &resp.Diagnostics)
}

// ValidateConfig repeats the route's checks, so a credential the API would
// refuse fails at plan time.
func (r *providerCredentialResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg providerCredentialModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.ProviderID.IsUnknown() || cfg.Fields.IsUnknown() || cfg.Fields.IsNull() {
		return
	}
	def := credentialProviderByID(cfg.ProviderID.ValueString())
	if def == nil {
		return // provider_id's own validator reports it
	}
	var fields map[string]types.String
	resp.Diagnostics.Append(cfg.Fields.ElementsAs(ctx, &fields, false)...)
	for _, msg := range def.credentialFieldErrors(fields) {
		resp.Diagnostics.AddAttributeError(path.Root("fields"), "Invalid provider credential", msg)
	}
}

// applyTo copies the server's view onto m. fields is the configuration's.
func (a *apiProviderCredential) applyTo(m *providerCredentialModel) {
	m.ID = types.StringValue(a.Provider)
	m.ProviderID = types.StringValue(a.Provider)
	m.RoutingLive = types.BoolValue(a.RoutingLive)
	m.LastFour = stringOrNull(a.LastFour)
	m.UpdatedAt = stringOrNull(a.UpdatedAt)
}

// readFields is the fields to keep after a read. The API returns no value, so
// the ones in state stay, unless the last four characters it reports are not
// those of the credential in state: then the preview field reads as a mask,
// as a masked SIEM or PagerDuty secret does, and the plan sends fields again.
// A credential changed outside Terraform that keeps the same last four (or a
// vertex_ai or ollama credential, which has no secret field to preview)
// cannot be seen.
func (a *apiProviderCredential) readFields(prior types.Map) types.Map {
	def := credentialProviderByID(a.Provider)
	if def == nil || prior.IsNull() || prior.IsUnknown() {
		return prior
	}
	values := map[string]string{}
	for k, v := range prior.Elements() {
		s, ok := v.(types.String)
		if !ok || s.IsNull() || s.IsUnknown() {
			return prior
		}
		values[k] = s.ValueString()
	}
	got := ""
	if a.LastFour != nil {
		got = *a.LastFour
	}
	key, want := def.credentialPreview(values)
	if key == "" || want == got {
		return prior
	}
	elems := map[string]attr.Value{}
	for k, v := range values {
		elems[k] = types.StringValue(v)
	}
	elems[key] = types.StringValue(credentialMask(got))
	return types.MapValueMust(types.StringType, elems)
}

func (r *providerCredentialResource) put(ctx context.Context, m *providerCredentialModel) error {
	var fields map[string]string
	if d := m.Fields.ElementsAs(ctx, &fields, false); d.HasError() {
		return fmt.Errorf("reading fields: %v", d)
	}
	var out apiProviderCredential
	if err := r.client.Put(ctx, providerCredentialPath+"/"+esc(m.ProviderID.ValueString()), fields, &out); err != nil {
		return err
	}
	out.applyTo(m)
	return nil
}

func (r *providerCredentialResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan providerCredentialModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.put(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Saving provider credential failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *providerCredentialResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state providerCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var out struct {
		Data []apiProviderCredential `json:"data"`
	}
	if err := r.client.Get(ctx, providerCredentialPath, &out); err != nil {
		resp.Diagnostics.AddError("Reading provider credentials failed", err.Error())
		return
	}
	for i := range out.Data {
		if c := &out.Data[i]; c.Provider == state.ProviderID.ValueString() && c.Provisioned {
			c.applyTo(&state)
			state.Fields = c.readFields(state.Fields)
			resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
			return
		}
	}
	resp.State.RemoveResource(ctx)
}

func (r *providerCredentialResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan providerCredentialModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.put(ctx, &plan); err != nil {
		resp.Diagnostics.AddError("Saving provider credential failed", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *providerCredentialResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state providerCredentialModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.client.Delete(ctx, providerCredentialPath+"/"+esc(state.ProviderID.ValueString()), nil)
	if err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Removing provider credential failed", err.Error())
	}
}

// ImportState takes the provider id. The stored fields cannot be read, so they
// stay null until the next apply sends the configured ones.
func (r *providerCredentialResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if credentialProviderByID(req.ID) == nil {
		resp.Diagnostics.AddError("Unknown provider",
			fmt.Sprintf("%q is not a provider id. Use one of: %s.", req.ID, strings.Join(credentialProviderIDs(), ", ")))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("provider_id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("fields"), types.MapNull(types.StringType))...)
}
