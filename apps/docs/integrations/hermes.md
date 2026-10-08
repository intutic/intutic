# Hermes

Integrate Intutic governance with [NousResearch Hermes](https://github.com/NousResearch/Hermes) — the skill-based AI developer agent.

## How it works

Intutic registers a pre-tool hook in Hermes' user config, `~/.hermes/config.yaml` (`hooks.preToolUse.command`), pointing at `~/.intutic/hooks/hermes-check.sh`, which filters shell commands and tool calls and blocks with exit code 2. It also installs a governance skill that tells the agent the hook exists. It does not change Hermes' model provider settings — point Hermes at the proxy yourself.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Hermes and registers it as a harness:

```
  ✔ hermes → .hermes/config.yaml
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic generates:
* **Hook registration:** `hooks.preToolUse.command` in `~/.hermes/config.yaml`. Only that key is set; the rest of the file, comments included, is kept, and a file that does not parse is left untouched.
* **Hook script:** `~/.intutic/hooks/hermes-check.sh`.
* **Skill:** `~/.hermes/skills/intutic-governance/SKILL.md` — tells the agent that tool calls are checked and not to work around a block.

To undo what `intutic connect` writes here, run `intutic disconnect --harness hermes`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
