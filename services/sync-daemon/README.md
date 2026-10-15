# @intutic/sync-daemon

> Bidirectional state sync between the Intutic control plane and developer workspaces.

## Overview

The sync daemon runs as a background process on developer machines, maintaining a live bidirectional link between the Intutic control plane and local AI coding harness configurations. It ensures that governance SOPs are always reflected in harness config files, and that local configuration changes are captured and reported upstream.

## Core Loop

```
fetch config → write harness files → compute hashes → report drift
```

On each sync cycle the daemon:

1. **Fetches** the latest SOP configuration from the control plane
2. **Writes** harness-specific config files: the CLI's harness adapters write the rules files, and this package's gate writers and config mergers the gates and settings they need
3. **Computes** content hashes for drift detection
4. **Reports** any detected drift back to the control plane

## Features

### Config Writers

The rules files are written by the CLI's harness adapters (one module per harness under `tools/cli/src/harness/`), which `intutic connect` runs. This package's `src/harness/` holds what they call: the gate writers (`*Hooks.ts`) and config mergers that translate governance SOPs into native configuration formats (YAML, JSON, TOML, Markdown, environment variables); most harnesses get a blocking pre-tool gate. The authoritative list of which harness gets which gate shape is `gateKind.ts` in `@intutic/shared-types`, and `__tests__/harness/gateRegistry.ts` exercises every generated gate — counts are not repeated here because they drifted every time a harness was added.

### Atomic Writes

Every write of a file a harness or gate reads (gate scripts, hook registrations, harness settings, the policy snapshot) goes to a temp file beside the target and is renamed over it (`src/lib/atomicWrite.ts`), so a reader never sees a partial file.

### macOS Immutable Flag Enforcement

When the workspace's `bypassEnforcementTier` is `immutable`, the daemon sets the macOS immutable flag (`chflags uchg`) on the rules files it manages between cycles, so a hand edit fails. The default tier, `rewrite`, sets no flag.

### Drift Detection

Content-hash-based drift detection identifies when a harness rules file has been modified outside of the sync loop and reports the discrepancy to the control plane. Under the default `rewrite` tier the daemon also puts the file back, keeping the edited copy as `<file>.drift-backup`; under `alert-only` the edit stays and is only reported.

### Trajectory Monitoring

Runs in the `intutic connect` process: watches the proxy's live trace events, buffers them per session in a sliding window, and submits trajectory summaries to the control plane for governance evaluation. A summary the control plane cannot take yet is spooled to `~/.intutic/events/offline-trajectories.jsonl` (capped at 16 MB) and retried; one it refuses with a non-retryable 4xx is dropped. No LLM runs on the developer machine.

### Config Capture

Captures each recorded harness's rules file for the workspace's config history. By default a capture is metadata only (path, SHA-256 of the redacted text, size); with the workspace's `configBodyUpload` setting on, it carries the text too, credential-shaped strings replaced by `[redacted]` first.

## Usage

The daemon is started via the CLI:

```bash
intutic connect                   # Start with default 30s interval
intutic connect --interval 10000  # Custom sync interval (milliseconds)
```

The package has no executable of its own; `intutic connect` is how it runs.

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
