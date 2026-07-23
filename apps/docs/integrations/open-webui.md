# Open WebUI

Integrate Intutic governance with [Open WebUI](https://openwebui.com) — the web interface for LLMs.

## How it works

Intutic injects a custom Python filter script `intutic-governance-filter.py` into OpenWebUI's directory. This filter acts as a middleware hook on all prompts and completions, running DLP, loop detection, and policy checks via local HTTP calls.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects OpenWebUI and registers it as a harness:

```
✓ Detected harnesses:
  • open-webui -> .open-webui/intutic-governance-filter.py
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic generates:
* **Filter Hook:** `.open-webui/intutic-governance-filter.py` (which connects to the local proxy / control plane to enforce policies).
