---
title: intutic doctor
description: Diagnose workspace health — verify proxy, auth, daemon, config integrity, logs, Valkey, cert trust, the policy snapshot and the optional Cisco skill scanner.
---

# `intutic doctor`

Runs a series of health checks to verify that all Intutic components are properly configured and reachable. Each check prints ✓ or ✗ with a one-line remediation if something is wrong.

## Usage

```bash
intutic doctor
```

No flags. The command reads `~/.intutic/` and the workspace recorded by `intutic init`.

## Checks

The doctor runs these nine checks in order:

| # | Check | What it verifies | Pass condition |
|---|---|---|---|
| 1 | **Proxy** | `GET http://127.0.0.1:4000/health` (the port of `INTUTIC_PROXY_URL` when set) | HTTP 200 within 3s |
| 2 | **Control Plane Auth** | `GET {controlPlaneUrl}/api/v1/auth/me` with the stored credentials from `intutic login` | Any response other than 401/403 within 5s |
| 3 | **Sync Daemon** | PID file at `~/.intutic/daemon.pid`, or a process scan | Process is alive |
| 4 | **Harness Configs** | SHA-256 of each governed harness file against `<workspaceRoot>/.intutic/integrity.json`, which `intutic connect` writes | Every file present and unchanged |
| 5 | **Daemon Log** | The first readable of `~/.intutic/logs/sync-daemon.log`, the system-service log (`/Library/Logs/Intutic/sync-daemon.log` on macOS, `/var/log/intutic/sync-daemon.log` on Linux), then the legacy `~/.intutic/daemon.log` | Readable and not empty; the age of the newest entry is shown |
| 6 | **Valkey** | TCP connection to `127.0.0.1:6379` | Connects within 2s |
| 7 | **Cert Trust** | `~/.intutic/ca.crt` exists and is in the OS trust store | macOS: `security verify-cert`; Linux: system CA directory |
| 8 | **Policy Snapshot** | `~/.intutic/hooks/policy-snapshot.rules`, the compiled workspace policy every harness gate reads | Present, digest valid, belongs to the logged-in workspace, at least one rule, refreshed within 7 days |
| 9 | **Cisco Skill Scanner** | Whether the optional `skill-scanner` binary used by `intutic skill audit --engine cisco` is on `PATH` | Always passes; prints the install command when absent |

Valkey is optional for a standalone proxy (`intutic start` runs without it), so a failed
Valkey check on a machine that never set one up is expected. A stale policy snapshot is still
enforced; the check fails because nothing has refreshed it in over a week.

The command exits `0` whether or not checks fail, so read the summary line rather than the
exit status.

## Example output

```
Intutic Doctor — Workspace Health Check

  ✓ Proxy — Reachable at http://127.0.0.1:4000/health (HTTP 200)
  ✓ Control Plane Auth — Authenticated at https://your-control-plane.example
  ✓ Sync Daemon — Running (PID 42156)
  ✓ Harness Configs — 3 file(s) intact — no drift detected
  ✓ Daemon Log — Readable at /Users/dev/.intutic/logs/sync-daemon.log (847 lines, last entry 2m ago)
  ✓ Valkey — Reachable at 127.0.0.1:6379 (direct TCP probe)
  ✓ Cert Trust — CA cert exists and is trusted by macOS Keychain
  ✓ Policy Snapshot — 9 rule(s), digest a1b2c3d4e5f60718293a4b5c6d7e8f90, 0d old
  ✓ Cisco Skill Scanner — not installed (optional integration)
    → pipx install cisco-ai-skill-scanner

✔ All 9 checks passed — workspace is healthy.
```

When a check fails:

```
  ✗ Proxy — Not reachable — fetch failed
    → Start the proxy: ensure `intutic connect` is running or the proxy binary is started.
  ✗ Sync Daemon — Not running
    → Start with `intutic connect` or install as a service with `intutic daemon install`.
```

## Remediation commands

| Check | Fix |
|---|---|
| Proxy not reachable | `intutic start` (standalone) or `intutic connect` |
| No credentials | `intutic login` |
| Auth failed (401/403) | `intutic login` (re-authenticate) |
| Daemon not running | `intutic connect` or `intutic daemon install` |
| No workspace config | `intutic init` |
| No integrity data, or config drift detected | `intutic connect` (writes the configs and auto-corrects drift) |
| Daemon log not found | Start the daemon first with `intutic connect` |
| Valkey not reachable | `docker compose up -d valkey` or install locally (optional for a standalone proxy) |
| CA cert not found | `intutic connect` (auto-generates on first run) |
| CA cert not trusted (macOS) | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.intutic/ca.crt` |
| CA cert not trusted (Linux) | `sudo cp ~/.intutic/ca.crt /usr/local/share/ca-certificates/intutic-ca.crt && sudo update-ca-certificates` |
| Policy snapshot absent, invalid, empty or stale | `intutic policy snapshot` |
| Cisco skill scanner not installed | `pipx install cisco-ai-skill-scanner` (only needed for `--engine cisco`) |

## Source

- [doctor.ts](https://github.com/intutic/intutic/blob/main/tools/cli/src/commands/doctor.ts)
