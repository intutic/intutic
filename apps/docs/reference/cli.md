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

All commands support:

| Option | Description |
|--------|-------------|
| `--version` | Show CLI version |
| `--help` | Show help for command |

---

## `intutic init`

Initialize workspace — detect harnesses, configure sync.

```bash
intutic init [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
1. Scans the workspace for all harness config files
2. Creates a workspace on the control plane
3. Generates a virtual API key (`vk_*`)
4. Writes governance config into each detected harness file

---

## `intutic setup`

Guided setup wizard — detect harnesses, configure a provider credential, verify it, and
optionally choose a judge model, in one interactive flow. Unlike `intutic init`, this command
prompts; it is the interactive counterpart, not a replacement — `init` stays flag-driven and
safe for CI. See [the cohort wizard guide](/guide/cohort-wizard) for a full narrative walkthrough
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
   `intutic credentials set` hits) or writes the local env file
6. Optionally picks a judge model from [Intutic's model catalog](/reference/model-catalog) (or a
   custom name), saves it (same route the dashboard's Settings → LLM Judge panel uses), and — in
   connected mode — runs the same test round-trip the panel's own Test button does, reporting
   which stage (shape/provider/completion) it reached

**Examples:**

```bash
# Connected to Intutic (requires `intutic login` first)
intutic setup

