package intutic

import rego.v1

# Block a Bash tool call that deletes recursively from the filesystem root or
# the home directory.
deny contains msg if {
	some call in input.tool_calls
	call.name == "Bash"
	some target in ["rm -rf /", "rm -rf ~"]
	contains(call.arguments.command, target)
	msg := concat("", ["destructive shell command blocked by Rego policy: ", call.arguments.command])
}
