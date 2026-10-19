# Goose

Integrate Intutic governance with [Goose](https://block.github.io/goose/) — Block's terminal agent and desktop framework.

## How it works

Intutic injects a custom plugin directory into Goose's plugin structure. It creates a blocking hook (`hooks.json`), sets the local proxy base URL in Goose's configuration file (with `--route`), and writes your SOPs into a marked section of the workspace's `.goosehints`, which Goose loads at the start of every session.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Goose and registers it as a harness:

```
  ✔ goose → /path/to/project/.goosehints
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic gates install` (open core, no control plane), from the rule sets in `.intutic/sops/` — see [What writes harness files](/integrations/#what-writes-harness-files):

```bash
intutic gates install
```

### 2. Start the proxy

```bash
intutic start
```

### 3. Route Goose through the proxy

```bash
intutic gates install --route
```

`--route` also writes the `OPENAI_HOST` and `ANTHROPIC_HOST` keys below; the proxy must be running. Without it, start Goose as `intutic exec -- goose` instead.

<!-- ENTERPRISE_ONLY_START -->
> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It writes the same files, starts the same proxy and adds bidirectional config sync.
<!-- ENTERPRISE_ONLY_END -->

## What gets written

Intutic generates and hardens Goose plugin rules:
* **Rules:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in the workspace's `.goosehints`, written when at least one SOP targets Goose. Your own hints in the file are kept. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).
* **Plugin:** `~/.agents/plugins/intutic-governance/plugin.json` and `hooks/hooks.json`, which runs `scripts/intutic-check.sh` on every `PreToolUse` with `on_failure: "block"` (Goose refuses the call if the gate times out, crashes or answers nothing it reads; its default is to run it) and `timeout: 10`. The same script runs on `PostToolUse` with `--event post` and always allows; Goose's post-tool payload has not been checked against a real install, so it records no test outcome, and a [`requires_before: action:run_tests[ok]`](/reference/harness-security-matrix#post-tool-outcome) rule refuses there. Before gate body v23 the post-tool call re-ran the pre-tool gate.
* **Configuration:** `hooks.pre_tool_use` (the gate script) and, with `--route`, `OPENAI_HOST` and `ANTHROPIC_HOST` (the proxy) in `~/.config/goose/config.yaml`. These are the top-level keys Goose's OpenAI and Anthropic providers read their host from; an `OPENAI_BASE_URL` already in the file, which Goose prefers to `OPENAI_HOST`, is pointed at the proxy too. A `GOOSE_PROVIDER` other than these two is not routed through the proxy. A `provider.host` key that an earlier version wrote, which Goose never read, is removed. The rest of the file is kept. The Intutic gate refuses an agent tool call that names this file; if `hooks.pre_tool_use` goes anyway, `intutic gates install` puts it back<!-- ENTERPRISE_ONLY_START -->, and under `intutic connect` the sync daemon does so on its own<!-- ENTERPRISE_ONLY_END -->.
* **Hardening:** Makes the three plugin files read-only (`chmod 444`) and applies file system immutable flags (`chflags uchg` on macOS, `chattr +i` on Linux, which needs root and is skipped without it) to prevent Goose from disabling or deleting the governance hooks.

To undo what `intutic gates install` writes here, run `intutic disconnect --harness goose`: each file goes back to what it held before Intutic first wrote it, or is deleted if Intutic created it, and edits you made since are kept. In `.goosehints` only the marked section is taken out. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
