# Antigravity (Gemini)

Integrate Intutic governance with [Google Antigravity](https://cloud.google.com/gemini) — Google's AI coding agent (Gemini CLI / Gemini in IDEs).

## How it works

Intutic does two things:

- **Rules** — merges your SOPs into the `customInstructions` field of the project's `.gemini/settings.json`. Existing settings in the file are preserved — only `customInstructions` is overwritten.
- **A blocking gate** — registers `.intutic/hooks/antigravity-check.sh` as a Gemini CLI `BeforeTool` hook in `~/.gemini/settings.json`. Gemini CLI runs it before every tool call with the call as JSON on stdin and blocks the call when it exits with code 2. Your other settings and hooks in that file are kept.

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
  ✔ antigravity → .gemini/settings.json
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic reads the existing `.gemini/settings.json`, merges governance instructions into `customInstructions`, and writes the file back:

```json
{
  "customInstructions": "# Intutic Governance Rules (auto-generated)\n# DO NOT EDIT — managed by intutic sync daemon\n# Last sync: 2026-06-11T22:24:00Z\n# Proxy URL: http://localhost:4000/v1\n\n## Code Review Requirements\n\nAll code changes must include unit tests...",
  "existingSetting": "preserved",
  "anotherSetting": true
}
```

The gate registration in `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": ".*",
        "hooks": [{ "name": "intutic-governance", "type": "command", "command": "bash \"/path/to/project/.intutic/hooks/antigravity-check.sh\"" }]
      }
    ]
  }
}
```

::: tip Non-destructive merge
Both files are read first and merged; all other settings are preserved. A settings file that is not plain JSON (for example one with comments) is left untouched and reported in the `intutic connect` log.
:::

To undo what `intutic connect` writes here, run `intutic disconnect --harness antigravity`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `antigravity` |
| Config file | `.gemini/settings.json` |
| Detection | Checks for `.gemini/` directory |
| Format | JSON (merges `customInstructions` field) |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
