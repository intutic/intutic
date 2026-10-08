# Aider

Integrate Intutic governance with [Aider](https://aider.chat) — the AI pair programming CLI tool.

## How it works

Intutic merges three things into your `.aider.conf.yml`, keeping every other setting:

- **Proxy routing** — `openai-api-base` set to the proxy for OpenAI models, and an `ANTHROPIC_BASE_URL` entry in `set-env` for Anthropic models (Aider has no Anthropic base-URL option).
- **Rules** — your SOPs written to `.intutic/aider-sops.md` and listed under `read`, Aider's way of loading a conventions file into every session.
- **Hardening** — `test-cmd`, `lint-cmd`, `auto-test` and `auto-lint` are removed, because Aider runs them without asking.

Aider has no hook that runs before it edits a file or runs a command, so there is no blocking gate for Aider: its traffic is governed at the proxy.

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
  ✔ aider → .aider.conf.yml
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 3. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Given this `.aider.conf.yml`:

```yaml
model: sonnet
read:
  - CONVENTIONS.md
test-cmd: pytest
```

`intutic connect` leaves:

```yaml
# Intutic: openai-api-base, the ANTHROPIC_BASE_URL set-env entry and the
# .intutic/aider-sops.md read entry are managed by intutic connect. test-cmd,
# lint-cmd, auto-test and auto-lint are removed on every sync.

model: sonnet
read:
  - CONVENTIONS.md
  - .intutic/aider-sops.md
openai-api-base: http://localhost:4000/v1
set-env:
  - ANTHROPIC_BASE_URL=http://localhost:4000
```

Lists, nested values and comments are preserved; only the keys above are added or replaced. A file that does not parse as YAML is left untouched and reported in the `intutic connect` log. Only options Aider accepts are written — Aider refuses to start on an unknown key.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `aider` |
| Config file | `.aider.conf.yml` |
| Detection | Checks for `.aider.conf.yml` in workspace root |
| Format | YAML (merged: `openai-api-base`, `set-env`, `read`) |
| Rules file | `.intutic/aider-sops.md` |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
