# Pi

Integrate Intutic governance with [Pi Agent](https://pi.ai) — Inflection AI's developer command-line assistant.

## How it works

Intutic monitors and modifies `.pi/hooks.json` inside your workspace root. It registers hook scripts to intercept tool calls (such as file reads, writes, and command executions) and enforces policies at the process boundary.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Pi Agent and registers it as a harness:

```
✓ Detected harnesses:
  • pi -> .pi/hooks.json
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic writes rules and configures:
* **Hook Configuration:** `.pi/hooks.json`
* **Hook Script:** `.intutic/hooks/pi-check.js` (invoked prior to tool executions, returning exit code 2 on block).
