# OpenClaw

Integrate Intutic governance with [OpenClaw](https://github.com/clawpute-final) — the developer terminal agent.

## How it works

Intutic monitors and modifies `.openclaw/openclaw.json` config. It registers pre-tool-call checks and configures OpenClaw to route LLM queries through the local proxy.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects OpenClaw and registers it as a harness:

```
  ✔ openclaw → .openclaw/openclaw.json
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic configures:
* **JSON Config:** `.openclaw/openclaw.json` (specifying the proxy `baseUrl` and authentication rules).
* **Hook Script:** `.intutic/hooks/openclaw-check.js` (drained by sync-daemon).

To undo what `intutic connect` writes here, run `intutic disconnect --harness openclaw`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).
