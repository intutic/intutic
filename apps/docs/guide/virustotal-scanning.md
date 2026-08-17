---
title: VirusTotal Integration
description: Opt-in, hash-only VirusTotal lookup for skill-bundled scripts — what it checks, the budget/pacing model, and what a flagged hash does to an agent's posture score.
---

# VirusTotal Integration <Badge type="danger" text="Enterprise" />

Checks the sha256 hash of a skill-bundled **script** against VirusTotal's public database of known file reputations. Opt-in, off by default, and **hash-only — file content is never uploaded.**

---

## Hash-only, stated up front

This integration calls exactly one VirusTotal endpoint: `GET /api/v3/files/{sha256}`. It never calls `POST /api/v3/files` (upload), and the module that talks to VirusTotal (`services/control-plane/src/services/virusTotalService.ts`) has no code path capable of reading, buffering, or transmitting a file's actual content — only the sha256 hash `auditScriptFile` already computes during [skill scanning](/guide/skill-scanning#bundled-scripts) ever leaves your workspace.

**This is not the same thing as this product's standing decline of a global MCP-server reputation database.** [MCP Governance](/guide/mcp-governance#what-this-phase-deliberately-does-not-cover) states directly that Intutic does not maintain or consume a shared "is this MCP server known bad" list, across tenants, for MCP *servers*. This integration is narrower and different in kind: a workspace-scoped, opt-in hash lookup on a skill-bundled *script file*, disabled until an operator turns it on, never treated as a cross-tenant reputation signal beyond the identical-hash verdict cache described below.

Scope, precisely:

- **Skill-bundled SCRIPTS only** — the sibling files `discoverSkillBundledFiles` enumerates next to a `SKILL.md` (a `setup.sh`, a `helper.py`, a downloaded binary).
- **Never `SKILL.md` prose.** Markdown content has no VirusTotal-checkable hash relationship to a known-malware corpus; it stays covered by the pattern-based [skill scanner](/guide/skill-scanning) only.

## Enabling it

From **Settings → Integrations → VirusTotal Skill Scanning**:

1. Add your VirusTotal API key (a free-tier key works — see the budget note below for what that limits). OWNER/ADMIN role required; the key is encrypted at rest (AES-256-GCM, the same house pattern every other stored credential in this product uses) and only ever displayed masked (last 4 characters).
2. Click **Test connection** to validate the key against the sha256 of the empty file — a real lookup, but against a benign, well-known hash, so you can confirm the key authenticates without needing a real (or malicious) sample.
3. Toggle **Enable VirusTotal lookups for this workspace** on.

With the toggle on but no key stored (or after a key is removed), lookups are a logged no-op — never an error, and never treated as "checked, clean."

## What happens on a skill report

Every `intutic skill audit` (or sync-daemon report) that includes bundled-script hashes fire-and-forget enqueues those hashes for lookup — the report itself is never blocked or delayed waiting on VirusTotal. From there, each unique hash:

1. Checks a **global** verdict cache first (`vt:verdict:{sha256}`, 7-day TTL). A VT verdict on a public file hash carries no tenant-specific data, so this cache is shared across every workspace that happens to report the same hash — a popular installer script gets looked up once, not once per workspace.
2. On a cache miss, reserves one unit of the workspace's **daily lookup budget** (default 200/day, `VT_DAILY_LOOKUP_CAP` env-overridable; the counter resets on a UTC day boundary).
3. Waits for a **pacing slot** — VirusTotal's free-tier public API allows roughly 4 requests/minute, so lookups for one workspace are spaced out rather than bursted, even when a report carries dozens of hashes at once.
4. Calls `GET /api/v3/files/{sha256}` and records the verdict.

## Budget and pacing

| Control | Default | Notes |
|---|---|---|
| Daily lookup cap | 200 lookups/workspace/day | `VT_DAILY_LOOKUP_CAP` env var; resets at UTC midnight |
| Pacing interval | ~15s between calls/workspace | Matches VirusTotal's free-tier ~4 req/min |
| Verdict cache TTL | 7 days | Global — shared across every workspace |

The Integrations panel shows today's usage (`used / cap`) live, reading the same Valkey counter the lookup path itself increments.

## Fail-secure, always

An API error, a timeout, a malformed response, or an exhausted daily budget all leave a hash **unjudged** — never defaulted to "clean." Only an explicit `flagged: false` verdict from a successful VirusTotal response counts as "checked, not flagged." A hash VirusTotal has never seen (a 404) is recorded as `unknown`, distinct from both `flagged` and a confirmed clean result.

## Effect on the posture score

A hash that comes back flagged (any AV engine detection) scores that skill **zero** in the [agent posture](/guide/dashboard) ring's `skills` dimension — the identical severity treatment a confirmed finding from the native pattern scanner gets. It also raises a `skill.malware.detected` notification at **HIGH** severity, the same tier as a provider outage or a device dropping its firewall enforcement.

## Related

| Page | What it covers |
|---|---|
| [Skill Scanning](/guide/skill-scanning) | The pattern-based `SKILL.md` and bundled-script scanners this lookup complements — read this first for what gets hashed and when |
| [MCP Governance](/guide/mcp-governance) | The separate, pre-existing decline of a global MCP-server reputation database, distinct from this narrower integration |
| [Governance Controls Checklist](/guide/governance-controls) | The house style for stating partial coverage honestly |
