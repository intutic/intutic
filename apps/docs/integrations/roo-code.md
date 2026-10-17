# Roo Code

Integrate Intutic governance with [Roo Code](https://github.com/RooVetGit/Roo-Code) — the AI-powered VS Code extension (formerly Roo Cline).

## How it works

Intutic writes governance rules into a marked section of the workspace's `AGENTS.md`, which Roo Code reads as custom instructions unless the `roo-cline.useAgentRules` setting is off. Roo Code has no hook system, so there is no gate to install: the rules are advisory, and enforcement comes from the proxy, once Roo Code is routed through it (below). Intutic does not wrap Roo Code's MCP servers.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Roo Code and registers it as a harness:

```
  ✔ roo-code → /path/to/project/AGENTS.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic gates install` (open core, no control plane), from the rule sets in `.intutic/sops/` — see [What writes harness files](/integrations/#what-writes-harness-files):

```bash
intutic gates install
```

### 2. Start the proxy

```bash
intutic start
```

<!-- ENTERPRISE_ONLY_START -->
> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It writes the same files, starts the same proxy and adds bidirectional config sync.
<!-- ENTERPRISE_ONLY_END -->

## What gets written

Intutic generates:
* **Rules:** the section between `<!-- INTUTIC:RULES:START -->` and `<!-- INTUTIC:RULES:END -->` in the workspace's `AGENTS.md`, written when at least one SOP targets Roo Code or another `AGENTS.md` reader in the workspace. Your own text in the file is kept, and the section is shared with every other harness that reads `AGENTS.md` (see [Where rule sets go](/guide/how-it-works#where-rule-sets-go)).

Intutic does not write `.roorules` or `.roo/rules/`: a file in `.roo/rules/` would stop Roo Code reading your own `.roorules` and `.clinerules`. Earlier versions overwrote `.roorules` whole; the first write with this version gives you your own copy of it back.

To undo what `intutic gates install` writes here, run `intutic disconnect --harness roo-code`: each file goes back to what it held before Intutic first wrote it, or is deleted if Intutic created it, and edits you made since are kept. In `AGENTS.md` only the marked section is taken out, and it stays while another harness that writes it is still connected. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Proxy routing

To route Roo Code's requests through the local proxy:
1. Open the Roo Code sidebar in VS Code.
2. Click the gear icon to open Settings.
3. Choose **API Provider:** `OpenAI Compatible`.
4. Set **Base URL** to `http://localhost:4000/v1`.
5. Enter your Intutic API Key.

Roo Code keeps these in its own settings storage, not in a file Intutic writes, so this step is manual.
