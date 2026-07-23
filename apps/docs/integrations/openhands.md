# OpenHands

Integrate Intutic governance with [OpenHands](https://github.com/All-Hands-AI/OpenHands) — the open-source AI software developer platform.

## How it works

Intutic writes governance rules into an `[intutic]` section of your `config.toml` file, which OpenHands reads for configuration. The section includes the proxy URL and SOP instructions as a multi-line TOML string.

## Setup

### 1. Ensure config.toml exists

```bash
touch config.toml
```

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • openhands → config.toml
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

Intutic writes a TOML file with an `[intutic]` section:

```toml
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

[intutic]
proxy_url = "https://proxy.intutic.ai/v1"
instructions = """
## Code Review Requirements

All code changes must include unit tests...

---

## Security Policy

Never commit secrets or API keys...
"""
```

::: warning
Intutic overwrites the entire `config.toml` file. If you have custom OpenHands settings, keep them in a separate config file or manage them through the Intutic dashboard.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `openhands` |
| Config file | `config.toml` |
| Detection | Checks for `config.toml` in workspace root |
| Format | TOML (`[intutic]` section with `proxy_url` and `instructions`) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
