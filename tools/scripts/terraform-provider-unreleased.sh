#!/bin/bash
# The Terraform provider is released on its own tag (terraform-provider-v*), not
# with the product. Print the latest provider tag and the provider files changed
# since it, tests left out; print nothing after the tag when there are none.
# Usage: terraform-provider-unreleased.sh [ref]   (default HEAD)
set -euo pipefail
ref=${1:-HEAD}
last=$(git describe --tags --abbrev=0 --match 'terraform-provider-v*' "$ref")
echo "$last"
git diff --name-only "$last" "$ref" -- packages/terraform-provider-intutic \
  ':(exclude)packages/terraform-provider-intutic/**/*_test.go' \
  ':(exclude)packages/terraform-provider-intutic/**/testdata/**'
