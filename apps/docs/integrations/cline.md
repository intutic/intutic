# Cline

Integrate Intutic governance with [Cline](https://github.com/cline/cline) — the VS Code extension for autonomous agentic coding.

## How it works

Cline runs *file hooks*: an executable named `PreToolUse` in a hooks directory runs before every tool call, with the call as JSON on stdin. Intutic installs its gate as `.clinerules/hooks/PreToolUse`. It refuses a call by printing `{"cancel": true, "errorMessage": "…"}` on stdout, with the refusal's `code` and `ruleId` ([refusal codes](/reference/harness-security-matrix#hook-refusal-codes)) — Cline ignores the hook's exit code. The hook has no tool filter, so it sees every tool call, including MCP calls (`use_mcp_tool`). Governance rules are written next to it as `.clinerules/intutic-governance.md`, which Cline reads as a rules file.

The same file serves the VS Code extension and the Cline CLI, which read different payload shapes; the gate accepts both. In the VS Code extension, turn on **Enable Hooks** in Cline's feature settings — hooks do not run until you do.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Cline and registers it as a harness:

```
  ✔ cline → .clinerules/intutic-governance.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

* **Gate:** `.clinerules/hooks/PreToolUse` — an executable Node.js script that evaluates shell commands, file edits and MCP tool calls against the built-in protections and your SOPs.
* **Rules:** `.clinerules/intutic-governance.md` — your SOP text.

`.clinerules` has to be a directory for both to fit. A flat `.clinerules` file that an earlier Intutic version wrote is converted automatically. A flat `.clinerules` file you wrote yourself is left alone, and no gate is installed until you move its content into a file inside a `.clinerules/` directory; the `intutic connect` log says so. A `PreToolUse` hook you wrote yourself is never overwritten.

To undo what `intutic connect` writes here, run `intutic disconnect --harness cline`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Proxy routing

To route Cline's LLM requests through the local proxy:
1. Open the Cline panel in VS Code.
2. Click the gear icon to open Settings.
3. Set **API Provider** to `OpenAI Compatible`.
4. Set **Base URL** to `http://localhost:4000/v1`.
5. Enter your Intutic API Key.

Cline keeps these in its own settings storage, not in a file Intutic writes, so this step is manual. For the **Anthropic** provider instead, check **Use custom base URL** and enter `http://localhost:4000` — Cline appends `/v1/messages` itself.
