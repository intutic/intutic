# Developer Sessions <Badge type="warning" text="Cloud / Team" />

The **Developer Session Monitor** (accessible via `/agent-top` in the dashboard) provides a real-time console showing currently running AI agent processes, active workspace configurations, and central telemetry from developer workstations.

## Why Developer Session Monitor?

AI coding agents are highly active but often hard to observe locally. The Developer Session Monitor brings real-time system process metrics and configuration sync audits together into a single screen:
- **Process Activity (`abtop`)**: Telemetry indicating which agent tools (Cursor, Claude Code, Aider, Windsurf) are actively running on system workstations.
- **Config Sync Status**: Telemetry showing whether local rules files (`.cursorrules`, `CLAUDE.md`, `.windsurfrules`) are synced or have drifted from the central SOP policies.
- **Rules Safety Auditing**: Summarizes findings from local skill audits (secrets, credentials, dangerous wildcards).

---

## Key Features

### 1. Active Process Telemetry (`abtop`)
When the sync daemon runs locally (via `intutic connect`), it polls the local process table to identify active agent runners.
The dashboard displays:
- Active agent tool name (e.g. `Claude Code`, `Cursor`, `Aider`)
- Live connection heartbeats (Daemon status online/offline)
- Active Agent Sessions count

### 2. Local Skills Discovery
Tracks files parsed during local runs of `intutic skill list` and `intutic skill audit`.
Shows:
- File paths (e.g. `.cursorrules`, `CLAUDE.md`)
- Total instruction line counts
- Unsafe segments detected (Security & Compliance issues count)

### 3. Local Audit Auto-Pruning
If the workspace setting `enableLocalSkillAuditDelete` is active:
- The local CLI/daemon automatically prunes any rule lines containing leaked keys, passwords, or unsafe shell wildcards during security scans.

### 4. Local Services Health & Disaster Recovery (DR)
The sync daemon continuously monitors and auto-heals essential local dependencies on the workstation:
- **Proxy Gateway**: The Intutic Rust proxy gateway (port 4000) redirecting LLM API requests and normalising protocols. If it exits or crashes, the daemon immediately re-spawns it.
- **Valkey Cache**: Caches local requests and telemetry (port 6379). The daemon auto-provisions and recovers Valkey using Docker, native binaries, or static fallback binaries.
- **SSL Certificate Trust**: Verifies whether the local CA certificate (`ca.crt`) is trusted by the host OS keychain.

---

## CLI Integration

### List discovered skills:
```bash
intutic skill list
```

### Audit safety:
```bash
intutic skill audit
```
