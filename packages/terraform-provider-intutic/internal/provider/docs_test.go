package provider

import (
	"context"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

func providerSchema(t *testing.T) *tfprotov6.GetProviderSchemaResponse {
	t.Helper()
	server, err := protoV6Factories["intutic"]()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := server.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// Twenty attributes rendered as a bare name and type in the generated docs,
// with nothing saying what they hold. Every attribute, nested ones included,
// must say something.
func TestEveryAttributeHasADescription(t *testing.T) {
	resp := providerSchema(t)
	var missing []string
	var walk func(owner string, attrs []*tfprotov6.SchemaAttribute)
	walk = func(owner string, attrs []*tfprotov6.SchemaAttribute) {
		for _, a := range attrs {
			if strings.TrimSpace(a.Description) == "" {
				missing = append(missing, owner+"."+a.Name)
			}
			if a.NestedType != nil {
				walk(owner+"."+a.Name, a.NestedType.Attributes)
			}
		}
	}
	for name, s := range resp.ResourceSchemas {
		walk(name, s.Block.Attributes)
	}
	for name, s := range resp.DataSourceSchemas {
		walk(name, s.Block.Attributes)
	}
	sort.Strings(missing)
	for _, m := range missing {
		t.Errorf("%s has no description", m)
	}
}

// The docs-site index lists the resources and data sources by hand (a
// tfplugindocs template sees no resource list), and missed both budgets.
func TestDocsSiteIndexListsEveryResource(t *testing.T) {
	resp := providerSchema(t)
	tmpl, err := os.ReadFile("../../templates-docs-site/index.md.tmpl")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, m := range regexp.MustCompile(`\[(intutic_[a-z_]+)\]\(\./(resources|data-sources)/([a-z_]+)\)`).FindAllStringSubmatch(string(tmpl), -1) {
		if m[1] != "intutic_"+m[3] {
			t.Errorf("index.md.tmpl links %s to ./%s/%s", m[1], m[2], m[3])
		}
		listed[m[2]+"/"+m[1]] = true
	}
	want := map[string]bool{}
	for name := range resp.ResourceSchemas {
		want["resources/"+name] = true
	}
	for name := range resp.DataSourceSchemas {
		want["data-sources/"+name] = true
	}
	for k := range want {
		if !listed[k] {
			t.Errorf("templates-docs-site/index.md.tmpl does not list %s", k)
		}
	}
	for k := range listed {
		if !want[k] {
			t.Errorf("templates-docs-site/index.md.tmpl lists %s, which the provider does not have", k)
		}
	}
}
