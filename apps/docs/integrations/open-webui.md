# Open WebUI

Integrate Intutic governance with [Open WebUI](https://openwebui.com) — the web interface for LLMs.

## How it works

`intutic connect` writes a Python filter, `~/.open-webui/intutic-governance-filter.py`, that an Open WebUI admin adds once as a Function (**Admin → Settings → Functions → + New Function**, paste the file). The filter sees each prompt and refuses it when it matches a snapshot rule marked block. Open WebUI loads filters only through its admin UI, so Intutic cannot install it into a running instance.

## Setup

### 1. Initialize Intutic

Open WebUI runs as a server (usually in Docker), so `intutic init` cannot detect it. Add `"open-webui"` to the `harnesses` list in `~/.intutic/config.json` yourself (create the file with `intutic init` first).

`intutic init` writes no harness files. The files described on this page are written by `intutic connect` — see [What writes harness files](/integrations/#what-writes-harness-files).

### 2. Start the proxy

```bash
intutic start
```

> Have an Intutic account or run your own control plane? Use `intutic connect` instead. It starts the same proxy and adds bidirectional config sync.

## What gets written

Intutic generates:
* **Filter:** `~/.open-webui/intutic-governance-filter.py` — paste it into Open WebUI as a Function (see above).
* **Notes:** `.intutic/env/open-webui.env` in the workspace, with the same installation steps.
