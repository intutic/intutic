# Aider

Integrate Intutic governance with [Aider](https://aider.chat) — the AI pair programming CLI tool.

## How it works

Intutic merges three things into your `.aider.conf.yml`, keeping every other setting:

- **Proxy routing** (with `intutic gates install --route`) — `openai-api-base` set to the proxy for OpenAI models, and an `ANTHROPIC_BASE_URL` entry in `set-env` for Anthropic models (Aider has no Anthropic base-URL option).
- **Rules** — your SOPs written to `.intutic/aider-sops.md` (when the workspace has any) and listed under `read` by absolute path, Aider's way of loading a conventions file into every session. Aider resolves `read` entries against the directory it runs in, so the absolute path lets it find the file from any subdirectory. Aider has no instructions option of its own; it loads only the files listed under `read`.
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
  ✔ aider → /path/to/project/.intutic/aider-sops.md
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic gates install` (open core, no control plane), from the rule sets in `.intutic/sops/` — see [What writes harness files](/integrations/#what-writes-harness-files):

```bash
intutic gates install
```

### 3. Start the proxy

```bash
intutic start
```

### 4. Route Aider through the proxy

```bash
intutic gates install --route
```

`--route` also writes the proxy routing keys below; the proxy must be running. Without it, start Aider as `intutic exec -- aider` instead.

<!-- ENTERPRISE_ONLY_START -->
> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It writes the same files, starts the same proxy and adds bidirectional config sync.
<!-- ENTERPRISE_ONLY_END -->

## What gets written

Given this `.aider.conf.yml`:

```yaml
model: sonnet
read:
  - CONVENTIONS.md
test-cmd: pytest
```

`intutic gates install --route` leaves:

```yaml
# Intutic: openai-api-base, the ANTHROPIC_BASE_URL set-env entry and the
# .intutic/aider-sops.md read entry are managed by Intutic. test-cmd,
# lint-cmd, auto-test and auto-lint are removed on every sync.

model: sonnet
read:
  - CONVENTIONS.md
  - /path/to/project/.intutic/aider-sops.md
openai-api-base: http://localhost:4000/v1
set-env:
  - ANTHROPIC_BASE_URL=http://localhost:4000
```

Lists, nested values and comments are preserved; only the keys above are added or replaced. A file that does not parse as YAML is left untouched and reported. Only options Aider accepts are written — Aider refuses to start on an unknown key.

To undo what `intutic gates install` writes here, run `intutic disconnect --harness aider`: each file goes back to what it held before Intutic first wrote it, or is deleted if Intutic created it, and edits you made since are kept. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `aider` |
| Config file | `.aider.conf.yml` |
| Detection | Checks for `.aider.conf.yml` in workspace root |
| Format | YAML (merged: `openai-api-base`, `set-env`, `read`) |
| Rules file | `.intutic/aider-sops.md` |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
