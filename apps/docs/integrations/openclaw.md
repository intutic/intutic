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
✓ Detected harnesses:
  • openclaw -> .openclaw/openclaw.json
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic configures:
* **JSON Config:** `.openclaw/openclaw.json` (specifying the proxy `baseUrl` and authentication rules).
* **Hook Script:** `.intutic/hooks/openclaw-check.js` (drained by sync-daemon).
