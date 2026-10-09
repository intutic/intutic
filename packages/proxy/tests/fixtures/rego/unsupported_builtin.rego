# Uses crypto.md5, which the host does not provide: the rule is refused at load.
package unsupported

import rego.v1

deny if crypto.md5(input.tool) == "x"
