# Developer Sessions <Badge type="tip" text="Cloud" />

**Activity › Developer Sessions** (`/activity/sessions`) shows what the sync daemon on your developers' machines reports: whether it is connected, which agent sessions are running, and whether local guidelines are in sync and free of security issues.

## Why Developer Sessions?

AI coding agents are highly active but often hard to observe locally. Developer Sessions brings process activity and configuration sync audits together into a single screen:
- **Process Activity**: Which agent tools (Cursor, Claude Code, Aider, Windsurf) are running on the workstation.
- **Config Sync Status**: Whether local rules files (such as `.cursor/rules/intutic-governance.mdc`, `.claude/rules/intutic-governance.md` or the rules section of `AGENTS.md`) are synced or have drifted from the central SOP policies.
- **Rules Safety Auditing**: Findings from local skill audits (secrets, credentials, dangerous wildcards).

---

## What the page shows

A strip at the top summarizes the sync daemon: **Sync daemon** (with when it connected), **Configuration warnings** (platforms with drifted guidelines), **Security issues** (in local instruction files), **Active sessions** on this host, and **Last guidelines sync**. Below it:

### Local Guidelines & Rules
The files found by local runs of `intutic skill list` and `intutic skill audit`:
- **Instruction file** — the file path (e.g. `.cursorrules`, `CLAUDE.md`)
- **Lines** — the instruction line count
- **Security check** — unsafe segments detected (Intutic virtual keys and `sk-live-` secrets, `rm -rf *` / `rm -rf /`, `curl` / `wget` network commands). A skill's `SKILL.md` under `.agents/skills` or `.claude/skills` is checked by the skill-content scan instead ([Skill Scanning](/guide/skill-scanning)).

If the workspace setting `enableLocalSkillAuditDelete` is active, `intutic skill audit` removes every flagged line (leaked keys, unsafe recursive deletes, `curl` / `wget` commands, or a line the skill-content scan flags) from the file it scans.

### Guideline Sync
Sync status by agent platform: each platform the daemon found, its guidelines, and when they last synced.

### Developer Trust Scores
A workspace-wide table, one row per developer: **User**, **Trust score** (hover for the anomalies detected), **Clean sessions** and **Last anomaly**. Scores accumulate as sessions run.

### Active Developer Sessions
The agent sessions running on this host now, from the daemon's process scan.

### Local Services Health
The sync daemon monitors and auto-heals essential local dependencies on the workstation:
- **Proxy gateway**: The Intutic Rust proxy gateway (port 4000) redirecting LLM API requests and normalising protocols. If a proxy the daemon started exits or crashes, the daemon re-spawns it at its next check (every poll, 30 seconds by default).
- **Valkey cache**: Caches local requests and telemetry (port 6379). When Valkey is down, the daemon restarts it: the `intutic-valkey` Docker container, else a native `valkey-server` / `redis-server`, else the static binary under `~/.intutic/bin`.
- **SSL certificate trust**: Verifies whether the local CA certificate (`ca.crt`) is trusted by the macOS keychain, or, on Linux, is the certificate in the system trust store; on Windows it only checks that the certificate exists.

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
