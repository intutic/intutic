# Pi

Integrate Intutic governance with [Pi](https://github.com/earendil-works/pi) — the pi coding agent, a terminal coding harness.

## How it works

Intutic installs a Pi extension whose `tool_call` handler runs inside Pi before every tool call (file reads, writes, edits, shell commands and MCP tools) and refuses a call that breaks a rule by returning Pi's block result with the reason, which the model reads. Pi waits for an extension's handler with no time limit, so the extension refuses a call it cannot finish evaluating within 4 seconds rather than hold the agent. It also points Pi's Anthropic and OpenAI providers at the proxy in Pi's `models.json`, and writes your SOPs into a marked section of the workspace's `AGENTS.md`, which Pi reads as instructions.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Pi Agent and registers it as a harness:

```
  ✔ pi → AGENTS.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic writes rules and configures:
* **Rules:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in the workspace's `AGENTS.md`, written when at least one SOP targets Pi or another `AGENTS.md` reader in the workspace. Your own text in the file is kept, and the section is shared with every other harness that reads `AGENTS.md` (see [Where rule sets go](/guide/how-it-works#where-rule-sets-go)). Once connect creates `AGENTS.md` in a workspace that only had a `CLAUDE.md`, Pi reads `AGENTS.md` in its place.
* **Extension:** `~/.pi/agent/extensions/intutic-governance.js`, which Pi loads at startup and on `/reload`. Your own extensions in that directory are left alone.
* **Provider routing:** `~/.pi/agent/models.json` — `baseUrl` for the `anthropic` provider set to `http://localhost:4000` and for `openai` to `http://localhost:4000/v1`. Other providers and keys are kept; Google is not routed, because the proxy does not serve the Gemini API. The file is merged; one that does not parse is left untouched and reported in the `intutic connect` log.

Both paths are in Pi's default agent directory, `~/.pi/agent`. If you move it with `PI_CODING_AGENT_DIR`, copy the extension into that directory's `extensions/` folder.

An agent cannot edit or remove the extension: the Intutic gate refuses a tool call that names `.pi/agent/extensions`, reading it included, under Pi and under every other harness with a hook gate. Add or change your own extensions there yourself.

To undo what `intutic connect` writes here, run `intutic disconnect --harness pi`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `AGENTS.md` only the marked section is taken out, and it stays while another harness that writes it is still connected. Disconnect also removes what earlier versions wrote where Pi does not read it: the PreToolUse entries in `~/.pi/hooks.json`, the provider routing in `~/.pi/models.json`, and `~/.intutic/hooks/pi-check.sh`. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
