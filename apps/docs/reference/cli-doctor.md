---
title: intutic doctor
description: Diagnose workspace health — verify proxy, auth, daemon, config integrity, logs, Valkey, and cert trust.
---

# `intutic doctor`

Runs a series of health checks to verify that all Intutic components are properly configured and reachable. Each check prints ✓ or ✗ with a one-line remediation if something is wrong.

## Usage

```bash
intutic doctor
```

No flags required — the command reads workspace configuration from `~/.intutic/`.

## Checks

The doctor runs these checks in order:

| # | Check | What it verifies | Pass condition |
|---|---|---|---|
| 1 | **Proxy** | `GET http://127.0.0.1:4000/health` | HTTP 200 within 3s |
| 2 | **Control Plane Auth** | `GET {controlPlaneUrl}/api/v1/health` with stored API key | HTTP 200 (non-401/403) |
| 3 | **Sync Daemon** | PID file at `~/.intutic/daemon.pid`, or process scan | Process is alive |
| 4 | **Harness Configs** | SHA-256 hashes vs `~/.intutic/integrity.json` | All hashes match |
| 5 | **Daemon Log** | `~/.intutic/daemon.log` exists and is readable | File is readable |
| 6 | **Valkey** | Proxy `/health` valkey field, or TCP probe port 6379 | Connection succeeds within 2s |
| 7 | **Cert Trust** | `~/.intutic/ca.crt` exists and is in OS trust store | macOS: `security verify-cert`; Linux: system CA dir |

## Example output

```
Intutic Doctor — Workspace Health Check

  ✓ Proxy — Reachable at http://127.0.0.1:4000/health (HTTP 200)
  ✓ Control Plane Auth — Authenticated at https://api.intutic.ai
  ✓ Sync Daemon — Running (PID 42156)
  ✓ Harness Configs — 3 file(s) intact — no drift detected
  ✓ Daemon Log — Readable at /Users/dev/.intutic/daemon.log (847 lines)
  ✓ Valkey — Reachable at 127.0.0.1:6379 (direct TCP probe)
  ✓ Cert Trust — CA cert exists and is trusted by macOS Keychain

✔ All 7 checks passed — workspace is healthy.
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
| Proxy not reachable | `intutic connect` |
| No credentials | `intutic login` |
| Auth failed (401/403) | `intutic login` (re-authenticate) |
| Daemon not running | `intutic connect` or `intutic daemon install` |
| No workspace config | `intutic init` |
| Config drift detected | `intutic connect` (auto-corrects drift) |
| Daemon log not found | Start daemon first with `intutic connect` |
| Valkey not reachable | `docker compose up -d valkey` or install locally |
| CA cert not found | `intutic connect` (auto-generates on first run) |
| CA cert not trusted (macOS) | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.intutic/ca.crt` |
| CA cert not trusted (Linux) | `sudo cp ~/.intutic/ca.crt /usr/local/share/ca-certificates/intutic-ca.crt && sudo update-ca-certificates` |

## Source

- [doctor.ts](https://github.com/intutic/intutic/blob/main/tools/cli/src/commands/doctor.ts)
