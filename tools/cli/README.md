# @intutic/cli

> AI governance for developer workspaces.

Intutic intercepts agent-to-LLM traffic, enforces SOPs, detects anomalies, and tracks costs — all without changing how your team codes.

## Quick Start

```bash
# Install globally
npm install -g @intutic/cli

# Or run directly
npx @intutic/cli init
```

**5 minutes to your first governance verdict:**

```bash
intutic init               # Detect harnesses, record them in ~/.intutic/config.json
intutic gates install      # Write each harness's gate and rules file from .intutic/sops/
intutic start              # Run the proxy standalone — no account needed
intutic traces list        # See governance verdicts
```

<!-- UNRELEASED:cloud
**With a control plane:**

```bash
intutic login              # Authenticate with control plane
intutic init               # Detect harnesses, record them for sync
intutic connect            # Start sync daemon — writes harness rules and gates
intutic traces list        # See governance verdicts
```
-->

## Commands

| Command | Description |
|---------|-------------|
| `intutic init` | Initialize workspace — detect harnesses, record them in `~/.intutic/config.json`, and offer to install the Git hooks and the gates (`--git-hooks`, `--no-git-hooks`, `--gates`, `--no-gates`) |
| `intutic setup` | Guided setup — detect harnesses, configure a provider credential and verify it, in one interactive flow |
| `intutic gates install` | Write each recorded harness's gate and rules file from local SOPs (`.intutic/sops/`), with no control plane (`--harness`, `--add` to record a harness `init` did not detect, `--route` to also write proxy routing while the proxy runs, `--dry-run`, `--workspace`) |
| `intutic start` | Start the proxy standalone — no account or control plane needed; refreshes the installed gates when `.intutic/sops/` changes (`--port`, `--valkey-port`, `--upstream-url`, `--no-gates`) |
| `intutic decide test` | Ask a decide rule's questions about one call and show each answer, the `when` value and the outcome |
| `intutic decide eval` | Measure a decide rule on labelled calls; under a pre-registration, a pass pins the engine's model so the rule may enforce |
| `intutic decide calibrate` | Fit a combiner and a band to labelled calls, saved as a candidate for the next pre-registered eval |
| `intutic decide models` | The models the bake-off measured, and which passed; nothing is downloaded |
| `intutic decide check` | Evaluate one call's decide rules for a shell or n8n gate: a JSON request on stdin, one JSON line out |
| `intutic decide configure` | Write `~/.intutic/decide/engine.json`: the self-hosted engine's URL, adapter and model |
| `intutic decide disable` | Run every decide rule on this machine as shadow (logged, never refusing) |
| `intutic decide enable` | Undo `intutic decide disable` |
| `intutic decide lint` | Read every local `decide:` line and name the ones that do not read |
| `intutic status` | Show workspace status — auth, harnesses, sync state |
| `intutic disconnect` | Undo `intutic gates install` — restore the harness configs it changed (`--harness`, `--dry-run`, `--keep-login`) |
| `intutic doctor` | Diagnose workspace health — proxy, Valkey, CA trust, policy snapshot, gates, decide engine |
| `intutic rollback` | List or restore the pre-images captured when a guard flagged a file-writing call (`--list`, `--id`) |
| `intutic budget` | Check the local spending cap and what this machine has spent today (`--watch`, `--interval`) |
| `intutic policy` | WASM rules: `compile`, `test`, `install` and `list-local` |
| `intutic rules` | Build and test Rego policies as Intutic rules (`build`, `test`) |
| `intutic enforce` | Manage the default-deny egress firewall that forces all traffic through the proxy (`generate`, `apply`, `remove`, `status`) |
| `intutic env` | Persist or clear the proxy base-URL environment variables (`persist`, `clear`) |
| `intutic exec -- <command>` | Run a command with the proxy environment variables set, optionally in a sandbox (`--sandbox`) |
| `intutic chaos` | Run an agent with a known fault injected, in the sandbox, and score what it did (`validate`, `list`, `run`) |
| `intutic daemon` | Manage the sync daemon, MCP daemon and standalone proxy system services (`install`, `uninstall`, `status`, `stop`, `start`) |
| `intutic skill` | Manage and audit agent skills and instructions (`list`, `audit`, `scan-staged`) |
| `intutic traces list` | List execution traces (`--limit`, `--since`, `--action` with a control plane, `--verdict` without one, `--model`, `--json`) |
| `intutic traces inspect <id>` | Show full detail of a single trace |
<!-- UNRELEASED:cloud
| `intutic login` | Authenticate with control plane (`--api-key`, `--control-plane-url`, `--dev`) |
| `intutic logout` | Clear stored credentials |
| `intutic whoami` | Show current authenticated identity |
| `intutic connect` | Start sync daemon — bidirectional config sync (`--interval`) |
| `intutic disconnect` | Also undoes `intutic connect`: removes its services and logs out unless `--keep-login` |
-->

## Supported Harnesses

Intutic auto-detects and configures AI coding harnesses, among them:

