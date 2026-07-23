# Aider

Integrate Intutic governance with [Aider](https://aider.chat) — the AI pair programming CLI tool.

## How it works

Intutic writes governance rules into the `extra-instructions` field of your `.aider.conf.yml` file. Aider reads this field as additional system instructions for every session.

## Setup

### 1. Ensure .aider.conf.yml exists

```bash
touch .aider.conf.yml
```

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • aider → .aider.conf.yml
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

Intutic writes a YAML file with SOPs in the `extra-instructions` multi-line string:

```yaml
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

# Proxy URL: https://proxy.intutic.ai/v1

extra-instructions: |
  ## Code Review Requirements

  All code changes must include unit tests...

  ---

  ## Security Policy

  Never commit secrets or API keys...
```

::: warning
Intutic overwrites the entire `.aider.conf.yml` file. If you have custom Aider settings (model, edit-format, etc.), consider keeping them in a separate config or managing them as SOPs.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `aider` |
| Config file | `.aider.conf.yml` |
| Detection | Checks for `.aider.conf.yml` in workspace root |
| Format | YAML (`extra-instructions` multi-line string) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
