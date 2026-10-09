# Block destructive shell commands: a recursive delete of the filesystem
# root, the home directory or a parent directory, formatting a disk, writing
# straight to a block device, and force-pushing to main.
#
# Build: intutic rules build --rego block_destructive_shell.rego \
#          --entrypoint intutic/shell/deny --risk-tier critical
package intutic.shell

import rego.v1

# A set of messages: empty allows, any message denies with the first.
deny contains msg if {
	input.tool == "Bash"
	some pattern in destructive
	regex.match(pattern, input.args.command)
	msg := sprintf("destructive shell command blocked: %s", [input.args.command])
}

# A command over the 64 KB input limit reaches the policy cut short, and what
# was cut is what this policy cannot see. Padding a command must not hide it.
deny contains "shell command too long to check in full: refused" if {
	input.tool == "Bash"
	input.truncated
}

destructive := [
	`\brm\s+(-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-\S+\s+)*(/|~|\$HOME|\.\.)/?(\s|$)`,
	`\bmkfs(\.[a-z0-9]+)?\s`,
	`\bdd\s.*\bof=/dev/`,
	`\bgit\s+push\s.*(--force\b|\s-f\b).*\b(main|master)\b`,
]
