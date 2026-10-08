# Roo Code

Integrate Intutic governance with [Roo Code](https://github.com/RooVetGit/Roo-Code) — the AI-powered VS Code extension (formerly Roo Clinic).

## How it works

Intutic writes governance rules into `.roorules` inside your project root, which Roo Code reads as custom instructions. Roo Code has no hook system, so there is no gate to install: the rules are advisory, and enforcement comes from the proxy (once Roo Code is routed through it, below) and from the MCP governance proxy wrapping its MCP servers.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

The CLI detects Roo Code and registers it as a harness:

```
  ✔ roo-code → .roorules
```

`intutic init` only detects the harness and records it in `~/.intutic/config.json`; it writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic generates:
* **Custom Instructions:** `.roorules`

## Proxy routing

To route Roo Code's requests through the local proxy:
1. Open the Roo Code sidebar in VS Code.
2. Click the gear icon to open Settings.
3. Choose **API Provider:** `OpenAI Compatible`.
4. Set **Base URL** to `http://localhost:4000/v1`.
5. Enter your Intutic API Key.

Roo Code keeps these in its own settings storage, not in a file Intutic writes, so this step is manual.
