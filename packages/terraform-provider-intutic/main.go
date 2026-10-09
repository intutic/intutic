// Command terraform-provider-intutic is the Terraform provider for Intutic.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/intutic/terraform-provider-intutic/internal/provider"
)

// Generate the Registry docs (docs/) and the docs site's reference pages
// (apps/docs/reference/terraform/) from the schema and examples/.
//go:generate go tool tfplugindocs generate --provider-name intutic
//go:generate go tool tfplugindocs generate --provider-name intutic --website-source-dir templates-docs-site --rendered-website-dir ../../apps/docs/reference/terraform

// version is set by GoReleaser at release time.
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers such as delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/intutic/intutic",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
