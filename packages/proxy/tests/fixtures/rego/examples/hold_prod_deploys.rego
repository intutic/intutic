# Hold a production deploy until a person approves it. The hold goes to the
# review queue through the decisions API; once approved, the identical retry
# goes through.
#
# Build: intutic rules build --rego hold_prod_deploys.rego \
#          --entrypoint intutic/deploy/decision --risk-tier high
package intutic.deploy

import rego.v1

# A decision object: allow, deny, hold or reask, with a reason and a risk tier.
default decision := {"decision": "allow"}

decision := {
	"decision": "hold",
	"reason": sprintf("production deploy needs approval: %s", [input.args.command]),
	"risk_tier": "high",
} if {
	input.tool == "Bash"
	some pattern in prod_deploys
	regex.match(pattern, input.args.command)
}

prod_deploys := [
	`\bkubectl\s.*--context[= ]\S*prod`,
	`\bhelm\s+(upgrade|install)\s.*\bprod`,
	`\bterraform\s+apply\b.*\bprod`,
	`\bdeploy\.sh\s.*\bprod`,
]
