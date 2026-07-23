# SOP Format Reference <Badge type="warning" text="Cloud / Team" />

::: warning Commercial / Team Tier Feature
Centralized SOP management and dynamic policy syncing require an active **Intutic Control Plane** (local dev stack or Cloud SaaS / Team tier).
:::

SOPs (Standard Operating Procedures) are the policy documents that define governance rules in Intutic. This page covers how to write and manage SOPs.

## Structure

An SOP consists of:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | ✅ | 1–500 characters |
| `markdown_content` | string | ✅ | 1–100,000 characters — the actual policy rules |
| `risk_tier` | enum | ✅ | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `complexity_tier` | enum | ✅ | `LOW`, `MEDIUM`, `HIGH` |
| `version` | string | ❌ | Semantic version string (1–50 chars) |
| `dependencies` | string[] | ❌ | IDs of SOPs this one depends on |

## Writing SOPs

SOPs are written in markdown. The content is synced to harness config files and used by the circuit breaker for enforcement decisions.

### Example SOP: Code Quality

```markdown
## Code Quality Standards

### Test Coverage
- All new code must include unit tests
- Minimum 80% line coverage for new files
- Integration tests required for API endpoints

### Naming Conventions
- Functions: camelCase
- Types/Interfaces: PascalCase
- Constants: SCREAMING_SNAKE_CASE
- Files: camelCase.ts

### Prohibited Patterns
- No `any` type assertions without justification
- No `console.log` in production code
- No hardcoded credentials or API keys
```

### Example SOP: Security Policy

```markdown
## Security Policy

### Forbidden Actions
- NEVER commit secrets, API keys, or tokens to version control
- NEVER disable security linting rules
- NEVER use `eval()` or dynamic code execution
- NEVER access environment variables starting with `SECRET_` or `PRIVATE_`

### File Access Restrictions
- Do NOT modify files in `/etc/`, `/var/`, or system directories
- Do NOT read or write to `~/.ssh/` or `~/.gnupg/`
- Do NOT access other users' home directories

### Data Handling
- PII must be masked in logs
- Database queries must use parameterized statements
- File uploads must be validated for type and size
```

### Example SOP: Budget Controls

```markdown
## Budget Controls

### Token Limits
- JUNIOR tier: max 50,000 tokens per request
- SENIOR tier: max 200,000 tokens per request
- STAFF tier: max 500,000 tokens per request
- PRINCIPAL tier: max 1,000,000 tokens per request

### Model Selection
- Default to economy-tier models for routine tasks
- Frontier models only for complex architectural decisions
- Local models preferred for code completion
```

## Risk Tiers

| Tier | When to use |
|------|-------------|
| `LOW` | Cosmetic, documentation, formatting rules |
| `MEDIUM` | Code quality, naming conventions, test requirements |
| `HIGH` | Security policies, data handling, access control |
| `CRITICAL` | Compliance mandates, regulatory requirements, incident response |

## Lifecycle States

SOPs follow a 7-state lifecycle:

```
DRAFT → PENDING_REVIEW → GENERATED → HYPOTHESIZED → REFINED → VALIDATED
                                                                    ↓
                                                              INVALIDATED
```

| State | Description |
|-------|-------------|
| `DRAFT` | Initial authoring. Not enforced. |
| `PENDING_REVIEW` | Submitted for team review. |
| `GENERATED` | Auto-generated from observed patterns. |
| `HYPOTHESIZED` | Proposed rule being tested in shadow mode. |
| `REFINED` | Iteratively improved based on feedback. |
| `VALIDATED` | **Active and enforced.** Only validated SOPs are synced to harnesses. |
| `INVALIDATED` | Retired or superseded. No longer enforced. |

### Transitioning states

Use the API to transition an SOP:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target_state": "VALIDATED", "reason": "Approved by team lead"}' \
  "https://api.intutic.ai/api/v1/sops/sop_abc123/transition"
```

## Change Classification

When an SOP is updated, the change is classified:

| Classification | Meaning |
|---------------|---------|
| `STRENGTHEN` | Makes the rule more restrictive |
| `CLARIFY` | Improves wording without changing scope |
| `NARROW` | Reduces the scope of the rule |
| `WEAKEN` | Makes the rule less restrictive |

This classification is recorded for audit trail and helps track policy drift over time.

## Dependencies

SOPs can declare dependencies on other SOPs. When a parent SOP is invalidated, **cascade invalidation** automatically invalidates all dependent SOPs.

```json
{
  "title": "API Security Checklist",
  "dependencies": ["sop_security_base", "sop_auth_policy"],
  "markdown_content": "..."
}
```

View the dependency graph:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.intutic.ai/api/v1/sops/sop_abc123/dependencies"
```

## Health Metrics

Each SOP has health metrics showing how effective it is:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.intutic.ai/api/v1/sops/sop_abc123/health"
```

Health metrics include enforcement hit rate, false positive rate, and compliance improvement over time.
