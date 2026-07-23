# Antigravity (Gemini)

Integrate Intutic governance with [Google Antigravity](https://cloud.google.com/gemini) — Google's AI coding agent (Gemini CLI / Gemini in IDEs).

## How it works

Intutic merges governance rules into the `customInstructions` field of your `.gemini/settings.json` file. Existing settings in the JSON file are preserved — only `customInstructions` is overwritten.

## Setup

### 1. Ensure .gemini directory exists

```bash
mkdir -p .gemini
```

Antigravity detection checks for the `.gemini/` directory, not the settings file itself.

### 2. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • antigravity → .gemini/settings.json
```

### 3. Start sync

```bash
intutic connect
```

## What gets written

Intutic reads the existing `.gemini/settings.json`, merges governance instructions into `customInstructions`, and writes the file back:

```json
{
  "customInstructions": "# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n# Last sync: 2026-06-11T22:24:00Z\n# Proxy URL: https://proxy.intutic.ai/v1\n\n## Code Review Requirements\n\nAll code changes must include unit tests...",
  "existingSetting": "preserved",
  "anotherSetting": true
}
```

::: tip Non-destructive merge
Unlike other harness adapters, the Antigravity adapter reads the existing JSON file first and only updates the `customInstructions` field. All other settings are preserved.
:::

## Config details

| Property | Value |
|----------|-------|
| Harness type | `antigravity` |
| Config file | `.gemini/settings.json` |
| Detection | Checks for `.gemini/` directory |
| Format | JSON (merges `customInstructions` field) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
