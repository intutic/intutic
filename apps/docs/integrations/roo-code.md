# Roo Code

Integrate Intutic governance with [Roo Code](https://github.com/RooVetGit/Roo-Code) — the AI-powered VS Code extension (formerly Roo Clinic).

## How it works

Intutic writes governance rules into `.roorules` inside your project root, which Roo Code reads as custom instructions. Additionally, it writes hooks into `.roorules/hooks/hooks.json` to monitor and intercept actions prior to execution (exit code 2 to cancel).

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Roo Code and registers it as a harness:

```
✓ Detected harnesses:
  • roo-code -> .roorules
```

### 2. Start sync

```bash
intutic connect
```

## What gets written

Intutic generates:
* **Custom Instructions:** `.roorules`
* **Pre-tool execution hooks:** `.roorules/hooks/hooks.json` mapping to `.intutic/hooks/roo-check.js`

## Proxy routing

To route Roo Code's requests through the local proxy:
1. Open the Roo Code sidebar in VS Code.
2. Click the gear icon to open Settings.
3. Choose **API Provider:** `OpenAI Compatible`.
4. Set **Base URL** to `http://localhost:4000/v1`.
5. Enter your Intutic API Key.
