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
1. Scans the workspace for all 17 harness config files
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
| `--budget <limit>` | Maximum budget ceiling in USD | `10.00` |
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
| `--budget <limit>` | Maximum budget ceiling in USD | `10.00` |
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


