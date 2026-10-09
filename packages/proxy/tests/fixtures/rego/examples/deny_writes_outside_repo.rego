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
	not input.truncated
	path := target(input.args)
	not inside_repo(path)
	msg := sprintf("%s outside %s is not allowed: %s", [input.tool, repo_root, path])
}

# Arguments over the 64 KB input limit reach the policy cut short, the path
# included, and a cut path can look inside the repository when it is not.
# This refuses writing a file larger than about 64 KB, inside the repository
# too; split such a write into smaller edits.
deny contains msg if {
	input.tool in write_tools
	input.truncated
	msg := sprintf("%s arguments too long to check in full: refused", [input.tool])
}

target(args) := args.file_path
target(args) := args.notebook_path if not args.file_path

inside_repo(path) if {
	startswith(path, concat("", [repo_root, "/"]))
	not contains(path, "/../")
}
