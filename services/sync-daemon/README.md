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
2. **Writes** harness-specific config files using 18 format-aware config writers
3. **Computes** content hashes for drift detection
4. **Reports** any detected drift back to the control plane

## Features

### Config Writers

18 harness-specific config writers that translate governance SOPs into native configuration formats (YAML, JSON, TOML, Markdown, environment variables).

### Atomic Writes

All config file writes use a write-to-tmp + rename pattern to prevent partial writes from corrupting harness configurations.

### macOS Immutable Flag Enforcement

On macOS, the daemon sets the immutable flag (`chflags uchg`) on managed config files to prevent accidental manual edits that would cause governance drift.

### Drift Detection

Content-hash-based drift detection identifies when harness config files have been modified outside of the sync loop and reports the discrepancy to the control plane.

### Trajectory Monitoring

Monitors active agent sessions and streams trajectory data (tool calls, file edits, terminal commands) to the control plane for real-time governance evaluation.

### Brain Indexing

Indexes harness-specific context directories (BRAIN folders, memory files, skill definitions) and uploads structured metadata to the context graph.

### Config Capture

Captures point-in-time snapshots of all harness configurations for audit, compliance, and historical comparison.

## Usage

The daemon is typically started via the CLI:

```bash
intutic connect              # Start with default 30s interval
intutic connect --interval 10  # Custom sync interval (seconds)
```

Or directly:

```bash
npx @intutic/sync-daemon --api-url https://api.intutic.ai --interval 30
```

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
