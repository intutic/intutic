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
| `--version`, `-V` | Show the CLI version. Only before a command: `intutic --version`. After a command, `--version` belongs to that command (as in `intutic policy rollback <id> --version 2`). |
| `--help`, `-h` | Show help for the program or for any command, e.g. `intutic policy rollback --help` |

`intutic trace` is an alias of `intutic traces`, and `intutic install-daemon` /
`intutic uninstall-daemon` are shortcuts for `intutic daemon install` / `intutic daemon uninstall`.

## Plan badges

Commands without a badge run on your machine with no account. A badge on a command means it calls
a control plane and needs `intutic login` first; the badge names the plan, as in
[Plan badges](/guide/plans#badges): <Badge type="tip" text="Cloud" /> works on any connected
workspace, free included; <Badge type="warning" text="Self-serve+" />,
<Badge type="warning" text="Biz Org+" /> and <Badge type="danger" text="Enterprise" /> need that
plan or higher. Every command ships in the open-core CLI; the badge says what it needs to work.

## Choosing a control plane {#control-plane-url}

Every command that talks to a control plane picks it the same way; the first that is set wins:

1. A flag: `--control-plane-url <url>` (on `login`, `connect` and `daemon install`), or `--dev`
   for the local one at `http://localhost:3001`. A workspace initialized with `intutic init --dev`
   counts as `--dev`.
2. The environment: `INTUTIC_CONTROL_PLANE_URL`, or `INTUTIC_DEV=1` for the local one.
3. The control plane `intutic login` saved with your credentials.
4. Intutic's hosted control plane.

For a self-hosted control plane, log in once with its URL and every later command uses it:

```bash
intutic login --control-plane-url https://intutic.internal.example
intutic whoami
intutic connect
```

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

**What it does:**
1. Finds the workspace root: the nearest directory, from the current one upwards, that holds `.git/` or `package.json`. Exits `1` if there is none.
2. Detects the harnesses present in the workspace and lists each with its config file.
3. Reports whether you are logged in. No login is needed: `init` makes no network call.
4. Records the workspace root, the detected harnesses and dev mode in `~/.intutic/config.json`, keeping any other settings already there.
5. Installs the Git hooks if you agree: `post-commit` and `post-checkout` (record the branch and commit with `intutic sync-context`), `pre-commit` (refuses a commit that stages a credential, and warns on risky skill files) and `post-merge` (refreshes the decisions log). A hook that already exists and is not Intutic's is left untouched.
6. Prints setup instructions for pointing each detected harness at the local proxy (`http://localhost:4000`, or `INTUTIC_PROXY_URL`).

`init` writes no harness config files. [`intutic connect`](#intutic-connect) writes them, from the
control plane's SOPs plus your local `.intutic/sops/`, once a control plane is attached; standalone,
run [`intutic start`](#intutic-start) and point the harness at the proxy.

**Prompts:** with a terminal attached, `init` asks before installing the Git hooks. Without one (CI,
a provisioning script, `stdin` redirected) it never asks: it skips the hooks unless `--git-hooks`
is passed, and says so. `--git-hooks` and `--no-git-hooks` skip the question either way.

**Examples:**

```bash
intutic init

# Non-interactive, with the hooks
intutic init --git-hooks
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

**What it does:**

1. **Valkey (best-effort).** Checks for a Valkey or Redis on `127.0.0.1:<valkey-port>`. If none is listening, it tries, in order: starting an `intutic-valkey` Docker container (`valkey/valkey:8-alpine`), then `valkey-server` or `redis-server` from `PATH`. If none of these works, it warns and continues in standalone mode: routing, policies, DLP, and local spend caps all still work; bandit learning persists to `~/.intutic`, and the response cache lasts only as long as the process.
2. **Proxy binary.** Runs the version-matched binary in `~/.intutic/bin/` if it is there, otherwise `intutic-proxy` from `PATH`. If neither exists it prints `npm install -g @intutic/proxy` and exits with status `1`.
3. **Proxy environment.** Starts the proxy with your environment plus:
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

## `intutic setup`

Guided setup wizard — detect harnesses, configure a provider credential, and verify it, in one
interactive flow. It is the interactive counterpart of `intutic init`, not a replacement: this
command always prompts, while `init` asks only about Git hooks, and never without a terminal, so
it stays safe for CI. See [the cohort wizard guide](/guide/cohort-wizard) for a full narrative walkthrough
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
   `intutic credentials set` hits) or writes the local env file; local mode then points you at
   `intutic judge configure` for an on-prem judge

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
1. Prompts for a judge model — a self-hosted model from the
   [model catalog](/reference/model-catalog) (Ollama; Ollama Cloud excluded) or a custom
   reference such as `ollama/llama3.1` or a local alias your LiteLLM serves. Judges run only on
   self-hosted models: a custom reference that names a hosted provider (Anthropic, OpenAI,
   OpenRouter, Ollama Cloud…) is refused and nothing is written
2. Writes a LiteLLM `litellm_config.yaml` to `--out`, with one `model_list` entry for that model
3. Prints the env block (`INTUTIC_GATEWAY_LOCAL_JUDGE`, `LITELLM_LOCAL_URL`,
   `LITELLM_LOCAL_API_KEY`, `LITELLM_LOCAL_JUDGE_MODEL`) for Docker/bare-metal deployments
4. Prints the Helm values (`proxy.localJudge`, `litellm.enabled`, `litellm.judgeModel`) for the
   `intutic-gateway` chart, which is published at `oci://ghcr.io/intutic/charts/intutic-gateway`.
   The chart renders LiteLLM's config from the file this command wrote, passed with `--set-file`

The optional typed stage's variables (`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`,
`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI`, `LITELLM_LOCAL_TYPED_JUDGE_MODEL`) are not printed: the
band must be measured for your model. See
[On-Prem Judge Setup](/external/on-prem-judge#typed-stage-optional).

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

Without `--api-key` it prompts for your email and password (the password is not echoed). The
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

# A self-hosted control plane, saved for every later command
intutic login --control-plane-url https://intutic.internal.example

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

Diagnose workspace health — proxy, auth, daemon, configs, logs, Valkey, CA trust, policy snapshot.

```bash
intutic doctor
```

No options. Runs nine checks in order, each printing ✓ or ✗ plus a one-line remediation on failure:

1. Proxy reachable (`http://127.0.0.1:4000/health`, or the port of `INTUTIC_PROXY_URL`)
2. Control plane auth (the stored credentials against `/api/v1/auth/me`)
3. Sync daemon running (PID file or process scan)
4. Harness config files intact (SHA-256 against `<workspaceRoot>/.intutic/integrity.json`)
5. Daemon log readable (`~/.intutic/logs/sync-daemon.log`, then the system-service log, then the legacy `~/.intutic/daemon.log`)
6. Valkey reachable (TCP probe on `127.0.0.1:6379`)
7. CA cert trust (`~/.intutic/ca.crt` plus the OS trust store)
8. Policy snapshot present, valid, non-empty and fresh (`~/.intutic/hooks/policy-snapshot.rules`)
9. Cisco skill scanner on `PATH` (optional; never fails)

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
   nothing is listening on the proxy port (the port of `INTUTIC_PROXY_URL`, else `4000`).
2. Seeds the policy snapshot (`~/.intutic/hooks/policy-snapshot.rules`) so the harness gates
   enforce workspace policy from the first tool call.
3. Every `--interval`, and whenever the control plane pushes a change, fetches the workspace
   config and writes each detected harness's config file from the workspace SOPs plus the local
   SOP folders under `.intutic/sops/`, then refreshes the policy snapshot.
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

# Self-hosted control plane, explicit workspace credentials
intutic connect --workspace-id wk_xxxx --api-key "$INTUTIC_API_KEY" \
  --control-plane-url https://intutic.internal.example
```

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
- Session start and end, with the Git branch and commit from `.intutic/git-context.json`, and the
  names of your local SOP folders.
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
| `.agents/plugins/intutic-governance/hooks/hooks.json` | `goose` |
| `.aider.conf.yml` | `aider` |
| `.clinerules/intutic-governance.md` | `cline` |
| `.continue/config.json` | `continue` |
| `.cursorrules` | `cursor` |
| `.env.intutic` | `codex`, `langgraph`, `langchain`, `crewai`, `autogen`, `ag2`, `google-adk`, `openai-agents`, `pydantic-ai`, `smolagents`, `strands`, `agent-framework`, `mastra`, `vercel-ai-sdk`, `eve`, `trueforge`, `ai-sdk-harness`, `ai-sdk-workflow` |
| `.gemini/settings.json` | `antigravity` |
| `.github/copilot-instructions.md` | `github-copilot` |
| `.hermes/config.yaml` | `hermes` |
| `.intutic/n8n/governance-workflow.json` | `n8n` |
| `.open-webui/intutic-governance-filter.py` | `open-webui` |
| `.openclaw/openclaw.json` | `openclaw` |
| `.pi/hooks.json` | `pi` |
| `.roorules` | `roo-code` |
| `.windsurfrules` | `windsurf` |
| `AGENTS.md` | `muse-code`, `grok`, `opencode` |
| `claude_desktop_config.json` | `claude-desktop` |
| `CLAUDE.md` | `claude-code` |
| `config.toml` | `openhands` |

---

## `intutic disconnect`

Undo `intutic connect` on this machine: put every harness config it changed back the way it was, remove the background services, and log out.

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

- **Rules files connect writes whole** (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`, `.github/copilot-instructions.md`, `.roorules`, `.clinerules/intutic-governance.md`, `.env.intutic`): the file you had before comes back, or the file is deleted if connect created it.
- **Hook registrations** in each harness's settings (`.claude/settings.json`, Cursor's and Windsurf's `hooks.json`, and the rest): only the entries that run an Intutic gate are removed. The gate scripts are deleted.
- **Proxy routing**: base URLs and proxy settings connect pointed at the proxy (Codex `openai_base_url`, Continue `apiBase`, Goose `provider.host`, Grok `base_url`, Pi and OpenHands base URLs, Aider `openai-api-base`, Windsurf `http.proxy`, the JetBrains IDE proxy for the Windsurf plugin, dsh's `llm-deepseek` route) go back to the values they had.
- **MCP servers**: each server connect wrapped gets its original entry back, every key included; the `intutic` server connect added is removed; and the copies of approved `.mcp.json` servers connect added to `~/.claude.json` are removed.
- **What connect replaced or removed** comes back: the Claude Code `permissions.deny` rules connect replaced, and Aider's `test-cmd`, `lint-cmd`, `auto-test` and `auto-lint`.
- **n8n**: the `intutic_proxy_url` and `intutic_governance_rules` variables connect set on your workflows, through the n8n API at `N8N_URL` (default `http://localhost:5678`).

Without `--harness` it also removes the services [`intutic daemon install`](#intutic-daemon-install) set up for your user (a system-wide one is listed with the command that removes it), the Intutic CA certificate connect trusted in the macOS login keychain, the `intutic-valkey` Docker container connect started, the gate caches in `~/.intutic/hooks/`, `~/.intutic/env/runtime.env` (the copy of the API key the gates read) and, unless `--keep-login`, the stored credentials. It resets the synced config version, so a later `intutic connect` writes everything again.

**How it knows what you had:** before connect first writes a file, it keeps a copy of it, in `.intutic/originals/` for files in the workspace and `~/.intutic/originals/` for the rest (owner-only, and ignored by git). A file you have not changed since is restored byte for byte. In one you have changed, only Intutic's entries are taken out and your edits stay. A file connect writes whole that you edited is left as it is, and listed.

**Files from an earlier connect:** versions before this one kept no copies. For their files, disconnect removes what it can recognise as Intutic's: the generated header, entries that run an Intutic gate, wrapped MCP servers (their arguments carry the original command), and URLs on the proxy connect used. A generated file git does not track is deleted; where git has a committed version that is not generated, that version comes back. A setting connect overwrote is removed rather than restored, because its earlier value is unknown, and the output says so. Deny rules connect added to `permissions.deny` cannot be told apart from yours, and are listed for you to review.

**Left in place:** your SOPs in `.intutic/sops/`, Intutic's own state in `~/.intutic/` (configuration, logs, events, the downloaded proxy), `<file>.drift-backup` copies (they hold edits connect reverted), and a `valkey-server` or `redis-server` connect started outside Docker. Git hooks from `intutic init --git-hooks` live in `.git/hooks/`, and variables from [`intutic env persist`](#intutic-env-persist) are removed with [`intutic env clear`](#intutic-env-clear).

**While connect runs:** a running `intutic connect` would write everything straight back. A real run stops the services first, then exits with status `1` before changing any file if an `intutic connect` you started yourself is still running. `--dry-run` only warns.

**One harness:** `--harness` leaves a file another connected harness also writes (`AGENTS.md` is shared by Muse Code, Grok Build and OpenCode; `.env.intutic` by Codex and the SDK frameworks). It removes the harness from `~/.intutic/config.json`, so connect stops writing its config and stops wrapping its MCP servers; run `intutic init` to manage it again.

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

## `intutic sync-context`

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
4. If `CLAUDE.md` exists in the current directory, replaces the section between `<!-- INTUTIC:DECISIONS_LOG:START -->` and `<!-- INTUTIC:DECISIONS_LOG:END -->` with the 10 newest entries, adding the section if it is not there. A missing `CLAUDE.md` is not created.

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
Records the outcome, the note, and you as the adjudicator. The adjudicator is always the logged-in member, never a flag. Ruling on a finding again replaces the earlier ruling. Any workspace member can rule on most findings; `response_injection:*` findings need the OWNER or ADMIN role, the same roles that can see their response excerpt. These rulings are what `intutic findings stats` and `intutic findings echo-report` compute false-positive rates from.

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

## `intutic integrity roots` <Badge type="tip" text="Cloud" />

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
| Signature `unverifiable` | `0` | The root names a key the JWKS does not publish — a key-retention gap, not evidence of forgery. |
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

Check remaining daily/monthly budget and list active loops, or watch spend live.

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

- When you are logged in, prints the workspace's budget from the control plane: daily and monthly spend against their budgets with percentages, remaining budget, and an alert line when the alert threshold is exceeded.
- Prints the local spending cap from `~/.intutic/config.json` (`maxDailyBudgetUsd`, or `max_daily_budget_usd`; default `$10.00`).
- Prints today's machine-local spend from the local proxy at `http://127.0.0.1:4000` (or the port of `INTUTIC_PROXY_URL`), or a dash when the proxy is not running.
- When you are logged in, lists every `ACTIVE` loop run with its token spend and budget limit.

Without a login it runs in standalone (offline) mode and prints only the local figures.

With `--watch`, it prints one line per tick in this shape:

```
[10:42:05] machine-local: $0.4210 / $10.00  |  workspace: $3.1200 / $50.00
```

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
2. Estimates the output (and any reasoning) tokens from the workspace's baseline: past usage recorded for this model at a similar input size, falling back to usage across all workspaces. With no baseline, it uses a fixed output ratio for the model family.
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

A delta with no data behind it is printed as "not measured", never as zero. Below 20 recorded verdicts, the command prints an insufficient-data block with the count so far instead of a report. Verdicts are aggregated across every workspace mirroring the same candidate, not only yours.

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
| `--sarif` | Print the findings as a single SARIF 2.1.0 JSON document on stdout (for GitHub Code Scanning and other CI tools) instead of the readable report | — |
| `--engine <engine>` | `native` runs the built-in scanner. `cisco` also runs Cisco's `skill-scanner` on each skill directory; the `skill-scanner` binary must be on `PATH` (`pipx install cisco-ai-skill-scanner`). | `native` |
| `--exit-zero` | Exit `0` even when the audit has findings | — |

**What it does:**

It scans the workspace recorded by `intutic init`, or the current directory when there is none:

1. **Rule files** at the workspace root (`.cursorrules`, `CLAUDE.md`, `.windsurfrules`, `.clauderules`) are checked for hardcoded Intutic virtual keys, hardcoded `sk-live-` secrets, recursive-delete wildcards such as `rm -rf *`, and `curl`/`wget` commands.
2. **Skill files** (`.agents/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`) are content-scanned for prompt-injection, data-exfiltration, and malicious-code patterns. See [Skill Scanning](/guide/skill-scanning).
3. **Bundled files** next to each `SKILL.md` (up to 3 directories deep and 40 files per skill; symlinks are skipped) are hashed (SHA-256). Shell, Python, JavaScript, TypeScript, Ruby, PowerShell, and Perl scripts up to 256 KiB are also content-scanned. Larger files, unreadable files, and unrecognised file types are reported as unscanned, never as clean.

When you are logged in, three workspace settings change the run:

| Setting | Effect |
|---------|--------|
| `enableLocalSkillAuditDelete` | Deletes each flagged line from the file it was found in |
| `ciscoSkillScannerEnabled` | Runs the Cisco engine without `--engine cisco` if `skill-scanner` is on `PATH`; if it is not, the run continues with the built-in scanner only |
| `semanticSkillAnalysisEnabled` | Includes each `SKILL.md`'s content in the report it uploads |

When you are logged in, the results are also reported to the control plane; a failed report is ignored. With `--sarif`, nothing but the JSON document is printed. Cisco's results, when that engine ran, are added as a second run in the same document.

**Exit status:** `1` when the audit has findings, so a CI step fails on them; `0` when it is clean, or with `--exit-zero`. Also `1` for an unknown `--engine` value, or for `--engine cisco` when `skill-scanner` is not on `PATH`. The report, the SARIF document and the control-plane report are all complete before the command exits.

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
| `--name <name>` | Unique name identifier for the loop run | _(required)_ |
| `--budget <limit>` | Maximum token spend budget in USD (e.g. `5.00`) | _(none)_ |
| `--sops <sops>` | Comma-separated local SOP folder names or option indices | — |
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

## `intutic loop list` <Badge type="tip" text="Cloud" />

List loop runs and cost accounting details for the workspace.

```bash
intutic loop list [options]
```

---

## `intutic loop complete <loop_run_id>` <Badge type="tip" text="Cloud" />

Mark a running loop as successfully completed.

```bash
intutic loop complete <loop_run_id> [options]
```

---

## `intutic loop kill <loop_run_id>` <Badge type="tip" text="Cloud" />

Kill an active loop and prevent subsequent API requests.

```bash
intutic loop kill <loop_run_id> [options]
```

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
Resolves a run in `PENDING_REVIEW`: the state a `review_before:` SOP puts a whole run in when the proxy sees a declared action, after which every request in the run is refused until someone reviews it. A run in any other state is refused. If the workspace requires a different approver, the person who started the run cannot approve it.

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

## `intutic policy enable <policy_id>` <Badge type="tip" text="Cloud" />

Enable a compliance policy.

```bash
intutic policy enable <policy_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy disable <policy_id>` <Badge type="tip" text="Cloud" />

Disable a compliance policy.

```bash
intutic policy disable <policy_id> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--dev` | Use local control plane (`http://localhost:3001`) |

---

## `intutic policy rollback <policy_id>` <Badge type="tip" text="Cloud" />

Rollback a compliance policy to a specific version.

```bash
intutic policy rollback <policy_id> --version <v> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--version <v>` | Target version number (required) |
| `--dev` | Use local control plane (`http://localhost:3001`) |

Restores that version as a new version of the policy. `--version` here is the policy's version,
not the CLI's: after a command name it belongs to the command.

**Example:**

```bash
intutic policy rollback pol_abc123 --version 2
```

---

## `intutic policy export` <Badge type="tip" text="Cloud" />

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

If the fetch returns nothing usable, the command says the snapshot was **not** written and exits `1`. Any previous snapshot is left untouched and stays enforced. Without any snapshot, the gates still enforce the floor compiled into them.

The gates look for the snapshot at `INTUTIC_SNAPSHOT_RULES` when that variable is set, and at `~/.intutic/hooks/policy-snapshot.rules` otherwise. This command follows the same variable: it writes into the directory that `INTUTIC_SNAPSHOT_RULES` names. The file name is always `policy-snapshot.rules`, so if the variable names a different file the command warns that the gates will read a file it does not write.

**Example:**

```bash
intutic policy snapshot
intutic doctor
```

---

## `intutic policy replay <ruleId>` <Badge type="tip" text="Cloud" />

Run a WASM rule against this workspace's own recent traffic and report what it would have done, without touching enforcement.

```bash
intutic policy replay <ruleId> [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `ruleId` | A WASM rule uploaded to this workspace (`wasm_…`), installed or not yet active |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Maximum number of sampled request contexts to replay against (capped at 5000) | `500` |
| `--since <duration>` | Only contexts at or after this time: relative (`24h`, `7d`) or an ISO 8601 date | _(all sampled history)_ |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Evaluates the rule against request contexts the proxy has sampled from this workspace's traffic (5% of requests by default), then prints how many contexts were replayed, how many the rule would have acted on (count and rate), the count for each verdict (`allow`, `block`, `reask`), and the first contexts it would not have allowed, as JSON.

A rate needs enough traffic behind it: below 50 sampled contexts the command reports how many it found and how many it needs, and exits `1`. More contexts come from more traffic over time, not from a higher `--limit`. An unknown rule id or a rule that fails to evaluate also exits `1`.

**Example:**

```bash
intutic policy replay wasm_abc123 --since 7d --limit 2000
```

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

**Compiling a rule candidate** <Badge type="warning" text="Self-serve+" />**:**

| Option | Description |
|--------|-------------|
| `--candidate <id>` | Fetch the candidate's source of record from the control plane, verify its hash, write it to `generated/candidates/<id>.ts` and compile it to `build/<id>.wasm` (unless `--out` is given). Cannot be combined with `--src`. |
| `--upload` | After compiling, upload the bundle to `POST /api/v1/rule-candidates/<id>/bundle` together with the source hash, and print the gate results. Requires `--candidate`. |
| `--dev` | Use the local control plane (`http://localhost:3001`). |

Run it from a rule project that has `assembly/index.ts` (the SDK layout): the generated source imports the SDK from two directories up. See [Rules from policy documents](/guide/wasm-rules#rules-from-policy-documents).

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

## `intutic guardrails` <Badge type="warning" text="Self-serve+" />

The Policy Clause Ledger from the terminal: sources, documents, the review queue, the three decisions that move a cited guardrail, and the file plane. A client of `/api/v1/policy-guardrails/*` and `/api/v1/connectors`; nothing here decides anything the server would not, and the acting identity is never a flag — the server records the authenticated member. Not `intutic policy` (the WASM rule loop) and not `intutic sops` (your own SOP files). See [Policy Guardrails](/guide/policy-guardrails).

---

## `intutic guardrails sources list` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails sources add <provider>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails sources sync <connectorId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails docs list` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails docs show <docId>` <Badge type="warning" text="Self-serve+" />

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
One model call per chunk of passages, under the workspace's daily cap (exit 1 with the cap on 429). A proposal is a verbatim quote plus a clause in the closed grammar; anything else is rejected by name. A valid clause becomes a proposed guardrail that enforces nothing until approved for shadow.

---

## `intutic guardrails search <token>` <Badge type="warning" text="Self-serve+" />

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
Coverage for one token: the passages whose token index carries it and the guardrails whose rule names it, so "do we have a rule about X" has an answer with citations.

With `--text`, the argument is read as words rather than a token: every live passage is searched (stemmed English, so `deploys` finds `deploy`) and up to 50 passages are listed, best match first. You can quote a phrase, use `or`, and exclude a word with a leading `-`; the query is limited to 200 characters. This answers "which passages talk about production deploys" where the token search answers "which passages name `Bash`". It lists passages only, not guardrails.

**Examples:**

```bash
intutic guardrails search Bash
intutic guardrails search --text "production deploy"
```

---

## `intutic guardrails list` <Badge type="warning" text="Self-serve+" />

List guardrails with their status and shadow evidence.

```bash
intutic guardrails list
```

**Options:**

| Option | Description |
|--------|-------------|
| `--status <status>` | `PROPOSED`, `SHADOW`, `ENFORCING`, `REJECTED` or `RETIRED` |
| `--target <target>` | `hook_rule`, `sop_front_matter`, `wasm_rule` or `workspace_setting` |
| `--doc <docId>` | Only guardrails cited from this document |
| `--limit <n>` | Max rows (default 50, capped at 200) |
| `--json` | Output as JSON |
| `--dev` | Use local control plane (`http://localhost:3001`) |

**What it does:**
One line per guardrail: id, status, target, the cited quote, and the shadow counters.

---

## `intutic guardrails show <guardrailId>` <Badge type="warning" text="Self-serve+" />

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
For a hook rule, prints the tool and input patterns and the exact stderr line a developer sees on a block; for a front-matter rule, the lines the proxy reads; for a WASM rule, the predicate source; for a workspace setting, the setting and the values it proposes. A SHADOW guardrail also prints the server's readiness reasons verbatim.

---

## `intutic guardrails approve-shadow <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails promote <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails reject <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails retire <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails reconfirm <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails replay <guardrailId>` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails conflicts` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails impact` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails duplicates` <Badge type="warning" text="Self-serve+" />

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

## `intutic guardrails pull` <Badge type="warning" text="Self-serve+" />

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

## `intutic sops push <name>` <Badge type="tip" text="Cloud" />

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
Writes one file per SOP, with `title:`/`risk_tier:`/`version:` front matter reconstructed and a `content_hash:` marker recording the body's hash. Refuses to overwrite a file whose recorded hash no longer matches its current body (a local edit since the last pull) unless `--force` is passed; a file with no recorded hash at all is treated as unverifiable and always requires `--force`. See [GitOps for SOPs](/guide/gitops-sops).

---

## `intutic sops status` <Badge type="tip" text="Cloud" />

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
Deactivates the floor, so it stops applying to every workspace in the org. The row is kept (a soft delete), not erased. You need the OWNER or ADMIN role on at least one active workspace in the org. A floor that does not exist and a caller without that role get the same "not found" answer, so the command cannot tell you which one it was.

**Example:**

```bash
intutic sops org-rm osp_abc123
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

## `intutic attenuate` <Badge type="warning" text="Biz Org+" />

Mint a child API key that carries a subset of a parent key's capabilities and expires sooner.

```bash
intutic attenuate --parent-key <keyId> --caps <cap,cap,...> [--ttl <seconds>] [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--parent-key <keyId>` | ID of the parent API key to narrow (required) | — |
| `--caps <caps>` | Comma-separated capabilities to grant the child key; each must be one the parent key has (required) | — |
| `--ttl <seconds>` | Child key lifetime in whole seconds, from 60 to 86400 | `14400` (4 hours) |
| `--dev` | Use local control plane (`http://localhost:3001`) | — |

**What it does:**
Asks the control plane to mint the child key, then prints the child key itself (`vk_…`), its key ID, the attenuation chain ID, the granted capabilities and the expiry time. The child key is shown **once** and never stored, so save it when it is printed. A child never outlives its parent: it expires after `--ttl` or when the first key it descends from expires, whichever comes sooner, and the printed expiry is that time.

Capabilities are the parent key's scopes, matched exactly as written. `*` is not expanded, so a key created with the default `*` scope can only grant `*`.

The request is refused when the parent key is revoked or expired, or descends from an expired key, when a requested capability is not one of the parent's (the error names which), or when the chain is already four attenuations deep. A missing `--parent-key`, an empty `--caps` or a `--ttl` outside 60–86400 whole seconds exits `1` before anything is sent.

**Example:**

```bash
# <scope-a>,<scope-b>: scopes the parent key was created with
intutic attenuate --parent-key vk_abc123 --caps <scope-a>,<scope-b> --ttl 3600
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
Prints each link in the chain: parent key, child key, granted capabilities, expiry and when it was minted. Needs the OWNER or ADMIN role. The same chains are shown on the dashboard's **Attenuated API Keys** card.

---

## `intutic gateway register` <Badge type="danger" text="Enterprise" />

Register a [self-hosted gateway](/external/self-hosted-gateway) — an org's own Docker,
Kubernetes, or bare-metal (systemd) deployment of the Intutic proxy — and print its one-time
management token.

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

Reports `online`, `degraded`, `unreachable`, or `pending`. A gateway with no heartbeat inside
the TTL window (~90s) shows `unreachable` — a valid, self-healing status rather than an error.
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
deployment target: within `INTUTIC_GATEWAY_HEARTBEAT_INTERVAL_SECS` (30 seconds by default). See
[Changing a gateway's config](/external/self-hosted-gateway#changing-a-gateway-s-config).

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

## `intutic org create` <Badge type="warning" text="Biz Org+" />

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
| `--sandbox-image <image>` | Sandbox image — must contain the agent, `nftables`, and `capsh`. Default: `intutic/sandbox:<CLI version>`, built locally from the Dockerfile shipped with the CLI on first use; it has no agent, so extend it ([Sandboxed Execution](/guide/sandboxed-execution)). |
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

The base-URL variables point at the local proxy, `http://localhost:4000`, or at
`INTUTIC_PROXY_URL` when it is set; inside `--sandbox` they point at the host the proxy runs on.

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
| `report` | None (needs `intutic login`) | Reports the locally recorded enforcement state (firewall, CA-trust, system-hooks posture) to the control plane. For when `apply`/`remove` ran elevated and couldn't reach stored credentials. |

**Options** (`apply`/`remove`/`status`/`generate`):

| Option | Description |
|--------|-------------|
| `--port <port>` | The proxy's listener port to permit. Default: `4000`. |
| `--uid <uid>` | uid the proxy runs as, exempted from the deny. Defaults to the current user. |
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

## `intutic enterprise install`

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
| `--dev` | Send the device report to the local control plane (`http://localhost:3001`) instead of to Intutic's hosted control plane (the default) | — |
| `--cli-binary-path <path>` | Absolute path of the `intutic` binary on the *target* machines, written into the firewall manifests | `/usr/local/bin/intutic` |

**What it does:**

1. Reads the proxy's CA certificate from `~/.intutic/ca.crt`. The proxy creates it on first run, so run `intutic start` (or `intutic connect`) once first; if the file is missing the command exits with status `1`.
2. Writes nine manifests to `--mdm-output-dir` (no privilege needed):
   - `intutic-governance.mobileconfig` — CA trust profile
   - `cursor-hooks-jamf.json` / `cursor-hooks-intune.json` — Cursor system hooks for Jamf / Intune
   - `gemini-cli-hooks-jamf.json` / `gemini-cli-hooks-intune.json` — the Gemini CLI gate in Gemini CLI's system settings file, which it applies over user and workspace settings
   - `antigravity-hooks-jamf.json` / `antigravity-hooks-intune.json` — the Google Antigravity gate for each user's `~/.gemini/config/hooks.json` (Antigravity has no machine-wide hooks file)
   - `jamf-firewall-manifest.json` / `intune-firewall-manifest.json` — a recurring managed script that runs `<cli-binary-path> enforce apply` with root/administrator privilege, so the egress firewall is re-applied on every check-in

   With `--generate-mdm-only` the command stops here.
3. Checks for admin/root privilege. If the shell is not elevated it prints a warning and still attempts the remaining steps.
4. Unless `--skip-hooks`: writes the Cursor hook script to `<workspace>/.intutic/hooks/cursor-check.js` and a `hooks.json` pointing at it in `<workspace>/.cursor/`, `~/.cursor/`, and the system location (`/Library/Application Support/Cursor/` on macOS, `/etc/cursor/` elsewhere). The workspace is the one recorded by `intutic init`, or the current directory. If you are logged in, your workspace ID is embedded in the hook's event payloads; without a login it is left empty.
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
| `--control-plane-url <url>` | Control plane the sync-daemon or MCP daemon connects to, written into the service | Resolved as in [Choosing a control plane](#control-plane-url): `INTUTIC_CONTROL_PLANE_URL`, then the URL saved by `intutic login`, then Intutic's hosted control plane |
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
| `INTUTIC_CONTROL_PLANE_URL` | Every command that calls a control-plane API | The control plane to use, ahead of the one saved by `intutic login` and behind a `--control-plane-url` or `--dev` flag. See [Choosing a control plane](#control-plane-url). |
| `INTUTIC_DEV` | Every command that calls a control-plane API | `1` targets the local control plane at `http://localhost:3001`, the same as `--dev`, unless `INTUTIC_CONTROL_PLANE_URL` is set. Any other value is ignored. |
| `INTUTIC_PROXY_URL` | `intutic exec`, `start`, `connect`, `budget`, `doctor`, `daemon install --proxy`, `enterprise install`, and the setup output of `init` and `connect` | Base URL of the local proxy, default `http://localhost:4000`. Its port is the one every command uses: `start`, `connect` and `daemon install --proxy` run the proxy there unless `--port` says otherwise, and `budget` and `doctor` probe it there. `exec` points the child process's SDK variables at it. `enterprise install` uses it when `--proxy-url` is not given. `init` and `connect` print it as your gateway endpoint (with `/v1` appended). The shell's `PORT` is not read. |
| `VALKEY_URL` | `intutic start`, `intutic connect` | Valkey/Redis the proxy uses. `start` passes it through only when a Valkey is reachable on `--valkey-port`; otherwise it uses `redis://127.0.0.1:<valkey-port>`. `connect` defaults to `redis://127.0.0.1:6379`. |
| `CONTROL_PLANE_URL` | `intutic start` | When set and no Valkey is available, `start` does not force standalone mode; the proxy treats the run as a managed deployment and requires Valkey. The CLI does not use it to choose a control plane. |
| `INTUTIC_SNAPSHOT_RULES` | Hook gates, `intutic policy snapshot`, `intutic doctor` | Path of the policy snapshot file the gates enforce. Default `~/.intutic/hooks/policy-snapshot.rules`. `policy snapshot` writes into this path's directory and always names the file `policy-snapshot.rules` (it warns if your path uses another name); `doctor` checks this path. |
| `INTUTIC_GUARD_DISABLE` | Hook gates | `1` makes the gates skip the snapshot's destructive-command rules. The built-in protections (protected paths, bypass guards) and your workspace's own SOP block rules still apply. Every gated tool call while it is set is recorded as a `guards_disabled` event; once `intutic connect` uploads those events, the control plane opens a HIGH-severity incident for each affected session. |
| `INTUTIC_SKIP_GLOBAL_HOOKS` | `intutic connect` (Claude Code hooks) | Any non-empty value stops the sync daemon from writing Intutic's hooks and deny rules into `~/.claude/settings.json`. The project's `.claude/settings.json` is still written. |
| `INTUTIC_WASM_DIR` | `intutic policy install`, `intutic policy list-local`, the proxy | Directory for local WASM rules. Default `~/.intutic/wasm`; a leading `~/` is expanded. Set it the same way for the CLI and the proxy. |
| `INTUTIC_FC_KERNEL` | `intutic exec --sandbox firecracker` | Path to the guest kernel image. Required; no default. |
| `INTUTIC_FC_ROOTFS` | `intutic exec --sandbox firecracker` | Path to the guest root filesystem image containing your agent. Required; no default. |
| `INTUTIC_FC_TAP` | `intutic exec --sandbox firecracker` | Host tap device name. Default `tap-intutic`. |
| `INTUTIC_FC_GUEST_IP` | `intutic exec --sandbox firecracker` | Guest IP on the tap link. Default `172.16.0.2`. |
| `INTUTIC_FC_HOST_IP` | `intutic exec --sandbox firecracker` | Host IP on the tap link; the guest reaches the proxy here. Default `172.16.0.1`. |
| `INTUTIC_FC_PREFIX` | `intutic exec --sandbox firecracker` | Prefix length of the tap link. Default `30`. |
| `INTUTIC_FC_VCPUS` | `intutic exec --sandbox firecracker` | Guest vCPU count. Default `1`. |
| `INTUTIC_FC_MEM` | `intutic exec --sandbox firecracker` | Guest memory in MiB. Default `512`. |

The control plane itself is chosen as described in [Choosing a control plane](#control-plane-url).
