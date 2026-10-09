# Every host-provided builtin, over the cases in conformance.input.json.
# `opa eval` on the same input gives conformance.expected.json; both hosts
# must produce it exactly. A case whose builtin fails is absent, in both.
package conformance

import rego.v1

results := {
	"sprintf": {id: sprintf(c[0], c[1]) | some id, c in input.sprintf},
	"crypto.sha256": {id: crypto.sha256(c) | some id, c in input.sha256},
	"crypto.sha1": {id: crypto.sha1(c) | some id, c in input.sha1},
	"regex.find_n": {id: regex.find_n(c[0], c[1], c[2]) | some id, c in input.find_n},
	"regex.replace": {id: regex.replace(c[0], c[1], c[2]) | some id, c in input.replace},
	"regex.split": {id: regex.split(c[0], c[1]) | some id, c in input.split},
	"strings.any_prefix_match": {id: strings.any_prefix_match(c[0], c[1]) | some id, c in input.any_prefix_match},
	"strings.any_suffix_match": {id: strings.any_suffix_match(c[0], c[1]) | some id, c in input.any_suffix_match},
	"strings.count": {id: strings.count(c[0], c[1]) | some id, c in input.count},
	"indexof_n": {id: indexof_n(c[0], c[1]) | some id, c in input.indexof_n},
	"json.patch": {id: json.patch(c[0], c[1]) | some id, c in input.patch},
	"json.marshal_with_options": {id: json.marshal_with_options(c[0], c[1]) | some id, c in input.marshal},
	"time.now_ns": is_number(time.now_ns()),
}
