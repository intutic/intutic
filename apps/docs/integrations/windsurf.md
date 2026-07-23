# Windsurf

Integrate Intutic governance with [Windsurf](https://codeium.com/windsurf) — the AI-native code editor by Codeium.

## How it works

Intutic writes governance rules into your project's `.windsurfrules` file, which Windsurf reads as custom instructions for its AI features.

## Setup

### 1. Ensure .windsurfrules exists

```bash
touch .windsurfrules
```

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • windsurf → .windsurfrules
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

Same markdown format as Cursor and Claude Code:

```markdown
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-06-11T22:24:00Z

> **Proxy URL:** `https://proxy.intutic.ai/v1`

## SOP: Code Quality Standards
...
```

## Config details

| Property | Value |
|----------|-------|
| Harness type | `windsurf` |
| Config file | `.windsurfrules` |
| Detection | Checks for `.windsurfrules` in workspace root |
| Format | Markdown (header + SOP sections) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
