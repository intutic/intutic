---
title: SOP Library
description: 8 pre-built hook SOPs for common governance rules — filesystem, secrets, git, database, cost, review, network, and compliance.
---

# SOP Library <Badge type="tip" text="Built-in" />

Intutic ships with 8 pre-built hook SOPs that cover the most common governance needs. Each SOP runs as a `PRE_TOOL` hook in the [V8 sandbox](/concepts/enforcement-actions#hook-sop-examples) and uses `intutic.verdict()` to allow, block, warn, or modify tool calls.

## Available SOPs

| SOP | Category | Risk | Action | What it catches |
|---|---|---|---|---|
| [Filesystem Guard](#filesystem-guard) | filesystem | CRITICAL | block | `rm -rf /`, `/etc` writes, `mkfs`, `chmod 777` |
| [Secrets Guard](#secrets-guard) | secrets | HIGH | block | AWS keys, GitHub tokens, Stripe keys, hardcoded passwords |
| [Git Guard](#git-guard) | git | HIGH | block | Force-push main, rebase main, hard reset |
| [Database Guard](#database-guard) | database | CRITICAL | block | DROP TABLE, TRUNCATE, DELETE without WHERE |
| [Cost Cap Guard](#cost-cap-guard) | cost | MEDIUM | block/warn | Session spend > $5.00 (block), > $2.00 (warn) |
| [Test Coverage Guard](#test-coverage-guard) | review | LOW | warn | New source files without test files |
| [Network Guard](#network-guard) | network | HIGH | block | curl/wget to unapproved external domains |
| [PII Audit Guard](#pii-audit-guard) | compliance | HIGH | warn | Emails, phone numbers, SSNs, credit cards |
| [SQL Injection Guard](#sql-injection-guard) | database | HIGH | block | Common SQL Injection patterns (`' OR '1'='1`) |
| [Reverse Shell Guard](#reverse-shell-guard) | network | CRITICAL | block | Netcat reverse shell commands, socket connections |
| [Fork Bomb Prevention](#fork-bomb-prevention) | filesystem | CRITICAL | block | Recursion fork bomb patterns (`:(){ :\|:& };:`) |
| [Container Breakout Guard](#container-breakout-guard) | filesystem | CRITICAL | block | Mounts to docker.sock or root folders |
| [Metadata Service Guard](#metadata-service-guard) | network | HIGH | block | HTTP requests targeting IP `169.254.169.254` |
| [Token Burn Prevention](#token-burn-prevention) | cost | MEDIUM | block | Repeating loops of identical commands |
| [PII Redaction Guard](#pii-redaction-guard) | compliance | HIGH | modify | Active credit card pattern scrubbing |
| [SSO Redirect Policy](#sso-redirect-policy) | compliance | MEDIUM | block | Non-HTTPS SSO callback redirect URIs |
| [Kube API Access Guard](#kube-api-access-guard) | network | HIGH | block | Kubernetes secret theft and token queries |
| [SSH Key Extraction Guard](#ssh-key-extraction-guard) | secrets | CRITICAL | block | Reading `~/.ssh/id_rsa` or ed25519 files |
| [Package Install Guard](#package-install-guard) | review | MEDIUM | warn | Unapproved `npm install` / `pip install` commands |
| [Sudo / Root Preventer](#sudo--root-preventer) | filesystem | CRITICAL | block | Privilege escalation via `sudo` or `su` |

---

## Filesystem Guard

**ID:** `sp_hook-filesystem-guard` · **Risk:** CRITICAL

Blocks destructive filesystem operations that could cause irreversible damage.

**Blocked patterns:**
- `rm -rf /`, `rm -rf ~/`, `rm -rf *`
- Writes to `/etc/`, `/usr/`, `/var/`, `/sys/`
- `mkfs` and `dd if=` targeting block devices
- `chmod 777` on system directories

```js
// Trigger example — this tool call would be blocked:
// toolName: "run_terminal_cmd"
// toolArguments: "rm -rf /"
```

---

## Secrets Guard

**ID:** `sp_hook-secrets-guard` · **Risk:** HIGH

Detects hardcoded API keys, tokens, and passwords in tool arguments.

**Detected patterns:**
- AWS access keys (`AKIA...`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- Stripe secret keys (`sk_live_`, `sk_test_`)
- Generic `password = "..."` assignments
- Bearer tokens (warns, does not block)

---

## Git Guard

**ID:** `sp_hook-git-guard` · **Risk:** HIGH

Prevents force-push and history rewriting on protected branches.

**Blocked:**
- `git push --force` to main/master
- `git rebase main`
- `git reset --hard` on main/master

**Warns:**
- Force-push to non-protected branches

---

## Database Guard

**ID:** `sp_hook-database-guard` · **Risk:** CRITICAL

Blocks destructive SQL that could cause data loss.

**Blocked:**
- `DROP TABLE/DATABASE/SCHEMA/VIEW/INDEX`
- `TRUNCATE TABLE`
- `DELETE FROM ... ` without a `WHERE` clause

**Warns:**
- `ALTER TABLE` (reminds to create a migration)

---

## Cost Cap Guard

**ID:** `sp_hook-cost-guard` · **Risk:** MEDIUM

Enforces per-session cost limits using `estimatedCostUsd` from the hook context.

| Condition | Action | Default threshold |
|---|---|---|
| Cost ≥ $5.00 | block | Lowered to $1.00 when trust score < 0.3 |
| Cost ≥ $2.00 | warn | — |

Annotates traces with `costUsd` and `threshold` for FinOps dashboards.

---

## Test Coverage Guard

**ID:** `sp_hook-review-guard` · **Risk:** LOW

Warns when creating new source files (`.ts`, `.js`, `.py`, `.go`, `.rs`) without a corresponding test file.

**Excluded:** Config files, type definitions, index files, constants.

---

## Network Guard

**ID:** `sp_hook-network-guard` · **Risk:** HIGH

Blocks HTTP requests to unapproved external domains.

**Approved by default:**
- `localhost`, `127.0.0.1`
- `github.com`, `api.openai.com`, `api.anthropic.com`
- `registry.npmjs.org`, `pypi.org`
- `intutic.ai`

**Also warns** on non-HTTPS URLs to external hosts.

---

## PII Audit Guard

**ID:** `sp_hook-compliance-pii` · **Risk:** HIGH

Detects PII patterns in tool arguments and annotates traces for compliance review. **Does not block** — warns and creates an audit trail.

**Detected:**
- Email addresses
- US phone numbers
- Social Security Numbers
- Credit card numbers (Visa, Mastercard, Amex, Discover)

Annotations: `{ piiDetected: true, piiTypes: ["email", "ssn"] }`

---

## Creating the SOPs via API

Use the SOP registry API to create hook SOPs in your workspace:

```bash
curl -X POST https://api.intutic.ai/api/v1/sops \
  -H "Authorization: Bearer vk_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Filesystem Destructive Command Guard",
    "sopType": "hook",
    "hookPhase": "PRE_TOOL",
    "riskTier": "CRITICAL",
    "isActive": true,
    "markdownContent": "# Filesystem Guard\n\n```js\nconst args = (intutic.context.toolArguments || \u0027\u0027).toLowerCase();\nif (/rm\\\\s+(-[rRf]+\\\\s+)*(\\\\/\\\\s|~\\\\/|\\\\.\\\\.\\\\/)/.test(args)) {\n  intutic.verdict({ action: \u0027block\u0027, reason: \u0027Destructive rm command blocked.\u0027 });\n} else {\n  intutic.verdict({ action: \u0027allow\u0027 });\n}\n```"
  }'
```

### SQL Injection Guard

**ID:** `sp_hook-sqli-block` · **Risk:** HIGH

Blocks SQL queries containing common SQL Injection patterns.

---

### Reverse Shell Guard

**ID:** `sp_hook-reverse-shell` · **Risk:** CRITICAL

Blocks terminal commands attempting to open reverse TCP shells or netcat connections.

---

### Fork Bomb Prevention

**ID:** `sp_hook-fork-bomb` · **Risk:** CRITICAL

Blocks terminal commands initiating recursion loop fork bombs.

---

### Container Breakout Guard

**ID:** `sp_hook-container-breakout` · **Risk:** CRITICAL

Blocks mounting of `docker.sock` to prevent container breakouts.

---

### Metadata Service Guard

**ID:** `sp_hook-metadata-leak` · **Risk:** HIGH

Blocks access to Cloud Metadata Service IP (`169.254.169.254`).

---

### Token Burn Prevention

**ID:** `sp_hook-token-burn` · **Risk:** MEDIUM

Blocks repetitive agent execution loops.

---

### PII Redaction Guard

**ID:** `sp_hook-pii-redaction` · **Risk:** HIGH

Redacts credit card numbers from tool arguments dynamically using `modify`.

---

### SSO Redirect Policy

**ID:** `sp_hook-sso-ssl` · **Risk:** MEDIUM

Enforces that SSO redirects use secure HTTPS protocol.

---

### Kube API Access Guard

**ID:** `sp_hook-kube-guard` · **Risk:** HIGH

Blocks Kubernetes token extraction and secret queries.

---

### SSH Key Extraction Guard

**ID:** `sp_hook-ssh-guard` · **Risk:** CRITICAL

Blocks reading private keys in `~/.ssh/` directory.

---

### Package Install Guard

**ID:** `sp_hook-package-guard` · **Risk:** MEDIUM

Warns on unapproved dependency installations.

---

### Sudo / Root Preventer

**ID:** `sp_hook-sudo-guard` · **Risk:** CRITICAL

Blocks privilege escalation commands using `sudo` or `su`.

---

For development, the seed script can be run directly:

```bash
npx tsx tools/scripts/seed-hook-sops.ts
```

---

## Hook script API reference

Scripts run in the V8 sandbox with these APIs:

| API | Description |
|---|---|
| `intutic.context.toolName` | Name of the tool being called |
| `intutic.context.toolArguments` | Arguments passed to the tool |
| `intutic.context.model` | LLM model being used |
| `intutic.context.estimatedCostUsd` | Estimated cost in USD |
| `intutic.context.trustScore` | Session trust score (0–1) |
| `intutic.context.sessionId` | Current session ID |
| `intutic.context.workspaceId` | Workspace ID |
| `intutic.verdict({action, reason})` | Set the hook verdict |
| `console.log()` | Debug logging (written to trace) |
| `JSON`, `Math`, `Date`, `RegExp` | Standard built-ins |

**Actions:** `allow`, `block`, `modify`, `warn`

**Limits:** 100ms timeout, 64KB max script size, no `require`/`import`/`process`/`eval`.

---

## Related

- [Enforcement Actions](/concepts/enforcement-actions) — How verdicts map to BYPASS/ENHANCE/HIJACK/KILL
- [Harnesses](/concepts/harnesses) — How SOPs reach agent config files
- [Getting Started](/guide/getting-started) — Connect your first workspace
