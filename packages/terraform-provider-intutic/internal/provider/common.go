package provider

import (
	"context"
	"fmt"
	"net/url"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/intutic/terraform-provider-intutic/internal/client"
)

// configuredClient extracts the client the provider handed to a resource or
// data source. ProviderData is nil during validation, before Configure runs.
func configuredClient(providerData any, diags *diag.Diagnostics) *client.Client {
	if providerData == nil {
		return nil
	}
	c, ok := providerData.(*client.Client)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", providerData))
		return nil
	}
	return c
}

// esc escapes one path segment, so an id can never step outside its route.
func esc(id string) string { return url.PathEscape(id) }

// stringOrNull maps an optional API string to Terraform: absent is null.
func stringOrNull(v *string) types.String {
	if v == nil {
		return types.StringNull()
	}
	return types.StringValue(*v)
}

// stringList converts an API string slice to a Terraform list. A nil slice is
// null, so an unset optional list stays unset.
func stringList(v []string) types.List {
	if v == nil {
		return types.ListNull(types.StringType)
	}
	elems := make([]attr.Value, len(v))
	for i, s := range v {
		elems[i] = types.StringValue(s)
	}
	return types.ListValueMust(types.StringType, elems)
}

// stringSet is stringList for sets.
func stringSet(v []string) types.Set {
	if v == nil {
		return types.SetNull(types.StringType)
	}
	elems := make([]attr.Value, len(v))
	for i, s := range v {
		elems[i] = types.StringValue(s)
	}
	return types.SetValueMust(types.StringType, elems)
}

// listStrings reads a Terraform list or set of strings; null or unknown is nil.
func listStrings(ctx context.Context, v interface {
	IsNull() bool
	IsUnknown() bool
	ElementsAs(context.Context, any, bool) diag.Diagnostics
}, diags *diag.Diagnostics) []string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	var out []string
	diags.Append(v.ElementsAs(ctx, &out, false)...)
	return out
}

// errText is err's message, or fallback when there is no error to report
// (a read that succeeded but found nothing).
func errText(err error, fallback string) string {
	if err != nil {
		return err.Error()
	}
	return fallback
}
