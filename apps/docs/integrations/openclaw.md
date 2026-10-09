# OpenClaw

Integrate Intutic governance with [OpenClaw](https://github.com/openclaw/openclaw), the self-hosted agent gateway.

## How it works

Intutic installs an OpenClaw plugin whose `before_tool_call` hook runs before every tool call, in the Gateway process, and refuses a call that breaks a rule by returning OpenClaw's block result with the reason, which the model reads. OpenClaw runs this hook fail-closed: if the plugin throws or does not answer within its timeout, the call is blocked. The plugin also refuses a call it cannot finish evaluating within 9 seconds, inside that timeout. OpenClaw's internal hooks (`hooks.internal`) cannot stop a tool call, so the gate does not use them.

Your SOPs go into a marked section of the `AGENTS.md` in OpenClaw's own agent workspace: OpenClaw reads standing instructions only from that workspace, never from a project's `AGENTS.md`, even when it works in the project.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects OpenClaw and registers it as a harness:

```
  ✔ openclaw →
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic configures:
* **Rules:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in `AGENTS.md` of OpenClaw's agent workspace: the directory `agents.defaults.workspace` names in OpenClaw's config, else `OPENCLAW_WORKSPACE_DIR`, else `~/.openclaw/workspace`. Written when at least one SOP targets OpenClaw; the rest of the file is yours. OpenClaw truncates a bootstrap file past 20,000 characters, so keep the rule sets aimed at OpenClaw short. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
* **Plugin:** `~/.intutic/hooks/openclaw/intutic-governance.cjs`, a standalone plugin with the id `intutic-governance`. Its hook registers a 10-second timeout.
* **Config:** the plugin's path added to `plugins.load.paths` in `~/.openclaw/openclaw.json`, and its id added to `plugins.allow` when that list is not empty. The rest of the file is kept, written back as JSON, so comments in a JSON5 file are dropped (disconnect puts the original back); a file that does not parse is left untouched and reported in the `intutic connect` log. The Gateway's default `hybrid` reload mode picks the plugin up; with reload mode `off`, restart the Gateway. If `plugins.enabled` is `false`, or `plugins.deny` lists `intutic-governance`, OpenClaw does not load the plugin, and the `intutic connect` log says so.

An agent cannot edit OpenClaw's config to unload the plugin: the Intutic gate refuses a tool call that names `.openclaw/openclaw.json` or `.intutic/hooks`, reading them included, under OpenClaw and under every other harness with a hook gate. Change the config yourself.

Connect does not route OpenClaw's model traffic. To send it through the proxy, set `baseUrl` on the provider under `models.providers` in `~/.openclaw/openclaw.json`.

To undo what `intutic connect` writes here, run `intutic disconnect --harness openclaw`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `AGENTS.md` only the marked section is taken out. Disconnect also removes the `hooks.internal.entries.intutic-governance` entry and `~/.intutic/hooks/openclaw-check.js` that earlier versions wrote. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
