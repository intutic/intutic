# Deny file writes outside the repository the agent works in.
#
# Build: intutic rules build --rego deny_writes_outside_repo.rego \
#          --entrypoint intutic/paths/deny --risk-tier medium
package intutic.paths

import rego.v1

# The checkout agents work in. Set it to yours before building.
repo_root := "/workspace/app"

write_tools := {"Write", "Edit", "MultiEdit", "NotebookEdit"}

deny contains msg if {
	input.tool in write_tools
	path := target(input.args)
	not inside_repo(path)
	msg := sprintf("%s outside %s is not allowed: %s", [input.tool, repo_root, path])
}

target(args) := args.file_path
target(args) := args.notebook_path if not args.file_path

inside_repo(path) if {
	startswith(path, concat("", [repo_root, "/"]))
	not contains(path, "/../")
}
