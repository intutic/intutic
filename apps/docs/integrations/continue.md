# Continue

Integrate Intutic governance with [Continue](https://continue.dev) — the open-source autopilot for VS Code and JetBrains.

## How it works

With `intutic gates install --route`, Intutic points Continue's OpenAI and Anthropic models at the proxy by setting their `apiBase` in `~/.continue/config.yaml`. It always writes your SOPs to `.continue/rules/intutic-governance.md`, a rule with `alwaysApply: true` that Continue adds to every request. Everything else in your config — other models, context providers, comments — is kept.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Continue and registers it as a harness:

```
  ✔ continue → /path/to/project/.continue/rules/intutic-governance.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic gates install` (open core, no control plane), from the rule sets in `.intutic/sops/` — see [What writes harness files](/integrations/#what-writes-harness-files):

```bash
intutic gates install
```

### 2. Start the proxy

```bash
intutic start
```

### 3. Route Continue through the proxy

```bash
intutic gates install --route
```

`--route` also writes the `apiBase` settings below; the proxy must be running.

<!-- ENTERPRISE_ONLY_START -->
> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It writes the same files, starts the same proxy and adds bidirectional config sync.
<!-- ENTERPRISE_ONLY_END -->

## What gets written

* **`~/.continue/config.yaml`** (with `--route`)**:** `apiBase: http://localhost:4000/v1/` on each model whose `provider` is `openai` or `anthropic`. Models from other providers (Ollama, Gemini, …) are left alone — the proxy does not serve their APIs. A config with no such model, or one that does not parse, is left untouched and reported. Intutic does not set `apiKey`; keep your own.
* **`.continue/rules/intutic-governance.md`:** your SOP text, with `alwaysApply: true` front matter, written when at least one SOP targets Continue. The IDE extension reads the `.continue/rules/` of the workspace root; the `cn` CLI reads the `.continue/rules/` of the directory it runs in, so run `cn` from the workspace root. The file is Intutic's own; keep your own rules in other files there. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

To undo what `intutic gates install` writes here, run `intutic disconnect --harness continue`: each file goes back to what it held before Intutic first wrote it, or is deleted if Intutic created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## No pre-tool gate

Continue has no tool-call hook Intutic can use. The IDE extension has no hook
system. The CLI (`cn`) loads `PreToolUse` hooks from its settings files but
never runs them: nothing in it calls `firePreToolUse` (continuedev/continue
`main` at `5522c6f`), and the pull request that would have wired it in was
closed unmerged. So Continue is governed by the proxy, which sees every
request its OpenAI and Anthropic models make, and by the rules file above.
Earlier Intutic versions registered a gate in `.continue/settings.json` that
`cn` never ran; `intutic disconnect --harness continue` removes it.
