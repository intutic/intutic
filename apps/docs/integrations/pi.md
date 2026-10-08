# Pi

Integrate Intutic governance with [Pi](https://github.com/earendil-works/pi) — the pi coding agent, a terminal coding harness.

## How it works

Intutic registers a PreToolUse hook in Pi's user config, `~/.pi/hooks.json`, that runs before every tool call (file reads, writes and command executions) and blocks it with exit code 2 when it breaks a rule. It also points Pi's Anthropic and OpenAI providers at the proxy in `~/.pi/models.json`.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Pi Agent and registers it as a harness:

```
  ✔ pi → .pi/hooks.json
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic writes rules and configures:
* **Hook configuration:** `~/.pi/hooks.json` — PreToolUse entries for `Bash`, `Edit`, `Write` and `.*`, merged with your own hooks.
* **Hook script:** `~/.intutic/hooks/pi-check.sh` (runs before each tool call; exit code 2 blocks it).
* **Provider routing:** `~/.pi/models.json` — `baseUrl` for the `anthropic` provider set to `http://localhost:4000` and for `openai` to `http://localhost:4000/v1`. Other providers and keys are kept; Google is not routed, because the proxy does not serve the Gemini API.

Both JSON files are merged; one that does not parse is left untouched and reported in the `intutic connect` log.
