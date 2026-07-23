# Cursor

Integrate Intutic governance with [Cursor](https://cursor.sh) — the AI-powered code editor.

## How it works

Intutic writes governance rules into your project's `.cursorrules` file, which Cursor reads as custom instructions for its AI features. This means governance policies are automatically applied to every Cursor AI interaction.

## Setup

### 1. Ensure .cursorrules exists

Cursor looks for `.cursorrules` in your project root:

```bash
touch .cursorrules
```

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • cursor → .cursorrules
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `https://proxy.intutic.ai/v1`

## Code Review Requirements

All code changes must include unit tests...

---

## Security Policy

Never commit secrets or API keys...
```

::: warning
Intutic overwrites the entire `.cursorrules` file during sync. Move any custom rules into SOPs on the Intutic dashboard.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `cursor` |
| Config file | `.cursorrules` |
| Detection | Checks for `.cursorrules` in workspace root |
| Format | Markdown (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
