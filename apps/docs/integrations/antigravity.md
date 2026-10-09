# Google Antigravity and Gemini CLI

Integrate Intutic governance with Google's coding agents: [Google Antigravity](https://antigravity.google/) — the desktop app, the IDE and Antigravity CLI — and [Gemini CLI](https://geminicli.com/), which Antigravity CLI replaced for individual users in 2026 and which enterprise and API-key users keep. Both keep their configuration under `~/.gemini`, and one harness, `antigravity`, governs both: `intutic connect` installs a blocking gate for each.

## How it works

| | Google Antigravity (app, IDE, CLI) | Gemini CLI |
|---|---|---|
| Gate | `.intutic/hooks/antigravity-cli-check.js` | `.intutic/hooks/antigravity-check.sh` |
| Registered in | `~/.gemini/config/hooks.json`, as a `PreToolUse` hook for every tool | `~/.gemini/settings.json`, as a `BeforeTool` hook for every tool |
| How a call is refused | The gate prints `{"decision":"deny","reason":"..."}`; the reason ends with the [refusal code](/reference/harness-security-matrix#hook-refusal-codes) | The gate exits with code 2 |
| Rule sets | `GEMINI.md` in the project, a marked section | `GEMINI.md` in the project, the same section |
| Found by | Its app-data directories under `~/.gemini` (`antigravity`, `antigravity-cli`, `antigravity-ide`), a project `.agents/hooks.json`, or `antigravity` on `PATH` | `gemini` on `PATH`, a project `.gemini` directory, or a `~/.gemini/settings.json` with a setting of its own |
| Reports as | `antigravity` | `gemini-cli` |

`intutic init` detects the harness when it finds either product, a plain Gemini CLI install included. Each gate reports its events under its own name, so [gate health](/guide/settings), the [AI inventory](/guide/ai-inventory) and the [SIEM export](/guide/siem-export) show which product a call came through, and a machine with only one of the two is not expected to report from the other. It is still one harness: one entry in `intutic init`, one rules file, and one count in the harness total.

Both gates run before every tool call, with the call as JSON on stdin, and enforce the same policy: the built-in protections, the destructive-command tier, your rule sets, group rules and holds for review. They are installed whether or not any rule set targets the harness.

## Rule sets

Rule sets go into the project's `GEMINI.md`, the file both products load as persistent instructions, between two marker comments. Your own text in the file stays where it is:

```markdown
# Your own project notes

<!-- INTUTIC:RULES:START -->
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT this section — managed by intutic sync daemon; edit outside the INTUTIC:RULES markers

> **Proxy URL:** `http://localhost:4000`

## No secrets in logs

Never print a credential...
<!-- INTUTIC:RULES:END -->
```

- **Gemini CLI** loads `GEMINI.md` from the project directory and every parent up to the git root, and `~/.gemini/GEMINI.md`, and sends them with every prompt; `/memory show` prints what it loaded. It reads the project's files only in a folder you have trusted, so trust the project when Gemini CLI asks. If you renamed the context file with `context.fileName` in `settings.json`, keep `GEMINI.md` in the list, or Gemini CLI will not read the rules.
- **Antigravity** (app, IDE and CLI) loads `GEMINI.md` and `AGENTS.md` from each directory between the file it is working on and the workspace root, and keeps them active on every turn. It truncates any rules file over 24 KB, so keep `GEMINI.md`, rule sets included, under that size.

The first sync appends the section to an existing `GEMINI.md`, or creates the file; later syncs replace the text between the markers, wherever you moved the section, and leave the file alone when nothing changed. An edit inside the section is replaced on the next sync; edits outside it are yours, and are not reported as drift.

Earlier versions wrote the rule sets into a `customInstructions` key of `.gemini/settings.json`, which neither product reads. `intutic disconnect` removes that key.

## Google Antigravity

Antigravity runs hooks from `~/.gemini/config/hooks.json` (all your projects) and `.agents/hooks.json` (one project). Intutic adds its gate to the user-level file under its own key, `intutic-governance`, and keeps every other hook in the file:

```json
{
  "my-linter": { "PostToolUse": [ ... ] },
  "intutic-governance": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node \"/path/to/project/.intutic/hooks/antigravity-cli-check.js\"" }]
      }
    ]
  }
}
```

The gate reads Antigravity's tool calls by their own names and arguments: `run_command` with `CommandLine`, `write_to_file` and `replace_file_content` with `TargetFile`. For a call it allows, the gate prints `{}`, a result with no decision in it, so the permission prompts you set in Antigravity still apply. Antigravity ranks a result with no decision below every decision, so it never overrides another hook's answer either. Each documented decision would change what you see: `allow` approves the call past your prompts, and `ask` or `force_ask` prompts for calls you let run.

You can see and toggle the hook in the app under **Settings > Customizations > Hooks**, and in the CLI with `/hooks`. Turning it off counts as a change to the file: see [Tamper protection](#tamper-protection).

## Gemini CLI

Gemini CLI runs command hooks registered under `hooks.BeforeTool` in `~/.gemini/settings.json`. Intutic merges a catch-all entry for its gate and keeps your other settings and hooks:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": ".*",
        "hooks": [{ "name": "intutic-governance", "type": "command", "command": "bash \"/path/to/project/.intutic/hooks/antigravity-check.sh\"" }]
      }
    ]
  }
}
```

