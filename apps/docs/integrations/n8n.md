# n8n

Integrate Intutic governance with [n8n](https://n8n.io) — the workflow automation platform.

## How it works

Unlike file-based harnesses, n8n relies on an importable workflow node structure to enforce governance rules. The sync-daemon automatically handles detection and config generation for n8n:

1. **Detection**: The sync-daemon checks for active `n8n` processes running locally.
2. **Workflow Generation**: It builds and writes a pre-configured, importable n8n 1.x workflow JSON to `~/.intutic/n8n/governance-workflow.json`.
3. **Environment Setup**: It generates a `.intutic/env/n8n.env` file within the workspace, containing active webhook URLs and integration instructions.

---

## Config Details

| Property | Value |
|----------|-------|
| Harness type | `n8n` |
| Config file | `~/.intutic/n8n/governance-workflow.json` |
| Status | ✅ Fully Supported (Phase 3) |
| Format | n8n 1.x Workflow JSON |

---

## Setup & Activation

### 1. Detect & Generate
Run the Intutic init command to detect and configure active harnesses:
```bash
intutic init
```
If an active n8n instance is running, the sync-daemon will register it and write the importable workflow JSON to `~/.intutic/n8n/governance-workflow.json`.

### 2. Import into n8n
1. Open your local or self-hosted n8n instance.
2. Go to **Settings > Import Workflow** and select the generated file at `~/.intutic/n8n/governance-workflow.json`.
3. Activate the imported workflow.

### 3. Add API Key
Add your `INTUTIC_API_KEY` to your environment or configure it in the n8n Credentials UI as a header token. The webhook router will intercept and forward workflow execution trace audits to the Intutic control plane.
