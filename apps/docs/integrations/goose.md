# Goose

Integrate Intutic governance with [Goose](https://block.github.io/goose/) — Block's terminal agent and desktop framework.

## How it works

Intutic injects a custom plugin directory into Goose's plugin structure. It creates a blocking hook (`hooks.json`) and sets the local proxy base URL in Goose's configuration file.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Goose and registers it as a harness:

```
✓ Detected harnesses:
  • goose -> ~/.config/goose/config.yaml
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic generates and hardens Goose plugin rules:
* **Plugin Path:** `~/.agents/plugins/intutic-governance/hooks/hooks.json`
* **Configuration:** Updates `OPENAI_HOST` and `GOOSE_PROVIDER` in `~/.config/goose/config.yaml`.
* **Hardening:** Applies file system immutable flags (`chflags uchg` on macOS, `chattr +i` on Linux) to prevent Goose from disabling or deleting the governance hooks.