Gemini CLI's shell tool is `run_shell_command`; a hold such as `review_before: action:deploy` applies to the commands it runs.

## MCP servers

`intutic connect` puts the [MCP governance proxy](/guide/mcp-governance) in front of each product's MCP servers on every sync, so a server you add later is wrapped on the next one. The registry, allowlists, call budgets, DLP on results, prompt-injection scanning and TOFU pinning then apply to every MCP call either product makes, in addition to the gates.

| | Google Antigravity | Gemini CLI |
|---|---|---|
| File | `~/.gemini/config/mcp_config.json` | `~/.gemini/settings.json`, and the project's `.gemini/settings.json` when it exists |
| Written when | Antigravity is on the machine (see [How it works](#how-it-works)) | Gemini CLI is on the machine |
| A remote server | `serverUrl`, bridged over SSE, the transport Antigravity documents | `url` with `"type": "sse"`, bridged over SSE; `url` with no `type` or `"type": "http"`, and `httpUrl`, bridged over streamable HTTP |

A local server's `command` becomes `node <proxy> --workspace-id <ws> --server-name <name> -- <command> <args…>`; its `env` is kept and the proxy adds `INTUTIC_WORKSPACE_ID`. A remote server becomes a local one that runs the proxy in bridge mode (`--remote-url <url> --remote-transport sse|http`), with its `headers` in the `INTUTIC_REMOTE_HEADERS` environment variable, so they never appear in the process list. Gemini CLI's other keys stay on the entry and mean the same behind the proxy, which passes each tool through under its own name: `cwd`, `timeout`, `trust`, `description`, `includeTools` and `excludeTools`. An `intutic` server is added to each user-level file; the project's `.gemini/settings.json` gets none, since Gemini CLI already loads the user's.

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/path/to/@intutic/mcp-governance-proxy/dist/index.js", "--workspace-id", "ws_…", "--server-name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "…", "INTUTIC_WORKSPACE_ID": "ws_…" },
      "trust": true
    }
  }
}
```

A wrapped entry is recognised by its command, not by a marker key: Gemini CLI warns at every start about a key its settings schema does not declare. Running the merge again on a wrapped file writes nothing. Left as they are:

- a Gemini CLI server that Gemini CLI authenticates itself, with `oauth` or a Google credential provider in `authProviderType`. The bridge forwards static headers only, so behind it the server would stop authenticating. The [MCP Servers page](/guide/mcp-governance#the-registry) lists it as not governed, with the reason;
- a Gemini CLI websocket server (`tcp`), which the bridge cannot carry;
- servers an Antigravity plugin brings in `plugins/<name>/mcp_config.json`, which belong to the plugin.

A remote server that only speaks SSE and is written as `url` with no `type` stops connecting once bridged: Gemini CLI falls back to SSE on its own, the bridge does not. Add `"type": "sse"` to it.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
  ✔ antigravity → GEMINI.md
```

The harness is detected from a `.gemini/` directory or an `.agents/hooks.json` file in the project, or from Antigravity's app-data directories (`~/.gemini/antigravity`, `~/.gemini/antigravity-cli`, `~/.gemini/antigravity-ide`). `intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

Gemini model traffic is not served by the proxy, so for these agents the gates, and the MCP governance proxy in front of their MCP servers, are the enforcement points.

::: tip Non-destructive merge
Every file is read first and merged; all other settings and hooks are preserved. A file that is not plain JSON (for example one with comments) is left untouched and reported in the `intutic connect` log.
:::

## Tamper protection

Every Intutic gate refuses an agent tool call that names `.gemini/settings.json`, `.gemini/config/hooks.json` or `.agents/hooks.json`, by a file write or in a shell command, so an agent cannot remove its own gate or register a hook that runs ahead of it.

`intutic connect` watches `~/.gemini/settings.json` and `~/.gemini/config/hooks.json`. If a gate registration is removed or disabled, or the file is deleted, it is put back and the change is reported to the control plane. Like every gate file, it is restored under every hand-edit setting, Record only included: see [Settings](/guide/settings).

## Fleet deployment

`intutic enterprise install` writes Jamf and Intune manifests for both gates: `gemini-cli-hooks-*.json` places the Gemini CLI hook in Gemini CLI's system settings file, which Gemini CLI applies over user and workspace settings, and `antigravity-hooks-*.json` places the Antigravity hook in each user's `~/.gemini/config/hooks.json` (Antigravity has no machine-wide hooks file). See [`intutic enterprise install`](/reference/cli#intutic-enterprise-install).

## Disconnecting

To undo what `intutic connect` writes here, run `intutic disconnect --harness antigravity`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `GEMINI.md` only the marked section is removed, and each wrapped MCP server is rebuilt from its command, or taken from the copy of the file connect kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `antigravity` |
| Rules file | `GEMINI.md` in the project (the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->`) |
| Gates | `~/.gemini/config/hooks.json` (Antigravity), `~/.gemini/settings.json` (Gemini CLI) |
| MCP servers | `~/.gemini/config/mcp_config.json` (Antigravity), `mcpServers` in `~/.gemini/settings.json` and the project's `.gemini/settings.json` (Gemini CLI), proxy-wrapped |
| Detection | `.gemini/` or `.agents/hooks.json` in the project, or Antigravity's app-data directories |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
