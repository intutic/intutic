# Hermes

Integrate Intutic governance with [NousResearch Hermes](https://github.com/NousResearch/Hermes) — the skill-based AI developer agent.

## How it works

Intutic injects rules into `.hermes/config.yaml` to override model provider endpoints and binds tool execution hooks (`hermes-check.sh`) to filter shell commands and tool uses.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Hermes and registers it as a harness:

```
✓ Detected harnesses:
  • hermes -> .hermes/config.yaml
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic generates:
* **YAML Config:** `.hermes/config.yaml` (overriding base URLs and credentials).
* **Hook Script:** `.intutic/hooks/hermes-check.js` (referenced for PreToolUse interception).
