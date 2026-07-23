# Continue

Integrate Intutic governance with [Continue](https://continue.dev) — the open-source autopilot for VS Code and JetBrains.

## How it works

Intutic writes configuration rules directly into your `~/.continue/config.json` file. It merges the gateway models, system rules, and proxy settings into the existing configurations while preserving user-defined fields.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Continue and registers it as a harness:

```
✓ Detected harnesses:
  • continue -> ~/.continue/config.json
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic updates `~/.continue/config.json` to insert:
* **Models:** Sets `apiBase` to `http://localhost:4000/v1` and injects `apiKey`.
* **System Instructions:** Custom governance prompts injected as default system messages.
