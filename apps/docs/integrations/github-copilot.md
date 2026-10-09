# GitHub Copilot

Integrate Intutic governance with [GitHub Copilot](https://github.com/features/copilot) — the AI pair programmer.

## How it works

Intutic writes active SOP governance rules into a marked section of `.github/copilot-instructions.md`, Copilot's repository-specific instructions file. Your own instructions in the file are kept. GitHub Copilot automatically loads these instructions for chat queries and inline completions, ensuring recommendations align with your guidelines. In VS Code agent mode it also installs a PreToolUse hook that refuses tool calls breaking a rule — see [Pre-tool hooks](#pre-tool-hooks-preview).

## Setup

### 1. Initialize Intutic

```bash
npx @intutic/cli init
```

The CLI detects GitHub Copilot presence (via `.git` or `.github` folders) and registers it as a harness:

```
  ✔ github-copilot → .github/copilot-instructions.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start sync

```bash
npx @intutic/cli connect
```

## What gets written

Intutic writes rules and configures:
* **Instructions:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in `.github/copilot-instructions.md`, holding the active rules and the proxy URL reference. The file is created if it does not exist; nothing outside the markers is changed. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
* **Agent-mode hook (Preview):** `.github/hooks/intutic-governance.json` (workspace) and `~/.copilot/hooks/intutic-governance.json` (user), registering the blocking gate `.intutic/hooks/github-copilot-check.js`. The Intutic gate refuses an agent tool call that names either hook file, and the sync daemon writes one back if it is deleted or loses the gate.

To undo what `intutic connect` writes here, run `intutic disconnect --harness github-copilot`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `.github/copilot-instructions.md` only the marked section is taken out. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Pre-tool hooks (Preview)

::: warning Preview feature
VS Code agent hooks are a **Preview** mechanism and the format may change
between releases. The generated gate fails **closed**: a stdin payload it does
not recognise is refused (exit 2) rather than silently allowed, so a format
shift surfaces as loud blocks — restart `intutic connect` after upgrading so it rewrites the gate.
:::

In agent mode, Copilot fires the PreToolUse hook before each tool call with
JSON on stdin (`{session_id, cwd, hook_event_name, tool_name, tool_input,
tool_use_id}`). The gate evaluates the compiled protection floor plus your
policy snapshot — including ` WHERE ` (argPattern) rules matched against the
serialized tool input — and refuses with exit code 2 (a
`"permissionDecision": "deny"` from any hook also wins). The instructions file
remains in place as an advisory layer; the hook is what enforces.

### Keeping the hook on

VS Code loads hook files from `.github/hooks` and `~/.copilot/hooks` by
default, so the gate needs no VS Code setting. Two settings can still switch
it off: `chat.useHooks` set to false turns every hook off, and an entry in
`chat.hookFilesLocations` that maps `.github/hooks` or `~/.copilot/hooks` (or
the hook file itself) to false drops that location. No VS Code policy locks
`chat.hookFilesLocations`, so Intutic protects the two keys instead:

- Every Intutic hook gate refuses an agent edit (Write, Edit) that sets either
  key, in any settings file, and a shell command that names either one (rules
  `hook_settings.vscode_key_written` and `hook_settings.vscode_key_command`).
- The sync daemon watches your VS Code user settings and the workspace's
  `.vscode/settings.json`. If either key is set to switch the gate off, it sets
  that value back to true, changes nothing else in the file, comments included,
  and reports the change as a `config_tamper` incident. It does this only while
  the Copilot gate is installed.

To change hook settings yourself, edit them in VS Code's settings rather than
through an agent.

#### The administrator's lock

For a hard lock, use VS Code's enterprise policies, deployed through Group
Policy, Intune or a macOS configuration profile
([AI settings in VS Code](https://code.visualstudio.com/docs/enterprise/ai-settings)):

| Policy | What it does |
|---|---|
| `ChatHooks` | Controls `chat.useHooks`. Set it to `true` so hooks cannot be switched off in settings; `false` disables every hook, Intutic's gate included. |
| `ChatAllowManagedHooksOnly` | Loads hooks only from enterprise-managed sources and plugins a policy force-enables, so a hook file an agent writes into a workspace does not load. With it set, deliver Intutic's hook through your managed source too, or the gate in `.github/hooks` does not load either. |

`ChatHooks` applies to VS Code's Local agent harness, where these hooks run; it does not apply to Copilot sessions that use Agent Host.
