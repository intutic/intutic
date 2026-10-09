# Terraform Provider for Intutic

Manage an Intutic workspace's SOPs, enforcement policies, policy guardrails, workspace settings, virtual keys, self-hosted gateways, notification rules and MCP server decisions with Terraform. Built on the [Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework).

- Guide: [Manage Intutic with Terraform](https://docs.intutic.ai/guide/terraform)
- Reference: [`docs/`](docs/) (the Registry's format) and [docs.intutic.ai/reference/terraform](https://docs.intutic.ai/reference/terraform/)

## Authentication

A workspace API key (`vk_…`) created with **This key is for automation** ticked, in `INTUTIC_API_KEY` or the provider's `api_key`. The provider acts as the key's member; most resources need an OWNER or ADMIN role. For a self-hosted control plane, set `INTUTIC_CONTROL_PLANE_URL` or `endpoint`.

## Develop

Requires Go (the version in `go.mod`) and Terraform.

```sh
go build ./...
go vet ./...
go test ./...      # unit tests and plan-time validation; needs the terraform binary, no control plane
go generate ./...  # regenerate docs/ and the docs site's reference pages after a schema or example change
```

### Acceptance tests

`TF_ACC=1` runs every resource against a real control plane: apply, an empty re-plan, import, and drift. Point the tests at a test workspace, never a production one:

```sh
export INTUTIC_CONTROL_PLANE_URL=http://127.0.0.1:3081
export INTUTIC_API_KEY=vk_...              # an OWNER key; self-hosted gateways need an Enterprise or Self-host plan
export INTUTIC_TEST_WORKSPACE_ID=ws_...    # the key's workspace
export INTUTIC_TEST_MCP_SERVER=...         # optional: an MCP server a proxy has already reported
TF_ACC=1 go test ./... -run TestAcc
```

The tests create and destroy their own resources, but leave the workspace settings they write as they set them. Intutic's CI runs them against a control plane on a throwaway database, started by `services/control-plane/scripts/terraform-acceptance-server.ts`, which writes these variables to a file.

## Releasing

Releases are cut from the open-core repository by pushing a tag `terraform-provider-vX.Y.Z`. `.github/workflows/release-terraform-provider.yml` pushes this directory to `intutic/terraform-provider-intutic`, tags it `vX.Y.Z` there, and builds a signed GoReleaser release in that repository, which is where the Terraform Registry reads providers from.

One-time setup before the first release:

1. Create the public repository `intutic/terraform-provider-intutic`, empty.
2. Generate a GPG signing key. The Registry accepts RSA or DSA keys, not ECC: `gpg --full-generate-key`, choose RSA, 4096 bits.
3. Add the ASCII-armoured public key (`gpg --armor --export <fingerprint>`) in the [Terraform Registry](https://registry.terraform.io) under **User Settings › Signing Keys**, for the `intutic` namespace. Signing in to the Registry with the GitHub account that administers the `intutic` organization creates that namespace.
4. In the open-core repository's Actions secrets, add:
   - `TERRAFORM_PROVIDER_REPO_TOKEN`: a fine-grained token with **Contents: read and write** on `intutic/terraform-provider-intutic` only;
   - `TERRAFORM_PROVIDER_GPG_KEY`: the armoured private key (`gpg --armor --export-secret-keys <fingerprint>`);
   - `TERRAFORM_PROVIDER_GPG_PASSPHRASE`: its passphrase.
5. Push the first tag, for example `git tag terraform-provider-v0.1.0 && git push origin terraform-provider-v0.1.0`, and wait for the release to appear on `intutic/terraform-provider-intutic`.
6. In the Registry, choose **Publish › Provider**, select `intutic/terraform-provider-intutic`, and publish. The Registry installs a webhook on that repository, so later tags publish on their own.

Once the provider is on the Registry, the guide's build-from-source steps can give way to `source = "intutic/intutic"` alone.
