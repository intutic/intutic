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
1. Scans the workspace for all 18 harness config files
2. Creates a workspace on the control plane
3. Generates a virtual API key (`vk_*`)
4. Writes governance config into each detected harness file

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

## `intutic sops push <name>`

Push a local offline SOP folder to the central workspace.

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

**What it does:**
Concatenates every `.md` file in `.intutic/sops/<name>/`, derives a title from the folder name (`postgres-migration` → `Postgres Migration`), and creates a workspace SOP on the control plane. Fails if the folder is missing or contains no markdown.

---

## `intutic exec`

Execute a command wrapped with Intutic proxy environment variables.

```bash
intutic exec -- <command> [args...]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `command...` | Command and arguments to execute (e.g. `-- claude`) |

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
| `--control-plane-url <url>` | Control plane URL | `https://api.intutic.ai` |
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


