# GitHub Copilot

Integrate Intutic governance with [GitHub Copilot](https://github.com/features/copilot) — the AI pair programmer.

## How it works

Intutic monitors and modifies `.github/copilot-instructions.md` config in your workspace root. It writes active SOP governance rules as repository-specific instructions. GitHub Copilot automatically loads these instructions for chat queries and inline completions, ensuring recommendations align with your guidelines.

## Setup

### 1. Initialize Intutic

```bash
npx @intutic/cli init
```

The CLI detects GitHub Copilot presence (via `.git` or `.github` folders) and registers it as a harness:

```
✓ Detected harnesses:
  • github-copilot -> .github/copilot-instructions.md
```

### 2. Start sync

```bash
npx @intutic/cli connect
```

## What gets written

Intutic writes rules and configures:
* **Instructions File:** `.github/copilot-instructions.md` containing formatted markdown of all active rules and the proxy URL reference.
