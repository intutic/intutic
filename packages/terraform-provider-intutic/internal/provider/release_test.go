package provider

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// unreleasedBlock is a passage hidden until its distribution is released.
var unreleasedBlock = regexp.MustCompile(`(?s)<!-- UNRELEASED:(cloud|self-host)\n.*?-->`)

// advertises names what only a released cloud or self-host distribution may
// point users at: the hosted endpoint, the plans, trials, the dashboard's key page.
var advertises = regexp.MustCompile(`api\.intutic\.ai|Intutic Cloud|Biz Org|Self-host plan|Enterprise and Self-host|\(or a trial\)|trial/status|Settings › Security › Virtual API Keys`)

func TestUnreleasedCloudHasNoDefaultEndpoint(t *testing.T) {
	if cloudReleased {
		t.Skip("the hosted cloud is released")
	}
	if got := defaultEndpoint(); got != "" {
		t.Errorf("defaultEndpoint() = %q, want none", got)
	}
}

func TestMissingEndpointIsExplained(t *testing.T) {
	if cloudReleased {
		t.Skip("the hosted cloud is the default endpoint")
	}
	t.Setenv("INTUTIC_CONTROL_PLANE_URL", "")
	t.Setenv("INTUTIC_API_KEY", "vk_offline")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{{
			Config:      `data "intutic_workspace" "this" {}`,
			ExpectError: regexp.MustCompile(`Missing control-plane endpoint`),
		}},
	})
}

// The environment still names the control plane (staging, a test server):
// the provider gets past configuration and fails only on the unreachable host.
func TestEndpointFromTheEnvironmentIsUsed(t *testing.T) {
	t.Setenv("INTUTIC_CONTROL_PLANE_URL", "http://127.0.0.1:9")
	t.Setenv("INTUTIC_API_KEY", "vk_offline")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: protoV6Factories,
		Steps: []resource.TestStep{{
			Config:      `data "intutic_workspace" "this" {}`,
			ExpectError: regexp.MustCompile(`Reading the API key's member failed`),
		}},
	})
}

// Until a distribution is released, nothing the Registry shows (schema
// descriptions, the generated docs, the README) advertises it outside an
// UNRELEASED comment block, which the Registry does not render.
func TestUnreleasedDistributionsAreNotAdvertised(t *testing.T) {
	if cloudReleased || selfHostReleased {
		t.Skip("a distribution is released")
	}
	check := func(where, text string) {
		if m := advertises.FindString(unreleasedBlock.ReplaceAllString(text, "")); m != "" {
			t.Errorf("%s mentions %q outside an UNRELEASED block", where, m)
		}
	}
	resp := providerSchema(t)
	check("provider schema", resp.Provider.Block.Description)
	for _, a := range resp.Provider.Block.Attributes {
		check("provider."+a.Name, a.Description)
	}
	for name, s := range resp.ResourceSchemas {
		check(name, s.Block.Description)
		for _, a := range s.Block.Attributes {
			check(name+"."+a.Name, a.Description)
		}
	}
	for name, s := range resp.DataSourceSchemas {
		check(name, s.Block.Description)
		for _, a := range s.Block.Attributes {
			check(name+"."+a.Name, a.Description)
		}
	}
	var files []string
	for _, root := range []string{"../../docs", "../../templates", "../../examples"} {
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				files = append(files, p)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	files = append(files, "../../README.md")
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		check(strings.TrimPrefix(f, "../../"), string(b))
	}
}
