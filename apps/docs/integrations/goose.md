# Goose

Integrate Intutic governance with [Goose](https://block.github.io/goose/) — Block's terminal agent and desktop framework.

## How it works

Intutic injects a custom plugin directory into Goose's plugin structure. It creates a blocking hook (`hooks.json`), sets the local proxy base URL in Goose's configuration file, and writes your SOPs into a marked section of the workspace's `.goosehints`, which Goose loads at the start of every session.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Goose and registers it as a harness:

```
  ✔ goose → .goosehints
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic generates and hardens Goose plugin rules:
* **Rules:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in the workspace's `.goosehints`, written when at least one SOP targets Goose. Your own hints in the file are kept. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
* **Plugin Path:** `~/.agents/plugins/intutic-governance/hooks/hooks.json`
* **Configuration:** Updates `OPENAI_HOST` and `GOOSE_PROVIDER` in `~/.config/goose/config.yaml`.
* **Hardening:** Applies file system immutable flags (`chflags uchg` on macOS, `chattr +i` on Linux) to prevent Goose from disabling or deleting the governance hooks.

To undo what `intutic connect` writes here, run `intutic disconnect --harness goose`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. In `.goosehints` only the marked section is taken out. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
