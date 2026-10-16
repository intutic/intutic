package provider

// Release flags: which Intutic distributions this build may point users at.
//
// Only the open core is released. The hosted cloud and the self-hosted
// distribution are not, so while their flag is false the provider has no
// default endpoint (set `endpoint` or INTUTIC_CONTROL_PLANE_URL), schema
// descriptions leave out the plans a resource needs, and the Registry docs
// hide the passages that advertise them (`<!-- UNRELEASED:cloud` /
// `<!-- UNRELEASED:self-host` comment blocks in templates/ and README.md).
//
// Launching one is a flag flip in all three places, then a release of each:
//   - here (the Terraform provider, intutic/intutic on the Registry),
//   - packages/shared-types/src/release.ts (CLOUD_RELEASED, SELF_HOST_RELEASED)
//     for the TypeScript packages,
//   - packages/intutic-clawde/intutic_clawde/release.py (CLOUD_RELEASED,
//     SELF_HOST_RELEASED) for the Python SDK.
//
// When flipping one, also unwrap its UNRELEASED blocks and run go generate.
const (
	// cloudReleased: the hosted cloud (https://api.intutic.ai) is released.
	cloudReleased = false
	// selfHostReleased: the self-hosted (on-prem) distribution is released.
	selfHostReleased = false
)

// hostedEndpoint is Intutic Cloud's control plane, the same default the CLI uses.
const hostedEndpoint = "https://api.intutic.ai"

// defaultEndpoint is the control plane used when neither `endpoint` nor
// INTUTIC_CONTROL_PLANE_URL names one: Intutic Cloud once it is released, and
// none ("") until then.
func defaultEndpoint() string {
	if cloudReleased {
		return hostedEndpoint
	}
	return ""
}

// planNote returns s, a sentence naming the plans a resource needs, only once
// a distribution that sells those plans is released; "" until then.
func planNote(s string) string {
	if cloudReleased || selfHostReleased {
		return s
	}
	return ""
}