| Harness | Detection | Config Method |
|---------|-----------|---------------|
| **Claude Code** | `CLAUDE.md` in the workspace | `.claude/rules/intutic-governance.md` (never `CLAUDE.md`) + PreToolUse gate in `.claude/settings.json` |
| **Cursor** | `.cursor/` or `.cursorrules` in the workspace, or `~/.cursor/` | `.cursor/rules/intutic-governance.mdc` + gate in `.cursor/hooks.json` |
| **Aider** | `.aider.conf.yml` in the workspace | `.intutic/aider-sops.md`, loaded by `read:` in `.aider.conf.yml` |
| **Antigravity** | `~/.gemini/antigravity*/`, `.agents/hooks.json`, `.gemini/` in the workspace, or `antigravity` / `gemini` on PATH | `GEMINI.md` section + `PreToolUse` gate in `~/.gemini/config/hooks.json` (Gemini CLI: `BeforeTool` gate in `~/.gemini/settings.json`) |
| **Codex** | `codex` on PATH, or `CODEX_HOME` set | `AGENTS.md` section + gate in `.codex/hooks.json`; proxy routing in `~/.codex/config.toml` (with `--route`) |
| **n8n** | Running n8n instance (`N8N_URL`, default `http://localhost:5678`) | Workflow JSON file + external hook gate `~/.intutic/hooks/n8n-governance-hook.js` |
| **OpenClaw** | `~/.openclaw/` or `.openclaw/openclaw.json` | `AGENTS.md` section in its agent workspace + `~/.intutic/hooks/openclaw/intutic-governance.cjs` (plugin gate, listed in `~/.openclaw/openclaw.json`) |
| **Hermes** | `~/.hermes/` or `.hermes/config.yaml` | `AGENTS.md` section + `hooks.pre_tool_call` gate in `~/.hermes/config.yaml` |
| **OpenCode** | `.opencode/`, `opencode.json`, `~/.config/opencode/` or `opencode` on PATH | `AGENTS.md` + `.opencode/plugins/intutic-governance.js` (plugin gate; OpenCode 2.x: `.opencode/plugins/intutic-governance/index.js`) |

## Trace Inspection

View governance verdicts directly from the terminal:

```bash
# List recent traces (last 24h)
intutic traces list

# Filter by enforcement action (connected to a control plane)
intutic traces list --action KILL

# Filter by the proxy's verdict (standalone: `intutic start`, no login)
intutic traces list --verdict killed

# Filter by model and time window
intutic traces list --model claude-4 --since 7d

# JSON output for scripting (connected; standalone rows carry `.verdict`)
intutic traces list --json | jq '.traces[] | select(.enforcementAction == "HIJACK")'

# Inspect a specific trace
intutic traces inspect tr_abc123
```

## Configuration

Credentials are stored at `~/.intutic/credentials.json` (mode `0600`).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `INTUTIC_CONTROL_PLANE_URL` | Control plane URL for this shell (overrides the one a control-plane login saved) |
| `INTUTIC_DEV` | `1` targets the local control plane (`http://localhost:3001`), like `--dev` |
| `INTUTIC_PROXY_URL` | Local proxy URL; its port is the proxy port (default `4000`) |
| `INTUTIC_DECIDE_ENGINE_URL` | The self-hosted decide engine. Overrides `url` in `~/.intutic/decide/engine.json` (default `http://127.0.0.1:11434`) |
| `INTUTIC_DECIDE_ADAPTER` | `logprobs` (the default), `systemone` or `decisions`. Overrides `adapter` in `engine.json` |
| `INTUTIC_DECIDE_MODEL` | The model the engine serves. Overrides `model` in `engine.json`; with none, the engine is not configured |
| `INTUTIC_DECIDE_TIMEOUT_MS` | Per-call timeout (default `5000`). Overrides `timeoutMs` in `engine.json` |
| `INTUTIC_DECIDE_PARALLEL` | Most engine requests in flight (default `1` for Ollama, `8` otherwise). Overrides `parallel` in `engine.json` |
| `INTUTIC_DECIDE_API_KEY` | The engine's key, if it needs one. Read from the environment only, never written or logged |
| `INTUTIC_DECIDE_MODEL_DIGEST` | The weights digest, for a server that cannot report one. Pins are keyed by it |
| `INTUTIC_DECIDE_BUDGET_MS` | Milliseconds one tool call's decide rules may take (default `7300`) |

<!-- UNRELEASED:cloud
For non-interactive auth, use `intutic login --api-key vk_...`.

### Development Mode

Use `--dev` flag to point at local control plane (`http://localhost:3001`):

```bash
intutic login --dev
intutic connect --dev
intutic traces list --dev
```
-->

## Documentation

Full documentation: [docs.intutic.ai](https://docs.intutic.ai)

- [Getting Started](https://docs.intutic.ai/guide/getting-started)
- [Integration Guides](https://docs.intutic.ai/integrations/)
- [CLI Reference](https://docs.intutic.ai/reference/cli)
- [API Reference](https://docs.intutic.ai/reference/api)

## License

MIT — see [LICENSE](../../LICENSE) for details.
