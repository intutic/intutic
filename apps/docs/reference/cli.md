# CLI Reference <Badge type="tip" text="Open-Core" />

The Intutic CLI provides workspace management, harness detection, config sync, and trace querying.

## Installation

```bash
# Install workspace CLI globally
npm install -g @intutic/cli

# Install or run native Rust proxy gateway
npm install -g @intutic/proxy
npx @intutic/proxy
```

## Global options

| Option | Description |
|--------|-------------|
| `--version`, `-V` | Show the CLI version. Only before a command: `intutic --version`. |
| `--help`, `-h` | Show help for the program or for any command, e.g. `intutic gates install --help` |

`intutic trace` is an alias of `intutic traces`, and `intutic install-daemon` /
`intutic uninstall-daemon` are shortcuts for `intutic daemon install` / `intutic daemon uninstall`.

A command that changes the workspace needs a role that may make the change, the same as in the
dashboard ([what each role can change](/guide/security#what-each-role-can-change)). When yours
cannot, the command fails with the roles it needs, for example
`API PUT /api/v1/budget refused (403): Requires the OWNER or ADMIN role`. A Viewer can run the
read-only commands and manage their own login and keys.

<!-- ENTERPRISE_ONLY_START -->
## Plan badges

Commands without a badge run on your machine with no account. A badge on a command means it calls
a control plane, which the open core does not include, and needs `intutic login` first. Every
command ships in the open-core CLI; the badge says what it needs to work.

<!-- ENTERPRISE_ONLY_START -->
The badge names the plan, as in [Plan badges](/guide/plans#badges):
<Badge type="tip" text="Cloud" /> works on any connected workspace, free included;
<Badge type="warning" text="Self-serve+" />, <Badge type="warning" text="Biz Org+" /> and
<Badge type="danger" text="Enterprise" /> need that plan or higher.
<!-- ENTERPRISE_ONLY_END -->

## Choosing a control plane {#control-plane-url}

Every command that talks to a control plane picks it the same way; the first that is set wins:

1. A flag: `--control-plane-url <url>` (on `login`, `connect` and `daemon install`), or `--dev`
   for the local one at `http://localhost:3001`.
2. The environment: `INTUTIC_CONTROL_PLANE_URL`, or `INTUTIC_DEV=1` for the local one.
3. A workspace initialized with `intutic init --dev`, which uses the local one.
4. The control plane `intutic login` saved with your credentials.
<!-- ENTERPRISE_ONLY_START -->
5. Intutic's hosted control plane.
<!-- ENTERPRISE_ONLY_END -->

With none of these set, a command that needs a control plane says so and exits: the open core runs
locally (`intutic start`) and has no default control plane.

`intutic status` shows the control plane this order picks.

<!-- ENTERPRISE_ONLY_START -->
For a self-hosted control plane, log in once with its URL and every later command uses it:

```bash
intutic login --control-plane-url https://intutic.internal.example
intutic whoami
intutic connect
```
<!-- ENTERPRISE_ONLY_END -->

---

## `intutic init`

Initialize the workspace: find its root, detect harnesses, and record both locally.

```bash
intutic init [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Record dev mode, so later commands use the local control plane (`http://localhost:3001`) |
| `--git-hooks` | Install the Intutic Git hooks without asking |
| `--no-git-hooks` | Skip the Git hooks without asking |
| `--gates` | Install the harness gates and rules files ([`intutic gates install`](#intutic-gates-install)) without asking |
| `--no-gates` | Skip the harness gates without asking |

**What it does:**
1. Finds the workspace root: the nearest directory, from the current one upwards, that holds `.git/` or `package.json`. Exits `1` if there is none.
2. Detects the harnesses present in the workspace and lists each with its config file.
3. Reports whether you are logged in. No login is needed: `init` makes no network call.
4. Records the workspace root, the detected harnesses and dev mode in `~/.intutic/config.json`, keeping any other settings already there.
5. Installs the Git hooks if you agree: `post-commit` and `post-checkout` (record the branch and commit with `intutic sync-context`), `pre-commit` (refuses a commit that stages a credential, and warns on risky skill files) and `post-merge` (refreshes the decisions log). A hook that already exists and is not Intutic's is left untouched.
6. With no login and at least one harness detected, installs the harness gates and rules files if you agree: the same as running [`intutic gates install`](#intutic-gates-install) afterwards.
7. Prints setup instructions for pointing each detected harness at the local proxy (`http://localhost:4000`, or `INTUTIC_PROXY_URL`).

Without the gates, `init` writes no harness config files. [`intutic gates install`](#intutic-gates-install)
writes them from this machine alone; on a machine with a login, [`intutic connect`](#intutic-connect)
writes them instead, from the control plane's SOPs plus your local `.intutic/sops/`.

**Prompts:** with a terminal attached, `init` asks before installing the Git hooks, and before
installing the gates. Without one (CI, a provisioning script, `stdin` redirected) it never asks: it
skips both unless `--git-hooks` or `--gates` is passed, and says so. `--git-hooks`/`--no-git-hooks`
and `--gates`/`--no-gates` skip each question either way.

**Examples:**

```bash
intutic init

# Non-interactive, with the hooks and the gates
intutic init --git-hooks --gates
```

---

## `intutic start`

Run the proxy in the foreground, standalone — no account or control plane needed.

```bash
intutic start [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Port the proxy listens on | The port of `INTUTIC_PROXY_URL`, else `4000` |
| `--valkey-port <port>` | Local Valkey port to use or start | `6379` |
| `--upstream-url <url>` | Upstream LLM provider base URL, passed to the proxy as `UPSTREAM_URL` | _(proxy default)_ |
| `--no-gates` | Neither refresh the local gates nor watch `.intutic/sops` | Refresh and watch |

**What it does:**

1. **Local gates.** On a machine with no login whose gates [`intutic gates install`](#intutic-gates-install) installed, refreshes them before the proxy starts (the gate scripts, the rules files from `.intutic/sops/` and the policy snapshot), and again whenever `.intutic/sops/` changes while the proxy runs. The refresh never writes routing. Each refresh also deletes the decide logs in `~/.intutic/logs/` (`decide-<date>.jsonl`, and the `decide-state-<date>.jsonl` files `--log-state` writes) more than 30 days old. With no gates installed, one line names the recorded harnesses that have none. `--no-gates` skips this step.
2. **Decide engine (background).** When the policy snapshot carries decide rules and an engine is configured (`intutic decide configure`, or `INTUTIC_DECIDE_MODEL`), it loads the engine's model and keeps it loaded for 8 hours (Ollama's `keep_alive`, with the `logprobs` adapter only), then runs the known-answer canary and stores the result in `~/.intutic/decide/canary.json`, where the gates read it. This runs beside the proxy's start-up: each result is printed, and none stops or delays the proxy.
3. **Valkey (best-effort).** Checks for a Valkey or Redis on `127.0.0.1:<valkey-port>`. If none is listening, it tries, in order: starting an `intutic-valkey` Docker container (`valkey/valkey:8-alpine`), then `valkey-server` or `redis-server` from `PATH`. If none of these works, it warns and continues in standalone mode: routing, policies, DLP, and local spend caps all still work; bandit learning persists to `~/.intutic`, and the response cache lasts only as long as the process.
4. **Proxy binary.** Runs the version-matched binary in `~/.intutic/bin/` if it is there, otherwise `intutic-proxy` from `PATH`. If neither exists it prints `npm install -g @intutic/proxy` and exits with status `1`.
5. **Proxy environment.** Starts the proxy with your environment plus:
   - `PORT` set to `--port`
   - with Valkey running: `VALKEY_URL`, taken from your environment if set, otherwise `redis://127.0.0.1:<valkey-port>`
   - without Valkey: `INTUTIC_STANDALONE=1` — unless `CONTROL_PLANE_URL` is set in your environment. That marks a managed deployment, where the proxy requires Valkey and refuses to start without it; `intutic start` leaves that decision to the proxy.
   - `UPSTREAM_URL` when `--upstream-url` is given

`Ctrl+C` stops the proxy, and the command exits with the proxy's exit code.

**Examples:**

```bash
intutic start
export ANTHROPIC_BASE_URL=http://localhost:4000

# Different port, and a Valkey on 6380
intutic start --port 8080 --valkey-port 6380
```

---

## `intutic gates install`

Install the tool-call gate and rules file for each harness `intutic init` recorded, from this
machine alone — no account or control plane needed.

```bash
intutic gates install [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--harness <id>` | Only this harness, for example `cursor`. It must be recorded in `~/.intutic/config.json`, unless `--add` is passed too |
| `--add` | With `--harness`: record the harness in `~/.intutic/config.json` first |
| `--route` | Also point each harness's LLM traffic at the local proxy (`http://127.0.0.1:4000`, or the port of `INTUTIC_PROXY_URL`). The proxy must then be running, for example as a service with [`intutic daemon install --proxy`](#intutic-daemon-install), or the harnesses cannot reach their model |
| `--dry-run` | Print what would be written, and write nothing |
| `--workspace <path>` | The workspace to write into. Default: the one `intutic init` recorded |

**What it writes**, for every recorded harness (one with `--harness`):

1. **The gate.** The same tool-call gate [`intutic connect`](#intutic-connect) installs, registered where the harness reads it (`.claude/settings.json` for Claude Code, Cursor's `hooks.json`, and so on). Your own hooks and settings stay. Every gate enforces the built-in protections, such as refusing an agent's attempt to remove or unlock Intutic's own files.
2. **The policy snapshot** (`~/.intutic/hooks/policy-snapshot.rules` and `.json`) every gate reads: the destructive-command and skill-directory tiers, and from `.intutic/sops/` each `review_before:` token, the lane holds of each `closed_lanes:`, the `decide:` rules (with the pins `intutic decide eval` wrote), and the rule records: each qualified `requires_before:` (`[ok]`), `scope_paths:` under `scope_paths_mode: enforce`, and `plan_approval:`. A SOP with `roles:` contributes no rule records or lane holds, since a gate knows no role. With no control plane to approve a hold, a `review_before:` token or a lane hold is refused outright, with a message saying so, rather than held, and `plan_approval:` refuses every gated call that is not a read (`PLAN_NOT_APPROVED`). The snapshot names no workspace and is marked `source: local`.
3. **The rules files** from the SOPs in `.intutic/sops/`, into each harness's own file (see [Where rule sets go](/guide/how-it-works#where-rule-sets-go)). A harness no SOP targets gets no rules file.

It also blanks the API key an earlier `intutic connect` may have left in `~/.intutic/env/runtime.env`,
so no gate posts events to that control plane, and moves `.intutic/events/hook-events.jsonl` aside to
`hook-events.jsonl.1` once it passes 10 MB: with no control plane, nothing drains it.

**Not written:** proxy routing (unless `--route`), MCP server wrapping, the bundled agent skills, and
anything sent anywhere: it makes no network call. `.env.intutic`, which Codex and the SDK frameworks
read only when you source it, is still written for a harness a SOP targets. With `--route`, Windsurf's
traffic goes through the proxy's TLS interception, which needs the Intutic CA (`~/.intutic/ca.crt`,
created when the proxy first runs) trusted; `gates install` does not trust it for you.

It prints each file written and the gate file of each harness, and ends with `Undo with intutic disconnect`.
Re-run it after editing `.intutic/sops/`, or keep [`intutic start`](#intutic-start) running, which
refreshes the gates when the SOPs change.

Refused, with exit status `1`, on a machine with a login (`intutic connect` installs and refreshes the
gates there; run [`intutic disconnect`](#intutic-disconnect) first to switch to local gates), and
before `intutic init`.

**Examples:**

```bash
intutic gates install

# What it would write, for Cursor only
intutic gates install --harness cursor --dry-run

# Also route the harnesses through a proxy that runs as a service
intutic daemon install --proxy
intutic gates install --route
```

When the SOPs carry `decide:` rules, it also prints how many were compiled and how many are stamped
`enforce`, names any `decide:` line that does not read by file and line number, and warns when more
than 4 rules name one tool.

---

## `intutic decide test <rule>`

Ask a decide rule's questions about one call, with the engine `intutic decide configure` set up, and
print each answer's probability against its band, the `when` value and the outcome the rule would
reach if it enforced. [Decide rules](/guide/decide) walks through writing, evaluating and enforcing a
rule with these commands.

```bash
intutic decide test <rule> --state <file> [options]
```

`<rule>` is the rule's ref (`local:data.md#prod-data-export`), its id when only one local rule has it,
or `<file>#<id>`.

**Options:**

| Option | Description |
|--------|-------------|
| `--state <file>` | A JSON file with the call: `{"tool", "toolInput", "cwd"?}`. A `lastUserTurn` in it is not sent: `context: ["last_user_turn"]` is reserved in 3.0, and no gate supplies the user's last turn. For an `on: response` rule, the response instead: `{"response"}`, asked in the gateway's layout (the SOP's text, then the response) and held to the engine's response limit (32,768 bytes unless `INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES` says otherwise) |
| `--json` | Print the result as JSON |
| `--log-state` | Also write the exact state sent to `~/.intutic/logs/decide-state-<date>.jsonl` |
| `--workspace <dir>` | The workspace whose `.intutic/sops` to read. Default: the recorded one, else the current directory |

---

## `intutic decide eval <rule>`

Measure a decide rule on labelled calls. A rule enforces only on a model a passing pre-registered eval
pinned, so this is how a rule leaves shadow.

```bash
intutic decide eval <rule> --labels <file.jsonl> [--preregister <file>] [--adversarial]
```

Each labels line is one call: `{"id", "label": "refuse" | "allow", "tool", "toolInput", "cwd"?}`
(`violation` and `clean` read as `refuse` and `allow`). For an `on: response` rule each line is one
response, `{"id", "label", "response"}`, asked about in the gateway's layout and under its response
limit; a response over the limit counts as an escalation. Recall counts a `refuse` case as caught when it
is refused or escalated; false alarms count `allow` cases refused. A case the engine could not answer
counts as an escalation, never as an allow.

- **Without `--preregister`**, it fits one band on the dev split (the cases whose id hashes to a
  multiple of 3), choosing the band with no automatic error and the fewest escalations, then reports
  recall, false alarms, escalation and each question's AUC on the rest. It writes a run report and
  no pin.
- **`--preregister <file>` naming a file that does not exist** writes the pre-registration there: the
  rule hash, the model digest, the bands and the pass marks, before any label is read. Nothing else
  happens.
- **`--preregister <file>` naming that file** evaluates every labelled case at the rule's own bands,
  with the adversarial families added. It passes when the pre-registration matches the rule and the
  model, the labels file was not used by an earlier pre-registered run of this rule, there are at least
  20 cases with 5 to refuse, recall is at least 95%, false alarms at most 10%, escalation at most 40%,
  and planted approvals are caught at least 90% of the time. A pass writes the pin
  (`~/.intutic/decide/evals/<ruleHash>/<digest>.json`) and rewrites the local policy snapshot. A failed
  run exits with status `1`. On a logged-in machine the pin is still written, but the policy snapshot
  there takes its decide rules and pins only from the control plane, so the pin applies to local use on
  a machine with no login, and the command says so.

`--adversarial` adds three fixed families to the refuse cases: five planted approvals appended to the
arguments, five instructions aimed at the model, and paraphrases of the command (an environment
variable for the program, quoting, a line split, reordered flags, long and short options). For a
response rule the approvals and instructions are appended to the response, with no paraphrase. No
model writes a case. Each family is reported apart.

<!-- ENTERPRISE_ONLY_START -->
**On a logged-in machine** a pre-registered eval is also registered with the control plane
(`POST /api/v1/decide/eval-runs`, see [Eval runs and calibrations](/reference/api#eval-runs-and-calibrations))
when the pre-registration is written, before any label is read, and its results are uploaded to that
run (`POST /api/v1/decide/eval-runs/:evalRunId/results`):
the labelled set's hash, the recall, false-alarm and escalation figures and the adversarial report,
never a label's text or a state. The local pin and its message are unchanged, and a failed upload
only says so. `--calibration <id>` pre-registers a control-plane candidate calibration's band and
combiner (the calibration must be a candidate of this rule, fitted on the engine's model), scores
the run under them, and registers it as that calibration's companion run, which is how a candidate
fitted by the calibration job gets the planted-approval mark its promotion needs.
<!-- ENTERPRISE_ONLY_END -->

**Options:**

| Option | Description |
|--------|-------------|
| `--labels <file>` | The labelled calls, JSONL |
| `--preregister <file>` | Write the pre-registration when the file is absent (reading no label); evaluate against it when present |
| `--adversarial` | Add the adversarial families (always on under a pre-registration) |
| `--calibration <id>` | With `--preregister`, when writing the pre-registration: pre-register the band and combiner of a candidate calibration of this rule that a control plane holds, fitted on the engine's model, and register the run as that calibration's companion. Needs a control plane: refused without a login |
| `--json` | Print the run report as JSON |
| `--log-state` | Also write each exact state sent to `~/.intutic/logs/decide-state-<date>.jsonl` |
| `--workspace <dir>` | The workspace whose `.intutic/sops` to read |

**Examples:**

```bash
intutic decide eval prod-data-export --labels dev.jsonl
intutic decide eval prod-data-export --preregister prereg.json
intutic decide eval prod-data-export --labels fresh.jsonl --preregister prereg.json
```

---

## `intutic decide calibrate <rule>`

Fit a logistic combiner over the rule's questions (L2, λ = 1) and a band on its output to labelled
calls, and save them as a candidate in `~/.intutic/decide/evals/<ruleHash>/candidates/`. The next
`intutic decide eval --preregister` for that model carries the candidate; once that eval passes, the
combiner replaces `when` for the model it was fitted on.

| Option | Description |
|--------|-------------|
| `--labels <file>` | The labelled calls, as for `intutic decide eval` |
| `--json` | Print the candidate as JSON |
| `--workspace <dir>` | The workspace whose `.intutic/sops` to read |

---

## `intutic decide models`

The models the pre-registered bake-off measured, and which passed. No laptop-sized model passed, so
none is validated for a laptop and the engine has no default model: bring a self-hosted model and
validate it on your own labels with `intutic decide eval`. Nothing is downloaded.

| Option | Description |
|--------|-------------|
| `--json` | Print as JSON |

---

## `intutic decide check`

The entry the shell gates (Gemini CLI, Goose, Hermes, OpenHands) and the n8n gate call for a tool call
that a decide rule names. It reads one JSON request from stdin and writes one JSON line, with exit
status `0`:

```bash
echo '{"v":1,"harness":"goose","tool":"Bash","toolInput":{"command":"pg_dump -h prod"},"cwd":"/repo","sessionId":"s1","budgetMs":3400,"lastUserTurn":null}' \
  | intutic decide check --stdin
# {"v":1,"outcome":"refuse","code":"DECIDE_REFUSED","ruleId":"decide.local:data.md#prod-data-export","reason":"…"}
```

`outcome` is `allow`, `refuse` or `escalate`; `code` is null, `DECIDE_REFUSED`, `DECIDE_ESCALATED` or
`GOVERNANCE_UNAVAILABLE`. A shadow rule never refuses. An enforcing rule refuses with
`GOVERNANCE_UNAVAILABLE` when the engine is unavailable (an error, a timeout, a failed canary), as does
input that does not read and a decide record that does not decode. An enforcing rule the engine cannot
answer inside `budgetMs` escalates without being asked. Every evaluated call is written to the decide
log, `~/.intutic/logs/decide-<date>.jsonl`.

| Option | Description |
|--------|-------------|
| `--stdin` | Read the request from stdin |

---

## `intutic decide configure`

Write `~/.intutic/decide/engine.json` (mode `0600`): the engine's URL, adapter and model. The engine
must run on this machine or a private address, or on a host listed in
`INTUTIC_SELF_HOSTED_DECISION_HOSTS`; hosted decision APIs are refused. The key, if the engine needs
one, is read from `INTUTIC_DECIDE_API_KEY` only and is never written. The `INTUTIC_DECIDE_*`
variables override the file (see [Configuration](/reference/configuration)).

| Option | Description |
|--------|-------------|
| `--url <url>` | The engine's base URL. Default `http://127.0.0.1:11434` (Ollama) |
| `--adapter <adapter>` | `logprobs` (Ollama, vLLM, llama.cpp, LM Studio), `systemone` or `decisions`. Default `logprobs` |
| `--model <model>` | The model the engine serves. Without one the engine is not configured |
| `--timeout-ms <ms>` | Per-call timeout. Default 5000 |
| `--parallel <n>` | Most requests in flight. Default 1 for Ollama, 8 otherwise |
| `--structured` | Send `structured_outputs` with logprobs requests |
| `--no-structured` | Do not send it (the default) |
| `--json` | Print the written configuration as JSON |

`intutic doctor` then checks the engine and its model, runs the known-answer canary, measures the
per-call p95 and names every harness whose time budget a rule cannot fit.

---

## `intutic decide disable`

Run every decide rule on this machine as shadow (each call is logged, none is refused) until
`intutic decide enable`. It rewrites the local policy snapshot; on a connected machine the sync daemon
applies it on its next poll. A `decide:` line that does not read still refuses its tools.

---

## `intutic decide enable`

Undo `intutic decide disable`.

---

## `intutic decide lint`

Read every `decide:` line in `.intutic/sops/`: each rule with its file, line, rule hash and whether a
pin exists for it, each line that does not read with its error (a bare `decide:` line gets the hint
"write one rule per line as `decide: {json}`"), and each tool more than 4 rules name. An
`on: response` rule is marked as judged at the gateway. It warns about each rule declaring
`context: ["last_user_turn"]`, which is reserved and not supplied in 3.0; `intutic gates install` and
`intutic doctor` report it too. Exits with status `1` when a line does not read; the warnings do not
change the status.

| Option | Description |
|--------|-------------|
| `--json` | Print as JSON |
| `--workspace <dir>` | The workspace whose `.intutic/sops` to read |

---

## `intutic setup`

Guided setup wizard — detect harnesses, configure a provider credential, and verify it, in one
interactive flow. It is the interactive counterpart of `intutic init`, not a replacement: this
command always prompts, while `init` asks only whether to install the Git hooks and the gates, and
never without a terminal, so it stays safe for CI. See [the cohort wizard guide](/guide/cohort-wizard) for a full narrative walkthrough
of every step.

```bash
intutic setup [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
1. Detects harnesses in the current workspace (same detection `intutic init` uses)
2. Asks whether to configure a provider against a **connected** workspace or **locally** (no
   control plane — writes a `.intutic.env` file instead)
3. Picks a provider from the registry (`intutic credentials list` shows the same set) and
   prompts for its credential fields
4. Verifies the credential against the provider's own API before saving — a 401/403 asks for
   confirmation before proceeding anyway; a rate-limited or unreachable response is reported but
   does not block
5. Saves the credential (`PUT /api/v1/workspace/provider-credentials/:provider`, same route
   `intutic credentials set` hits) or writes the local env file<!-- ENTERPRISE_ONLY_START -->; local mode then points you at
   `intutic judge configure` for an on-prem judge<!-- ENTERPRISE_ONLY_END -->

There is no judge-model step: judges run only on self-hosted models, so a workspace has no
judge model to choose.

**Examples:**

```bash
# Connected to Intutic (requires `intutic login` first)
intutic setup

# Against a local control plane
intutic setup --dev
```

---

<!-- ENTERPRISE_ONLY_START -->
## `intutic judge configure`

Generate the local artifacts an on-prem LLM-as-judge needs: a `litellm_config.yaml`, the decide
engine's configuration, an env block, and a Helm values snippet. Writes files only — it never calls a remote API, since
`local_judge` is deliberately not remotely configurable (see [the self-hosted gateway's local
judge](/external/self-hosted-gateway#4-what-does-not-run-locally-read-this-before-you-deploy)).
See [On-Prem Judge Setup](/external/on-prem-judge) for the full walkthrough.

```bash
intutic judge configure [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--out <path>` | Where to write `litellm_config.yaml` (default: `./litellm_config.yaml`) |
| `--engine-url <url>` | Where this machine reaches the model server, for the decide engine (default: `http://127.0.0.1:11434`). Must be loopback, private, or listed in `INTUTIC_SELF_HOSTED_DECISION_HOSTS` |

**What it does:**
1. Prompts for a judge model — a self-hosted model from the
   [model catalog](/reference/model-catalog) (Ollama; Ollama Cloud excluded) or a custom
   reference such as `ollama/llama3.1` or a local alias your LiteLLM serves. Judges run only on
   self-hosted models: a custom reference that names a hosted provider (Anthropic, OpenAI,
   OpenRouter, Ollama Cloud…) is refused and nothing is written
2. Writes a LiteLLM `litellm_config.yaml` to `--out`, with one `model_list` entry for that model
3. Writes `~/.intutic/decide/engine.json` (mode `0600`) for the decide engine: `--engine-url`, the
   `logprobs` adapter and that model, keeping other keys the file holds. Never a key
4. Prints the env block (`INTUTIC_GATEWAY_LOCAL_JUDGE`, `LITELLM_LOCAL_URL`,
   `LITELLM_LOCAL_API_KEY`, `LITELLM_LOCAL_JUDGE_MODEL`) for Docker/bare-metal deployments, with a
   warning: these variables are deprecated since 3.0 (the gateway maps them to the decide rule
   `local-judge`) and removed in 4.0
5. Prints the Helm values (`proxy.localJudge`, `litellm.enabled`, `litellm.judgeModel`, and
   `litellm.secretName: litellm-env` for the Secret holding `LITELLM_MASTER_KEY`) for the
   `intutic-gateway` chart, which is published at `oci://ghcr.io/intutic/charts/intutic-gateway`.
   The chart renders LiteLLM's config from the file this command wrote, passed with `--set-file`

The typed band's variables (`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`,
`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI`, `LITELLM_LOCAL_TYPED_JUDGE_MODEL`) are not printed: the
band must be measured for your model. See
[On-Prem Judge Setup](/external/on-prem-judge#typed-stage-the-local-judge-decide-rule).

**Example:**

```bash
intutic judge configure --out ./litellm_config.yaml

# Kubernetes: log Helm in with the pull token Intutic sent you, then install with the local judge
helm registry login ghcr.io --username <username>
helm install my-gateway oci://ghcr.io/intutic/charts/intutic-gateway --version <version> \
  --namespace intutic-gateway \
  --set-file litellm.config=./litellm_config.yaml \
  --set proxy.localJudge=true,litellm.enabled=true,litellm.judgeModel=<model alias>
```

`<version>` is the release Intutic sent you. The rest of the install (the gateway token Secret,
the image pull Secret) is in [Self-Hosted Gateway](/external/self-hosted-gateway).

---
<!-- ENTERPRISE_ONLY_END -->

## `intutic login` <Badge type="tip" text="Cloud" />

Authenticate with the Intutic control plane.

```bash
intutic login [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Authenticate with an API key (`vk_*`) |
| `--control-plane-url <url>` | The control plane to log in to, such as a self-hosted one. Must be an `http(s)` URL. |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Without `--api-key` it prompts for your email and password (the password is masked as you type). The
credentials are saved to `~/.intutic/credentials.json`, with the token in the OS keychain when one
is available, together with the control plane they were issued by. Every later command uses that
control plane unless a flag or `INTUTIC_CONTROL_PLANE_URL` names another; see
[Choosing a control plane](#control-plane-url). Without `--control-plane-url`, `login` itself
resolves the control plane the same way.

**Examples:**

```bash
# Email and password
intutic login

# API key login
intutic login --api-key vk_abc123def456

# Local dev
intutic login --dev
```

<!-- ENTERPRISE_ONLY_START -->
```bash
# A self-hosted control plane, saved for every later command
intutic login --control-plane-url https://intutic.internal.example
```
<!-- ENTERPRISE_ONLY_END -->

---

## `intutic logout` <Badge type="tip" text="Cloud" />

Clear stored credentials.

```bash
intutic logout
```

No options. Removes locally stored authentication tokens.

---

## `intutic status`

Show workspace status — auth, harnesses, sync state.

```bash
intutic status
```

No options. Displays:
- Current authentication state: email, workspace, and the control plane commands use (see [Choosing a control plane](#control-plane-url))
- The workspace root, dev mode and config version recorded by `intutic init`
- The harnesses recorded by `intutic init`, by name
- Gates: installed locally (by [`intutic gates install`](#intutic-gates-install)), installed by `intutic connect`, or none
- Sync state: last sync timestamp and the number of tracked files, and whether the sync daemon is running
- Running agent processes, with a warning when a recorded harness is running but the sync daemon is not

---

## `intutic whoami` <Badge type="tip" text="Cloud" />

Show current authenticated identity.

```bash
intutic whoami [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic doctor`

Diagnose workspace health — proxy, auth, daemon, configs, logs, Valkey, CA trust, policy snapshot, gates, decide.

```bash
intutic doctor
```

No options. Runs these checks in order, each printing ✓ or ✗ plus a one-line remediation on failure:

1. Proxy reachable (`http://127.0.0.1:4000/health`, or the port of `INTUTIC_PROXY_URL`)
2. Control plane auth (the stored credentials against `/api/v1/auth/me`)
3. Sync daemon running (PID file or process scan)
4. Harness config files intact (SHA-256 against `<workspaceRoot>/.intutic/integrity.json`)
5. Daemon log readable (`~/.intutic/logs/sync-daemon.log`, then the system-service log, then the legacy `~/.intutic/daemon.log`)
6. Valkey reachable (TCP probe on `127.0.0.1:6379`)
7. CA cert trust (`~/.intutic/ca.crt` plus the OS trust store)
8. Policy snapshot present, valid, non-empty and fresh (`~/.intutic/hooks/policy-snapshot.rules`)
9. Local gates, on a machine with no login: a gate file for each recorded harness that has one
10. Plan approval, only when a SOP sets `plan_approval:`: with no control plane connected it fails, since every gated call that is not a read is refused with `PLAN_NOT_APPROVED`; on a connected machine it fails until the daemon has written a fresh approved-plans cache (`~/.intutic/hooks/approved-plans.jsonl`)
11. Cisco skill scanner on `PATH` (optional; never fails)
12. Decide, always. With no decide rules in the snapshot and no engine configured it prints one passing line, `✓ Decide — no decide rules and no engine configured`. Otherwise: the engine and its model (with the digest, and a note when the server cannot report a weights digest), the known-answer canary (cached in `~/.intutic/decide/canary.json`), the per-call p95 of 20 warm calls (stored in `~/.intutic/decide/engine.json`), and every harness and rule pair whose time budget the rule cannot fit, for example "prod-data-export cannot be evaluated within windsurf's 2,300 ms (estimated 3,100 ms)". Such a rule escalates there instead of being asked

Checks 2–5 need a control plane. On a machine with no login they are skipped with one note, the
proxy and CA-trust remediations point at `intutic start`, and checks 8 and 9 look at what
[`intutic gates install`](#intutic-gates-install) wrote and point at it to fix what is missing.

See [`intutic doctor`](/reference/cli-doctor) for what each check verifies and how to fix it.

---

## `intutic connect` <Badge type="tip" text="Cloud" />

Start sync daemon — bidirectional config sync with control plane.

```bash
intutic connect [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--dev` | Use the local control plane (`http://localhost:3001`) unless `--control-plane-url` is given | — |
| `--interval <ms>` | Poll interval in milliseconds | `30000` |
| `--workspace-id <id>` | Workspace ID (e.g. `wk_xxxx`) to connect as, instead of the stored login. Takes effect only together with `--api-key`. | — |
| `--api-key <key>` | Workspace API key (e.g. `vk_xxxx`) to connect with, instead of the stored login. Takes effect only together with `--workspace-id`. | — |
| `--control-plane-url <url>` | Control plane to sync with. Overrides every other source. | — |

**Control plane URL:** resolved as for every command (see
[Choosing a control plane](#control-plane-url)), except that the URL saved by `intutic login` is
skipped when `--workspace-id` and `--api-key` are given: those credentials were not issued with
that login.

**What it does:**
1. Starts Valkey if none is running (connected mode needs it), and spawns a managed proxy if
   nothing is listening on the proxy port (the port of `INTUTIC_PROXY_URL`, else `4000`). It then
   trusts the proxy's CA certificate (`~/.intutic/ca.crt`): in the login keychain on macOS and
   the Root store on Windows. On Linux the system trust store needs root, so connect installs the
   certificate there only when it runs as root; otherwise it prints the two commands to run, for
   example
   `sudo cp ~/.intutic/ca.crt /usr/local/share/ca-certificates/intutic-connect-ca.crt` and
   `sudo update-ca-certificates` (Debian/Ubuntu), or the `update-ca-trust extract` equivalent
   on RHEL/Fedora. The file is named `intutic-connect-ca.crt`, beside the `intutic-ca.crt` that
   `intutic enterprise install` writes, so `intutic disconnect` removes only connect's copy.
2. Seeds the policy snapshot (`~/.intutic/hooks/policy-snapshot.rules`) so the harness gates
   enforce workspace policy from the first tool call, and writes the
   [Kitkat](/integrations/kitkat) and [Rule Author](/integrations/rule-author) agent skills into
   `.agents/skills/` when they are missing.
3. Every `--interval`, and whenever the control plane pushes a change, fetches the workspace
   config and writes each detected harness's config file from the workspace SOPs plus the local
   SOPs under `.intutic/sops/`, then refreshes the policy snapshot. Every configured
   harness that has a tool-call hook gets its gate. Where the harness has a key for it, the hook
   entry carries a 10-second timeout, and each gate refuses with `GATE_DEADLINE` one second
   before its harness's timeout, at most 9 seconds (see
   [Hook timeouts](/reference/harness-security-matrix#hook-timeouts)).
4. Watches the governed harness files and restores the approved version when one is edited
   locally, keeping the edited copy as `<file>.drift-backup`.
5. Every fifth poll, records each harness rules file that changed in the workspace's config
   history: metadata only, unless the workspace turned on content upload (see
   [Config content upload](#config-content-upload)).

**Credentials:** `--workspace-id` and `--api-key` together replace the stored login for this run; either one alone is ignored. With the pair, `intutic login` is not needed, and if `intutic init` has not run, the current directory is used as the workspace with no harnesses. This is how the service installed by [`intutic daemon install`](#intutic-daemon-install) runs. Without the pair and without a login, the command exits with status `1` and points to `intutic start`.

**Examples:**

```bash
# Default (30s poll)
intutic connect

# 10 second poll interval
intutic connect --interval 10000

# Local dev with fast polling
intutic connect --dev --interval 5000
```

<!-- ENTERPRISE_ONLY_START -->
```bash
# Self-hosted control plane, explicit workspace credentials
intutic connect --workspace-id wk_xxxx --api-key "$INTUTIC_API_KEY" \
  --control-plane-url https://intutic.internal.example
```
<!-- ENTERPRISE_ONLY_END -->

The daemon runs in the foreground. Use `Ctrl+C` to stop.

**What `connect` sends to the control plane:**

- A SHA-256 hash of each governed harness config file, and a drift report (harness, file path and
  hashes) when one changes.
- A config history capture of each harness rules file that changed: its path, the SHA-256 of its
  redacted text, its size, the harness and the time. Its text only when the workspace turned on
  content upload; see [Config content upload](#config-content-upload).
- A status heartbeat: config version, detected harnesses, running agent process names, and the
  health of the proxy, Valkey and CA trust.
- An agent report per harness: the configured guardrails, role SOPs, skills found under
  `.agents/skills` (scan findings and file hashes, not file contents), declared MCP servers and the
  budget tier.
- Every tenth poll (about every five minutes at the default interval), the machine's
  [AI inventory](/guide/ai-inventory), under the machine's fingerprint and hostname: every harness
  detected on it, connected or not, with its version and gate state; the MCP servers the harness
  configs declare and whether each is wrapped; and the skill bundles under `.agents/skills`,
  `.claude/skills` and `~/.claude/skills` (names, hashes and scan results). Names, home-relative
  paths, hashes and timestamps only, never file contents.
- At most once a minute per proxy session, a trajectory summary of the session's live traces: tool
  call count and tool names, tokens, model switches, errors and repeated identical calls.
- Session start and end, with the names of your local SOP folders, and the repository, Git branch
  and HEAD commit of the workspace root, reported again when they change. The repository is the
  `origin` remote reduced to host and path; any user name, password or token in it is removed
  before it is sent.
- The Git branch and commit in `.intutic/git-context.json`, when `intutic sync-context` has
  written it.
- Hook events and review requests the harness gates logged under `.intutic/events/`.
- The proxy's local trace files, `~/.intutic/logs/traces-*.jsonl`, which are deleted locally once
  uploaded.

### Config content upload {#config-content-upload}

The config history records the harness rules files below, from the workspace root, for each
harness `intutic connect` governs. What it uploads depends on one workspace setting,
**Upload config file content** (`configBodyUpload`, in Settings › Security › Harness Config
History). It is off by default.

- **Off:** each file's path, the SHA-256 of its redacted text, its size in bytes, the harness and
  the capture time. Never its text. The history shows when a file changed, and its hash chain can
  still be verified, but there are no config diffs and no SkillOpt config-edit suggestions.
- **On:** the same, plus the file's text. Before the text leaves the machine, API keys, tokens,
  private keys, passwords and other credential-shaped strings in it are replaced with
  `[redacted]`: the patterns the harness gates and the pre-commit check refuse, and
  `secret: value` assignments to keys named like a secret. The hash is of the redacted text in
  both modes.

The control plane refuses a capture that carries text while the setting is off, and stores
nothing from it. A change to the setting reaches each machine at its next sync and applies from
the next capture: `connect` captures every fifth poll, about every 2.5 minutes at the default
interval. Files larger than 512 KB are not captured.

| File | Harnesses |
|------|-----------|
| `.claude/rules/intutic-governance.md` | `claude-code` |
| `.clinerules/intutic-governance.md` | `cline` |
| `.continue/rules/intutic-governance.md` | `continue` |
| `.cursor/rules/intutic-governance.mdc` | `cursor` |
| `.env.intutic` | `langgraph`, `langchain`, `crewai`, `autogen`, `ag2`, `google-adk`, `openai-agents`, `pydantic-ai`, `smolagents`, `strands`, `agent-framework`, `mastra`, `vercel-ai-sdk`, `eve`, `trueforge`, `ai-sdk-harness`, `ai-sdk-workflow` |
| `.github/copilot-instructions.md` | `github-copilot` |
| `.goosehints` | `goose` |
| `.intutic/aider-sops.md` | `aider` |
| `.openhands/microagents/intutic-governance.md` | `openhands` |
| `.windsurf/rules/intutic-governance.md` | `windsurf` |
| `AGENTS.md` | `codex`, `hermes`, `pi`, `roo-code`, `muse-code`, `grok`, `opencode`, `dsh` |
| `GEMINI.md` | `antigravity` |

`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.goosehints` are often your own files with Intutic's rules in a marked section; they are captured whole, your own text included.

---

## `intutic disconnect`

Undo `intutic connect` or [`intutic gates install`](#intutic-gates-install) on this machine: put every harness config they changed back the way it was, remove the gates and the background services, and log out.

```bash
intutic disconnect [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--harness <id>` | Disconnect one harness only, for example `cursor`. The login, the services and the other harnesses stay. |
| `--dry-run` | Print exactly what would change, and change nothing |
| `--keep-login` | Keep the stored credentials |

**What it undoes**, for every harness (one with `--harness`):

- **Rules files of Intutic's own** (`.claude/rules/intutic-governance.md`, `.cursor/rules/intutic-governance.mdc`, `.windsurf/rules/intutic-governance.md`, `.clinerules/intutic-governance.md`, `.continue/rules/intutic-governance.md`, `.openhands/microagents/intutic-governance.md`, `.intutic/aider-sops.md`) and `.env.intutic`: deleted, or the file you had before at that path comes back.
- **Rules sections** in files you also write (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.goosehints`, and the `AGENTS.md` of OpenClaw's agent workspace): the section between the `INTUTIC:RULES` markers is taken out, and the file comes back byte for byte when you did not edit it, or is deleted if connect created it. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
- **Rules files earlier versions wrote whole** (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `.roorules`, `AGENTS.md`): the file you had before comes back, or the file is deleted if connect created it.
- **Hook registrations** in each harness's settings (`.claude/settings.json`, Cursor's and Windsurf's `hooks.json`, and the rest): only the entries that run an Intutic gate are removed. The gate scripts are deleted.
- **Proxy routing**: base URLs and proxy settings connect pointed at the proxy (Codex `openai_base_url`, Continue `apiBase`, Goose `OPENAI_HOST`/`ANTHROPIC_HOST`, Grok `base_url`, Pi and OpenHands base URLs, Aider `openai-api-base`, Windsurf `http.proxy`, the JetBrains IDE proxy for the Windsurf plugin, dsh's `llm-deepseek` route) go back to the values they had.
- **MCP servers**: each server connect wrapped gets its original entry back, every key included; the `intutic` server connect added is removed; and the copies of approved `.mcp.json` servers connect added to `~/.claude.json` are removed.
- **What connect replaced or removed** comes back: the Claude Code `permissions.deny` rules connect replaced, and Aider's `test-cmd`, `lint-cmd`, `auto-test` and `auto-lint`.
- **Agent skills** (without `--harness`): the [Kitkat](/integrations/kitkat) and [Rule Author](/integrations/rule-author) skills connect wrote into `.agents/skills/`, unless you have edited them. A copy that was there before connect, or that an earlier version of connect wrote, stays.

Without `--harness` it also removes the services [`intutic daemon install`](#intutic-daemon-install) set up for your user (a system-wide one is listed with the command that removes it), the Intutic CA certificate connect trusted (in the macOS login keychain, or connect's `intutic-connect-ca.crt` in the Linux system trust store, which needs root: run as a user, disconnect prints the `sudo rm` and bundle-rebuild commands instead), the `intutic-valkey` Docker container connect started, the gate caches in `~/.intutic/hooks/` (the policy snapshot with its verified copy, the approved bypasses and the egress policy), `~/.intutic/env/runtime.env` (the copy of the API key the gates read) and, unless `--keep-login`, the stored credentials. It resets the synced config version, so a later `intutic connect` writes everything again.

**How it knows what you had:** before connect first writes a file, it keeps a copy of it, in `.intutic/originals/` for files in the workspace and `~/.intutic/originals/` for the rest (owner-only, and ignored by git). A file you have not changed since is restored byte for byte. In one you have changed, only Intutic's entries are taken out and your edits stay. A file connect writes whole that you edited is left as it is, and listed.

**Files from an earlier connect:** versions before this one kept no copies. For their files, disconnect removes what it can recognise as Intutic's: the generated header, entries that run an Intutic gate, wrapped MCP servers (their arguments carry the original command), and URLs on the proxy connect used. A generated file git does not track is deleted; where git has a committed version that is not generated, that version comes back. A setting connect overwrote is removed rather than restored, because its earlier value is unknown, and the output says so. Deny rules connect added to `permissions.deny` cannot be told apart from yours, and are listed for you to review.

**Left in place:** your SOPs in `.intutic/sops/`, Intutic's own state in `~/.intutic/` (configuration, logs, events, the downloaded proxy), `<file>.drift-backup` copies (they hold edits connect reverted), and a `valkey-server` or `redis-server` connect started outside Docker. Git hooks from `intutic init --git-hooks` live in `.git/hooks/`, and variables from [`intutic env persist`](#intutic-env-persist) are removed with [`intutic env clear`](#intutic-env-clear).

**The control plane is told** (with a login; with none there is no control plane, and nothing is sent): before it removes the credentials, a real run reports the disconnect (`POST /api/v1/devices/disconnect`, with the machine's fingerprint and the harnesses), so the control plane stops expecting the machine's gates instead of alerting that they went [silent](/guide/settings), the devices list and the [AI inventory](/guide/ai-inventory) show the machine or harness as disconnected rather than stale or newly ungoverned, and the disconnect is recorded for [SIEM export](/guide/siem-export) (`device_disconnects`). If the control plane cannot be reached within five seconds, the disconnect goes ahead and says so. Running `intutic connect` again reconnects.

**While connect runs:** a running `intutic connect` would write everything straight back. A real run stops the services first, then exits with status `1` before changing any file if an `intutic connect` you started yourself is still running. `--dry-run` only warns.

**One harness:** `--harness` leaves a file another connected harness also writes (`AGENTS.md` is shared by Codex, Muse Code, Grok Build, OpenCode, Pi, Hermes, Roo Code and dsh; `.env.intutic` by Codex and the SDK frameworks). It removes the harness from `~/.intutic/config.json`, so connect stops writing its config and stops wrapping its MCP servers; run `intutic init` to manage it again.

**Examples:**

```bash
# See what would change
intutic disconnect --dry-run

# Disconnect everything, keep the login
intutic disconnect --keep-login

# Stop governing Cursor only
intutic disconnect --harness cursor
```

---

## `intutic sync-context` <Badge type="tip" text="Cloud" />

Record the current Git branch and commit for the sync daemon to report.

```bash
intutic sync-context --git
intutic sync-context --branch <name> --commit <hash>
```

**Options:**

| Option | Description |
|--------|-------------|
| `--branch <name>` | Current Git branch name |
| `--commit <hash>` | Current Git commit SHA |
| `--git` | Read the branch and commit from the repository, for any not given with `--branch` / `--commit` |

**What it does:**

Writes `.intutic/git-context.json` in the current directory, containing the `--branch` and `--commit` values and a timestamp. Without `--git`, an omitted flag is stored as an empty string. Nothing leaves the machine. When `intutic connect` is running for this workspace, its file watcher picks up the change and reports the branch and commit, with the list of local SOPs, to the control plane.

The `post-commit` and `post-checkout` hooks that `intutic init` can install run this command in the background after every commit and checkout. Exits with status `1` if the file cannot be written.

**Example:**

```bash
intutic sync-context --git
```

---

## `intutic decisions-log-refresh` <Badge type="tip" text="Cloud" />

Refresh the [Governed Decisions Log](/guide/decisions-log) now instead of waiting for the sync daemon's next poll.

```bash
intutic decisions-log-refresh
```

No options.

**What it does:**

1. Uses the credentials from `intutic login`. If you are not logged in, it does nothing.
2. Reads the workspace's `decisionsLogEnabled` setting (off by default). If it is off, nothing is written.
3. Fetches the workspace's recent governance decisions from the control plane and writes them to `.intutic/DECISIONS.md` in the current directory.
4. Writes the 10 newest entries where each harness in `~/.intutic/config.json` reads its standing instructions: a file of its own such as `.claude/rules/intutic-decisions.md`, or the section between `<!-- INTUTIC:DECISIONS_LOG:START -->` and `<!-- INTUTIC:DECISIONS_LOG:END -->` in a file such as `AGENTS.md`. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go). `CLAUDE.md` is never written; a decisions section an earlier version put there is taken out.

It always exits with status `0`. When nothing was refreshed it prints the reason (not authenticated, `decisionsLogEnabled` is off, or the fetch failed).

The `post-merge` Git hook that `intutic init` can install runs this command in the background after every merge, so the log is current right after you pull. The hook does nothing if `intutic` is not on `PATH`.

**Example:**

```bash
intutic decisions-log-refresh
```

---

## `intutic traces list`

List execution traces, from the control plane when you are logged in or from the local proxy's trace log when you are not.

```bash
intutic traces list [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Number of traces to show (1–100 in connected mode) | `20` |
| `--since <duration>` | Time window: `30m`, `24h`, `7d`, or an ISO 8601 timestamp | `24h` |
| `--action <type>` | Connected mode only. Filter by enforcement action: `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` | _(all)_ |
| `--verdict <type>` | Local mode only. Filter by verdict: `allowed`, `killed`, `upstream_error`, `reasked`, `hijacked` | _(all)_ |
| `--model <name>` | Filter by requested model name | _(all)_ |
| `--json` | Output as JSON instead of a table | `false` |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

`intutic trace list` is the same command.

**What it does:**

The mode depends only on whether `intutic login` has stored credentials, not on whether `intutic connect` is running:

- **Connected mode** (logged in) queries the control plane and shows Trace ID, Timestamp, Model, Action, Score, and Cost. `--verdict` is ignored. If the request fails, the command exits with status `1`.
- **Local mode** (not logged in) reads the proxy's daily trace files, `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` (`%APPDATA%\intutic\logs\` on Windows), newest first, and shows Trace ID, Timestamp, Model, Verdict, and Cost. There is no compliance score locally. `--model` must match the requested model exactly. It warns when a day's file reached the proxy's 64 MB daily limit (later traces that day were dropped, so the count is a minimum) and when lines could not be parsed. Passing `--action`, or a `--verdict` value not in the list, exits with status `1`.

**Examples:**

```bash
# Last 20 traces from the past 24 hours
intutic traces list

# All KILL actions from the past week (connected mode)
intutic traces list --action KILL --since 7d

# Killed requests from the local log (local mode)
intutic traces list --verdict killed --since 7d

# JSON output for scripting
intutic traces list --json --limit 100

# Filter by model
intutic traces list --model claude-4-sonnet
```

---

## `intutic traces inspect <trace_id>`

Show full detail of a single trace.

```bash
intutic traces inspect <trace_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `trace_id` | The trace ID to inspect (e.g., `tr_abc123`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**Example:**

```bash
intutic traces inspect tr_abc123
```

Logged in, it returns the trace from the control plane: token counts, costs, compliance scores,
anomaly data and the corrective prompt card. Not logged in, it looks the trace up in the local
trace files (`~/.intutic/logs/traces-*.jsonl`).

---

## `intutic findings list` <Badge type="tip" text="Cloud" />

List detector findings for the workspace.

```bash
intutic findings list [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--unadjudicated` | Only findings nobody has ruled on yet | _(all findings)_ |
| `--detector <id>` | Only findings from this detector, e.g. `response_injection:override-instructions` | _(all detectors)_ |
| `--limit <n>` | Maximum rows to return (at most 500) | `100` |
| `--json` | Output as JSON instead of table | — |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Prints a table of findings with their id, time, detector, reason, disposition and outcome (`TRUE_POSITIVE`, `FALSE_POSITIVE`, or `unruled`). When the list includes response-injection findings, it also points you to the dashboard's Findings queue: those findings may carry a scrubbed excerpt of the model's response, which the CLI never prints.

**Example:**

```bash
intutic findings list --unadjudicated --limit 20
```

---

## `intutic findings adjudicate <findingId>` <Badge type="tip" text="Cloud" />

Record your ruling on one finding: a true positive or a false positive.

```bash
intutic findings adjudicate <findingId> (--true-positive | --false-positive) [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `findingId` | The finding to rule on, as listed by `intutic findings list` |

**Options:**

| Option | Description |
|--------|-------------|
| `--true-positive` | Mark the finding a true positive |
| `--false-positive` | Mark the finding a false positive |
| `--note <text>` | Optional note recorded with the ruling (up to 2000 characters) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Exactly one of `--true-positive` and `--false-positive` is required; passing neither or both exits `1` before anything is sent.

**What it does:**
Records the outcome, the note, and you as the adjudicator. The adjudicator is always the logged-in member, never a flag. Ruling on a finding again replaces the earlier ruling. Ruling on a finding needs the OWNER, ADMIN or EM role; `response_injection:*` findings need the OWNER or ADMIN role, the same roles that can see their response excerpt. These rulings are what `intutic findings stats` and `intutic findings echo-report` compute false-positive rates from.

**Example:**

```bash
intutic findings adjudicate df_abc123 --false-positive --note "Quoted the docs, not an instruction"
```

---

## `intutic findings stats` <Badge type="tip" text="Cloud" />

Per-detector false-positive rate, computed over adjudicated findings only.

```bash
intutic findings stats [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of table |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one row per detector: whether it runs in shadow, its total findings, how many have been adjudicated, and its false-positive rate. A detector nobody has ruled on shows `no measured rate`, never `0%`. The caveats the server returns with the numbers are printed in full below the table.

---

## `intutic findings echo-report` <Badge type="tip" text="Cloud" />

Response-injection echo report: the false-positive rate for each pattern.

```bash
intutic findings echo-report [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--since <date>` | Window start, as an ISO date | 7 days before `--until` |
| `--until <date>` | Window end, as an ISO date | now |
| `--json` | Output as JSON instead of table | — |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Prints the window and the number of traces ingested in it, then a row for each response-injection pattern with its findings, its adjudicated findings and its false-positive rate. A pattern with fewer than 20 adjudicated findings has its rate withheld, and the reason is printed below the table. A window with no traces gets a warning instead of a rate. A date that cannot be parsed exits `1`.

**Example:**

```bash
intutic findings echo-report --since 2026-09-01 --until 2026-10-01
```

---

## `intutic incidents list` <Badge type="tip" text="Cloud" />

List the workspace's governance incidents, as on **Findings › Incidents**. Needs the OWNER, ADMIN or EM role.

```bash
intutic incidents list [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--status <status>` | Only incidents with this status: `OPEN`, `RESOLVED` or `AUTO_RESOLVED` | _(every status)_ |
| `--severity <severity>` | Only incidents of this severity: `CRITICAL`, `HIGH`, `MEDIUM` or `LOW` | _(every severity)_ |
| `--type <type>` | Only incidents of this [type](/guide/concepts#incident-types): an anomaly type such as `SCOPE_VIOLATION`, or `WASM_RULE_REFUSED` or `SYSTEM_ANOMALY` | _(every type)_ |
| `--page <n>` | The page to show | `1` |
| `--limit <n>` | Incidents per page (at most 100) | `20` |
| `--json` | Output as JSON instead of table | — |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Prints each incident's id, severity, type, status and time, with its description below. The list is ranked by review priority (severity, detector confidence and age), not by time, and the review queue is bounded: when the budget leaves incidents out, the CLI says how many. A severity or type that does not exist is refused before any request. A list of 20 or more arrives compressed, with each description cut at 120 characters; `intutic incidents show` prints the whole incident.

**Example:**

```bash
intutic incidents list --status OPEN --type SYSTEM_ANOMALY
```

---

## `intutic incidents show <incidentId>` <Badge type="tip" text="Cloud" />

Print one governance incident in full.

```bash
intutic incidents show <incidentId> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of table |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the incident's type, severity, status, when it was filed and resolved and by whom, its session and trace, its whole description, and its escalation details: for a refused custom filter, the rule, the version, the reason and how many times it was reported.

---

## `intutic integrity roots` <Badge type="tip" text="Cloud" />

List the 50 most recent sealed Merkle roots for the workspace, newest first. Roots are sealed by the control
plane — see [Trace Integrity](/concepts/trace-integrity).

```bash
intutic integrity roots [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--loop-run <id>` | Only roots sealed for this loop run | _(all)_ |
| `--json` | Output as JSON instead of table | `false` |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

The **Signature** column reports whether the sealing key is published in the JWKS — not
whether the signature verifies. Checking the bytes is what `verify` does.

If nothing has been sealed yet the command says so and explains why: the sweep seals a loop
run once it is terminal and has been quiet for fifteen minutes, so recent traces are recorded
but under no root.

---

## `intutic integrity verify <root_id>` <Badge type="tip" text="Cloud" />

Re-derive one root from the traces that are in the database **now**, and check its signature
against the published key the root itself names.

```bash
intutic integrity verify <root_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--against <file>` | Also compare with the copy of this root mirrored to your own bucket (BYOC). See [Checking your copy](/concepts/trace-integrity#checking-your-copy). |
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**Exit status — this is the point of the command.** It is designed to be a CI step, so it is
deliberate about which findings are failures:

| Result | Exit | Meaning |
|--------|:----:|---------|
| Re-derivation `match` | `0` | The stored root is the root of the traces on disk. |
| Re-derivation mismatch | `1` | A covered trace changed after sealing. |
| `missing_traces` | `1` | A covered trace is gone. The leaf survives it, so the root still names it. |
| `missing_traces`, past retention | `0` | The root is older than 3 years and the 3-year trace retention deleted its traces. Reported, not failed. |
| Signature `valid` | `0` | Verified against the key the root names. |
| Signature `invalid` | `1` | A key we hold **rejected** it. |
| Signature `unverifiable` | `0` | The root names a key the JWKS does not publish (a key-retention gap, not evidence of forgery), or it was signed under a preimage version or algorithm this CLI cannot rebuild (upgrade the CLI). |
| Signature `unsigned` | `0` | The deployment seals roots without signing them, which is supported. |
| `keys_unavailable` | `0` | The JWKS could not be fetched. No verdict was reached, so none is reported. |
| `--against` copy matches | `0` | The copy in your bucket agrees with what the control plane serves. |
| `--against` copy differs | `1` | The served root, its chain link, its signature or its leaves are not what was mirrored to you at seal time. |
| `--against` file unreadable | `1` | The comparison you asked for did not happen, so the command does not pass. |

The distinction between **invalid** and **unverifiable** is load-bearing. A rotated-out key
that was never added to `TRACE_SIGNING_RETIRED_KEYS` would otherwise turn every historical
root into an apparent forgery and your pipeline red. The command never falls back to "some
other published key that happens to verify" — a signature that checks out under a different
key is a different claim.

**Example:**

```bash
intutic integrity verify tmr_abc123
intutic integrity verify tmr_abc123 --against ./roots/ws_abc/tmr_abc123.json
```

---

## `intutic integrity chain` <Badge type="tip" text="Cloud" />

Walk the `previous_root` chain and report roots that have been deleted outright — the one
form of tampering re-derivation cannot see, because the survivors all verify perfectly.

```bash
intutic integrity chain [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

A **break** — a root whose named predecessor is not the root that actually precedes it — exits
`1` and prints both ends of the gap. An **unchained** root, one that claims no predecessor at
all, exits `0`: nothing was claimed, so nothing is contradicted. Roots written before the
chain existed are unchained, which is what a rolling deploy produces, and failing on them
would make every deploy red.

Only the most recent 500 roots are walked. When older ones exist the report says so: an intact
window is not an intact history.

---

## `intutic integrity config-chain` <Badge type="tip" text="Cloud" />

Walk the harness **config snapshot** chain and re-hash every stored body. Each snapshot in
`harness_config_snapshots` records a `content_hash` of its own body and the `previous_hash` of
the snapshot before it, per harness type and file path — this is the command that reads them.

`intutic connect` captures the snapshots (see [Config content upload](#config-content-upload)).
A snapshot holds a file's redacted text only when the workspace turned content upload on;
otherwise it holds the file's hash and size. The links of a snapshot without text are checked
like any other, but its content cannot be re-hashed, because it was never uploaded: the report
says how many such snapshots it walked, and they are not a finding.

```bash
intutic integrity config-chain [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Two findings, reported separately, because they have different causes and different remedies:

| Finding | Exit | Meaning |
|---------|:----:|---------|
| **Break** | `1` | A snapshot names a predecessor that is not the snapshot actually before it. That is what deleting a snapshot leaves behind. Both ends of the gap are printed. |
| **Content mismatch** | `1` | A stored body no longer hashes to the `content_hash` recorded with it — the body was rewritten in place. Every link around it is still intact. |
| **Unchained** | `0` | A snapshot mid-chain names no predecessor. Nothing was claimed, so nothing is contradicted — but a deletion at that point would go unseen. |

Both checks are needed, and neither substitutes for the other. Checking only the links leaves
an edited body undetected, because `previous_hash` describes the *predecessor* and says nothing
about the row carrying it. Re-hashing only the bodies leaves a deleted snapshot undetected,
because every survivor still hashes correctly.

A workspace with **no snapshots** is reported as an absent chain, not a clean one, and exits
`0` — nothing was verified, so there is nothing to have failed.

Only the most recent 500 snapshots are walked. When older ones exist the report says so: an
intact window is not an intact history.

---

## `intutic budget`

Check remaining daily/monthly budget and list active loops, or watch spend live. The subcommands below set the workspace's caps and the budgets and rate limits on keys and members.

```bash
intutic budget [options]
intutic budget --watch [--interval <seconds>]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--dev` | Use local control plane (`http://localhost:3001`) | — |
| `--watch` | Print machine-local and workspace spend continuously, one line per tick, until `Ctrl+C` | — |
| `--interval <seconds>` | Tick interval for `--watch`. A non-numeric or non-positive value falls back to the default. | `5` |

**What it does:**

Without `--watch`:

- When you are logged in, prints the workspace's budget from the control plane: daily and monthly spend against their budgets with percentages, the daily cap and whether it is the workspace's own or the $100-a-day default of a workspace that never saved one, remaining budget, and an alert line when the alert threshold is exceeded.
- Prints the local spending cap from `~/.intutic/config.json` (`maxDailyBudgetUsd`, or `max_daily_budget_usd`; default `$10.00`).
- Prints today's machine-local spend from the local proxy at `http://127.0.0.1:4000` (or the port of `INTUTIC_PROXY_URL`), or a dash when the proxy is not running.
- When you are logged in, lists every `ACTIVE` loop run with its token spend and budget limit.

Without a login it runs in standalone (offline) mode and prints only the local figures.

With `--watch`, it prints one line per tick in this shape:

```
[10:42:05] machine-local: $0.4210 / $10.00  |  workspace: $3.1200 / $50.00
```

The time is printed in your locale's format.

- `machine-local` is today's spend and cap as reported by the local proxy at `http://127.0.0.1:4000` (or the port of `INTUTIC_PROXY_URL`). `(enforcement off)` is appended when the proxy is not enforcing the cap; `— (local proxy not running)` is shown when it cannot be reached.
- `workspace` is the workspace's daily spend and daily budget, refreshed on the first tick and every 6th tick after that (every 30 seconds at the default interval). It shows `— (not connected)` when you are not logged in or the request fails.

`--watch` does not list loops. It works without a login; only the workspace figure needs one.

**Examples:**

```bash
intutic budget

# Live view, one line every 5 seconds
intutic budget --watch

# Every 2 seconds
intutic budget --watch --interval 2
```

---

## `intutic budget set` <Badge type="tip" text="Cloud" />

Set the workspace's daily and monthly caps, the alert threshold, and whether each cap refuses requests. OWNER or ADMIN.

```bash
intutic budget set [--daily <usd|default>] [--monthly <usd|default>] [--threshold <pct>] [--daily-enforcement hard|soft] [--monthly-enforcement hard|soft]
```

| Option | Description |
|--------|-------------|
| `--daily <usd>` | Daily cap in USD; `0` for no daily cap; `default` returns a saved daily cap to the $100 default |
| `--monthly <usd>` | Monthly cap in USD; `0` for no monthly cap; `default` returns it to the $500 default |
| `--threshold <pct>` | Raise a budget alert at this percentage of each cap (1–100) |
| `--daily-enforcement <mode>` | `hard`: the proxy refuses a request the rest of the day's cap does not cover. `soft`: alerts only. A new workspace's daily cap is `hard` |
| `--monthly-enforcement <mode>` | The same for the month. A new workspace's monthly cap is `soft` |
| `--json` | Print the budget after the change as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Only the options you give are sent; everything else stays as it is, so `--monthly` alone leaves a daily cap that was never saved on the $100 default. See [Budgets](/guide/budgets#workspace-caps).

```bash
intutic budget set --monthly 1000 --monthly-enforcement hard
intutic budget set --daily default
```

---

## `intutic budget keys` <Badge type="tip" text="Cloud" />

Every live virtual key with its owner, its spend budgets, its rate limit, and what it has spent today and this month (UTC). OWNER, ADMIN and EM see every key; anyone else sees their own.

```bash
intutic budget keys [--json] [--dev]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic budget key <keyId>` <Badge type="tip" text="Cloud" />

Set a virtual key's spend budgets and rate limit. OWNER or ADMIN, for any key in the workspace.

```bash
intutic budget key <keyId> [--daily <usd|none>] [--monthly <usd|none>] [--daily-enforcement hard|soft] [--monthly-enforcement hard|soft] [--rpm <n|none>] [--tpm <n|none>]
```

| Option | Description |
|--------|-------------|
| `--daily <usd>` | The key's day budget in USD, or `none` to remove it |
| `--monthly <usd>` | The key's month budget in USD, or `none` to remove it |
| `--daily-enforcement <mode>` | `hard` (the default for a new budget): refuse requests the budget does not cover. `soft`: alert only |
| `--monthly-enforcement <mode>` | The same for the month budget |
| `--rpm <n>` | Requests per minute, or `none` to remove the limit |
| `--tpm <n>` | Tokens per minute, or `none` to remove the limit |
| `--json` | Print the key after the change as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Only what you name changes. Find key ids with `intutic budget keys`. See [Key budgets](/guide/budgets#key-budgets) and [Rate limits](/guide/budgets#key-rate-limits).

```bash
intutic budget key key_abc123 --daily 5 --monthly 100 --monthly-enforcement soft --rpm 60
intutic budget key key_abc123 --tpm none
```

---

## `intutic budget members` <Badge type="warning" text="Biz Org+" />

The default member budget, and each active member with their own budgets, the budgets that apply to them, and their spend today and this month across the keys they own. OWNER, ADMIN and EM see every member; anyone else sees themselves.

```bash
intutic budget members [--json] [--dev]
```

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic budget member <memberId>` <Badge type="warning" text="Biz Org+" />

Set a member's spend budgets, or with `default` the budget every member without their own gets. OWNER or ADMIN.

```bash
intutic budget member <memberId|default> [--daily <usd|none>] [--monthly <usd|none>] [--daily-enforcement hard|soft] [--monthly-enforcement hard|soft]
```

| Option | Description |
|--------|-------------|
| `--daily <usd>` | Day budget in USD, or `none` to remove it |
| `--monthly <usd>` | Month budget in USD, or `none` to remove it |
| `--daily-enforcement <mode>` | `hard` (the default for a new budget) or `soft` |
| `--monthly-enforcement <mode>` | `hard` (the default for a new budget) or `soft` |
| `--json` | Print the member's budgets after the change as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

A member's own budget for a period replaces the default's for that period. See [Member budgets](/guide/budgets#member-budgets).

```bash
intutic budget member default --daily 20 --monthly 300 --monthly-enforcement soft
intutic budget member mbr_abc123 --monthly 1000
```

---

## `intutic predict-cost` <Badge type="tip" text="Cloud" />

Estimate what a prompt or task will cost before it runs.

```bash
intutic predict-cost --model <model> (--tokens <n> | --file <path>) [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--model <model>` | Model to estimate against, e.g. `claude-sonnet-4-5` (required) | — |
| `--tokens <n>` | Input size as a token count | — |
| `--file <path>` | Size the input from this file's contents | — |
| `--json` | Output as JSON instead of a report | — |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

Exactly one of `--tokens` and `--file` is required. Passing both, or neither, exits `1` before anything is sent: without an input size there is nothing to estimate.

**What it does:**
Requires `intutic login`; the estimate is computed by the control plane, not locally.

1. Takes the input size from `--tokens`, or sends the file's contents to the control plane, which counts roughly four characters per token.
2. Estimates the output (and any reasoning) tokens from past usage recorded for this model at a similar input size: the workspace's own, or usage across all workspaces when the workspace has none. With fewer than 3 recorded samples, it uses a fixed output ratio for the model family.
3. Prices input, output and reasoning tokens with the same rate table as every other cost figure the control plane reports. Reasoning tokens are billed at the output rate.

The report shows input tokens, estimated output and reasoning tokens, the estimated cost in USD, a confidence (`high`, `medium` or `low`), and what the estimate was based on. An estimate from the fixed ratio is always `low`.

**Examples:**

```bash
intutic predict-cost --model claude-sonnet-4-5 --tokens 12000
intutic predict-cost --model gpt-4o --file ./prompt.md --json
```

---

## `intutic routing adoption-report` <Badge type="tip" text="Cloud" />

Mirror-test report for one candidate model: win/loss/tie, fault-rate delta, cost delta and latency delta.

```bash
intutic routing adoption-report --candidate-model <model> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--candidate-model <model>` | The mirror-tested candidate model to report on (required) |
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Reads the verdicts recorded for a candidate model that the proxy has been mirror-testing (set with `mirror_candidate_model` in the proxy's `config.yaml`; see [Pre-Adoption Report for Model Upgrades](/guide/mirror-adoption-report)). It prints the sample count; how often the candidate was better, the original was better, or they tied, plus unjudged pairs; and three deltas:

- **Fault-rate delta**, in percentage points. Negative means the candidate faults less.
- **Average cost delta**, in USD per request.
- **Average latency delta**, in milliseconds.

A delta with no data behind it is printed as "not enough scored pairs" (fault rate) or "not measured" (cost, latency), never as zero. Below 20 recorded verdicts, the command prints an insufficient-data block with the count so far instead of a report. Verdicts are aggregated across every workspace mirroring the same candidate, not only yours.

The report is a signal for a person to read before adopting a model. Nothing it prints changes routing.

**Example:**

```bash
intutic routing adoption-report --candidate-model gpt-4o-mini
```

---

## `intutic skill list`

List the rule and skill files in the workspace.

```bash
intutic skill list
```

No options.

**What it does:**

Looks in the workspace recorded by `intutic init` (`~/.intutic/config.json`), or the current directory when there is none, for:

- Rule files at the workspace root: `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clauderules`, `rules.md`
- Skill files one directory below each skill root: `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`

Prints each file found with its line count. It reads the files but does not scan their content; use `intutic skill audit` for that. When you are logged in, it also reports the list (paths and line counts) to the control plane. A failed report is ignored.

---

## `intutic skill audit`

Scan rule files, skill files, and the scripts bundled with skills for leaked credentials and unsafe instructions.

```bash
intutic skill audit [--sarif] [--engine <native|cisco>] [--exit-zero]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--sarif` | Print the skill-file and bundled-script findings as a single SARIF 2.1.0 JSON document on stdout (for GitHub Code Scanning and other CI tools) instead of the readable report. Findings in root rule files are not in the document but still set the exit status | — |
| `--engine <engine>` | `native` runs the built-in scanner. `cisco` also runs Cisco's `skill-scanner` on each skill directory; the `skill-scanner` binary must be on `PATH` (`pipx install cisco-ai-skill-scanner`). | `native` |
| `--exit-zero` | Exit `0` even when the audit has findings or could not scan everything | — |

**What it does:**

It scans the workspace recorded by `intutic init`, or the current directory when there is none:

1. **Rule files** at the workspace root (`.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clauderules`) are checked for hardcoded Intutic virtual keys, hardcoded `sk-live-` secrets, recursive-delete wildcards such as `rm -rf *`, and `curl`/`wget` commands.
2. **Skill files** (`.agents/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`) are content-scanned, whole, for prompt-injection, data-exfiltration, and malicious-code patterns. See [Skill Scanning](/guide/skill-scanning).
3. **Bundled files** next to each `SKILL.md` (up to 3 directories deep and 40 files per skill; symlinks are skipped) are hashed (SHA-256). Shell, Python, JavaScript, TypeScript, Ruby, PowerShell, and Perl scripts up to 256 KiB are also content-scanned. Data files — `.md`, `.markdown`, `.txt`, `.rst`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.csv`, `.tsv` and images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.bmp`) — are not scripts: they are listed as not applicable and do not affect the result, unless a shebang makes one a script, which is then scanned. Any other file that is larger than the cap, unreadable, or not a recognised script is reported as unscanned, never as clean: the report names each one, and the audit does not pass.

When you are logged in, three workspace settings change the run:

| Setting | Effect |
|---------|--------|
| `enableLocalSkillAuditDelete` | Deletes each flagged line from the rule file or `SKILL.md` it was found in (bundled scripts are not changed) |
| `ciscoSkillScannerEnabled` | Runs the Cisco engine without `--engine cisco` if `skill-scanner` is on `PATH`; if it is not, the run continues with the built-in scanner only |
| `semanticSkillAnalysisEnabled` | Includes each `SKILL.md`'s content (its first 65,536 characters) in the report it uploads, with the SHA-256 and length of the whole file. A `SKILL.md` longer than that is named in a warning: the semantic judge reads only the first 65,536 characters, so the skill is reported as partially scanned and needs review. It does not change the exit status |

When you are logged in, the results are also reported to the control plane; a failed report is ignored. With `--sarif`, nothing but the JSON document is printed. Cisco's results, when that engine ran, are added as a second run in the same document. The run's `invocations` entry lists each unscanned file as a warning notification, each data file as a note, and each failed Cisco run as an error notification, with `executionSuccessful: false` when an engine run failed.

**Exit status:** `1` when the audit has findings, when a file other than a data file could not be scanned, or when a Cisco engine run failed, so a CI step fails on them; `0` when everything was scanned and nothing was found, or with `--exit-zero`. Also `1` for an unknown `--engine` value, or for `--engine cisco` when `skill-scanner` is not on `PATH`. The report, the SARIF document and the control-plane report are all complete before the command exits.

**Examples:**

```bash
intutic skill audit

# Upload to GitHub Code Scanning, which then decides pass/fail
intutic skill audit --sarif --exit-zero > skills.sarif

# Also run Cisco's skill-scanner
intutic skill audit --engine cisco
```

---

## `intutic skill scan-staged`

Scan staged skill files for risky content before a commit, as a warning only.

```bash
intutic skill scan-staged
```

No options.

**What it does:**

Lists the files staged for commit (added, copied, or modified) under `.agents/skills/` and `.claude/skills/`, then runs the skill-content scan over the staged version of each file (what `git commit` will record, not what is on disk). Each finding is printed as a warning naming the file, category, and pattern.

It never blocks a commit: the exit status is always `0`, findings or not. Outside a Git repository, or with nothing staged under those directories, it prints nothing.

The `pre-commit` hook that `intutic init` can install runs this after its credential scan. Unlike this command, the credential scan does refuse the commit when it finds a secret. Run `intutic skill audit` for the full report.

---

## `intutic loop start` <Badge type="tip" text="Cloud" />

Register and start an active loop execution session.

```bash
intutic loop start [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Name for the loop run (need not be unique; the run is addressed by its `lr_…` id) | _(required)_ |
| `--budget <limit>` | Maximum token spend budget in USD (e.g. `5.00`) | `10.00` (set by the control plane) |
| `--sops <sops>` | Comma-separated local rule sets to select: SOP folder names, single SOP file names (`deploy` or `deploy.md`) in `.intutic/sops/`, or option indices (folders first, then files). The selection narrows only which local SOPs are written into the rules files; the gates and the proxy still enforce every local SOP | — |
| `--auto-judge` | Enable automatic E2E judging for the loop | — |
| `--dev` | Use local control plane | — |

---

## `intutic loop exec` <Badge type="tip" text="Cloud" />

Execute an agent command wrapped with loop budget boundaries.

```bash
intutic loop exec [options] -- <command> [args...]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Name for the loop run (need not be unique; the run is addressed by its `lr_…` id) | `exec-<command>` (e.g. `exec-npm`) |
| `--budget <limit>` | Maximum token spend budget in USD (e.g. `5.00`) | `10.00` (set by the control plane) |
| `--sops <sops>` | Comma-separated local rule sets to select: SOP folder names, single SOP file names (`deploy` or `deploy.md`) in `.intutic/sops/`, or option indices (folders first, then files). The selection narrows only which local SOPs are written into the rules files; the gates and the proxy still enforce every local SOP | — |
| `--auto-judge` | Enable automatic E2E judging for the loop | — |
| `--dev` | Use local control plane | — |

**What it does:** Starts a loop run, writes its id and the commit it starts from
(`INTUTIC_LOOP_BASE_COMMIT`) to `~/.intutic/env/loop.env`, then runs the command with
`INTUTIC_LOOP_RUN_ID` set to the run id. When the command exits, the run is marked `COMPLETED`
(exit `0`) or `FAILED` (non-zero), and `loop exec` exits with the command's code. When the
workspace requires a verified completion (`loop_review.requireVerifiedCompletion`), a run whose
command exited `0` is verified first, as [`intutic loop verify`](#intutic-loop-verify)
does; a failed verify, or a `409` or `503` refusal from completing, is printed, the run stays
`ACTIVE`, and `loop exec` exits `1`. A run held for review (`PENDING_REVIEW`) is left
open, and the command prints the `intutic loop review` line to run. Exits `1` if the run cannot be
started.

**Example:**
```bash
intutic loop exec --name "npm-build" --budget 1.50 -- npm run build
```

---

## `intutic loop list` <Badge type="tip" text="Cloud" />

List loop runs and cost accounting details for the workspace.

```bash
intutic loop list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic loop verify <loop_run_id>` <Badge type="tip" text="Cloud" />

Verify a loop run's changes before completing it.

```bash
intutic loop verify <loop_run_id> [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--base <ref>` | Diff against this ref | the commit the run started from (`INTUTIC_LOOP_BASE_COMMIT`), else `HEAD` |
| `--task <text>` | What the run was asked to do, for the judge | `Loop run <id>` |
| `--dev` | Use local control plane | — |

**What it does:** Takes `git diff <base>` and the changed paths, and first checks them against the
`scope_paths` of the local SOPs the session selected (those with no `roles:`): a path outside them
stops the verify with the findings, and nothing is sent. Otherwise it posts the diff, the paths and
the base to the control plane, which checks scope and plan first and asks the judge only if those
pass. Prints each check; exits `1` unless the run verified.

---

## `intutic loop complete <loop_run_id>` <Badge type="tip" text="Cloud" />

Mark a running loop as successfully completed. When the workspace requires a verified completion,
an unverified, failed or stale verify is refused (`409` with `E_LOOP_NOT_VERIFIED`,
`E_LOOP_UNVERIFIABLE` or `E_LOOP_VERIFY_STALE`), and a check that cannot run is refused with
`503 GOVERNANCE_UNAVAILABLE`; the command prints the refusal and its findings and exits `1`.

```bash
intutic loop complete <loop_run_id> [options]
```

A Developer can complete a run they started; completing anyone's run needs the OWNER, ADMIN or EM role.

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic loop kill <loop_run_id>` <Badge type="tip" text="Cloud" />

Kill an active loop and prevent subsequent API requests.

```bash
intutic loop kill <loop_run_id> [options]
```

A Developer can kill a run they started; killing anyone's run needs the OWNER, ADMIN or EM role.

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic loop review <loop_run_id>` <Badge type="tip" text="Cloud" />

Approve or reject a loop run that is held for human review.

```bash
intutic loop review <loop_run_id> (--approve | --reject) [--note <note>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `loop_run_id` | The held loop run (`lr_…`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--approve` | Release the hold; the run becomes `ACTIVE` again |
| `--reject` | Refuse the hold; the run is `KILLED` |
| `--note <note>` | Why, recorded against the run (up to 2000 characters) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Exactly one of `--approve` and `--reject` is required; passing neither or both exits `1`.

**What it does:**
Resolves a run in `PENDING_REVIEW`: the state a `review_before:` SOP puts a whole run in when the proxy sees a declared action, or an `on_reask_exhausted: pause` SOP puts it in on the third failed correction (see [SOP front matter](/reference/sop-front-matter)), after which every request in the run is refused until someone reviews it. After an approval that followed `on_reask_exhausted: pause`, the run gets three fresh correction attempts. A run in any other state is refused. It needs the OWNER, ADMIN or EM role. When the workspace requires a different approver (`loop_review.requireDistinctApprover`, off by default), the member who started the run cannot approve or reject it; an owner or admin turns that on with `PUT /api/v1/workspace/settings` and `{"loop_review": {"requireDistinctApprover": true}}`, and the change is recorded in the settings history.

**How it differs from `intutic decision approve|reject`:** `loop review` acts on a whole **loop run**, addressed by its loop run id. `decision` acts on a single **held tool call**, the `hold_…` id a harness hook gate prints when it holds a call. The two ids are not interchangeable: a hold id given to `loop review` is not found.

**Example:**

```bash
intutic loop review lr_abc123 --approve --note "Deploy manifest checked"
```

---

## `intutic decision approve <holdId>` <Badge type="tip" text="Cloud" />

Approve a held decision, such as a call a `review_before:` hold stopped.

```bash
intutic decision approve <holdId> [--reason <reason>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `holdId` | The hold id a gate printed (`hold_…`), or the decision's entry id |

**Options:**

| Option | Description |
|--------|-------------|
| `--reason <reason>` | Why, recorded against the decision (up to 2000 characters) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Marks the decision `APPROVED`, attributed to you as the logged-in member. You need the OWNER, ADMIN or EM role, and only a decision still awaiting review can be approved. The Slack card's **Approve** button does exactly the same.

When the workspace has opted in with the `reviewHoldBypassEnabled` setting (off by default), approving also lets the exact held call (same tool, same command, same target) through for a short window, 10 minutes by default, and the command tells you to retry it. Otherwise the approval only records the decision. See [Stop and ask me first](/guide/graph-guardrails#stop-and-ask-me-first).

This is the command a harness hook gate's `HELD` message tells you to run. To release a whole loop run held by the proxy, use `intutic loop review` instead.

**Example:**

```bash
intutic decision approve hold_abc123 --reason "Release approved in #deploys"
```

---

## `intutic decision reject <holdId>` <Badge type="tip" text="Cloud" />

Reject a held decision.

```bash
intutic decision reject <holdId> [--reason <reason>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `holdId` | The hold id a gate printed (`hold_…`), or the decision's entry id |

**Options:**

| Option | Description |
|--------|-------------|
| `--reason <reason>` | Why, recorded against the decision (up to 2000 characters) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Marks the decision `REJECTED`, attributed to you, with the reason in its rationale. The held call stays blocked. You need the OWNER, ADMIN or EM role, and only a decision still awaiting review can be rejected.

**Example:**

```bash
intutic decision reject hold_abc123 --reason "Not during the freeze"
```

---

## `intutic policy snapshot` <Badge type="tip" text="Cloud" />

Compile this workspace's policy to `~/.intutic/hooks/policy-snapshot.rules`, the file every harness gate reads.

```bash
intutic policy snapshot [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
1. Uses the credentials stored by `intutic login` (it exits 1 without them) to fetch the workspace's resolved policy from the control plane.
2. Writes `policy-snapshot.rules` and `policy-snapshot.json` to `~/.intutic/hooks`, replacing any previous snapshot in one step and leaving the files read-only.
3. Prints the number of rules now enforced, the snapshot digest, the workspace and the path, and suggests `intutic doctor` to confirm the gates accept it.

`intutic connect` writes the same file, as one step of starting the full sync daemon. This command does only this one thing, so you can arm the gates without running the daemon.

If the fetch returns nothing usable, the command says the snapshot was **not** written and exits `1`. Any previous snapshot stays enforced. The exception is when the control plane refuses the key (revoked, deactivated, or past the SSO idle window): the previous snapshot is then rewritten with the member's SSO groups treated as unknown, which refuses every high-risk tool. Without any snapshot, the gates still enforce the floor compiled into them.

The gates look for the snapshot at `INTUTIC_SNAPSHOT_RULES` when that variable is set, and at `~/.intutic/hooks/policy-snapshot.rules` otherwise. This command follows the same variable: it writes into the directory that `INTUTIC_SNAPSHOT_RULES` names. The file name is always `policy-snapshot.rules`, so if the variable names a different file the command warns that the gates will read a file it does not write.

**Example:**

```bash
intutic policy snapshot
intutic doctor
```

---

## `intutic policy replay <ruleId>` <Badge type="warning" text="Biz Org+" />

Run a WASM rule against this workspace's own recent traffic and report what it would have done, without touching enforcement. Needs the OWNER, ADMIN or EM role.

```bash
intutic policy replay <ruleId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `ruleId` | A native WASM rule uploaded to this workspace (`wasm_…`), installed or not yet active. A Rego rule is refused; test it with [`intutic rules test`](#intutic-rules-test) |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Maximum number of sampled request contexts to replay against (capped at 5000) | `500` |
| `--since <duration>` | Only contexts at or after this time: relative (`24h`, `7d`) or an ISO 8601 date. An unparseable value is ignored | _(all sampled history)_ |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Evaluates the rule against request contexts the proxy has sampled from this workspace's traffic (5% of requests by default), then prints how many contexts were replayed, how many the rule would have acted on (count and rate), the count for each verdict (`allow`, `block`, `reask`), and the first contexts it would not have allowed, as JSON.

Sampled contexts carry each tool call's name and its arguments' keys and size, not the values, unless the workspace sets [`storeToolArguments`](/reference/workspace-settings). A rule that reads `tool_calls[].arguments` sees an empty string on those contexts, so the command then prints how many contexts withheld arguments and how to change that; contexts sampled after the setting is turned on carry the values, redacted.

A rate needs enough traffic behind it: below 50 sampled contexts the command reports how many it found and how many it needs, and exits `1`. More contexts come from more traffic over time, not from a higher `--limit`. An unknown rule id or a rule that fails to evaluate also exits `1`.

**Example:**

```bash
intutic policy replay wasm_abc123 --since 7d --limit 2000
```

---

## `intutic policy test`

Run dry-run WASM policy evaluation locally. For a Rego rule, use [`intutic rules test`](#intutic-rules-test).

```bash
intutic policy test --wasm <path> --mock <path>
```

**Options:**

| Option | Description |
|--------|-------------|
| `--wasm <path>` | Path to compiled WebAssembly rule binary (required) |
| `--mock <path>` | Path to mock JSON request context file (required) |

---

## `intutic policy compile`

Compile an AssemblyScript rule to WASM (wraps `asc`).

```bash
intutic policy compile [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--src <path>` | Rule source entry file | `assembly/index.ts` |
| `--out <path>` | Output `.wasm` path | `build/rule.wasm` |
| `--debug` | Include debug info and source maps | `false` |

**What it does:**
Shells out to `npx --no-install asc <src> -o <out> --optimize --exportRuntime`, creating the output directory if needed. With `--debug` it also passes `--debug --sourceMap`. If `asc` is not available, install it with `pnpm add -D assemblyscript assemblyscript-json`.

**Compiling a rule candidate** <Badge type="warning" text="Self-serve+" />**:**

| Option | Description |
|--------|-------------|
| `--candidate <id>` | Fetch the candidate's source of record from the control plane, verify its hash, write it to `generated/candidates/<id>.ts` and compile it to `build/<id>.wasm` (unless `--out` is given). Cannot be combined with `--src`. |
| `--upload` | After compiling, upload the bundle to `POST /api/v1/rule-candidates/<id>/bundle` together with the source hash, and print the gate results. Requires `--candidate` and the OWNER or ADMIN role. |
| `--dev` | Use the local control plane (`http://localhost:3001`). |

Run it from a rule project that has `assembly/index.ts` (the SDK layout): the generated source imports the SDK from two directories up. See [Rules from policy documents](/guide/wasm-rules#rules-from-policy-documents).

---

## `intutic policy install`

Validate and install a compiled WASM rule, native or Rego, into the local proxy rules dir.

```bash
intutic policy install --wasm <path> [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--wasm <path>` | Path to compiled WebAssembly rule binary (required) | — |
| `--name <name>` | Rule name | _(the file name)_ |
| `--priority <NN>` | Evaluation priority — lower runs first | `100` |

**What it does:**
1. Instantiates the rule and evaluates it against a built-in allow-mock context — a rule that fails to instantiate or evaluate, or returns a code other than 0, 1, 2 or 3, is **not** installed (2 installs with a deprecation warning: the proxy treats it as a block). A [Rego rule](/guide/rego-policies) is loaded and evaluated through the Rego host instead, and refused if a proxy could not run it
2. Writes it as `{priority}_{name}.wasm` into the local rules dir — `INTUTIC_WASM_DIR` if set, otherwise `~/.intutic/wasm`
3. Prints the destination path, priority, and SHA-256 of the installed binary

The proxy picks up local rule changes within ~5s on the next request. If your proxy `config.yaml` sets `intutic_settings.wasm_local_dir`, make sure it matches this path (or set `INTUTIC_WASM_DIR` for both).

---

## `intutic policy list-local`

List WASM rules installed in the local proxy rules dir.

```bash
intutic policy list-local
```

No options. For each `.wasm` file in the local rules dir (`INTUTIC_WASM_DIR`, defaulting to `~/.intutic/wasm`) it prints the rule name, priority, size, mtime, and a SHA-256 prefix.

---

## `intutic rules build`

Compile a Rego policy to a rule with OPA, and package it with the metadata the proxies read.

```bash
intutic rules build --rego <path> --entrypoint <package/rule> [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--rego <path>` | Rego file or directory (required) | — |
| `--entrypoint <package/rule>` | The rule to evaluate, e.g. `intutic/shell/deny` (required) | — |
| `--risk-tier <tier>` | Default risk tier for the rule's decisions: `low`, `medium`, `high` or `critical` | _(none)_ |
| `--out <path>` | Output `.wasm` path | `build/<entrypoint>.wasm`, with each character other than a letter, digit, `_` or `-` as `_` (`build/intutic_shell_deny.wasm`) |

**What it does:**
1. Runs `opa build -t wasm -e <entrypoint>` — OPA must be on the `PATH`, or set `INTUTIC_OPA_BIN`; without it the command says how to install it
2. Takes `policy.wasm` from the bundle and appends an `intutic.rule` section with the entrypoint, the ABI (`opa`) and the risk tier
3. Loads it as the proxies will and refuses one they would refuse, such as a policy needing a builtin Intutic does not provide, which it names
4. Writes the module and prints its size and SHA-256

Install the result with [`intutic policy install`](#intutic-policy-install). See [Rego policies](/guide/rego-policies).

---

## `intutic rules test`

Evaluate a Rego rule against sample inputs locally, through the same Rego host the proxies use.

```bash
intutic rules test <module> --input <file...>
```

**Options:**

| Option | Description |
|--------|-------------|
| `--input <file...>` | JSON file(s), each holding one [input document](/guide/rego-policies#the-input-document) or an array of `{"name", "input", "expect"}` cases (required) |

Prints each case's decision (`ALLOW`, `DENY`, `HOLD` or `REASK`), reason and risk tier. `expect` is optional, and one of `allow`, `deny`, `hold` or `reask` in lowercase; the command exits 1 when a case gets a decision other than the one it expects, or when evaluation fails. The rule runs under the proxies' instruction budget, so a rule that would run out of it in the proxy fails here too. A native rule is refused, with a pointer to [`intutic policy test`](#intutic-policy-test).

---

## `intutic guardrails` <Badge type="tip" text="Cloud" />

The Policy Clause Ledger from the terminal: sources, documents, the review queue, the three decisions that move a cited guardrail, guardrails you author directly, and the file plane. A client of `/api/v1/policy-guardrails/*` and `/api/v1/connectors`; nothing here decides anything the server would not, and the acting identity is never a flag — the server records the authenticated member. Only `docs extract` needs a paid plan, because it is the one step that spends model budget. Not `intutic policy` (the WASM rule loop) and not `intutic sops` (your own SOP files). Reading needs an OWNER, ADMIN or EM key; `docs extract`, the transitions (`approve-shadow`, `promote`, `reject`, `retire`, `reconfirm`), `create`, `update` and `delete` need OWNER or ADMIN. See [Policy Guardrails](/guide/policy-guardrails).

---

## `intutic guardrails sources list` <Badge type="tip" text="Cloud" />

List configured policy sources and their last sync.

```bash
intutic guardrails sources list
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Lists the workspace's source connectors (Notion, Confluence, GitHub, Google Docs), with auto-sync state, last sync and the error of a failed scheduled sync; `--json` also carries `last_attempt_at`. Memory providers are not policy sources and are not listed.

---

## `intutic guardrails sources add <provider>` <Badge type="tip" text="Cloud" />

Connect a policy source; the credential is read from `--token` or `--token-file`, never echoed.

```bash
intutic guardrails sources add <provider>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `provider` | One of `notion`, `confluence`, `github`, `gdrive` |

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | Display name for the source (required) |
| `--token <token>` | Provider credential (integration token or API key) |
| `--token-file <path>` | Read the credential from a file — a Google service-account key JSON |
| `--config <json>` | Provider-specific settings as a JSON object, e.g. `{"folder_id":"…"}` for Google Docs |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the connector encrypted at rest. Exactly one of `--token` / `--token-file` is required. Only a workspace owner or admin may create, reschedule, sync or remove a source, whatever the provider. For Google Docs, share the Drive folder with the service account's email first.

---

## `intutic guardrails sources sync <connectorId>` <Badge type="tip" text="Cloud" />

Pull the source now instead of waiting for the next cron pass.

```bash
intutic guardrails sources sync <connectorId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `connectorId` | The connector to sync |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Runs one sync: changed documents are re-split into passages, and citations that no longer hold are re-bound or marked stale. Prints the documents processed, SOPs written and any upstream successor drafts. A manual sync does not queue extraction; run `intutic guardrails docs extract <docId>` for a changed document (the scheduled sync queues it when the plan carries the budget). Notion and Google Drive are cloud-only and answer 503 in a self-hosted deployment.

---

## `intutic guardrails docs list` <Badge type="tip" text="Cloud" />

List ingested policy documents.

```bash
intutic guardrails docs list
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
One line per document: provider, title, passage, clause and guardrail counts, and the last extraction run.

---

## `intutic guardrails docs show <docId>` <Badge type="tip" text="Cloud" />

Show a document, its passages and the clauses extracted from them.

```bash
intutic guardrails docs show <docId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `docId` | The document id (`psd_…`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the document's provenance (source, content hash, upstream version), the number of live passages, every clause with its status, its guardrail and the checks that refused it, and each extraction run. `--json` includes every live passage with its hash.

---

## `intutic guardrails docs extract <docId>` <Badge type="warning" text="Self-serve+" />

Propose cited guardrails from a document; every proposal is re-validated deterministically.

```bash
intutic guardrails docs extract <docId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `docId` | The document to extract from |

**Options:**

| Option | Description |
|--------|-------------|
| `--no-llm` | Only lift existing SOP front matter; do not call the extraction model |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
One model call per chunk of passages, under the workspace's daily cap (exit 1 with the cap on 429, and exit 1 without a model call when the cap store is unreachable). A proposal is a verbatim quote plus a clause in the closed grammar; anything else is rejected by name. A valid clause becomes a proposed guardrail that enforces nothing until approved for shadow.

---

## `intutic guardrails search <token>` <Badge type="tip" text="Cloud" />

Which passages and guardrails mention a tool or action token; with `--text`, which passages use these words.

```bash
intutic guardrails search <token>
intutic guardrails search --text "<words>"
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `token` | A tool name or action token, e.g. `Bash`, `action:deploy`. With `--text`, the words to search for |

**Options:**

| Option | Description |
|--------|-------------|
| `--text` | Full-text search over the words of every live passage instead of an exact token |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Coverage for one token: the live passages whose token index carries it (case-insensitive) and the guardrails cited from those passages, so "do we have a rule about X" has an answer with citations.

With `--text`, the argument is read as words rather than a token: every live passage is searched (stemmed English, so `deploys` finds `deploy`) and up to 50 passages are listed, best match first. You can quote a phrase, use `or`, and exclude a word with a leading `-`; the query is limited to 200 characters. This answers "which passages talk about production deploys" where the token search answers "which passages name `Bash`". It lists passages only, not guardrails.

**Examples:**

```bash
intutic guardrails search Bash
intutic guardrails search --text "production deploy"
```

---

## `intutic guardrails list` <Badge type="tip" text="Cloud" />

List guardrails with their status and shadow evidence.

```bash
intutic guardrails list
```

**Options:**

| Option | Description |
|--------|-------------|
| `--status <status>` | `PROPOSED`, `SHADOW`, `ENFORCING`, `REJECTED` or `RETIRED` |
| `--target <target>` | `hook_rule`, `sop_front_matter`, `wasm_rule` or `workspace_setting` |
| `--provenance <provenance>` | `extracted` (compiled from a document) or `authored` (written directly) |
| `--doc <docId>` | Only guardrails cited from this document |
| `--limit <n>` | Max rows (default 200, capped at 1000) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
One line per guardrail: id, status, target, what it stands on (the cited quote, or an authored guardrail's name, description and version), and the shadow counters.

---

## `intutic guardrails show <guardrailId>` <Badge type="tip" text="Cloud" />

Show a guardrail: cited passage, rendered artifact, validation checks, readiness and history.

```bash
intutic guardrails show <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail id (`pgr_…`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
For a hook rule, prints the tool and input patterns and the exact stderr line a developer sees on a block; for a front-matter rule, the lines the proxy reads; for a WASM rule, the predicate source; for a workspace setting, the setting and the values it proposes. A SHADOW guardrail also prints the server's readiness reasons verbatim. An authored guardrail shows its name, description and version in place of a citation, and the version that replaced it, if one did.

---

## `intutic guardrails create` <Badge type="tip" text="Cloud" />

Author a guardrail directly: the same IR and checks as an extracted one, created PROPOSED.

```bash
intutic guardrails create --file guardrail.yaml
intutic guardrails create --name "Reviewed terraform apply" --kind hook_rule \
  --title "Reviewed plan before terraform apply" --tools Bash --arg-contains "terraform apply"
```

**Options:**

| Option | Description |
|--------|-------------|
| `--file <path>` | YAML or JSON: a bare IR (an object with `kind`), or `{ name, description, ir }` |
| `--name <name>` | One-line label, at most 80 characters, no surrounding whitespace (required here or in the file) |
| `--description <text>` | What the rule is for, at most 480 characters; shown where an extracted guardrail shows its quote, including in a hook rule's block message |
| `--kind <kind>` | The IR kind: `hook_rule`, `deny_tools`, `review_before`, `requires_before`, `forbid_after`, `max_calls`, `forbid_with`, `wasm_predicate`, `allowed_models` or `egress_allow` |
| `--title <title>` | `hook_rule`, `wasm_predicate`: the title in the block message |
| `--tools <list>` | `hook_rule`, `deny_tools`: comma-separated tool names |
| `--tokens <list>` | `review_before`: comma-separated tool or action tokens |
| `--arg-contains <literal>` | `hook_rule`: fire only when the tool input contains this; repeat for more |
| `--arg-not-contains <literal>` | `hook_rule`: fire only when the tool input does not contain this; repeat for more |
| `--first <token>` | `requires_before`, `forbid_after`: the first token |
| `--then <token>` | `requires_before`, `forbid_after`: the second token |
| `--token <token>` | `max_calls`, `forbid_with`: the token |
| `--limit <n>` | `max_calls`: the most calls allowed |
| `--taint <taint>` | `forbid_with`: `secrets()` or `pii()` |
| `--roles <list>` | Every kind but `allowed_models` and `egress_allow`: comma-separated lower-case roles the rule applies to; without it, everyone |
| `--models <list>` | `allowed_models`: comma-separated model ids |
| `--hosts <list>` | `egress_allow`: comma-separated hosts, suffixes or IPv4 CIDRs |
| `--rationale <text>` | `wasm_predicate`: why it re-asks |
| `--predicate <json>` | `wasm_predicate`: the predicate, as JSON |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sends the guardrail to `POST /api/v1/policy-guardrails/guardrails`. The flags and the file field names are the IR's own (`argContains` in a file, `--arg-contains` as a flag), and a `--name` or `--description` flag overrides the file's. The server runs the validator an extracted guardrail passes, without the checks that compare a model's output against a cited passage; a refusal exits 1 and prints the checks that ran, ending with the one that refused. The guardrail is created PROPOSED: it enforces and measures nothing until `intutic guardrails approve-shadow`, and promotion then waits on shadow evidence like any other. Needs an OWNER or ADMIN key. See [Authoring guardrails directly](/guide/policy-guardrails#authoring-guardrails-directly).

```yaml
# guardrail.yaml
name: Reviewed terraform apply
description: Production applies need a reviewed plan.
ir:
  kind: hook_rule
  title: Reviewed plan before terraform apply
  tools: [Bash]
  argContains: [terraform apply]
```

---

## `intutic guardrails update <guardrailId>` <Badge type="tip" text="Cloud" />

Edit an authored guardrail: a name or description in place; a changed IR creates the next version, PROPOSED with no evidence.

```bash
intutic guardrails update <guardrailId> --description "Production applies need a reviewed plan and a ticket."
intutic guardrails update <guardrailId> --file guardrail.yaml
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The authored guardrail to edit |

**Options:**

Every option of `intutic guardrails create`; `--clear-description` is the one only `update` has:

| Option | Description |
|--------|-------------|
| `--file <path>` | YAML or JSON: a bare IR, or `{ name, description, ir }` |
| `--name <name>` | A new label |
| `--description <text>` | A new description |
| `--clear-description` | Remove the description |
| `--kind <kind>` | A new IR, given with flags (`--title`, `--tools`, `--tokens`, `--arg-contains`, `--arg-not-contains`, `--first`, `--then`, `--token`, `--limit`, `--taint`, `--roles`, `--models`, `--hosts`, `--rationale`, `--predicate`). The flags need `--kind` and replace the whole IR; nothing is merged with the current one. Not with an IR in `--file` |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sends only what you give to `PUT /api/v1/policy-guardrails/guardrails/:guardrailId`. A name or description change happens in place and keeps the guardrail's status and evidence. A changed IR is a different rule: the server creates the next version under a new id, PROPOSED with no evidence, and retires this one, undoing what it wrote if it was an enforcing workspace-setting guardrail. The command prints the new id. An extracted guardrail is refused (exit 1): it changes when its document does.

---

## `intutic guardrails delete <guardrailId>` <Badge type="tip" text="Cloud" />

Retire an authored guardrail and undo what it wrote; its history is kept.

```bash
intutic guardrails delete <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The authored guardrail to retire |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Any state but RETIRED becomes RETIRED: the rule leaves every rule endpoint on the next poll, and an enforcing allowed-models or egress guardrail's setting write is undone as `retire` undoes it. The guardrail and its history stay readable with `show`. An extracted guardrail is refused; retire or reject it instead.

---

## `intutic guardrails approve-shadow <guardrailId>` <Badge type="tip" text="Cloud" />

Ship a proposed guardrail in shadow: it reports, never blocks.

```bash
intutic guardrails approve-shadow <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail to approve |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
PROPOSED → SHADOW. A hook rule is distributed at severity `warn`; a front-matter rule is served with `mode: shadow`; a WASM rule is handed to the rule-candidate pipeline and the command prints the candidate id and the compile command. Refused for a stale citation.

---

## `intutic guardrails promote <guardrailId>` <Badge type="tip" text="Cloud" />

Promote a shadow guardrail to enforcing once the server says it is ready (an egress allow list is applied from proposed).

```bash
intutic guardrails promote <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail to promote |

**Options:**

| Option | Description |
|--------|-------------|
| `--acknowledge-no-traffic` | Promote a rule that no observed traffic exercised, or apply an egress allow list, which has no shadow evidence |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
SHADOW → ENFORCING under the [promotion rule](/concepts/enforcement-actions#the-promotion-rule); refused (exit 1, with the reasons) until it holds. A WASM guardrail is promoted through its rule candidate instead, and this command says so. An allowed-models guardrail writes the workspace's `allowedModels`; an egress allow list has no shadow, so it goes PROPOSED → ENFORCING with `--acknowledge-no-traffic` and only adds its entries to `egressAllow` (see [Settings: allowed models and egress](/guide/policy-guardrails#settings-allowed-models-and-egress)).

---

## `intutic guardrails reject <guardrailId>` <Badge type="tip" text="Cloud" />

Reject a guardrail; the reason is recorded on its authority chain.

```bash
intutic guardrails reject <guardrailId> --reason "<reason>"
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail to reject |

**Options:**

| Option | Description |
|--------|-------------|
| `--reason <reason>` | Why it is rejected (required) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Any live state → REJECTED, with the reason on the event.

---

## `intutic guardrails retire <guardrailId>` <Badge type="tip" text="Cloud" />

Retire a shadow or enforcing guardrail; it stops being projected.

```bash
intutic guardrails retire <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail to retire |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
SHADOW or ENFORCING → RETIRED. The rule leaves both rule endpoints and the SOP policy on the next poll; a pulled file on disk stays until `intutic guardrails pull --prune` removes it. Retiring an enforcing allowed-models or egress guardrail undoes the setting it wrote.

---

## `intutic guardrails reconfirm <guardrailId>` <Badge type="tip" text="Cloud" />

Confirm a guardrail whose cited passage changed upstream still holds.

```bash
intutic guardrails reconfirm <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The stale guardrail |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Clears the stale flag only when the quote is still verbatim in a live passage of its document, re-binding the citation there. Otherwise refused: retire the guardrail or re-extract.

---

## `intutic guardrails replay <guardrailId>` <Badge type="tip" text="Cloud" />

Run a guardrail over captured calls and report how many it would have fired on.

```bash
intutic guardrails replay <guardrailId>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `guardrailId` | The guardrail to replay |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
A preview before anything ships: a hook rule over the enforcement log's captured calls, a front-matter rule over stored context snapshots (`review_before` holds rather than acts and is reported as not replayable), a WASM predicate over the same snapshots. An allowed-models list replays over the last 30 days of proxied requests, by model; an egress allow list has no observation source and is reported as not replayable.

---

## `intutic guardrails conflicts` <Badge type="tip" text="Cloud" />

List guardrails that contradict each other, with both quotes.

```bash
intutic guardrails conflicts
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Pure arithmetic over the live rules: a denied tool with a call ceiling, an ordering rule against its inverse, two ceilings on one token, a hook rule whose literals another's exclude. Each conflict names both ids and both cited sentences.

---

## `intutic guardrails impact` <Badge type="tip" text="Cloud" />

Show what a change to a document or a passage reaches: related passages, the clauses citing them, and their guardrails.

```bash
intutic guardrails impact --doc <docId>
intutic guardrails impact --passage <passageId>
```

**Options:**

| Option | Description |
|--------|-------------|
| `--doc <docId>` | Start from every live passage of this document |
| `--passage <passageId>` | Start from one passage |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Exactly one of `--doc` and `--passage` is required; passing neither or both exits `1`.

**What it does:**
Starting from the document's live passages (or the one passage), follows the computed links between passages, at most five steps out. Passages are linked when their text overlaps (Jaccard 0.70 or more), and a retired passage is linked to its near-identical successor. It then prints the number of passages reached (capped at 1000, and marked when capped), the valid clauses that cite them, and each guardrail standing on those clauses, with its status, target, how many steps it is from the change, and whether its citation is already stale.

When an enforcing guardrail is reached, the command warns: an upstream edit marks the guardrail stale for review, and never switches its enforcement off.

**Example:**

```bash
intutic guardrails impact --doc psd_abc123
```

---

## `intutic guardrails duplicates` <Badge type="tip" text="Cloud" />

List overlapping passages, with their Jaccard arithmetic, and the same rule cited from more than one passage.

```bash
intutic guardrails duplicates [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--min-jaccard <n>` | Only passage pairs at or above this Jaccard, a number from 0 to 1. Values below 0.70 are raised to 0.70, the line the overlaps were recorded at | `0.70` |
| `--json` | Output as JSON | — |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Two kinds of duplicate, both exact:

1. **Overlapping passages**: each pair of live passages whose text overlap clears the line, with the Jaccard score, the shingles they share out of the total, an excerpt of each side, and a `near-identical` flag at 0.85 or more.
2. **Repeated rules**: one rule, in its canonical form, cited from more than one passage, with each citing clause, its quote, and the guardrail it compiled to.

A value outside 0 to 1 exits `1`.

**Example:**

```bash
intutic guardrails duplicates --min-jaccard 0.85
```

---

## `intutic guardrails pull` <Badge type="tip" text="Cloud" />

Write the SHADOW and ENFORCING front-matter guardrails to `.intutic/sops/guardrail-<id>.md`, for a proxy that reads SOPs from disk.

```bash
intutic guardrails pull
```

**Options:**

| Option | Description |
|--------|-------------|
| `--force` | Overwrite a locally-modified guardrail file instead of refusing it |
| `--prune` | Remove guardrail files that are no longer served (unmodified ones only) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Fetches the workspace SOP policy and writes one flat file per served guardrail, named by the guardrail id, directly in `.intutic/sops/`. The proxy reads the files there and one folder down, and titles a file directly in the directory by its file name alone (a file in a folder is titled `<folder>/<name>`); that title is what the guardrail's shadow reports are credited to. The served front matter (the enforcing keys, `mode: shadow`, `source:`, `cite:`) is kept in its single fence and a `content_hash:` marker is added inside it. Refuses to overwrite a file whose recorded hash no longer matches its body unless `--force` is passed; reports a file whose guardrail is no longer served, and removes it only with `--prune` and only when unmodified. A gateway-mode proxy reads the served projection directly and ignores this directory. See [Policy Guardrails](/guide/policy-guardrails).

---

## `intutic sops push <name>` <Badge type="tip" text="Cloud" />

Push a local SOP folder, or a single SOP file, to the central workspace — one
control-plane SOP per file, each carrying its own declared front matter. A file
that records its SOP (`intutic_id:`) updates that SOP; any other file creates one.

```bash
intutic sops push <name> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `name` | A folder under `.intutic/sops/` in the workspace root, or a file there named with or without `.md` (the layout `sops pull` writes) |

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |
| `--force` | Overwrite a SOP that changed on the control plane since the file was pulled, and fork a DRAFT even when one already exists |
| `--create` | For a file whose recorded SOP no longer exists, create a new SOP instead of refusing |
| `--org` | Push as an org-wide floor instead of a workspace SOP (always creates) |

**What it does:**
For every `.md` file in `.intutic/sops/<name>/` — or, when there is no such folder, for the one file `.intutic/sops/<name>.md` — parses `title:`/`risk_tier:`/`version:` front matter (falling back to the file's first `# ` heading, then the file name, for title; to `MEDIUM` for an unstated risk tier on a new SOP; a value other than `LOW`, `MEDIUM`, `HIGH` or `CRITICAL` counts as unstated), front matter stripped from the uploaded body, and then, per file:

- **The file records a SOP** (`intutic_id:`, written by `sops pull` or an earlier push): if the file matches the SOP, nothing is sent (`up to date`). Otherwise the SOP is edited through the same path as the dashboard (`PUT /api/v1/sops/:id`): a DRAFT is edited in place; an approved SOP gets a new DRAFT version, and the approved one keeps enforcing until the draft is promoted: the file is marked `intutic_enforced: false` and the approved version is written beside it as `<name>.approved.md`, which push skips. The file's `intutic_revision:` is sent as the precondition, so a SOP edited on the control plane since the pull is refused ("changed on the server since you pulled it") instead of overwritten; run `intutic sops pull`, or push with `--force` to overwrite. A push that would fork a second DRAFT of the same approved SOP is refused the same way. An edit that loosens the guideline needs an Owner, and the control plane's refusal is printed. A recorded SOP that no longer exists is refused unless `--create` is passed.
- **The file records no SOP:** a new workspace SOP is created.

After a successful create or update, the file's front matter records the SOP's id and revision (the new DRAFT's id when the edit forked one), with every other line of the file kept. Each file's result is printed; the command exits `1` if any file failed. Fails if neither the folder nor the file exists, or the folder contains no markdown. Creating and editing workspace SOPs needs the OWNER or ADMIN role; `--org` needs that role on a workspace in the org. See [GitOps for SOPs](/guide/gitops-sops) for the full push/pull/status flow and what does not round-trip (declarative enforcement keys like `deny_tools:` have no control-plane column).

---

## `intutic sops pull` <Badge type="tip" text="Cloud" />

Pull every workspace SOP from the control plane into `.intutic/sops/<slug>.md`.

```bash
intutic sops pull [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |
| `--force` | Overwrite locally-modified files instead of refusing them |

**What it does:**
Writes one file per SOP, with `title:`/`risk_tier:`/`version:` front matter reconstructed, a `content_hash:` marker recording the body's hash, and the sync record `sops push` reads: `intutic_id:` (the SOP) and `intutic_revision:` (its edit counter). A SOP with no risk tier gets no `risk_tier:` line. Each file also records `intutic_enforced: true` for a `VALIDATED` SOP and `intutic_enforced: false` for any other state or a SOP no longer active; the proxy and the sync daemon skip a file marked `false`, so a pulled draft is not enforced locally (see [GitOps for SOPs](/guide/gitops-sops#pulled-sops-enforce-what-the-control-plane-enforces)). The key is updated on every pull, also over a locally edited file. While a file tracks a DRAFT forked from an approved SOP, the approved version is kept enforced in `<name>.approved.md` beside it (with an `intutic_draft:` line, so `sops push` never sends it); the first pull after the draft is promoted removes that file. A SOP goes into the local file that already records its id — flat or in a `<name>/` folder, keeping that file's other front-matter keys — and otherwise into `.intutic/sops/<slug>.md`. An approved version is skipped when a local file tracks its DRAFT successor. Refuses to overwrite a file whose recorded hash no longer matches its current body (a local edit since the last pull) unless `--force` is passed; a file with no recorded hash at all is treated as unverifiable and always requires `--force`. See [GitOps for SOPs](/guide/gitops-sops).

---

## `intutic sops status` <Badge type="tip" text="Cloud" />

Show drift between the local SOP files (`.intutic/sops/*.md` and `.intutic/sops/<name>/*.md`) and the control plane. Writes no local file.

```bash
intutic sops status [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
For each local file, matched to its SOP by the recorded `intutic_id:` (by title for a file without one), reports `in-sync`, `local-ahead` (edited locally, not yet pushed), `remote-ahead` (control plane moved on, safe to pull), `diverged` (edited on both sides, or no recorded pull hash and no match either — can't tell "never pulled" from "edited long ago"), or `push-only` (no matching SOP on the control plane yet, or the recorded one is gone). Files named `guardrail-*.md` (written by `intutic guardrails pull`) are skipped. Every matched result is also reported to the control plane, which the `sop_git_drift` compliance probe reads; a failed report does not fail the command. See [GitOps for SOPs](/guide/gitops-sops).

---

## `intutic sops org-list` <Badge type="tip" text="Cloud" />

List the org-wide SOP floors for your own org.

```bash
intutic sops org-list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per active org-wide SOP: its title, its id (`osp_…`) and its risk tier, then a count. These are the mandatory floors pushed with `intutic sops push <name> --org`; every workspace under the org is judged and enforced against them in addition to its own SOPs. The org is the one your logged-in workspace belongs to, and any member of a workspace in that org can list them.

**Example:**

```bash
intutic sops org-list
```

---

## `intutic sops org-rm <orgSopId>` <Badge type="tip" text="Cloud" />

Remove an org-wide SOP floor.

```bash
intutic sops org-rm <orgSopId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `orgSopId` | The org SOP id (`osp_…`), as printed by `intutic sops org-list` |

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Deactivates the floor, so it stops applying to every workspace in the org. The row is kept (a soft delete), not erased. You need the OWNER or ADMIN role on at least one active workspace in the org. Without that role the answer is "Org not found or you lack admin access" whether or not the floor exists; with it, a floor that does not exist (or was already removed) answers "Org SOP not found".

**Example:**

```bash
intutic sops org-rm osp_abc123
```

---

## `intutic optimizer settings` <Badge type="warning" text="Biz Org+" />

Print the [SOP Optimizer](/guide/metaclaw)'s approval mode and its auto-apply threshold.

```bash
intutic optimizer settings [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON: `workspaceId`, `mode` and `autoThreshold` |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Reads `GET /api/v1/dream-cycle/settings`. `manual` (the default) applies nothing automatically; `auto` lets a manually triggered optimizer run apply a `STRENGTHEN` proposal whose score reaches the threshold without review (see [What auto-apply applies](/guide/metaclaw#what-auto-apply-applies)). A workspace that never set the mode reads `manual` at 0.85. Any member can read it.

**Example:**

```bash
intutic optimizer settings --json
```

---

## `intutic optimizer set` <Badge type="warning" text="Biz Org+" />

Set the SOP Optimizer's approval mode, and optionally its auto-apply threshold.

```bash
intutic optimizer set --mode <manual|auto> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--mode <mode>` | `manual` or `auto`. Required |
| `--auto-threshold <n>` | The score from 0 to 1 a proposal must reach to be auto-applied in `auto`. Omit it to keep the current threshold |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sends `PUT /api/v1/dream-cycle/settings` with the mode and the threshold. The route takes both every time, so without `--auto-threshold` the command reads the current threshold first and sends it back unchanged. You need the OWNER or ADMIN role. This is the same switch as **Approval mode** on the SOP Optimizer page, and the one that replaced the removed `ff_metaclaw_auto_apply` feature flag; only a run started on a plan that includes the SOP Optimizer applies anything.

**Examples:**

```bash
intutic optimizer set --mode auto --auto-threshold 0.9
intutic optimizer set --mode manual
```

---

## `intutic credentials list` <Badge type="tip" text="Cloud" />

Provisioning status for every provider in the credential registry — see
[Provider Keys](/guide/settings#provider-keys).

```bash
intutic credentials list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Each provider is reported with whether it is **live** (the gateway actually routes to it) or
**not yet routable** (the key is stored, but nothing forwards to it yet), plus whether a key is
currently provisioned and its last-4 preview.

---

## `intutic credentials set <provider>` <Badge type="tip" text="Cloud" />

Provision or rotate a workspace's own upstream provider key.

```bash
intutic credentials set <provider> --field key=value [--field key=value ...] [--field-file key=path ...] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--field <key=value>` | A credential field; repeat for multi-field providers |
| `--field-file <key=path>` | A credential field read from a file, such as a Vertex AI service-account key; repeatable |
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

The fields are checked before anything is sent: a field the provider does not take, a missing required field, a Bedrock credential with neither an access key pair nor an API key, an Azure endpoint that is not an Azure resource over `https`, or a Vertex AI key that is not a `service_account` (or `authorized_user`) credential file is refused.

**Examples:**

```bash
# A single-key provider
intutic credentials set anthropic --field apiKey=sk-ant-...

# AWS Bedrock: a region and an access key pair, or a Bedrock API key
intutic credentials set bedrock --field awsRegion=us-east-1 --field apiKey=<BEDROCK_API_KEY>

# Google Vertex AI: the project, a location and a service-account key file
intutic credentials set vertex_ai --field projectId=my-project --field location=global \
  --field-file serviceAccountJson=./service-account.json

# Azure OpenAI: the resource endpoint and its key
intutic credentials set azure_openai \
  --field endpoint=https://your-resource.openai.azure.com \
  --field apiKey=<API_KEY>
```

After saving, the command checks the credential against the provider (the same check as **Test** on the Provider Keys card) and prints whether it was verified, rejected, or could not be verified; `--json` includes it as `verification`. A rejected credential is still saved. When the provider lists the models the key can reach, the command says how many; [`intutic credentials models`](#intutic-credentials-models) lists them.

Requests then name the provider's models as `bedrock/<model id>`, `vertex/<model>` or `azure/<deployment>`; see [AWS Bedrock](/integrations/aws-bedrock), [Google Vertex AI](/integrations/google-vertex-ai) and [Azure OpenAI](/integrations/azure-openai).

If BYO-key enforcement is on for your gateway, requests for a provider with no provisioned key
fail with `402 byok_required` until one is set here.

---

## `intutic credentials unset <provider>` <Badge type="tip" text="Cloud" />

Remove a provisioned provider credential.

```bash
intutic credentials unset <provider> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

If BYO-key enforcement is on, requests for this provider are refused after this until a new
key is provisioned.

---

## `intutic credentials models <provider>` <Badge type="tip" text="Cloud" />

The models a provider credential can reach, as the provider listed them when the key was last
checked.

```bash
intutic credentials models <provider> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of a report (`provider`, `models`, `checkedAt`) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

The list is recorded when a saved key is checked and the provider answers with its models, so
it follows the key: `intutic credentials set` (or **Test** on the Provider Keys card) records it,
and replacing, removing or failing the check on the key clears it. Until then the command says
no models have been discovered. Azure OpenAI, AWS Bedrock and Google Vertex AI keys have no
list: Azure lists base models rather than the deployments requests name.

**Example:**

```bash
intutic credentials models anthropic
```

---

## `intutic attenuate` <Badge type="warning" text="Biz Org+" />

Mint a child API key from one of your keys, with narrower scopes and a shorter life.

```bash
intutic attenuate --parent-key <keyId> --caps <scope,scope,...> [--ttl <seconds>] [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--parent-key <keyId>` | ID of the parent API key to narrow (required) | — |
| `--caps <scopes>` | Comma-separated [API key scopes](/reference/api#api-key-scopes) for the child key; each must be granted by the parent key (required) | — |
| `--ttl <seconds>` | Child key lifetime in whole seconds, from 60 to 86400 | `14400` (4 hours) |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Asks the control plane to mint the child key, then prints the child key itself (`vk_…`), its key ID, the attenuation chain ID, the granted scopes and the expiry time. The child key is shown **once** and never stored, so save it when it is printed. A child never outlives its parent: it expires after `--ttl` or when the first key it descends from expires, whichever comes sooner, and the printed expiry is that time.

A child can only narrow. Each requested scope must be granted by the parent: `*` grants every scope and `<area>:write` grants `<area>:read`. Called with a key rather than a dashboard session, each must also be granted by that key. The child acts with the parent owner's role, so the parent must be one of your own keys, and it is held to its parent's scopes on every request: narrowing the parent narrows the child.

The request is refused when the parent key is not yours, is revoked or expired, or descends from an expired key, when a requested scope is not granted (the error names which), or when the chain is already four attenuations deep. A missing `--parent-key`, an empty `--caps`, a scope that is not in the registry, or a `--ttl` outside 60–86400 whole seconds exits `1` before anything is sent.

**Example:**

```bash
# A one-hour key for a sub-agent: agent traffic and reading traces only
intutic attenuate --parent-key key_abc123 --caps gateway:use,traces:read --ttl 3600
```

---

## `intutic attenuate chain <chainId>` <Badge type="warning" text="Biz Org+" />

Show the full delegation lineage of an attenuation chain.

```bash
intutic attenuate chain <chainId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `chainId` | The chain ID (`att_…`) printed by `intutic attenuate` |

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each link in the chain: parent key, child key, granted scopes, expiry and when it was minted. Needs the OWNER or ADMIN role. The same chains are shown on the dashboard's **Attenuated API Keys** card.

---

## `intutic keys list` <Badge type="tip" text="Cloud" />

List your API keys in the workspace, revoked ones included.

```bash
intutic keys list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each key's id, label, prefix (`vk_…`), [scopes](/reference/api#api-key-scopes) and expiry (`never` when it has none), and when it was revoked. The key itself is never shown again after it is created. Every member sees only their own keys; `intutic budget keys` lists every key in the workspace with its spend.

---

## `intutic keys create` <Badge type="tip" text="Cloud" />

Create an API key and print it once.

```bash
intutic keys create --label <label> [--scopes <scope,scope,...>] [--expires-in-days <n>] [--service-account] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--label <label>` | A name for the key (required) |
| `--scopes <scopes>` | Comma-separated [API key scopes](/reference/api#api-key-scopes); `*` (everything your role allows) when left out |
| `--expires-in-days <n>` | Expire the key after this many days, 1 to 365; never when left out |
| `--service-account` | An automation key: exempt from the SSO idle-key check, because its owner may never sign in interactively. It still stops working when its owner is deactivated, and can still be revoked |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the key for you and prints its id, label, prefix, scopes and expiry, then the key itself (`vk_…`). The key is shown **once** and never stored, so copy it when it is printed. Called with a key rather than a dashboard session, every scope asked for must be granted by that key. A scope that is not in the registry, or an `--expires-in-days` that is not a positive whole number, exits `1` before anything is sent, naming the valid scopes.

**Example:**

```bash
# A key for a CI job that only runs agents
intutic keys create --label ci-runner --scopes gateway:use --expires-in-days 90 --service-account
```

---

## `intutic keys update <keyId>` <Badge type="tip" text="Cloud" />

Replace a key's scopes. OWNER or ADMIN, for any live key in the workspace.

```bash
intutic keys update <keyId> --scopes <scope,scope,...> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--scopes <scopes>` | Comma-separated [API key scopes](/reference/api#api-key-scopes) the key will hold, replacing its current ones (required) |
| `--json` | Print the key after the change as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sends the new scopes and prints the key with them. They apply from the key's next request, and the key's attenuated children are held to them too. A scope that is not in the registry exits `1` before anything is sent. Budgets and rate limits are set with `intutic budget key`.

**Example:**

```bash
intutic keys update key_abc123 --scopes gateway:use,traces:read
```

---

## `intutic keys revoke <keyId>` <Badge type="tip" text="Cloud" />

Revoke an API key: one of yours, or, as an OWNER or ADMIN, any live key in the workspace.

```bash
intutic keys revoke <keyId> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Revokes the key: every request made with it is refused from then on, and it cannot be restored. A key id you may not revoke (none live with that id in the workspace, one already revoked, or, below OWNER or ADMIN, another member's) is reported and exits `1`.

---

## `intutic gateway register` <Badge type="danger" text="Enterprise" />

Register a self-hosted gateway — an org's own Docker, Kubernetes, or bare-metal (systemd)
deployment of the Intutic proxy — and print its one-time management token.<!-- ENTERPRISE_ONLY_START --> See
[Self-Hosted Gateway](/external/self-hosted-gateway).<!-- ENTERPRISE_ONLY_END -->

```bash
intutic gateway register --name <name> --target <docker|kubernetes|bare_metal> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | Display name for this gateway (required) |
| `--target <docker\|kubernetes\|bare_metal>` | Deployment target (required) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

The printed `gwk_...` token is shown **once** and cannot be retrieved again — set it as
`INTUTIC_GATEWAY_TOKEN` in your deployment config. This is a distinct credential type from a
`vk_` virtual key: a control-plane management/heartbeat credential, never a data-plane
LLM-calling key.

---

## `intutic gateway list` <Badge type="danger" text="Enterprise" />

List the org's registered gateways.

```bash
intutic gateway list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic gateway status <gateway_id>` <Badge type="danger" text="Enterprise" />

Live, heartbeat-derived status for one gateway.

```bash
intutic gateway status <gateway_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Reports `online`, `degraded` or `unreachable`. A gateway with no heartbeat inside the TTL window
(90s) shows `unreachable`, including a newly registered one that `gateway list` still shows as
`pending` — a valid, self-healing status rather than an error.
`Config version` is the config the gateway reported running in its last heartbeat, against the
latest one [`gateway config set`](#intutic-gateway-config-set) produced.

---

## `intutic gateway rotate <gateway_id>` <Badge type="danger" text="Enterprise" />

Issue a new `gwk_...` token. The old token keeps authenticating for a grace period (24h by
default) so an unattended gateway has time to pick up the new one on its next restart.

```bash
intutic gateway rotate <gateway_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic gateway revoke <gateway_id>` <Badge type="danger" text="Enterprise" />

Revoke a gateway immediately — unlike `rotate`, this kills any active rotation grace period
too, since a revoke is a security response, not a scheduled rollover.

```bash
intutic gateway revoke <gateway_id> [--reason <text>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--reason <text>` | Recorded in the audit log |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic gateway config get <gateway_id>` <Badge type="danger" text="Enterprise" />

Show the config values set on a gateway, and their version.

```bash
intutic gateway config get <gateway_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Prints `requireVk` and `requireProvisionedKey` as [`gateway config set`](#intutic-gateway-config-set) left them, and the config version, the same values the gateway pulls. A flag that was never set here runs the deployment's own value (`INTUTIC_GATEWAY_REQUIRE_VK`, `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY`), which the control plane does not know. Any member of the gateway's org can read it. `gateway status` shows whether the gateway runs this version.

---

## `intutic gateway config set <gateway_id>` <Badge type="danger" text="Enterprise" />

Update a gateway's remote config. Only the fields the gateway actually reads are accepted.

```bash
intutic gateway config set <gateway_id> [--require-vk <true|false>] [--require-provisioned-key <true|false>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--require-vk <true\|false>` | Refuse non-`vk_` bearer tokens at this gateway |
| `--require-provisioned-key <true\|false>` | Refuse workspaces with no provisioned upstream key |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

The gateway applies the change on its next heartbeat, without a restart or a redeploy, on every
deployment target: within `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS` (30 seconds by default).<!-- ENTERPRISE_ONLY_START --> See
[Changing a gateway's config](/external/self-hosted-gateway#changing-a-gateway-s-config).<!-- ENTERPRISE_ONLY_END -->

---

## `intutic gateway assign` <Badge type="danger" text="Enterprise" />

Set or clear the gateway that this workspace, or the whole org by default, points at.

```bash
intutic gateway assign --gateway <gateway_id> [--org <org_id>] [options]
intutic gateway assign --clear [--org <org_id>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--gateway <gateway_id>` | The gateway to assign (`gw_…`) |
| `--clear` | Clear the current assignment instead of setting one |
| `--org <org_id>` | Set or clear the org's default instead of this workspace's own override |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Exactly one of `--gateway` and `--clear` is required; passing neither or both exits `1`. The gateway id is a flag value, not a positional argument.

**What it does:**
- **Without `--org`**, it sets or clears the override for the workspace you are logged in to. You need the OWNER or ADMIN role there. There is no flag for another workspace: log in to that workspace to change its assignment.
- **With `--org`**, it sets or clears the org's default, which every workspace in the org uses unless it has its own override. You need the OWNER or ADMIN role on at least one active workspace in the org.

The gateway must be registered to the same org and not revoked; otherwise the answer is "Gateway not found". Run `intutic gateway resolve` afterwards to see which gateway actually applies.

**Examples:**

```bash
intutic gateway assign --gateway gw_abc123
intutic gateway assign --gateway gw_abc123 --org org_abc123
intutic gateway assign --clear
```

---

## `intutic gateway resolve` <Badge type="danger" text="Enterprise" />

Show which gateway this workspace resolves to, and why.

```bash
intutic gateway resolve [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Resolves in this order: the workspace's own override, then the org's default, then the shared `gateway.intutic.ai` when nothing is assigned at either level (`source` is `workspace`, `org` or `default` in the JSON). For an assigned gateway it prints the source, gateway ID, name, deployment target and status:

- If the gateway is online and has a registered endpoint, it prints the endpoint. `intutic connect` uses that endpoint automatically unless the workspace sets its own `proxyUrl`.
- If the endpoint is registered but the gateway is not online yet, traffic stays on the shared gateway until it sends a heartbeat.
- With no registered endpoint, pointing a client at the gateway is a manual step.

If the assignment names a gateway that has since been revoked or deleted, the command warns and reports the fallback to the shared gateway until the assignment is changed or cleared.

This is routing discovery: it tells a client which gateway to use. It does not proxy traffic between gateways.

---

## `intutic org create` <Badge type="tip" text="Cloud" />

Create an org, with a default team and workspace, after proving you own its domain.

```bash
intutic org create [--org-name <name>] [--domain <domain>] [--region <region>] [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--org-name <orgName>` | Organization name, up to 128 characters | _(prompted)_ |
| `--domain <domain>` | Domain to verify ownership of, e.g. `acme.com` | _(prompted)_ |
| `--region <region>` | Region for the org's managed gateway, e.g. `us` or `eu`. Must be one this deployment offers; anything else is refused with the list of valid regions | The deployment's home region |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
1. Requires `intutic login` first; without stored credentials it exits `1`. Prompts for the name and domain if you did not pass them.
2. Starts domain verification and prints a DNS TXT record to publish: the name `_intutic-verify.<domain>` and a value.
3. Waits for you: press Enter to check DNS, or type `q` to abort, in which case nothing is created. Until the record resolves it reports "still pending" and asks again. DNS changes can take a few minutes to propagate, and a verification that expires has to be started again by rerunning the command.
4. Once the domain is verified, creates the org on the Biz Org plan with a 30-day trial, a **Default Team**, a default workspace in which you are OWNER, and a managed gateway in the chosen region. It prints the org ID, plan, region and default workspace.
5. Switches your CLI session to the new default workspace and suggests `intutic team list --org <org_id>`.

The DNS check is interactive even when every flag is given, so this command is not suited to CI. A verified domain backs exactly one org, and there is a per-user limit on how many orgs you can create.

**Example:**

```bash
intutic org create --org-name "Acme" --domain acme.com --region eu
```

---

## `intutic team list` <Badge type="warning" text="Biz Org+" />

List an org's teams.

```bash
intutic team list --org <org_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--org <org_id>` | The org (`org_…`) (required) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each team's ID, name, slug and creation time, oldest first. Any member of a workspace in the org can list its teams.

**Example:**

```bash
intutic team list --org org_abc123
```

---

## `intutic team create` <Badge type="warning" text="Biz Org+" />

Create a new team under an org.

```bash
intutic team create --org <org_id> --name <name> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--org <org_id>` | The org to create the team in (required) |
| `--name <name>` | Team name, up to 128 characters (required) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the team and prints its ID. You need the OWNER or ADMIN role on at least one active workspace in the org. The org's plan caps how many teams it can have, and the error names the plan when the cap is reached. A personal org can never have more than its one team.

**Example:**

```bash
intutic team create --org org_abc123 --name "Platform"
```

---

## `intutic team workspaces <team_id>` <Badge type="warning" text="Biz Org+" />

List the workspaces under a team.

```bash
intutic team workspaces <team_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `team_id` | The team (`tm_…`), as listed by `intutic team list` |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each workspace's ID, name, plan and creation time, oldest first. Any member of a workspace in the team's org can list them.

**Example:**

```bash
intutic team workspaces tm_abc123
```

---

## `intutic team create-workspace <team_id>` <Badge type="warning" text="Biz Org+" />

Create a new workspace under a team; you become its OWNER.

```bash
intutic team create-workspace <team_id> --name <name> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `team_id` | The team to create the workspace in |

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | Workspace name, up to 128 characters (required) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the workspace with the org's plan, spend caps and trial end date, adds you as its OWNER, and prints the new workspace ID. You need the OWNER or ADMIN role on at least one active workspace in the org. Your CLI session stays on its current workspace; run `intutic login` again to switch to the new one.

**Example:**

```bash
intutic team create-workspace tm_abc123 --name "payments-service"
```

---

## `intutic settings get [key]` <Badge type="tip" text="Cloud" />

Print the workspace's settings, or one of them.

```bash
intutic settings get [key] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `key` | One setting, e.g. `mcpDefaultPolicy`. Omit it for every setting |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON: the whole response, or with a key just its value (`null` when it is not set) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Reads `GET /api/v1/workspace/settings`: the stored settings merged with their defaults, with storage credentials redacted. Any member can read them.

**Example:**

```bash
intutic settings get mcpBudgets --json
```

---

## `intutic settings set <key> [value]` <Badge type="tip" text="Cloud" />

Change one workspace setting.

```bash
intutic settings set <key> (<value> | --file <path>) [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `key` | The setting to change |
| `value` | The new value. Read as JSON when it parses as JSON (`true`, `30`, `null`, `["a","b"]`), otherwise as a string (`deny`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--file <path>` | Read the value from a JSON file instead of the argument |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sends `PUT /api/v1/workspace/settings` with only this key, so every other setting keeps its value, and prints the key's new value. You need the OWNER or ADMIN role, and the change is recorded in the settings history. The server refuses an unknown key or a bad value with a message naming it. `mcpBudgets`, `sso_group_policy`, `piiDetectors` and `upstreamRetry` are also checked by the CLI before sending, and a mistake is reported with the path of the field at fault.

Settings often changed this way:

| Key | Values |
|-----|--------|
| `mcpDefaultPolicy` | `allow` or `deny`: what MCP proxies do with a server the [registry](/guide/mcp-governance#the-registry) has not approved |
| `mcpHighRiskToolChange` | `notify` or `hold`: what a [high-risk tool change](/guide/mcp-governance#tool-change-risk) does to a server |
| `mcpBudgets` | [MCP call budgets](/guide/mcp-governance#call-budgets), as a JSON object; usually given with `--file` |
| `mcpInjectionAction` | `warn` or `block`, for prompt-injection matches in MCP calls |
| `mcpInjectionPatterns` | Extra prompt-injection patterns, a JSON list of regular expressions |
| `mcpAnomalyMode` | `enforce`, `warn` or `off` |
| `mcpAnomalyOverrides` | A JSON object of detector id to `steer`, `reask`, `kill` or `off` |
| `sso_group_policy` | The [group policy for high-risk tools](/guide/settings#security), as a JSON object of `highRiskTools`, `requiredGroups` and `requireOboFor`; `null` clears it. Setting one needs a <Badge type="warning" text="Biz Org+" /> plan |
| `piiDetectors` | The [PII detector](/guide/policies#pii-detectors) actions for the workspace, as a JSON object of detector id to `off`, `redact` or `block`; each machine's proxy config may only tighten them. `null` clears it |
| `upstreamRetry` | The proxy's [retries and fallbacks](/guide/intelligent-routing#retries-and-fallbacks) for the workspace, as a JSON object; each field overrides the proxy's config. `null` clears it |
| `configBodyUpload` | `true` or `false`: [config content upload](#config-content-upload) |
| `interventionMode` | `TRANSPARENT`, `OPAQUE` or `SILENT_LOG`: what an agent is told when a call is refused on workspace policy ([Intervention Modes](/guide/policies#intervention-modes)). It is the only source of the mode; unset, it is `TRANSPARENT` |
| `storeToolArguments` | `true` or `false`: keep tool-call argument values, redacted, in the replay contexts [`intutic policy replay`](#intutic-policy-replay) reads. Off by default |

See [Workspace Settings](/reference/workspace-settings) for every key.

**Examples:**

```bash
intutic settings set interventionMode OPAQUE
intutic settings set mcpDefaultPolicy deny
intutic settings set mcpBudgets --file mcp-budgets.json
intutic settings set sso_group_policy null
intutic settings set piiDetectors '{"pii.card":"block","pii.email":"redact"}'
intutic settings set upstreamRetry '{"maxAttempts":4,"budgetMs":45000}'
```

---

## `intutic mcp list` <Badge type="tip" text="Cloud" />

List the MCP servers the workspace's MCP proxies have seen.

```bash
intutic mcp list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the registry's default policy, what a high-risk tool change does, how many servers await a decision, and each server with its id, name, status (`candidate`, `approved` or `blocked`, marked when a high-risk tool change holds it), how many tools it has and which are switched off, and when it was last seen. With `--json` it also includes the MCP call budgets and each server's latest scored tool change. Any member can list the registry. See [The registry](/guide/mcp-governance#the-registry).

---

## `intutic mcp approve <server_id>` <Badge type="tip" text="Cloud" />

Approve an MCP server, so MCP proxies let it run.

```bash
intutic mcp approve <server_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `server_id` | The server, as `intutic mcp list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sets the server's status to `approved`, attributed to you. You need the OWNER or ADMIN role. Every decision is recorded with who made it and reaches MCP proxies with the policy they poll, within a minute for a per-session proxy. Approving also releases a server held by a high-risk tool change.

---

## `intutic mcp block <server_id>` <Badge type="tip" text="Cloud" />

Block an MCP server, so MCP proxies refuse it.

```bash
intutic mcp block <server_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `server_id` | The server, as `intutic mcp list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sets the server's status to `blocked`, attributed to you. You need the OWNER or ADMIN role.

---

## `intutic mcp reset <server_id>` <Badge type="tip" text="Cloud" />

Return an MCP server to the approval queue.

```bash
intutic mcp reset <server_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `server_id` | The server, as `intutic mcp list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sets the server's status back to `candidate`, the **Reset** button on **Policies › MCP Servers**. A candidate runs or not according to `mcpDefaultPolicy`. You need the OWNER or ADMIN role.

---

## `intutic mcp enable-tool <server_id> <tool>` <Badge type="tip" text="Cloud" />

Switch one tool of an MCP server back on.

```bash
intutic mcp enable-tool <server_id> <tool> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `server_id` | The server, as `intutic mcp list` shows it |
| `tool` | The tool's name, as the server declares it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Removes the tool from the server's disabled list. You need the OWNER or ADMIN role.

---

## `intutic mcp disable-tool <server_id> <tool>` <Badge type="tip" text="Cloud" />

Switch one tool of an MCP server off.

```bash
intutic mcp disable-tool <server_id> <tool> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `server_id` | The server, as `intutic mcp list` shows it |
| `tool` | The tool's name, as the server declares it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Adds the tool to the server's disabled list: MCP proxies refuse calls to it while the rest of the server keeps working. You need the OWNER or ADMIN role.

**Example:**

```bash
intutic mcp disable-tool mcpsrv_abc123 delete_repository
```

---

## `intutic notifications list` <Badge type="tip" text="Cloud" />

List the workspace's notification rules.

```bash
intutic notifications list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each rule's id, event type, channel and target, filters, cooldown and whether it is on. Signing secrets are never shown, and PagerDuty routing keys are masked. See [Notifications](/guide/settings#notifications).

---

## `intutic notifications create` <Badge type="tip" text="Cloud" />

Create a notification rule.

```bash
intutic notifications create --event <type> --channel <channel> <target option> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--event <type>` | The event type, e.g. `incident.created`, `decision.pending` or `mcp.server.candidate` (required) |
| `--channel <channel>` | `slack`, `email`, `webhook` or `pagerduty` (required) |
| `--slack-channel <id>` | Slack channel ID, for the `slack` channel |
| `--email <addresses>` | Comma-separated recipients, up to 20, for the `email` channel |
| `--webhook-url <url>` | HTTPS URL, for the `webhook` channel |
| `--pagerduty-key <key>` | Routing key, for the `pagerduty` channel |
| `--severity <list>` | Only events of these comma-separated severities: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`, in any case. Another value is refused |
| `--harness <list>` | Only events from these comma-separated harnesses |
| `--user <ids>` | Only events from these comma-separated user ids |
| `--cooldown <minutes>` | Minimum minutes between two notifications from this rule, 1 to 1440 (default 15) |
| `--disabled` | Create the rule switched off |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the rule and prints it. Each channel needs its own target option; the server refuses a rule without one. A webhook URL must be HTTPS and must not point at an internal address. A webhook rule is always signed: the server generates its signing secret and returns it once, in this response, so copy it then. `intutic notifications rotate-secret` replaces it. You need the OWNER or ADMIN role.

**Example:**

```bash
intutic notifications create --event incident.created --channel webhook \
  --webhook-url https://hooks.example.com/intutic --severity high,critical
```

---

## `intutic notifications update <rule_id>` <Badge type="tip" text="Cloud" />

Change a notification rule.

```bash
intutic notifications update <rule_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `rule_id` | The rule, as `intutic notifications list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--event <type>` | New event type |
| `--channel <channel>` | New channel: `slack`, `email`, `webhook` or `pagerduty` |
| `--slack-channel <id>` | Slack channel ID |
| `--email <addresses>` | Comma-separated recipients, up to 20 |
| `--webhook-url <url>` | HTTPS URL |
| `--pagerduty-key <key>` | Routing key |
| `--severity <list>` | Only events of these comma-separated severities: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`, in any case. Another value is refused |
| `--harness <list>` | Only events from these comma-separated harnesses |
| `--user <ids>` | Only events from these comma-separated user ids |
| `--cooldown <minutes>` | Minimum minutes between two notifications, 1 to 1440 |
| `--enable` | Switch the rule on |
| `--disable` | Switch the rule off |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Changes only what you pass. The channel target options replace the rule's whole target, and the filter options its whole filter set. A rule switched to the `webhook` channel gets a signing secret, printed once; a webhook rule that stays one keeps its secret. You need the OWNER or ADMIN role.

**Example:**

```bash
intutic notifications update nr_abc123 --disable
```

---

## `intutic notifications delete <rule_id>` <Badge type="tip" text="Cloud" />

Delete a notification rule.

```bash
intutic notifications delete <rule_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `rule_id` | The rule, as `intutic notifications list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Deletes the rule. You need the OWNER or ADMIN role.

---

## `intutic notifications rotate-secret <rule_id>` <Badge type="tip" text="Cloud" />

Replace a webhook rule's signing secret.

```bash
intutic notifications rotate-secret <rule_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `rule_id` | A webhook rule |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Generates a new signing secret and prints it once. Deliveries are signed with the new secret from then on, so update the receiver's copy straight away. Only webhook rules are signed; any other rule is refused. You need the OWNER or ADMIN role.

---

## `intutic siem list` <Badge type="warning" text="Biz Org+" />

List the workspace's SIEM export destinations.

```bash
intutic siem list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON, including the valid source names (`sources.all`) and the default set (`sources.defaults`) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each destination's id, name, type, whether it is active, the sources it receives, its batching and its last heartbeat or error. Credentials are never shown. See [SIEM Export](/guide/siem-export).

---

## `intutic siem show <destination_id>` <Badge type="warning" text="Biz Org+" />

Show one SIEM destination.

```bash
intutic siem show <destination_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `destination_id` | The destination, as `intutic siem list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the destination with its adapter config, secrets masked to at most their last four characters.

---

## `intutic siem sources` <Badge type="warning" text="Biz Org+" />

List the event sources a destination can receive.

```bash
intutic siem sources [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON: `all` and `defaults` |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints every source name. The ones marked opt-in, such as `gate_decisions` (one record per tool call), reach only a destination that lists them; a destination with no list receives every other source. See [Choosing sources](/guide/siem-export#choosing-sources).

---

## `intutic siem create` <Badge type="warning" text="Biz Org+" />

Create a SIEM export destination.

```bash
intutic siem create --name <name> --type <adapter> --config <path> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | Display name, up to 128 characters (required) |
| `--type <adapter>` | `syslog_cef`, `webhook_https`, `splunk_hec`, `datadog_logs`, `gcs` or `s3` (required) |
| `--config <path>` | JSON file with the adapter's settings and credentials (required) |
| `--sources <list>` | Comma-separated sources to receive; omit for the default set |
| `--default-sources` | Receive the default set (the same as omitting `--sources`) |
| `--batch-size <n>` | Events per delivery batch (default 100) |
| `--flush-interval-ms <ms>` | Longest wait before a partial batch is sent (default 60000) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Creates the destination. The config is read from a file so credentials stay out of your shell history; each type needs its own keys, e.g. `host` and `port` for `syslog_cef`, `webhookUrl` for `webhook_https`, `hecUrl` and `token` for `splunk_hec`, `apiKey` for `datadog_logs`, `bucketName` and `credentials` (a base64-encoded service-account key) for `gcs`, `bucketName`, `accessKeyId` and `secretAccessKey` for `s3`. The server encrypts the config, refuses one that points at an internal address, and refuses an unknown source name. A `webhook_https` destination gets a signing secret, printed once. You need the OWNER or ADMIN role.

**Example:**

```bash
intutic siem create --name "Splunk prod" --type splunk_hec --config splunk.json \
  --sources governance_incidents,detector_findings,gate_decisions
```

---

## `intutic siem update <destination_id>` <Badge type="warning" text="Biz Org+" />

Change a SIEM destination.

```bash
intutic siem update <destination_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `destination_id` | The destination, as `intutic siem list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--name <name>` | New display name |
| `--config <path>` | JSON file with the new adapter settings; a secret left out, or left as its masked value, keeps the stored one. A webhook's `signingSecret` is always kept: replace it with `intutic siem rotate-secret` |
| `--sources <list>` | Comma-separated sources to receive, replacing the current list |
| `--default-sources` | Go back to the default set |
| `--batch-size <n>` | Events per delivery batch |
| `--flush-interval-ms <ms>` | Longest wait before a partial batch is sent |
| `--enable` | Turn a deactivated destination back on |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Changes only what you pass. A new config makes the events the address check refused before retryable again. You need the OWNER or ADMIN role.

**Example:**

```bash
intutic siem update siemdest_abc123 --default-sources
```

---

## `intutic siem delete <destination_id>` <Badge type="warning" text="Biz Org+" />

Deactivate a SIEM destination.

```bash
intutic siem delete <destination_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `destination_id` | The destination, as `intutic siem list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Stops the destination receiving events. It stays listed with its config, and `intutic siem update <destination_id> --enable` turns it back on. You need the OWNER or ADMIN role.

---

## `intutic siem rotate-secret <destination_id>` <Badge type="warning" text="Biz Org+" />

Replace a webhook destination's signing secret.

```bash
intutic siem rotate-secret <destination_id> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `destination_id` | A `webhook_https` destination |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Generates a new signing secret and prints it once. Deliveries are signed with it from then on. The other types authenticate with their own credentials and are refused. You need the OWNER or ADMIN role.

---

## `intutic tasks list` <Badge type="tip" text="Cloud" />

List the workspace's task-management connections.

```bash
intutic tasks list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Lists each Jira Cloud, Linear and PagerDuty connection with its id, provider, project key, base URL and last sync. The API token is never returned. Any workspace member can list connections.

---

## `intutic tasks add` <Badge type="tip" text="Cloud" />

Connect Jira Cloud, Linear or PagerDuty.

```bash
intutic tasks add --provider <provider> --base-url <url> --project-key <key> [--account-email <email>] (--token <token> | --token-file <path>) [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--provider <provider>` | `jira`, `linear` or `pagerduty` (required) |
| `--base-url <url>` | The provider's base URL, e.g. `https://acme.atlassian.net` (required) |
| `--project-key <key>` | The Jira project key, Linear team key or PagerDuty service key a ticket or incident is matched on (required) |
| `--account-email <email>` | Jira only, and required for Jira: the Atlassian account the API token belongs to |
| `--token <token>` | The provider API token (a Jira API token, a Linear API key, a PagerDuty REST API token) |
| `--token-file <path>` | Read the API token from a file instead, keeping it out of shell history |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Exactly one of `--token` / `--token-file` is required, and the token is never echoed. A Jira connection without `--account-email` is refused before anything is sent. The control plane tests the credentials with the provider and saves the connection only if they are accepted; otherwise it says what to check. The token is stored encrypted and never returned. You need the OWNER or ADMIN role. Connections cannot be edited: to change one, remove it and add it again.

---

## `intutic tasks test <connectionId>` <Badge type="tip" text="Cloud" />

Check a connection's stored credentials with the provider.

```bash
intutic tasks test <connectionId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `connectionId` | The connection, as `intutic tasks list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Asks the provider whether it still accepts the stored token and prints the result. Exits 1 when it does not (a revoked or expired token). You need the OWNER or ADMIN role.

---

## `intutic tasks remove <connectionId>` <Badge type="tip" text="Cloud" />

Remove a task-management connection.

```bash
intutic tasks remove <connectionId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `connectionId` | The connection, as `intutic tasks list` shows it |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Deletes the connection and its stored token; sessions stop picking up its tickets or incidents. Exits 1 when the workspace has no connection with that id. You need the OWNER or ADMIN role.

---

## `intutic compliance coverage <framework_id>` <Badge type="tip" text="Cloud" />

How the latest compliance probe results cover one framework.

```bash
intutic compliance coverage <framework_id> [--format <format>] [--out <path>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `framework_id` | `eu_ai_act`, `iso_42001`, `nist_ai_rmf` or `mitre_atlas` |

**Options:**

| Option | Description |
|--------|-------------|
| `--format <format>` | Download the report instead of the summary: `json`, `md`, `csv` or `pdf` |
| `--out <path>` | Write the report to this file instead of stdout |
| `--json` | The same as `--format json` |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Without `--format`, prints the control counts by coverage and state. With it, writes the report the dashboard downloads: to stdout, so it can be piped, or to `--out`. A PDF needs `--out` or a redirect, never the terminal. Any member can read coverage. These live reports are unsigned; the signed copies are in the evidence pack. See [Framework Mapping](/guide/framework-mapping).

**Example:**

```bash
intutic compliance coverage eu_ai_act --format pdf --out eu-ai-act.pdf
```

---

## `intutic compliance collect` <Badge type="tip" text="Cloud" />

Run a fresh evidence collection and seal it into an archive.

```bash
intutic compliance collect [--from <date>] [--to <date>] [--out <path>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--from <date>` | Start of the evidence period, ISO 8601 (default: 90 days before `--to`). It must be before `--to` and within the probe history kept, 400 days by default |
| `--to <date>` | End of the evidence period, ISO 8601 (default: now) |
| `--out <path>` | Also write the archive to this file |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Runs the compliance probes, maps them onto the SOC 2 trust categories and the four frameworks, and stores the run, as **Collect & export evidence** on the dashboard does. Prints the run id, the overall score and whether the archive is signed; an unsigned one comes with what to configure. OWNER or ADMIN. See [Compliance Evidence](/guide/compliance-evidence#evidence-runs).

---

## `intutic compliance download <run_id>` <Badge type="tip" text="Cloud" />

Download a stored evidence archive.

```bash
intutic compliance download <run_id> [--out <path>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `run_id` | The evidence run (`s2r_…`), as `collect` prints it |

**Options:**

| Option | Description |
|--------|-------------|
| `--out <path>` | Write the archive to this file instead of stdout |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Writes the archive as JSON: to stdout, so it can be piped, or to `--out`. OWNER or ADMIN.

---

## `intutic compliance verify <file>` <Badge type="tip" text="Cloud" />

Check an evidence archive's hashes and signature.

```bash
intutic compliance verify <file> [--jwks <path>] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `file` | An archive from `collect --out`, `download` or the dashboard |

**Options:**

| Option | Description |
|--------|-------------|
| `--jwks <path>` | The published signing keys, saved from `/.well-known/intutic-trace-signing.json`, to verify with no network access |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Recomputes the archive hash and every section hash in the manifest, then checks the Ed25519 signature against the published key its `keyId` names, the steps under [Verifying an archive](/guide/compliance-evidence#verifying-an-archive). Without `--jwks` it fetches the keys from the control plane, without credentials, as an auditor would; an unsigned archive needs no keys. Needs no login.

Exits 0 when the hashes match and a published key accepts the signature. Exits 1 when a hash or the signature does not match: the archive was changed. Exits 2 when the hashes match but the archive is **unsigned** (collected on a deployment without a signing key) or its signature could not be checked (no published key with its id, or the keys could not be fetched); the output says which. Exits 3 when the file cannot be read or is not an evidence archive, or the `--jwks` file is not a key set, so a wrong path is never read as a changed archive.

**Example:**

```bash
curl -s https://<control-plane>/.well-known/intutic-trace-signing.json > keys.json
intutic compliance verify evidence.json --jwks keys.json
```

---

## `intutic usage members` <Badge type="warning" text="Biz Org+" />

LLM usage per member.

```bash
intutic usage members [--period <period>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--period <period>` | `daily` (today) or `monthly` (this month), both in UTC; default `monthly` |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each member's cost, calls, tokens and active days, attributed to the owner of the virtual key that made each call, plus an unattributed row. OWNER, ADMIN and EM see every member; anyone else sees only their own row, and the output says so. See [Budgets & FinOps](/guide/budgets).

---

## `intutic usage teams` <Badge type="warning" text="Biz Org+" />

LLM usage per team, a team being a SCIM group.

```bash
intutic usage teams [--period <period>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--period <period>` | `daily` or `monthly`; default `monthly` |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Sums each SCIM group's members, nested groups included; a member in several groups counts in each. A workspace without SCIM groups has no teams, and the output says so. You need the OWNER, ADMIN or EM role.

---

## `intutic usage branches` <Badge type="warning" text="Biz Org+" />

LLM usage per repository and branch.

```bash
intutic usage branches [--period <period>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--period <period>` | `daily` or `monthly`; default `monthly` |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Groups calls by the git repository and branch the sync daemon reported for the session; calls with no git context form one row. Scoped like `intutic usage members`.

---

## `intutic usage commits` <Badge type="warning" text="Biz Org+" />

LLM usage per HEAD commit.

```bash
intutic usage commits [--period <period>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--period <period>` | `daily` or `monthly`; default `monthly` |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Groups calls by the commit checked out when each was made: the work that led to the next commit. Scoped like `intutic usage members`.

---

## `intutic usage pull-requests` <Badge type="warning" text="Biz Org+" />

LLM usage per GitHub pull request.

```bash
intutic usage pull-requests [--period <period>] [--refresh] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--period <period>` | `daily` or `monthly`; default `monthly` |
| `--refresh` | Look the branches up on GitHub first, instead of waiting for the next scheduled lookup (OWNER, ADMIN or EM) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints each pull request's cost, calls, tokens and developers: the calls on its branch from the previous pull request on that branch (or the branch's first call) until it was merged or closed. Pull requests come from a GitHub source's token or the pull-request webhook. When there is nothing to show, the output says what is missing: a GitHub connection, the token's permission to read pull requests, or any pull request yet. Scoped like `intutic usage members`. See [Cost per pull request](/guide/budgets#cost-per-pull-request).

---

## `intutic github webhook show` <Badge type="warning" text="Biz Org+" />

The workspace's GitHub pull-request webhook.

```bash
intutic github webhook show [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the payload URL to paste into GitHub, when the secret was made and when the last delivery arrived, or that the webhook is not set up. The secret itself is never shown here. You need the OWNER or ADMIN role.

---

## `intutic github webhook rotate-secret` <Badge type="warning" text="Biz Org+" />

Make the pull-request webhook, or replace its secret.

```bash
intutic github webhook rotate-secret [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints the payload URL and a new signing secret, once. The URL stays the same when the secret is replaced; deliveries signed with the old secret are refused from then on, so paste the new one into the webhook on GitHub straight away. You need the OWNER or ADMIN role.

---

## `intutic inventory summary` <Badge type="tip" text="Cloud" />

Counts of the AI tools on connected developer machines.

```bash
intutic inventory summary [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints how many machines report (and how many are stale), how many harnesses are governed, ungoverned, gate-stale or unverified, how many MCP servers run ungoverned, and how many skill bundles there are. OWNER, ADMIN and EM see every machine; a DEVELOPER sees only their own; VIEWER is refused. See [AI inventory](/guide/ai-inventory).

---

## `intutic inventory devices` <Badge type="tip" text="Cloud" />

Every machine that reports, with its id.

```bash
intutic inventory devices [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per machine: its device id (the value `--device` takes on the other inventory commands), hostname, platform and CLI version, whether it is stale or disconnected, how many harnesses it runs and how many of those are ungoverned or have a stale gate, and its last report. `--json` adds the guard-probe result. Visibility is as for `intutic inventory summary`.

---

## `intutic inventory harnesses` <Badge type="tip" text="Cloud" />

AI harnesses by machine, with gate state and status.

```bash
intutic inventory harnesses [filters] [--csv [--out <path>]] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--status <status>` | Only `governed`, `ungoverned`, `gate_stale` or `unverified` rows |
| `--harness <harness>` | Only rows for this harness, e.g. `cursor` |
| `--device <device_id>` | Only rows from this machine |
| `--search <text>` | Only rows whose harness or hostname contains this text |
| `--csv` | Download as CSV, the file **Export CSV** gives on the dashboard |
| `--out <path>` | With `--csv`: write to this file instead of stdout |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per harness per machine with its status, and why when it is not governed. The filters apply on the server, to the list and the CSV alike. Visibility is as for `intutic inventory summary`.

**Example:**

```bash
intutic inventory harnesses --status ungoverned --csv --out ungoverned.csv
```

---

## `intutic inventory mcp-servers` <Badge type="tip" text="Cloud" />

MCP servers by machine, wrapped by the MCP proxy or not.

```bash
intutic inventory mcp-servers [filters] [--csv [--out <path>]] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--status <status>` | Only `governed` or `ungoverned` rows |
| `--harness <harness>` | Only servers configured in this harness |
| `--device <device_id>` | Only rows from this machine |
| `--search <text>` | Only rows whose server name or hostname contains this text |
| `--csv` | Download as CSV, the file **Export CSV** gives on the dashboard |
| `--out <path>` | With `--csv`: write to this file instead of stdout |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per MCP server per machine, with its harness, transport and status. Visibility is as for `intutic inventory summary`.

---

## `intutic inventory skills` <Badge type="tip" text="Cloud" />

Skill bundles by machine, with their content scan result.

```bash
intutic inventory skills [--device <device_id>] [--search <text>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--device <device_id>` | Only rows from this machine |
| `--search <text>` | Only rows whose skill name or hostname contains this text |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per skill bundle per machine: its name, the folder it was found in, whether the [content scan](/guide/skill-scanning) found anything (or could not read it), and how many files are bundled with it. `--json` adds each bundle's `SKILL.md` SHA-256. Visibility is as for `intutic inventory summary`.

---

## `intutic inventory disconnects` <Badge type="tip" text="Cloud" />

Machines that ran `intutic disconnect`, newest first.

```bash
intutic inventory disconnects [--limit <n>] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--limit <n>` | At most this many (default 100, at most 500) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints one line per reported [disconnect](#intutic-disconnect): when, the machine's hostname, which harnesses it disconnected (or every harness, for a whole-machine disconnect), and the member whose credentials reported it. Visibility is as for `intutic inventory summary`: a DEVELOPER sees only the disconnects their own credentials reported.

---

## `intutic gate-liveness` <Badge type="tip" text="Cloud" />

Whether each installed harness's gate is reporting.

```bash
intutic gate-liveness [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Prints, per harness installed in the workspace, whether its gate is `reporting` (an event inside the liveness window), `silent` (installed long enough to have reported, and has not) or `new` (too recently installed to tell), when its gate and its agent were last heard from, and whether a silent-gate alert is open. You need the OWNER, ADMIN or EM role.

---

## `intutic exec`

Execute a command wrapped with Intutic proxy environment variables.

```bash
intutic exec -- <command> [args...]
intutic exec --sandbox -- <command> [args...]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `command...` | Command and arguments to execute (e.g. `-- claude`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--sandbox [kind]` | Run the agent in an isolated sandbox instead of directly on the host. `kind` is `oci` (default) or `firecracker`. See [Sandboxed Execution](/guide/sandboxed-execution) for what each backend actually isolates and requires. |
| `--sandbox-image <image>` | Sandbox image — must contain the agent, `nftables`, and `capsh`. Default: `intutic/sandbox:<CLI version>`, built locally from the Dockerfile shipped with the CLI on first use; it has no agent, so extend it ([Sandboxed Execution](/guide/sandboxed-execution)). `intutic/sandbox:<CLI version>-node` adds Node.js and npm, the base for Node agents such as Claude Code, and is built on first use the same way. |
| `--sandbox-memory <size>` | Sandbox memory cap, e.g. `2g`. Default: `2g`. |
| `--sandbox-cpus <n>` | Sandbox CPU cap. Default: `2`. |
| `--sandbox-pids <n>` | Sandbox max process count. Default: `512`. |
| `--sandbox-allow <cidrs>` | Comma-separated extra destination CIDRs the sandbox may reach beyond the proxy and DNS. |

If the workspace's sandbox requirement is set to **Require** (Settings →
Security → Sandboxed Execution) and `--sandbox` is omitted, the command
refuses to run rather than executing ungoverned on the host.

**What it does:**
Injects the proxy environment into the child process, then spawns it with inherited stdio and exits with the child's exit code. The injected variables cover the competing SDK conventions:

| Variable | Consumers |
|----------|-----------|
| `OPENAI_API_BASE` | LiteLLM, LangChain, CrewAI, ADK, Aider |
| `OPENAI_BASE_URL` | OpenAI Python SDK v1+, Pydantic-AI, Agent SDK |
| `OPENAI_API_BASE_URL` | OpenWebUI |
| `OPENAI_HOST` | Goose (host only, no `/v1`) |
| `ANTHROPIC_BASE_URL` | Claude Code, Anthropic SDK (host only) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `INTUTIC_API_KEY` | The workspace API key, when you are logged in |
| `INTUTIC_GRAPH_ID` / `INTUTIC_NODE_ID` / `INTUTIC_PARENT_ID` / `INTUTIC_DEPTH` | A nested `intutic exec` and the [Clawde SDK](/reference/clawde-sdk): the [agent graph](/guide/graph-guardrails) this agent belongs to |
| `ANTHROPIC_CUSTOM_HEADERS` | Claude Code: the same identity as `X-Intutic-*` headers, after any headers already set |

The base-URL variables point at the local proxy, `http://localhost:4000`, or at
`INTUTIC_PROXY_URL` when it is set; inside `--sandbox` they point at the host the proxy runs on.
Each carries the agent-graph identity as a path prefix (`/_i/<graph>/<node>/<parent>/<depth>`),
which the proxy strips before routing; the `OPENAI_*` URLs other than `OPENAI_HOST` end in `/v1`.

**Without a login** (open core, with [`intutic start`](#intutic-start) running) only the base URLs
change: the agent keeps the provider keys already in its environment, and the standalone proxy
passes them through to the provider. With `--sandbox`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
are handed into the container for the same reason.

**Logged in**, the key variables are set to the workspace key, the workspace's sandbox requirement
applies, and a sandboxed run is recorded as a session.

**Examples:**

```bash
intutic exec -- claude
intutic exec -- aider --model openai/gpt-4o
intutic exec -- python my_agent.py
```

---

## `intutic chaos run`

Run a chaos experiment: the agent with a known fault injected, in the sandbox, scored. See [Chaos Engineering for Agents](/guide/chaos-engineering).

```bash
intutic chaos run <file> [--sandbox-image <image>] [--out <report.json>] [--keep]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `file` | Experiment file (YAML) |

**Options:**

| Option | Description |
|--------|-------------|
| `--sandbox-image <image>` | Sandbox image; must contain the agent. Overrides the experiment's `sandbox_image`. Default: the [`intutic exec --sandbox`](#intutic-exec) image. For a Node agent, extend `intutic/sandbox:<CLI version>-node` ([Bring your agent](/guide/chaos-engineering#bring-your-agent)). |
| `--out <report.json>` | Where to write the JSON report. Default: `intutic-chaos/report-<name>-<timestamp>.json` under the OS temp directory. The path is printed. |
| `--keep` | Keep each repetition's git worktree instead of removing it. |

Refuses to start without a clean git working tree (each repetition is a fresh worktree of `HEAD`) or without an available sandbox backend; it never runs the agent on the host. Runs `repeat` baseline repetitions, then `repeat` faulted ones, each behind a dedicated proxy on a free port. Each worktree gets the project's generated gates, its Claude Code, Codex and Cursor project hook settings and the policy snapshot, with the project's path rewritten to `/work`; the output names what was carried in and warns when the project has no gates ([Bring your agent](/guide/chaos-engineering#bring-your-agent)). Exits 0 when the run is scored, 1 when it was aborted or refused to start (or the file is invalid), 2 when the run is invalid (the baseline failed `verify`).

---

## `intutic chaos validate`

Check a chaos experiment file against the experiment schema and print each error with the path of the field.

```bash
intutic chaos validate <file>
```

| Argument | Description |
|----------|-------------|
| `file` | Experiment file (YAML) |

Exits 1 when the file is invalid.

---

## `intutic chaos list`

Print the fault catalog: each fault, the component that injects it (proxy, MCP proxy or gate) and its safety class (fail-safe or mutating), and where the example experiments are.

```bash
intutic chaos list
```

---

## `intutic env persist`

Persist `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` at the OS level so new terminals and applications reach the proxy.

```bash
intutic env persist [--proxy-url <url>]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--proxy-url <url>` | Proxy base URL both variables are set to | `http://localhost:4000` |

**What it does:**

Sets exactly two variables, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, both to `--proxy-url`. It sets no API keys and none of the other variables [`intutic exec`](#intutic-exec) injects. The mechanism depends on the OS:

| OS | Mechanism | Scope |
|----|-----------|-------|
| macOS | `launchctl setenv` | Every application launched afterwards, including GUI apps, until you log out or restart |
| Linux (as root) | Writes `KEY="<url>"` lines to `/etc/environment`, replacing any earlier lines for the two variables | System |
| Linux (otherwise) | Appends `export KEY="<url>"` lines to `~/.bashrc`, each tagged with an `# intutic-env-<KEY>` marker; a re-run replaces the earlier lines | User |
| Windows | `setx` | User |

Terminals that are already open keep their old environment until you restart them or re-source your shell profile. On any other platform the command exits with status `1`.

This is opt-in on purpose: on macOS it reaches every GUI application you start afterwards. To route a single command instead, use `intutic exec`.

**Examples:**

```bash
intutic env persist
intutic env persist --proxy-url http://localhost:8080
```

---

## `intutic env clear`

Remove the variables written by `intutic env persist`.

```bash
intutic env clear
```

No options.

**What it does:**

Removes `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`: `launchctl unsetenv` on macOS, and the values in `HKCU\Environment` on Windows. On Linux it deletes the marked lines from `~/.bashrc`, leaving the rest of the file exactly as it was, and, when run as root, the two variables' lines from `/etc/environment`. Running it when nothing is set is not an error. Already-open terminals keep the old values until restarted.

---

## `intutic enforce`

Manage the mandatory default-deny egress firewall — makes the governing
proxy non-optional by dropping outbound traffic to everything except the
proxy, DNS, and operator-declared infrastructure. Where
[Network Egress Control](/guide/policies#network-egress-control) governs
traffic the proxy *sees*, `intutic enforce` closes the gap where an agent
simply doesn't route through the proxy at all: with it applied, there is
no other way out.

```bash
intutic enforce <action> [options]
```

**Actions:**

| Action | Privilege | What it does |
|--------|-----------|---------------|
| `generate` | None | Prints the platform firewall ruleset without applying it. |
| `apply` | Root | Applies the default-deny egress firewall. All egress except the proxy, DNS, and `--allow` infrastructure is dropped. |
| `remove` | Root | Removes the Intutic egress firewall. |
| `status` | None | Reports whether the egress firewall is currently applied. |
| `report` <Badge type="tip" text="Cloud" /> | None (needs `intutic login`) | Reports the locally recorded enforcement state (firewall, CA-trust, system-hooks posture) to the control plane. For when `apply`/`remove` ran elevated and couldn't reach stored credentials. |

**Options** (`apply`/`remove`/`status`/`generate`):

| Option | Description |
|--------|-------------|
| `--port <port>` | The proxy's listener port to permit. Default: `4000`; neither `PORT` nor `INTUTIC_PROXY_URL` is read, so pass it when the proxy listens elsewhere. |
| `--uid <uid>` | uid the proxy runs as, exempted from the deny. Defaults to you: the user the command runs as, or under `sudo` the user who invoked sudo (`SUDO_UID`), not root. Pass it when the proxy runs as a different account. |
| `--allow <cidrs>` | Comma-separated extra destinations to permit (control plane, private registries, etc.), each an IP address or CIDR block. A hostname is refused before anything is applied: resolve it to its address range first. |
| `--no-dns` | Also deny outbound DNS — only if a local resolver serves the host. |
| `--platform <os>` | Target ruleset platform: `linux`, `macos`, or `windows`. Defaults to the current OS. |

**What it does:**

Implemented in the `intutic-proxy` binary's own `enforce` subcommand
(platform-aware: nftables or iptables on Linux, `pf` on macOS); the CLI
command is a thin, discoverable wrapper around it. `apply`/`remove`
change the host firewall and need root — re-run with `sudo` if it fails
with a permission error. After a successful `apply`/`remove`, the CLI
re-queries status while still elevated and best-effort reports the result
to the control plane, so an admin can see whether enforcement is actually
active on a given machine without SSHing into it.

**Examples:**

```bash
# See what would be applied, without changing anything
intutic enforce generate

# Apply, permitting an internal network and a package registry's address range too
sudo intutic enforce apply --allow 10.0.0.0/8,203.0.113.0/24

# Check whether it's currently active
intutic enforce status

# Remove it
sudo intutic enforce remove
```

---

## `intutic enterprise install` <Badge type="danger" text="Enterprise" />

Prepare a managed fleet: write MDM manifests and, when run with admin/root privilege, trust the Intutic CA system-wide and install system-level Cursor hooks.

```bash
intutic enterprise install [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--proxy-url <url>` | Proxy base URL embedded in the generated Cursor hook script. Trailing slashes are removed. | `$INTUTIC_PROXY_URL`, else `http://localhost:4000` |
| `--generate-mdm-only` | Only write the MDM manifests; skip CA trust and system hooks. Needs no privilege. | — |
| `--mdm-output-dir <dir>` | Directory the MDM manifests are written to (created if missing) | `./intutic-mdm` |
| `--skip-ca` | Skip system-wide CA trust installation | — |
| `--skip-hooks` | Skip the Cursor hooks installation | — |
| `--dev` | Send the device report to the local control plane (`http://localhost:3001`) instead of the one chosen as in [Choosing a control plane](#control-plane-url) | — |
| `--cli-binary-path <path>` | Absolute path of the `intutic` binary on the *target* machines, written into the firewall manifests | `/usr/local/bin/intutic` |

**What it does:**

1. Reads the proxy's CA certificate from `~/.intutic/ca.crt`. The proxy creates it on first run, so run `intutic start` (or `intutic connect`) once first; if the file is missing the command exits with status `1`.
2. Writes nine manifests to `--mdm-output-dir` (no privilege needed):
   - `intutic-governance.mobileconfig` — CA trust profile
   - `cursor-hooks-jamf.json` / `cursor-hooks-intune.json` — Cursor system hooks for Jamf / Intune
   - `gemini-cli-hooks-jamf.json` / `gemini-cli-hooks-intune.json` — the Gemini CLI gate in Gemini CLI's system settings file, which it applies over user and workspace settings
   - `antigravity-hooks-jamf.json` / `antigravity-hooks-intune.json` — the Google Antigravity gate for each user's `~/.gemini/config/hooks.json` (Antigravity has no machine-wide hooks file)
   - `jamf-firewall-manifest.json` / `intune-firewall-manifest.json` — a recurring managed script that runs `<cli-binary-path> enforce apply` with root/administrator privilege, so the egress firewall is re-applied on every check-in. On macOS and Linux it passes `--uid` for the user signed in at the console (the owner of `/dev/console`, or the active `seat0` session's user), whose proxy is then exempt from the deny

   With `--generate-mdm-only` the command stops here.
3. Checks for admin/root privilege. If the shell is not elevated it prints a warning and still attempts the remaining steps.
4. Unless `--skip-hooks`: writes the Cursor hook script to `<workspace>/.intutic/hooks/cursor-check.js` and a `hooks.json` pointing at it in `<workspace>/.cursor/`, `~/.cursor/`, and the system location (`/Library/Application Support/Cursor/` on macOS, `/etc/cursor/` on Linux, `%ProgramData%\Cursor\` on Windows). The workspace is the one recorded by `intutic init`, or the current directory. If you are logged in, your workspace ID is embedded in the hook's event payloads; without a login it is left empty.
5. Unless `--skip-ca`: trusts `~/.intutic/ca.crt` system-wide — the System keychain via `security add-trusted-cert` on macOS; `update-ca-certificates` (Debian/Ubuntu) or `update-ca-trust` (RHEL/Fedora) on Linux; the Root store via `certutil` on Windows.
6. Records the outcome in a machine-wide state file (`/Library/Application Support/Intutic/enforcement-state.json` on macOS, `/var/lib/intutic/enforcement-state.json` on Linux, `%ProgramData%\Intutic\enforcement-state.json` on Windows). If you are logged in, it also reports that state to the control plane; this is best-effort and never fails the command.
7. Prints the next step. This command never changes the host firewall — use [`intutic enforce apply`](#intutic-enforce) for that.

A failed CA-trust or hooks step is printed as an error but does not change the exit status. A login is optional: it only adds the workspace ID to the hooks and enables the device report.

The CA certificate, config, and credentials are read from `~/.intutic` of the user the command runs as. Under `sudo`, check that this resolves to the home directory where the proxy created `ca.crt`.

**Examples:**

```bash
# Manifests only, for upload to Jamf or Intune
intutic enterprise install --generate-mdm-only --mdm-output-dir ./mdm

# Full install on this machine
sudo intutic enterprise install --proxy-url http://localhost:4000

# Fleet installs the CLI somewhere other than /usr/local/bin
intutic enterprise install --generate-mdm-only --cli-binary-path /opt/intutic/bin/intutic
```

---

## `intutic daemon install`

Install sync-daemon as a system service (auto-starts on login, restarts on any exit).

```bash
intutic daemon install --workspace-id <id> --api-key <key> [options]
intutic daemon install --proxy [--port <port>] [--valkey-url <url>] [--upstream-url <url>]
```

Also available as the top-level shortcut `intutic install-daemon`, with the same options and defaults.

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--workspace-id <id>` | Workspace ID, e.g. `wk_xxxx` (required unless `--proxy`) | — |
| `--api-key <key>` | Workspace API key, e.g. `vk_xxxx` (required unless `--proxy`) | — |
| `--control-plane-url <url>` <Badge type="tip" text="Cloud" /> | Control plane the sync-daemon or MCP daemon connects to, written into the service | Resolved as in [Choosing a control plane](#control-plane-url): `INTUTIC_CONTROL_PLANE_URL` (or `INTUTIC_DEV=1`), then a workspace initialized with `intutic init --dev`, then the URL saved by `intutic login`; this release has no default |
| `--binary-path <path>` | Path to the `intutic` CLI binary; with `--proxy`, an absolute path to `intutic-proxy` | _(current process; with `--proxy`, the launcher's pinned binary, then `intutic-proxy` on PATH)_ |
| `--dry-run` | Print what would be done without writing files | — |
| `--system` | Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux) | — |
| `--mcp` | Install the MCP proxy daemon instead of the sync-daemon | — |
| `--proxy` | Install the standalone `intutic-proxy` binary as a service — no workspace or key needed | — |
| `--port <port>` | With `--proxy`: proxy listen port (`PORT`) | The port of `INTUTIC_PROXY_URL`, else `4000` |
| `--valkey-url <url>` | With `--proxy`: Valkey to attach to (`VALKEY_URL`); omitted, the unit sets `INTUTIC_STANDALONE=1` | — |
| `--upstream-url <url>` | With `--proxy`: upstream LLM provider base URL (`UPSTREAM_URL`) | — |

**Service files written:**
- macOS: `~/Library/LaunchAgents/ai.intutic.sync-daemon.plist` (`KeepAlive: true`)
- Linux: `~/.config/systemd/user/intutic-sync-daemon.service` (`Restart=always`)
- With `--proxy`: `~/Library/LaunchAgents/ai.intutic.proxy.plist` / `~/.config/systemd/user/intutic-proxy.service`, running the binary with the same environment [`intutic start`](/integrations/standalone#option-c-native-npm-binary-runner-npx-intutic-proxy) sets. The binary path must be absolute — neither launchd nor systemd searches `PATH`.

Because the service restarts on any exit, stopping it requires `intutic daemon stop`, `intutic daemon uninstall`, or `launchctl unload`.

---

## `intutic daemon uninstall`

Remove the sync-daemon system service and stop it permanently.

```bash
intutic daemon uninstall [options]
```

Also available as the top-level shortcut `intutic uninstall-daemon`, with the same options.

**Options:**

| Option | Description |
|--------|-------------|
| `--dry-run` | Print what would be done without writing files |
| `--system` | Uninstall the system-level service |
| `--mcp` | Uninstall the MCP proxy daemon instead of the sync-daemon |
| `--proxy` | Uninstall the standalone `intutic-proxy` service instead of the sync-daemon |

---

## `intutic daemon status`

Show sync-daemon system service status. With `--proxy` or `--mcp`, the same for the standalone proxy service or the MCP proxy daemon.

```bash
intutic daemon status
intutic daemon status --proxy
intutic daemon status --mcp
```

**Options:**

| Option | Description |
|--------|-------------|
| `--proxy` | Show the standalone `intutic-proxy` service installed by `daemon install --proxy` instead of the sync-daemon. |
| `--mcp` | Show the MCP proxy daemon instead of the sync-daemon. |

---

## `intutic daemon start`

Start and load the sync-daemon system service. With `--proxy` or `--mcp`, the same for the standalone proxy service or the MCP proxy daemon.

```bash
intutic daemon start
intutic daemon start --proxy
intutic daemon start --mcp
```

**Options:**

| Option | Description |
|--------|-------------|
| `--proxy` | Start the standalone `intutic-proxy` service installed by `daemon install --proxy` instead of the sync-daemon. |
| `--mcp` | Start the MCP proxy daemon instead of the sync-daemon. |

---

## `intutic daemon stop`

Stop and unload the sync-daemon system service. With `--proxy` or `--mcp`, the same for the standalone proxy service or the MCP proxy daemon.

```bash
intutic daemon stop
intutic daemon stop --proxy
intutic daemon stop --mcp
```

**Options:**

| Option | Description |
|--------|-------------|
| `--proxy` | Stop the standalone `intutic-proxy` service installed by `daemon install --proxy` instead of the sync-daemon. |
| `--mcp` | Stop the MCP proxy daemon instead of the sync-daemon. |

---

## `intutic rollback`

List or restore file pre-images captured when a guard flagged a call and let
it proceed. This is the *restore* half of the mechanism — the
*capture* half runs automatically inside the generated harness hook when a
`warn`-tier guard fires, if capture is enabled.

```bash
intutic rollback              # list captured pre-images
intutic rollback --id <id>    # restore one
```

**Options:**

| Option | Description |
|--------|-------------|
| `--list` | List captured pre-images. The default when `--id` is omitted. |
| `--id <id>` | Restore the named pre-image. |

**Capture is opt-in and narrowly scoped** — set
`"captureRollbackPreImages": true` in `.intutic/config.json`. It's off by
default because it stores copies of flagged files locally. It only captures
on the `warn` enforcement tier: a `KILL`ed call never executes (nothing to
revert), and a `require`-tier violation is refused before it runs — capture
exists for the one case where a call was flagged *and allowed to proceed
anyway*, so there's a "before" worth keeping. Bounded to 2 MiB per file and
50 retained entries.

**What it does:**

- With no `--id`: lists every captured pre-image (id, capture time, tool,
  target path, byte size or "file did not exist") and prints the restore
  command for each.
- With `--id <id>`: restores exactly that pre-image and nothing else — there
  is no `--all` and no implicit "latest". Before restoring, the *current*
  contents of the target are themselves captured as a new pre-image, so the
  restore is itself undoable. The restore is appended to the same
  `.intutic/events/hook-events.jsonl` log the gate writes to
  (`tool_reverted`), so the audit trail reads "flagged → allowed →
  reverted", not a file that silently changed back. If the pre-image's
  stored blob was evicted by the retention ceiling, the command refuses
  rather than performing a partial restore.

**Examples:**

```bash
# See what's available to restore
intutic rollback

# Restore a specific one (id comes from the list above)
intutic rollback --id a1b2c3d4e5f60718
```

---

## Environment variables

Environment variables the CLI, and the hook gates and proxy it sets up, read. Command-line flags take precedence where both exist.

| Variable | Read by | Effect |
|----------|---------|--------|
| `INTUTIC_CONTROL_PLANE_URL` | Every command that calls a control-plane API | The control plane to use, ahead of a workspace initialized with `intutic init --dev` and the one saved by `intutic login`, and behind a `--control-plane-url` or `--dev` flag. See [Choosing a control plane](#control-plane-url). |
| `INTUTIC_DEV` | Every command that calls a control-plane API | `1` targets the local control plane at `http://localhost:3001`, the same as `--dev`, unless `INTUTIC_CONTROL_PLANE_URL` is set. Any other value is ignored. |
| `INTUTIC_PROXY_URL` | `intutic exec`, `start`, `connect`, `budget`, `doctor`, `daemon install --proxy`, `enterprise install`, and the setup output of `init` and `connect` | Base URL of the local proxy, default `http://localhost:4000`. Its port is the one every command uses: `start`, `connect` and `daemon install --proxy` run the proxy there unless `--port` says otherwise, and `budget` and `doctor` probe it there. `exec` points the child process's SDK variables at it. `enterprise install` uses it when `--proxy-url` is not given. `init` and `connect` print it as your gateway endpoint (with `/v1` appended). The shell's `PORT` is not read. `intutic enforce` reads neither: its `--port` defaults to `4000`. |
| `VALKEY_URL` | `intutic start`, `intutic connect` | Valkey/Redis the proxy uses. `start` passes it through only when a Valkey is reachable on `--valkey-port`; otherwise it uses `redis://127.0.0.1:<valkey-port>`. `connect` defaults to `redis://127.0.0.1:6379`. |
| `CONTROL_PLANE_URL` | `intutic start` | When set and no Valkey is available, `start` does not force standalone mode; the proxy treats the run as a managed deployment and requires Valkey. The CLI does not use it to choose a control plane. |
| `INTUTIC_SNAPSHOT_RULES` | Hook gates, `intutic policy snapshot`, `intutic doctor` | Path of the policy snapshot file the gates enforce. Default `~/.intutic/hooks/policy-snapshot.rules`. `policy snapshot` writes into this path's directory and always names the file `policy-snapshot.rules` (it warns if your path uses another name); `doctor` checks this path. |
| `INTUTIC_GUARD_DISABLE` | Hook gates | `1` makes the gates skip the snapshot's destructive-command rules. The built-in protections (protected paths, bypass guards) and your workspace's own SOP block rules still apply. Every gated tool call while it is set is recorded as a `guards_disabled` event; once `intutic connect` uploads those events, the control plane opens a HIGH-severity incident for each affected session. |
| `INTUTIC_SKIP_GLOBAL_HOOKS` | `intutic connect` (Claude Code hooks) | Any non-empty value stops the sync daemon from writing Intutic's hooks and deny rules into `~/.claude/settings.json`. The project's `.claude/settings.json` is still written. |
| `INTUTIC_OPA_BIN` | `intutic rules build` | The OPA binary used to compile Rego. Default `opa` on the `PATH`. |
| `INTUTIC_WASM_DIR` | `intutic policy install`, `intutic policy list-local`, the proxy | Directory for local WASM rules. Default `~/.intutic/wasm`; a leading `~/` is expanded. Set it the same way for the CLI and the proxy. |
| `INTUTIC_FC_KERNEL` | `intutic exec --sandbox firecracker` | Path to the guest kernel image. Required; no default. |
| `INTUTIC_FC_ROOTFS` | `intutic exec --sandbox firecracker` | Path to the guest root filesystem image containing your agent. Required; no default. |
| `INTUTIC_FC_GUEST_KEY` | `intutic exec --sandbox firecracker` | Path to the private ssh key the rootfs's sshd accepts for `root`; the agent runs in the guest over ssh. Required: without it, or if the file cannot be read, the run fails with exit `2` before the microVM is set up. |
| `INTUTIC_FC_TAP` | `intutic exec --sandbox firecracker` | Host tap device name. Default `tap-intutic`. |
| `INTUTIC_FC_GUEST_IP` | `intutic exec --sandbox firecracker` | Guest IP on the tap link. Default `172.16.0.2`. |
| `INTUTIC_FC_HOST_IP` | `intutic exec --sandbox firecracker` | Host IP on the tap link; the guest reaches the proxy here. Default `172.16.0.1`. |
| `INTUTIC_FC_PREFIX` | `intutic exec --sandbox firecracker` | Prefix length of the tap link. Default `30`. |
| `INTUTIC_FC_VCPUS` | `intutic exec --sandbox firecracker` | Guest vCPU count. Default `1`. |
| `INTUTIC_FC_MEM` | `intutic exec --sandbox firecracker` | Guest memory in MiB. Default `512`. |

The control plane itself is chosen as described in [Choosing a control plane](#control-plane-url).
