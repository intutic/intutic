# OpenClaw

Integrate Intutic governance with [OpenClaw](https://github.com/clawpute-final) — the developer terminal agent.

## How it works

Intutic monitors and modifies `.openclaw/openclaw.json` config. It registers pre-tool-call checks and configures OpenClaw to route LLM queries through the local proxy. Your SOPs go into a marked section of the `AGENTS.md` in OpenClaw's own agent workspace: OpenClaw reads standing instructions only from that workspace, never from a project's `AGENTS.md`, even when it works in the project.

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
* **JSON Config:** `.openclaw/openclaw.json` (specifying the proxy `baseUrl` and authentication rules).
* **Hook Script:** `.intutic/hooks/openclaw-check.js` (drained by sync-daemon).

To undo what `intutic connect` writes here, run `intutic disconnect --harness openclaw`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `AGENTS.md` only the marked section is taken out. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
