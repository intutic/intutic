---
title: Enforcement Actions
description: The four verdicts Intutic can apply to every AI agent tool call — BYPASS, ENHANCE, HIJACK, and KILL — and how they're decided.
---

# Enforcement Actions <Badge type="tip" text="Open-Core" />

Every tool call that flows through the Intutic proxy receives exactly one **enforcement action** — a verdict that determines what happens to the request. There are four possible actions:

| Action | What happens | Agent sees |
|---|---|---|
| **BYPASS** | Request passes through unchanged | Normal response from the LLM |
| **ENHANCE** | Request passes through with metadata, annotations, or warnings attached | Normal response + governance annotations in the trace |
| **HIJACK** | Request is modified before reaching the LLM (e.g., DLP redaction, prompt rewriting) | Modified response — agent may notice content was changed |
| **KILL** | Request is blocked entirely | Error response with the reason for blocking |

---

## How a verdict is decided

When a tool call arrives at the proxy, it flows through the **Policy-Controlled Agent Sandbox (PCAS)** evaluation pipeline:

```
Tool call arrives
       │
       ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Budget      │────▶│  DLP         │────▶│  PCAS        │
│  Gate        │     │  Scanner     │     │  Policy      │
│              │     │              │     │  Resolution  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │  SOP Hook    │
                                          │  Executor    │
                                          │  (V8 sandbox)│
                                          └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │  SSL         │
                                          │  Enforcement │
                                          │  (3-layer)   │
                                          └──────┬───────┘
                                                 │
                                           Final verdict
```

1. **Budget Gate** — checks session and workspace spend limits. If the budget is exhausted → `KILL`
2. **DLP Scanner** — scans for secrets, PII, and sensitive data. If found → `HIJACK` (redact and forward) or `KILL` (block entirely)
3. **PCAS Policy Resolution** — resolves effective permissions from the organization policy hierarchy, with Valkey caching and Postgres fallback
4. **SOP Hook Executor** — runs any hook-type SOPs in a V8 sandbox. Hooks can return `allow`, `block`, `modify`, or `warn`
5. **SSL Enforcement** — three-layer runtime enforcement (scheduling, structural, logical)

The **strictest verdict wins** — if any layer returns KILL, the request is killed regardless of what other layers decide.

---

## BYPASS

The request is permitted and passes through the proxy without modification. This is the default when all policy checks pass.

**When it happens:**
- No SOP matches the tool call
- The matched SOP explicitly allows the action
- Budget is within limits, no DLP matches, PCAS permissions grant access

**In the proxy verdict mapping:**

```typescript
// services/control-plane/src/lib/valkeySubscriber.ts
trace.verdict === 'allowed' → EnforcementAction.BYPASS
```

**Example trace output:**

```json
{
  "traceId": "tr_abc123",
  "toolName": "read_file",
  "toolArguments": { "path": "/src/utils.ts" },
  "enforcementAction": "BYPASS",
  "latencyMs": 2
}
```

---

## ENHANCE

The request passes through, but Intutic attaches governance metadata — warnings, annotations, or cost attribution tags — to the trace. The LLM request itself is not modified.

**When it happens:**
- A hook SOP returns `warn` (allow but flag for review)
- Cost tracking attaches attribution metadata
- Anomaly detection flags the pattern but doesn't block

**Example: a hook SOP that warns on large file reads**

```javascript
// Hook SOP: warn-large-reads
// Phase: PRE_TOOL

if (intutic.context.toolName === 'read_file') {
  const path = intutic.context.toolArguments;
  if (path && path.includes('/vendor/')) {
    intutic.verdict({
      action: 'warn',
      reason: 'Reading vendor files is unusual — review for necessity'
    });
    return;
  }
}
intutic.verdict({ action: 'allow' });
```

---

## HIJACK

The request is intercepted and modified before reaching the LLM. The most common cause is DLP redaction — secrets detected in prompts are replaced with placeholder tokens before the request leaves the proxy.

**When it happens:**
- DLP scanner detects API keys, passwords, or PII in the prompt → redacts before forwarding
- A hook SOP returns `modify` with replacement content
- PCAS downgrades a model selection (e.g., routes to a cheaper model)

**In the proxy verdict mapping:**

```typescript
// services/control-plane/src/lib/valkeySubscriber.ts
trace.verdict === 'dlp_redacted' → EnforcementAction.HIJACK
```

**Example: DLP redaction in action**

```
Original prompt:
  "Use API key sk-abc123xyz789 to call the endpoint"

After HIJACK:
  "Use API key [REDACTED] to call the endpoint"
```

The agent receives a normal response, but the sensitive data never reaches the LLM provider.

---

## KILL

The request is blocked entirely. The agent receives an error response explaining why the action was denied.

**When it happens:**
- Budget exhausted (session or workspace spend limit reached)
- DLP scanner detects an unredactable secret leak
- A hook SOP returns `block` with a reason
- PCAS denies the tool (not in the agent's allowed tool set)
- Loop breaker detects a repetitive failure pattern
- SSL enforcement finds a constraint violation

**In the proxy verdict mapping:**

```typescript
// services/control-plane/src/lib/valkeySubscriber.ts
// Anything other than 'allowed' or 'dlp_redacted' → KILL
trace.verdict !== 'allowed' && trace.verdict !== 'dlp_redacted'
  → EnforcementAction.KILL
```

**Example: a hook SOP that blocks destructive commands**

```javascript
// Hook SOP: block-destructive-fs
// Phase: PRE_TOOL

if (intutic.context.toolName === 'run_command') {
  const args = intutic.context.toolArguments || '';
  if (args.match(/rm\s+-rf\s+\//)) {
    intutic.verdict({
      action: 'block',
      reason: 'Blocked: recursive delete at filesystem root is prohibited'
    });
    return;
  }
}
intutic.verdict({ action: 'allow' });
```

**What the agent sees:**

```
Error: Tool call blocked by governance policy
Reason: Blocked: recursive delete at filesystem root is prohibited
SOP: block-destructive-fs (sop_fs001)
```

---

## Source code references

The enforcement action system is defined across these components:

| Component / File | What it defines | Scope |
|---|---|---|
| [enums.ts](../../../packages/shared-types/src/enums.ts#L29-L41) | `EnforcementAction` enum — `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` | Open-Core / Shared Types |
| `valkeySubscriber.ts` | Proxy verdict → `EnforcementAction` mapping | Enterprise Control Plane |
| `pcasService.ts` | PCAS permission resolution (Valkey → Postgres cascade) | Enterprise Control Plane |
| `sopHookExecutor.ts` | V8-sandboxed hook execution with `allow`/`block`/`modify`/`warn` verdicts | Enterprise Control Plane |
| `sslEnforcementService.ts` | Three-layer SSL enforcement (scheduling, structural, logical) | Enterprise Control Plane |
| `loopBreakerService.ts` | Sliding-window loop detection → KILL on repetitive failures | Enterprise Control Plane |
| `finopsService.ts` | Budget gate enforcement + cost tracking per action | Enterprise Control Plane |

---

## Related

- [Core Concepts](/guide/concepts) — Workspaces, harnesses, SOPs, and scoring
- [Security](/security) — Threat model and data flow
- [Integrations](/integrations/) — How each harness connects to the enforcement pipeline