# Against a local control plane
intutic setup --dev
```

---

## `intutic judge configure`

Generate the local artifacts an on-prem LLM-as-judge needs: a `litellm_config.yaml`, an env
block, and a Helm values snippet. Writes files only — it never calls a remote API, since
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

**What it does:**
1. Prompts for a judge model — from the model catalog (any provider, not filtered to ones
   Intutic's managed gateway can route to, since a local LiteLLM instance can serve anything) or
   a custom model reference
2. Writes a `litellm_config.yaml` `model_list` entry in the same shape
   `infra/compose/litellm_config.yaml`'s hand-written example uses
3. Prints the env block (`INTUTIC_GATEWAY_LOCAL_JUDGE`, `LITELLM_LOCAL_URL`,
   `LITELLM_LOCAL_API_KEY`, `LITELLM_LOCAL_JUDGE_MODEL`) for Docker/bare-metal deployments
4. Prints the Helm values snippet (`proxy.localJudge`, `litellm.enabled`, `litellm.judgeModel`)
   for `tools/helm/intutic-gateway`

**Example:**

```bash
intutic judge configure --out ./infra/compose/litellm_config.yaml
```

---

## `intutic login`

Authenticate with the Intutic control plane.

```bash
intutic login [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Authenticate with an API key (`vk_*`) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**Examples:**

```bash
# Browser-based login
intutic login

# API key login
intutic login --api-key vk_abc123def456

# Local dev
intutic login --dev
```

---

## `intutic logout`

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
- Current authentication state
- Detected harnesses and their config paths
- Sync state (last sync timestamp, any errors)

---

## `intutic whoami`

Show current authenticated identity.

```bash
intutic whoami [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic connect`

Start sync daemon — bidirectional config sync with control plane.

```bash
intutic connect [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--dev` | Use local control plane (`http://localhost:3001`) | — |
| `--interval <ms>` | Poll interval in milliseconds | `30000` |

**Examples:**

```bash
# Default (30s poll)
intutic connect

# 10 second poll interval
intutic connect --interval 10000

# Local dev with fast polling
intutic connect --dev --interval 5000
```

The daemon runs in the foreground. Use `Ctrl+C` to stop.

**Bidirectional Config Capture**:
When running, the sync daemon polls the workspace settings. If `FF_CONFIG_CAPTURE=true` is enabled, it periodically reads and hashes all detected harness configuration files (e.g. `.cursorrules`, `CLAUDE.md`, `.clinerules`) every N iterations (set by `CONFIG_CAPTURE_INTERVAL`, defaulting to 5, which corresponds to ~2.5 minutes on a 30s interval). It uploads these rule snapshots to the control plane, enabling visual audit trails, config diff histories, and rollback triggers in the dashboard.

---

## `intutic traces list`

List execution traces for the workspace.

```bash
intutic traces list [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Number of traces to show (1–100) | `20` |
| `--since <duration>` | Time window: `30m`, `24h`, `7d` | `24h` |
| `--action <type>` | Filter by enforcement action | _(all)_ |
| `--model <name>` | Filter by model name | _(all)_ |
| `--json` | Output as JSON instead of table | `false` |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**Enforcement action filter values:** `BYPASS`, `ENHANCE`, `HIJACK`, `KILL`

**Examples:**

```bash
# Last 20 traces from past 24 hours
intutic traces list

# All KILL actions from the past week
intutic traces list --action KILL --since 7d

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

Returns full trace detail including token counts, costs, compliance scores, anomaly data, and corrective prompt card.

---

<!-- ENTERPRISE_ONLY_START -->
## `intutic integrity roots`

List the sealed Merkle roots for the workspace, newest first. Roots are sealed by the control
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

## `intutic integrity verify <root_id>`

Re-derive one root from the traces that are in the database **now**, and check its signature
against the published key the root itself names.

```bash
intutic integrity verify <root_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**Exit status — this is the point of the command.** It is designed to be a CI step, so it is
deliberate about which findings are failures:

| Result | Exit | Meaning |
|--------|:----:|---------|
| Re-derivation `match` | `0` | The stored root is the root of the traces on disk. |
| Re-derivation mismatch | `1` | A covered trace changed after sealing. |
| `missing_traces` | `1` | A covered trace is gone. The leaf survives it, so the root still names it. |
| Signature `valid` | `0` | Verified against the key the root names. |
| Signature `invalid` | `1` | A key we hold **rejected** it. |
| Signature `unverifiable` | `0` | The root names a key the JWKS does not publish — a key-retention gap, not evidence of forgery. |
| Signature `unsigned` | `0` | The deployment seals roots without signing them, which is supported. |
| `keys_unavailable` | `0` | The JWKS could not be fetched. No verdict was reached, so none is reported. |

The distinction between **invalid** and **unverifiable** is load-bearing. A rotated-out key
that was never added to `TRACE_SIGNING_RETIRED_KEYS` would otherwise turn every historical
root into an apparent forgery and your pipeline red. The command never falls back to "some
other published key that happens to verify" — a signature that checks out under a different
key is a different claim.

**Example:**

```bash
intutic integrity verify tmr_abc123
```

---

## `intutic integrity chain`

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

---

## `intutic integrity config-chain`

Walk the harness **config snapshot** chain and re-hash every stored body. Each snapshot in
`harness_config_snapshots` records a `content_hash` of its own body and the `previous_hash` of
the snapshot before it, per harness type and file path — this is the command that reads them.

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
`0` — nothing was verified, so there is nothing to have failed. If you expected snapshots, the
sync daemon is not reaching the control plane.

Only the most recent 500 snapshots are walked. When older ones exist the report says so: an
intact window is not an intact history.

<!-- ENTERPRISE_ONLY_END -->

---

<!-- ENTERPRISE_ONLY_START -->
## `intutic gateway register`

Register a [self-hosted gateway](/external/self-hosted-gateway) — an org's own Docker,
Kubernetes, or bare-metal deployment of the Intutic proxy — and print its one-time management
token.

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

## `intutic gateway list`

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

## `intutic gateway status <gateway_id>`

Live, heartbeat-derived status for one gateway.

```bash
intutic gateway status <gateway_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Reports `online`, `degraded`, `unreachable`, or `pending`. A gateway with no heartbeat inside
the TTL window (~90s) shows `unreachable` — a valid, self-healing status rather than an error.

---

## `intutic gateway rotate <gateway_id>`

Issue a new `gwk_...` token. The old token keeps authenticating for a grace period (24h by
default) so an unattended daemon has time to pick up the new one on its next restart.

```bash
intutic gateway rotate <gateway_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic gateway revoke <gateway_id>`

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

## `intutic gateway config set <gateway_id>`

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

A bare-metal daemon-supervised gateway applies a config change on its next poll. Docker and
Kubernetes deployments need a manual redeploy to pick it up.

<!-- ENTERPRISE_ONLY_END -->

---

## `intutic skill list`

Discover and list local workspace rule/skill files.

```bash
intutic skill list
```

**What it does:**
Scans the current workspace root for active harness rules configurations, including `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clauderules`, and `rules.md`.

---

## `intutic skill audit`

Audit local rules/skills for security leakage or unsafe command patterns.

```bash
intutic skill audit
```

**What it does:**
Performs static analysis on active rules and instructions to find potential vulnerabilities, such as hardcoded API credentials or wildcard file operations (e.g. `rm -rf *`).

---

## `intutic loop start`

Register and start an active loop execution session.

```bash
intutic loop start [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Unique name identifier for the loop run | _(required)_ |
| `--budget <limit>` | Maximum token spend budget in USD (e.g. `5.00`) | _(none)_ |
| `--sops <sops>` | Comma-separated local SOP folder names or option indices | — |
| `--auto-judge` | Enable automatic E2E judging for the loop | — |
| `--dev` | Use local control plane | — |

---

## `intutic loop exec`

Execute an agent command wrapped with loop budget boundaries.

```bash
intutic loop exec [options] -- <command> [args...]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Unique name identifier for the loop run | _(generated)_ |
| `--budget <limit>` | Maximum token spend budget in USD (e.g. `5.00`) | _(none)_ |
| `--sops <sops>` | Comma-separated local SOP folder names or option indices | — |
| `--auto-judge` | Enable automatic E2E judging for the loop | — |
| `--dev` | Use local control plane | — |

**Example:**
```bash
intutic loop exec --name "npm-build" --budget 1.50 -- npm run build
```

---

## `intutic loop list`

List loop runs and cost accounting details for the workspace.

```bash
intutic loop list [options]
```

---

## `intutic loop complete <loop_run_id>`

Mark a running loop as successfully completed.

```bash
intutic loop complete <loop_run_id> [options]
```

---

## `intutic loop kill <loop_run_id>`

Kill an active loop and prevent subsequent API requests.

```bash
intutic loop kill <loop_run_id> [options]
```

---

## `intutic policy enable <policy_id>`

Enable a compliance policy.

```bash
intutic policy enable <policy_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy disable <policy_id>`

Disable a compliance policy.

```bash
intutic policy disable <policy_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy rollback <policy_id>`

Rollback a compliance policy to a specific version.

```bash
intutic policy rollback <policy_id> --version <v> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--version <v>` | Target version number (required) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy export`

Export workspace compliance policies to stdout as a JSON array.

```bash
intutic policy export --all [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--all` | Export all policies |
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy test`

Run dry-run WASM policy evaluation locally.

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

<!-- ENTERPRISE_ONLY_START -->
**Compiling a rule candidate:**

| Option | Description |
|--------|-------------|
| `--candidate <id>` | Fetch the candidate's source of record from the control plane, verify its hash, write it to `generated/candidates/<id>.ts` and compile it to `build/<id>.wasm` (unless `--out` is given). Cannot be combined with `--src`. |
| `--upload` | After compiling, upload the bundle to `POST /api/v1/rule-candidates/<id>/bundle` together with the source hash, and print the gate results. Requires `--candidate`. |
| `--dev` | Use the local control plane (`http://localhost:3001`). |

Run it from a rule project that has `assembly/index.ts` (the SDK layout): the generated source imports the SDK from two directories up. See [Rules from policy documents](/guide/wasm-rules#rules-from-policy-documents).
<!-- ENTERPRISE_ONLY_END -->

---

## `intutic policy install`

Validate and install a compiled WASM rule into the local proxy rules dir.

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
1. Instantiates the rule and evaluates it against a built-in allow-mock context — a rule that fails to instantiate or evaluate is **not** installed
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

<!-- ENTERPRISE_ONLY_START -->
## `intutic guardrails`

The Policy Clause Ledger from the terminal: sources, documents, the review queue, the three decisions that move a cited guardrail, and the file plane. A client of `/api/v1/policy-guardrails/*` and `/api/v1/connectors`; nothing here decides anything the server would not, and the acting identity is never a flag — the server records the authenticated member. Not `intutic policy` (the WASM rule loop) and not `intutic sops` (your own SOP files). See [Policy Guardrails](/guide/policy-guardrails).

---

## `intutic guardrails sources list`

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
Lists the workspace's source connectors (Notion, Confluence, GitHub, Google Docs), with auto-sync state, last sync and last error. Memory providers are not policy sources and are not listed.

---
## `intutic guardrails sources add <provider>`

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
Creates the connector encrypted at rest. Exactly one of `--token` / `--token-file` is required. A Google Docs source may only be created, rescheduled, synced or removed by a workspace owner or admin; share the Drive folder with the service account's email first.

---
## `intutic guardrails sources sync <connectorId>`

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
Runs one sync: changed documents are re-split into passages, citations that no longer hold are marked stale, and changed documents are queued for extraction when the plan carries the budget. A cloud-only provider (Notion, Google Drive) answers 503 in offline mode.

---
## `intutic guardrails docs list`

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
## `intutic guardrails docs show <docId>`

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
Prints the document's provenance, every live passage with its hash, and every clause with its check results.

---
## `intutic guardrails docs extract <docId>`

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
One model call per chunk of passages, under the workspace's daily cap (exit 1 with the cap on 429). A proposal is a verbatim quote plus a clause in the closed grammar; anything else is rejected by name. A valid clause becomes a proposed guardrail that enforces nothing until approved for shadow.

---
## `intutic guardrails search <token>`

Which passages and guardrails mention a tool or action token.

```bash
intutic guardrails search <token>
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `token` | A tool name or action token, e.g. `Bash`, `action:deploy` |

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Coverage for one token: the passages whose token index carries it and the guardrails whose rule names it, so "do we have a rule about X" has an answer with citations.

---
## `intutic guardrails list`

List guardrails with their status and shadow evidence.

```bash
intutic guardrails list
```

**Options:**

| Option | Description |
|--------|-------------|
| `--status <status>` | `PROPOSED`, `SHADOW`, `ENFORCING`, `REJECTED` or `RETIRED` |
| `--target <target>` | `hook_rule`, `sop_front_matter` or `wasm_rule` |
| `--doc <docId>` | Only guardrails cited from this document |
| `--limit <n>` | Max rows (default 50, capped at 200) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
One line per guardrail: id, status, target, the cited quote, and the shadow counters.

---
## `intutic guardrails show <guardrailId>`

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
For a hook rule, prints the tool and input patterns and the exact stderr line a developer sees on a block; for a front-matter rule, the lines the proxy reads; for a WASM rule, the predicate source. A SHADOW guardrail also prints the server's readiness reasons verbatim.

---
## `intutic guardrails approve-shadow <guardrailId>`

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
## `intutic guardrails promote <guardrailId>`

Promote a shadow guardrail to enforcing once the server says it is ready.

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
| `--acknowledge-no-traffic` | Promote a rule that no observed traffic exercised |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
SHADOW → ENFORCING under the [promotion rule](/concepts/enforcement-actions#the-promotion-rule); refused (exit 1, with the reasons) until it holds. A WASM guardrail is promoted through its rule candidate instead, and this command says so.

---
## `intutic guardrails reject <guardrailId>`

Reject a guardrail; the reason is recorded on its authority chain.

```bash
intutic guardrails reject <guardrailId>
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
## `intutic guardrails retire <guardrailId>`

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
SHADOW or ENFORCING → RETIRED. The rule leaves both rule endpoints and the SOP policy on the next poll; a pulled file on disk stays until `intutic guardrails pull --prune` removes it.

---
## `intutic guardrails reconfirm <guardrailId>`

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
## `intutic guardrails replay <guardrailId>`

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
A preview before anything ships: a hook rule over the enforcement log's captured calls, a front-matter rule over stored context snapshots (`review_before` holds rather than acts and is reported as not replayable), a WASM predicate over the same snapshots.

---
## `intutic guardrails conflicts`

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
## `intutic guardrails pull`

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
Fetches the workspace SOP policy and writes one flat file per served guardrail, named by the guardrail id — flat because the proxy reads one directory level and titles each SOP by its file name, and that name is what its shadow reports are credited to. The served front matter (the enforcing keys, `mode: shadow`, `source:`, `cite:`) is kept in its single fence and a `content_hash:` marker is added inside it. Refuses to overwrite a file whose recorded hash no longer matches its body unless `--force` is passed; reports a file whose guardrail is no longer served, and removes it only with `--prune` and only when unmodified. A gateway-mode proxy reads the served projection directly and ignores this directory. See [Policy Guardrails](/guide/policy-guardrails).

---
<!-- ENTERPRISE_ONLY_END -->

## `intutic doctor`

Diagnose workspace health — proxy, auth, daemon, configs, logs.

```bash
intutic doctor
```

No options. Runs seven checks in order, each printing ✓ or ✗ plus a one-line remediation on failure:

1. Proxy reachable (`http://127.0.0.1:4000/health`)
2. Control plane auth (via stored credentials)
3. Sync daemon running (PID file or process scan)
4. Harness config files intact (SHA-256 drift check)
5. Daemon log readable (`~/.intutic/daemon.log`)
6. Valkey connectivity (proxy `/health`, falling back to a TCP probe on port 6379)
7. CA cert trust (`~/.intutic/ca.crt` plus the OS trust store)

---

## `intutic budget`

Check remaining daily/monthly budget and list active loops.

```bash
intutic budget [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
Fetches cloud budget status (daily and monthly spend, percentages used, remaining budget, alert flag), prints the local spending cap configured in `~/.intutic/config.json` (default `$10.00`), and lists all `ACTIVE` loop runs with their token spend and budget limit. Without stored credentials it runs in standalone (offline) mode and reports only the local cap.

---

## `intutic credentials list`

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

## `intutic credentials set <provider>`

Provision or rotate a workspace's own upstream provider key.

```bash
intutic credentials set <provider> --field key=value [--field key=value ...] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--field <key=value>` | A credential field; repeat for multi-field providers |
| `--json` | Output as JSON instead of a report |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**Examples:**

```bash
# A single-key provider
intutic credentials set anthropic --field apiKey=sk-ant-...

# A multi-field provider (Azure OpenAI)
intutic credentials set azure_openai \
  --field apiKey=sk-... \
  --field endpoint=https://your-resource.openai.azure.com \
  --field deployment=gpt-4
```

If BYO-key enforcement is on for your gateway, requests for a provider with no provisioned key
fail with `402 byok_required` until one is set here.

---

## `intutic credentials unset <provider>`

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

## `intutic sops push <name>`

Push a local offline SOP folder to the central workspace — one control-plane
SOP per file, each carrying its own declared front matter.

```bash
intutic sops push <name> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `name` | Folder name under `.intutic/sops/` in the workspace root |

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |
| `--org` | Push as an org-wide floor instead of a workspace SOP |

**What it does:**
For every `.md` file in `.intutic/sops/<name>/`, parses `title:`/`risk_tier:`/`version:` front matter (falling back to the file's first `# ` heading, then the file name, for title; to `MEDIUM` for an unstated risk tier) and creates one workspace SOP per file, front matter stripped from the uploaded body. Fails if the folder is missing or contains no markdown. See [GitOps for SOPs](/guide/gitops-sops) for the full push/pull/status flow and what does not round-trip (declarative enforcement keys like `deny_tools:` have no control-plane column).

---

## `intutic sops pull`

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
Writes one file per SOP, with `title:`/`risk_tier:`/`version:` front matter reconstructed and a `content_hash:` marker recording the body's hash. Refuses to overwrite a file whose recorded hash no longer matches its current body (a local edit since the last pull) unless `--force` is passed; a file with no recorded hash at all is treated as unverifiable and always requires `--force`. See [GitOps for SOPs](/guide/gitops-sops).

---

## `intutic sops status`

Show drift between `.intutic/sops/*.md` and the control plane. Read-only.

```bash
intutic sops status [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
For each local file, matched by title against the workspace's control-plane SOPs, reports `in-sync`, `local-ahead` (edited locally, not yet pushed), `remote-ahead` (control plane moved on, safe to pull), `diverged` (no recorded pull hash and no match either — can't tell "never pulled" from "edited long ago"), or `push-only` (no matching title on the control plane yet). See [GitOps for SOPs](/guide/gitops-sops).

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
| `--sandbox-image <image>` | Sandbox image — must contain the agent, `nftables`, and `capsh`. Default: `intutic/sandbox:latest`. |
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
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `INTUTIC_API_KEY` | API key for all of the above |

Requires `intutic login` first. In dev mode the proxy is `http://localhost:4000`, otherwise `http://localhost:4000`.

**Examples:**

```bash
intutic exec -- claude
intutic exec -- aider --model openai/gpt-4o
intutic exec -- python my_agent.py
```

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
| `report` | None | Reports the locally recorded enforcement state (firewall, CA-trust, system-hooks posture) to the control plane. For when `apply`/`remove` ran elevated and couldn't reach stored credentials. |

**Options** (`apply`/`remove`/`status`/`generate`):

| Option | Description |
|--------|-------------|
| `--port <port>` | The proxy's listener port to permit. Default: `4000`. |
| `--uid <uid>` | uid the proxy runs as, exempted from the deny. Defaults to the current user. |
| `--allow <cidrs>` | Comma-separated extra destination CIDRs to permit (control plane, private registries, etc.). |
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

# Apply, permitting an internal package registry too
sudo intutic enforce apply --allow 10.0.0.0/8,registry.internal.corp

# Check whether it's currently active
intutic enforce status

# Remove it
sudo intutic enforce remove
```

---

## `intutic daemon install`

Install sync-daemon as a system service (auto-starts on login, restarts on any exit).

```bash
intutic daemon install --workspace-id <id> --api-key <key> [options]
```

Also available as the top-level shortcut `intutic install-daemon`.

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--workspace-id <id>` | Workspace ID, e.g. `wk_xxxx` (required) | — |
| `--api-key <key>` | Workspace API key, e.g. `vk_xxxx` (required) | — |
| `--control-plane-url <url>` | Control plane URL | `https://your-control-plane.example` |
| `--binary-path <path>` | Path to the `intutic` CLI binary | _(current process)_ |
| `--dry-run` | Print what would be done without writing files | — |
| `--system` | Install as a system-level service (LaunchDaemon on macOS, systemd system unit on Linux) | — |

**Service files written:**
- macOS: `~/Library/LaunchAgents/ai.intutic.sync-daemon.plist` (`KeepAlive: true`)
- Linux: `~/.config/systemd/user/intutic-sync-daemon.service` (`Restart=always`)

Because the service restarts on any exit, stopping it requires `intutic daemon stop`, `intutic daemon uninstall`, or `launchctl unload`.

---

## `intutic daemon uninstall`

Remove the sync-daemon system service and stop it permanently.

```bash
intutic daemon uninstall [options]
```

Also available as the top-level shortcut `intutic uninstall-daemon`.

**Options:**

| Option | Description |
|--------|-------------|
| `--dry-run` | Print what would be done without writing files |
| `--system` | Uninstall the system-level service |

---

## `intutic daemon status`

Show sync-daemon system service status.

```bash
intutic daemon status
```

No options.

---

## `intutic daemon start`

Start and load the sync-daemon system service.

```bash
intutic daemon start
```

No options.

---

## `intutic daemon stop`

Stop and unload the sync-daemon system service.

```bash
intutic daemon stop
```

No options.

---

## `intutic rollback`

List or restore file pre-images captured when a guard flagged a call and let
it proceed (TD-328). This is the *restore* half of the mechanism — the
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


