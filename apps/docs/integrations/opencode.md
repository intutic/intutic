# OpenCode

Integrate Intutic governance with [OpenCode](https://opencode.ai) — the open-source terminal coding agent (npm `opencode-ai` 1.x and `@opencode/cli` 2.x, binary `opencode`).

## How it works

OpenCode reads project rules from `AGENTS.md` (falling back to `CLAUDE.md`, plus `~/.config/opencode/AGENTS.md`) and loads **plugins** into its own process from `.opencode/plugins/*.js`. A plugin returns hooks, and one of them runs before every tool call — built-in tools, the `task` sub-agent tool and MCP tools alike. Throwing from that hook refuses the call: OpenCode turns the thrown message into the tool error the model reads, and the tool never runs.

Intutic writes one plugin module there (in the two directory layouts the 1.x and 2.x lines each look for). It carries the same gate every other hook harness in this product runs — the compiled protection floor, the workspace's policy snapshot, ` WHERE `/argPattern rules and the audit line — with a "throw" refusal in place of an exit code. There is nothing to register and no package to install: OpenCode discovers the file by globbing the directory.

## Setup

### 1. OpenCode detection

OpenCode is detected by any of:
- A `.opencode/` directory, `opencode.json` or `opencode.jsonc` in the project, **or**
- A user-level config directory (`$OPENCODE_CONFIG_DIR` or `~/.config/opencode/`), **or**
- The `opencode` (or 2.x `opencode2`) binary being found in your `PATH`

`AGENTS.md` alone is not a signal — Muse Code and Grok Build read the same file.

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • opencode → AGENTS.md
```

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

### 4. LLM egress

OpenCode has no base-URL environment variable. To route model traffic through the proxy, set your provider's base URL in `opencode.json` (or supply the same JSON in `OPENCODE_CONFIG_CONTENT`):

```json
{
  "provider": {
    "anthropic": { "options": { "baseURL": "http://127.0.0.1:4000" } }
  }
}
```

Intutic does not write `opencode.json` — it is your file, and a wholesale rewrite of it is exactly the kind of change the drift guard exists to catch. The plugin gate governs tool calls whether or not the egress is routed.

## What gets written

- **Rules file:** `AGENTS.md` — governance text, formatted the same `---`-separated way as `.cursorrules`/`CLAUDE.md`/`.windsurfrules`. Written only when the workspace has SOPs.
- **Plugin:** `.opencode/plugins/intutic-governance.js` and `.opencode/plugins/intutic-governance/index.js` — the gate, written twice with identical bytes because the two OpenCode lines discover local plugins differently: 1.x globs files in `.opencode/plugins/`, 2.x reads `<name>/index.js` sub-directories, and each ignores the other's layout. An ES module with the shared gate body embedded; a `tool.execute.before` hook for 1.x and a `tool` `execute.before` hook for 2.x in the same module. Written atomically; repeated syncs replace, never stack.
- **Not written:** `opencode.json` (egress and the optional static `permission` map are yours), and OpenCode's MCP server entries are not proxy-wrapped yet — see below.

## Pre-tool hooks (blocking)

The hook receives the tool name and its argument object and refuses by throwing `Error('[Intutic Governance] BLOCKED: <reason> [<rule id>]')`. OpenCode returns that message to the model as the tool's error, so the model sees why and can change approach; the process keeps running. An allow returns normally.

Fail-closed is local to the hook rather than process-wide: a fault inside the gate (or an argument object the gate cannot read) is rethrown as a BLOCKED error, so a call the gate could not evaluate is refused, never allowed. The plugin installs no `uncaughtException` handler — it runs inside your OpenCode process and must not exit it, the same posture the n8n in-process gate takes.

Every decision is appended to `.intutic/events/hook-events.jsonl` and drained to the control plane, same as every other harness. On load the plugin prints one line to OpenCode's stderr saying whether it found the policy snapshot, so a machine enforcing only the floor is visible.

::: tip Static fallback, if you want one
OpenCode's own `permission` map in `opencode.json` (1.x; `permissions` array in 2.x) can deny tools or bash-command globs — `"bash": { "rm -rf *": "deny" }`. It is static: no argument-pattern rules, no policy snapshot, no audit line. It is belt-and-braces beside the plugin, not a substitute, and Intutic leaves it to you.
:::

::: warning OpenCode MCP tool calls
The plugin runs for MCP tools too, but OpenCode 1.x names them `<server>_<tool>`, not the `mcp__<server>__<tool>` shape the per-server MCP allowlist parses, and OpenCode's `mcp` config block is not proxy-wrapped by `intutic connect` yet. An MCP call is still evaluated against every path and command rule; the server allowlist does not apply to it. Tracked as TD-487.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `opencode` |
| Config file | `AGENTS.md` |
| Plugin files | `.opencode/plugins/intutic-governance.js` (1.x layout), `.opencode/plugins/intutic-governance/index.js` (2.x layout) — same bytes |
| Detection | `.opencode/`, `opencode.json{,c}` in the project; `$OPENCODE_CONFIG_DIR` or `~/.config/opencode/`; `opencode`/`opencode2` in `PATH` |
| Format | Markdown (rules), ES module (plugin) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Block contract | Throw from `tool.execute.before` (1.x) / `tool` `execute.before` (2.x) — the message becomes the tool error |
| Versions | `opencode-ai` 1.x (plugin API since 0.3.113) and `@opencode/cli` 2.x |

::: tip Live-verified on 1.x; 2.x against the documented API
The 1.x path was run end to end against a real `opencode-ai@1.18.32` install with a local model: the plugin loaded, a `bash` call naming a governance-protected path came back to the model as the BLOCKED tool error, and the audit line landed. On 2.x (`@opencode/cli@2.0.14`) the one session that ran showed 2.x does not load the flat file — which is why the `intutic-governance/index.js` layout its docs specify is written as well — but later 2.x sessions would not open in the environment this was built in, so the 2.x layout and `setup(ctx)` hook shape are pinned by Intutic's own test driver against OpenCode's published plugin API, not against a live 2.x run. If 2.x ignores the plugin on your machine, say so: it is the one claim on this page not checked live.
:::
