# n8n

Integrate Intutic governance with [n8n](https://n8n.io) — the workflow automation platform.

## How it works

n8n is governed at two levels. `intutic connect` writes the files below for a recorded n8n harness:

1. **Detection**: `intutic init` checks for an n8n API at `N8N_URL` (default `http://localhost:5678`), or an `N8N_API_TOKEN` in the environment.
2. **Blocking gate (workflow-level)**: It writes an n8n *external hook* module to `~/.intutic/hooks/n8n-governance-hook.js`. Loaded via `EXTERNAL_HOOK_FILES` (see below), its `workflow.preExecute` hook runs before **every workflow execution**, evaluates each node's type and parameters against the compiled protection floor and your policy snapshot, and **throws** on a block-severity match — aborting the execution with an error naming the offending node and rule.
3. **Workflow Generation**: It builds and writes a pre-configured, importable n8n 1.x workflow JSON to `~/.intutic/n8n/governance-workflow.json` (event forwarding — telemetry, not enforcement).
4. **Environment Setup**: It generates a `.intutic/env/n8n.env` file within the workspace, plus `~/.intutic/n8n/INSTALL.md` with the gate's installation steps.

n8n has **no instructions file**: an AI Agent node's system message is part of the workflow, so the text of your rule sets cannot reach the model through a file. The blocking gate still enforces the rules compiled from them. See [Where rule sets go](/guide/how-it-works#where-rule-sets-go).

## The blocking gate

::: warning Manual, deployment-side installation
`EXTERNAL_HOOK_FILES` is read by the **n8n server process at startup** — the
Intutic daemon cannot set another process's environment. Until you set it and
restart n8n, the gate does not run:

```bash
export EXTERNAL_HOOK_FILES=~/.intutic/hooks/n8n-governance-hook.js
```
:::

Granularity is honest here: n8n's hook surface is per **workflow execution**,
not per tool call. The gate maps the shared rule model onto it — a node's
**type** stands in for the tool name (`subject: tool` rules match it), and the
node's **serialized parameters** are what command/path rules and ` WHERE `
(argPattern) rules match. One offending node aborts the whole execution.

---

## Config Details

| Property | Value |
|----------|-------|
| Harness type | `n8n` |
| Rules file | None (n8n reads no instructions file) |
| Config file | `~/.intutic/n8n/governance-workflow.json` |
| Status | ✅ Fully Supported (Phase 3) |
| Format | n8n 1.x Workflow JSON |

---

## Setup & Activation

### 1. Detect & Generate
Run the Intutic init command to detect active harnesses, then connect:
```bash
intutic init
intutic connect
```
If n8n was detected, `intutic connect` writes the gate, `INSTALL.md` and the importable workflow JSON to `~/.intutic/n8n/governance-workflow.json`. It does not change your workflows through the n8n API.

### 2. Import into n8n
1. Open your local or self-hosted n8n instance.
2. Go to **Settings > Import Workflow** and select the generated file at `~/.intutic/n8n/governance-workflow.json`.
3. Activate the imported workflow.

### 3. Add API Key
Add your `INTUTIC_API_KEY` to your environment or configure it in the n8n Credentials UI as a header token. The webhook router will intercept and forward workflow execution trace audits to the Intutic control plane.
