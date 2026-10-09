# Rego policies <Badge type="tip" text="Open-Core" />

Write governance rules in Rego, compile them with OPA, and run them in the Intutic proxy and the MCP governance proxy on every tool call. A Rego policy is a [custom filter](/guide/wasm-rules) like any other: it installs into the same rules directory, uploads through the same dashboard page, runs in the same sandbox and is [refused the same way](/guide/wasm-rules#when-a-rule-reaches-no-verdict) when it reaches no verdict. Only the language and the build step differ.

Rego rules are on wherever WASM rules are. `INTUTIC_DISABLE_REGO_RULES=1` switches them off on a proxy, which then refuses Rego modules at load.

---

## How it works

`opa build -t wasm` compiles a policy into a WebAssembly module with OPA's evaluator inside it. Intutic's hosts load that module directly:

1. For each tool call, the host builds the policy's **input document** (below) and evaluates the policy's **entrypoint** against it.
2. The entrypoint's result maps to an Intutic decision: allow, deny, hold for approval, or reask.
3. Builtins OPA cannot compile into the module (`sprintf`, `time.now_ns`, …) are provided by the host. A policy that needs one the host does not provide is refused when it loads, naming the builtin, instead of failing on every request.

`intutic rules build` runs `opa build` for you and stores the entrypoint and a default risk tier inside the module, so a rule is still one `.wasm` file.

---

## Writing a policy

A policy needs one rule to be its entrypoint. The rule's value decides:

| Entrypoint value | Decision |
| :--- | :--- |
| `true` | deny, with the reason `Denied by Rego policy <entrypoint>` |
| `false`, or undefined | allow |
| a set or array of strings | deny with the first string as the reason when non-empty; allow when empty |
| `{"decision": "allow"}` | allow |
| `{"decision": "deny", "reason": "…"}` | deny |
| `{"decision": "hold", "reason": "…"}` | hold the call for a person's approval |
| `{"decision": "reask", "reason": "…"}` | refuse this attempt and tell the agent why, so it can correct itself |

A decision object may also carry `"risk_tier"`: `low`, `medium`, `high` or `critical`. Without one, the rule's default from `intutic rules build --risk-tier` applies. The risk tier travels with a hold into the review queue and appears in `intutic rules test` output.

Anything else, such as an object without a known `decision`, is not a decision: the rule reached no verdict, as a native rule returning an unknown verdict code does, and the call is [refused](/guide/wasm-rules#when-a-rule-reaches-no-verdict) with `GOVERNANCE_UNAVAILABLE`, whatever the proxy's fail setting.

Reasons are trimmed, stripped of control characters and cut to 480 characters, as for every rule.

### Example: block destructive shell commands

A set of messages, the most common Rego shape:

```text
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
```

Build it with `--entrypoint intutic/shell/deny`.

### Example: hold production deploys for approval

A decision object, with `default` so the rule is always defined:

```text
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
	not input.truncated
	some pattern in prod_deploys
	regex.match(pattern, input.args.command)
}

# A command over the 64 KB input limit reaches the policy cut short, so it
# cannot be told apart from a deploy. Refused rather than held: an approver
# would be approving a command nobody saw in full.
decision := {
	"decision": "deny",
	"reason": "shell command too long to check in full: refused",
	"risk_tier": "high",
} if {
	input.tool == "Bash"
	input.truncated
}

prod_deploys := [
	`\bkubectl\s.*--context[= ]\S*prod`,
	`\bhelm\s+(upgrade|install)\s.*\bprod`,
	`\bterraform\s+apply\b.*\bprod`,
	`\bdeploy\.sh\s.*\bprod`,
]
```

Build it with `--entrypoint intutic/deploy/decision`.

### Example: deny writes outside the repository

```text
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
```

Build it with `--entrypoint intutic/paths/deny`.

These three policies, built and with test cases, are in the open-core repository under `packages/proxy/tests/fixtures/rego/examples/`.

---

## The input document

Version 1. Every field below is present unless marked otherwise; a field a host has no value for is absent, never `null` or zero, so a rule reading it does not match.

| Field | Type | What it is |
| :--- | :--- | :--- |
| `input.v` | number | `1`. Changes only when a policy could observe the difference. |
| `input.host` | string | `proxy` (the LLM proxy) or `mcp` (the MCP governance proxy). |
| `input.tool` | string or `null` | The tool being called, such as `Bash`, `Write` or an MCP tool name. `null` when the request carries no tool call. |
| `input.args` | object or `null` | The call's arguments, as the agent sent them. `null` with `tool`. |
| `input.server` | string | MCP proxy only: the MCP server this proxy fronts. |
| `input.session.id` | string | The agent session. |
| `input.session.workspace_id` | string | The workspace. |
| `input.session.tool_sequence` | array of strings | The session's recent tools and the actions they performed, oldest first. |
| `input.session.calls_last_60s` | number | Tool calls in the session in the last 60 seconds. |
| `input.session.model` | string | LLM proxy only: the model the agent asked for. |
| `input.session.risk_tier` | string | LLM proxy only: the risk tier the SOPs in force declare, `low` to `critical`. |
| `input.session.agent_role` | string | LLM proxy only, when the agent reports one: its role in a multi-agent graph. Client-supplied: never grant anything on it. |
| `input.session.harness` | string | LLM proxy only, when known: `claude-code`, `cursor`, … |
| `input.request.dlp_findings` | array | Secrets and sensitive data the DLP scanner found, as `{category, pattern_name, action}` (the MCP proxy fills `pattern_name` only). |
| `input.request.injection_findings` | array of strings | Prompt-injection patterns matched in the request. |
| `input.request.estimated_input_tokens` | number | LLM proxy only: the request's size in tokens. |
| `input.request.budget_remaining_usd` | number | LLM proxy only: the workspace budget left. |
| `input.truncated` | boolean | `true` when strings in `args` were cut to fit the input limit (below). |

A policy written against `input.tool` and `input.args` runs unchanged in both proxies.

**Which calls are evaluated.** The MCP proxy evaluates each tool call it intercepts. The LLM proxy evaluates the calls in the request's latest assistant turn, one evaluation per call, and the most restrictive decision wins: a deny ends it, a hold outranks a reask. A request with no tool call is evaluated once, with `tool` and `args` set to `null`, so a policy on the model or the budget still runs.

**Size.** The document is at most 64 KB. When a call's arguments make it larger, strings in `args` are cut, in steps of 16 KB, 4 KB, 1 KB and 256 bytes, until it fits, and `truncated` is set; if they still do not fit, `args` is `null`. 99.97% of real coding-agent tool calls fit untouched; the rest are mostly whole files passed to `Write`.

**A policy that inspects `args` must refuse the tools it governs when `truncated` is true.** The cut removes the end of a string, so padding a command past the limit moves whatever follows the padding out of the policy's sight: `echo ok; echo ok; … rm -rf /` arrives as `echo ok; echo ok; …`. The policy decides what an incomplete call means, as in OPA; for a policy that matches on arguments, the only safe answer is to refuse. All three examples above do, which is why the deny-writes example refuses a `Write` of a file larger than about 64 KB even inside the repository. `intutic rules build` warns about a policy that reads `input.args` and never `input.truncated`.

---

## Decisions

| Decision | LLM proxy | MCP proxy |
| :--- | :--- | :--- |
| allow | The request continues. | The call continues. |
| deny | HTTP 403, `policy_denied`, with the reason. | The call is refused with the reason. |
| reask | HTTP 409, `policy_reask`; the third reask from the same rule in a session is a 403. | The same reask ladder as other rules. |
| hold | HTTP 403, `policy_held`, naming the hold id. | The call is held, as for a `require_approval` rule. |

A **hold** goes through the decisions API like every other hold. The proxy first looks for an approval of this exact call (the same rule, tool and arguments, with keys in any order); if there is one, the call goes through. Otherwise it records the hold, which lands in the review queue and notifies the workspace, and the agent is told the hold id. An approver approves it with `intutic decision approve <holdId>`, the review API or the Slack card. When the workspace has the review-hold bypass on, approving lets the identical retry through for the bypass window; otherwise the approval is recorded and the retry is held again. Without a reachable control plane the call stays held: a rule that says a person must approve is not satisfied by nobody being reachable to ask.

Rules in shadow mode report what they would have decided, holds included, and change nothing.

---

## Building

```bash
intutic rules build --rego policies/shell.rego --entrypoint intutic/shell/deny --risk-tier critical
```

`--rego` takes a file or a directory. The command:

1. Runs `opa build -t wasm -e <entrypoint>`. It needs the `opa` binary on the `PATH`, or `INTUTIC_OPA_BIN` set to it; without one it says how to install OPA.
2. Appends the entrypoint, the ABI (`opa`) and the risk tier to the module, in a custom section named `intutic.rule`.
3. Loads the result the way the proxies will, and refuses it if they would: a builtin the host does not provide, or a module built for an evaluation ABI older than 1.2. It warns, before compiling, when the policy reads `input.args` and never `input.truncated` (see [Size](#the-input-document)).
4. Writes `build/<entrypoint>.wasm`, or `--out <path>`.

A module built with plain `opa build` loads too, when it has exactly one entrypoint.

## Testing

```bash
intutic rules test build/intutic_shell_deny.wasm --input cases.json
```

A case file holds one input document, or an array of cases:

```json
[
  { "name": "recursive delete of the root", "input": { "tool": "Bash", "args": { "command": "rm -rf /" } }, "expect": "deny" },
  { "name": "delete a build directory", "input": { "tool": "Bash", "args": { "command": "rm -rf ./build" } }, "expect": "allow" }
]
```

Each case runs through the same Rego host the MCP proxy uses, which decides as the LLM proxy does: both hosts' builtins are tested against `opa eval` on the same inputs. The test does not meter instructions or time, so a policy that passes here can still exceed the proxies' [limits](#limits) on a large input; check the largest inputs you expect against them. The command prints each decision, and exits 1 when a case gets a decision other than its `expect`, or reaches none. `opa test` also works on the policy source unchanged.

## Deploying

**Locally**, install the module into the rules directory both proxies read:

```bash
intutic policy install --wasm build/intutic_shell_deny.wasm --name shell --priority 20
```

`install` loads and evaluates the rule before copying it, and refuses one a proxy could not run. The proxies pick it up within about five seconds.

<!-- ENTERPRISE_ONLY_START -->
**For a workspace**, upload the module on **Policies › Custom Filters**, or with `POST /api/v1/wasm-rules`, as for any filter. The control plane checks it with the same Rego host and refuses one the proxies could not run, naming the builtin. The LLM proxy receives it the same way as a native rule: the workspace's rule set and each module by its SHA-256. The MCP governance proxy runs only the rules in the local rules directory (`~/.intutic/wasm/`, or `INTUTIC_WASM_DIR`), so for MCP tool calls install the module there too.

Replay (`intutic policy replay`, `POST /api/v1/wasm-rules/:id/replay`) runs native rules only: it replays sampled request contexts, which do not record which tool calls made up a request's latest turn. Measure a Rego rule on live traffic in shadow mode instead.
<!-- ENTERPRISE_ONLY_END -->

---

## Limits

A Rego rule runs in the same sandbox as a native rule, with a larger budget, because OPA does inside the sandbox what a native rule leaves out: it parses the whole input document and compiles each regular expression the policy uses, on every evaluation. Both bounds stop the rule, which then reaches no verdict and [refuses the call](/guide/wasm-rules#when-a-rule-reaches-no-verdict), as for every rule, whatever the proxy's fail setting. In the LLM proxy, a rule that reaches no verdict on one call of a turn refuses the request; a deny it reached on another call of that turn is the refusal reported.

| | Native rule | Rego rule, LLM proxy | Rego rule, MCP proxy |
| :--- | :--- | :--- | :--- |
| Memory | 16 MB | 16 MB | 16 MB |
| Instructions (fuel) | 1,000,000 | 100,000,000 | 300,000,000 metered |
| Deadline per evaluation (a backstop) | 1 s | 2 s | 10 s, round trip to its worker included |
| Input | the request context | 64 KB | 64 KB |

The MCP proxy meters instructions differently from the LLM proxy (V8 has no fuel counter, so it charges each straight-line run of code in full) and counts about three and a half times as many on an OPA build, which is why its number is larger.

Fuel is the limit a policy is held to, and it is deterministic: a policy within it reaches its verdict however busy the machine is. On the largest input, the destructive-shell and production-deploy examples use 21,000,000 instructions in the LLM proxy and 74,000,000 metered in the MCP proxy, and the deny-writes example under 3,000,000 and 9,000,000; each budget is four to five times the largest, so a heavier policy fits. The deadline is only a backstop for stalls fuel cannot see. It is set above the time it takes to use up the whole budget on a heavily loaded machine (a 14-core machine running 100 busy threads: at most 590 ms in the LLM proxy and 4.4 s in the MCP proxy), because a rule that reaches no verdict refuses the call, and a legitimate policy must not be refused because the machine is busy. The deadline interrupts a rule that is still running, rather than being checked after it returns.

Measured cost of the destructive-shell example, per evaluation, in the LLM proxy (fresh sandbox, input parse and policy), at sizes taken from 82,401 real coding-agent tool calls:

| Input | Instructions | Time |
| :--- | ---: | ---: |
| 734 B (median call) | 2,000,000 | 0.5 ms |
| 2.4 KB (90th percentile) | 2,500,000 | 0.4 ms |
| 10.6 KB (99th) | 4,900,000 | 0.4 ms |
| 32 KB (99.9th) | 11,300,000 | 0.8 ms |
| 64 KB (the limit) | 21,000,000 | 1.3 ms |

A policy without regular expressions costs far less: the deny-writes example uses 82,000 instructions on a median call and 2,900,000 at the limit. Each regular expression a policy uses costs about 500,000 instructions per evaluation to compile.

---

## Builtins

OPA compiles most builtins into the module: `concat`, `contains`, `startswith`, `endswith`, `split`, `lower`, `regex.match`, `regex.is_valid`, `regex.find_all_string_submatch_n`, `glob.match`, `json.marshal`, `json.unmarshal`, `json.filter`, `json.remove`, `base64.*`, `net.cidr_contains`, `object.get`, `walk` and the rest of the core library. Those need nothing from Intutic.

The host provides these, following OPA's documented semantics:

| Builtin | |
| :--- | :--- |
| `sprintf` | Go's `fmt` verbs, flags, width and precision |
| `time.now_ns` | Fixed for the whole evaluation, as in OPA |
| `crypto.sha1`, `crypto.sha256` | |
| `regex.find_n`, `regex.replace`, `regex.split` | |
| `strings.any_prefix_match`, `strings.any_suffix_match`, `strings.count` | |
| `indexof_n` | |
| `json.patch`, `json.marshal_with_options` | |

A policy needing any other builtin is refused at load, with the builtin named. `http.send` is never provided: a policy making network calls from the request path is not one the proxies run.

Known differences from `opa eval`:

- A number written in exponent notation (`1e-7`) is formatted by `sprintf` as a float; OPA formats it as written.
- A Rego set reaches a host builtin as an array, so `sprintf("%v", [{1, 2}])` prints `[1, 2]`.
- `sprintf` refuses a width or precision over 4096, and `regex.replace` a result over 1 MB; the result is then undefined.
- In the LLM proxy, `\d`, `\w`, `\s` and `\b` in the host-provided regex builtins also match non-ASCII digits, letters and spaces. In the MCP proxy and `intutic rules test`, those builtins run on JavaScript's regular expressions: Go's `(?P<name>…)` groups and leading `(?i)`, `(?s)` and `(?m)` flags work, other RE2-only syntax is refused, and `\s` matches Unicode spaces. `regex.match`, compiled into the module, behaves identically everywhere.
- `strings.split_n` is not provided: OPA 1.20's own evaluator does not follow its documented behaviour for it, so there is no single answer to match.

---

## Turning Rego rules off

Set `INTUTIC_DISABLE_REGO_RULES=1` in the environment of the proxy, the MCP proxy, or both. A Rego module is then refused at load, from the rules directory and from the control plane, and native rules are unaffected.

---

## Related

- [Custom Filters](/guide/wasm-rules): native rules in AssemblyScript, and the sandbox both kinds share
- [WASM Rules Engine](/external/wasm-rules): how rules load and run in the proxy
- [Review Queue](/guide/decisions): where a hold lands
- [CLI reference](/reference/cli#intutic-rules-build)
