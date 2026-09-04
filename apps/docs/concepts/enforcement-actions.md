---
title: Enforcement Actions
description: The five verdicts Intutic can apply to every AI agent tool call — BYPASS, ENHANCE, HIJACK, REASK and KILL — and how they're decided.
---

# Enforcement Actions <Badge type="tip" text="Open-Core" />

Every tool call that flows through the Intutic proxy receives exactly one **enforcement action** — a verdict that determines what happens to the request. There are five, in increasing severity:

| Action | What happens | Agent sees |
|---|---|---|
| **BYPASS** | Request passes through unchanged | Normal response from the LLM |
| **ENHANCE** | Request passes through with metadata, annotations, or warnings attached | Normal response + governance annotations in the trace |
| **HIJACK** | Request is modified before reaching the LLM (e.g., DLP redaction, prompt rewriting) | Modified response — agent may notice content was changed |
| **REASK** | The attempt is refused and the reason is handed back to the agent, which may retry a bounded number of times before the finding escalates to a block | An error it can read and act on, then another turn |
| **KILL** | Request is blocked entirely | Error response with the reason for blocking |

---

## How a verdict is decided

A tool call is evaluated at the **hook gate** (`POST /api/v1/hook-gate`), which returns an
allow/block decision synchronously:

```
Tool call arrives
       │
       ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  DLP         │────▶│  BLOCK: SOP  │────▶│  SSO group   │────▶│  Promoted    │
│  Scanner     │     │  match       │     │  policy      │     │  findings    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ hit                │ hit                │ DENIED             │ KILL
       ▼                    ▼                    ▼                    ▼
    blocked              blocked              blocked              blocked

  no hit at any stage ──▶ allowed
```

1. **DLP Scanner** — 20 patterns matched against the serialised tool arguments. A hit blocks the call and opens an incident.
2. **BLOCK: SOP match** — `VALIDATED` SOPs whose title begins `BLOCK:` are compiled to a pattern and tested against the tool name.
3. **SSO group policy** — resolves the caller's group privilege. `DENIED` or `REQUIRES_OBO` blocks.
4. **Promoted findings** — repeat anomaly findings that have been promoted to enforcement. Only a promoted `KILL` blocks; a promoted `HIJACK` is recorded and falls through.

**The first match wins, and the order is deliberate** — this is a short-circuit, not a
strictest-wins merge. Deterministic policy (DLP, an operator-authored `BLOCK:` SOP, an SSO
group decision) is evaluated before the heuristic, so a promoted detector can never override a
decision an operator stated explicitly. Every stage after DLP fails **open**: if the check
itself errors, the call is allowed and the error logged, rather than blocking work on an
infrastructure fault.

::: warning Not every harness consults the gate
`POST /api/v1/hook-gate` is called synchronously by the goose and OpenHands hook writers. The
Claude Code, Cursor, Cline, Claude Desktop, Windsurf, pi and openclaw integrations decide
locally and report to the control plane asynchronously, which keeps their tool path free of a
network round-trip. Everything on this page describes the gate; the local path enforces the
protected-path and shell-bypass guards written into the generated hook script.
:::

---

## Two rungs, not one bar

Everything above answers *what* a verdict does. This section answers *how a
check earns the right to block at all* — because Intutic runs two different
kinds of check side by side, and they are held to different bars on purpose.

**Rung 1 — deterministic, blocks today.** DLP pattern matches, `BLOCK:` SOPs,
SSO group policy, and budget limits are all authored by an operator or
computed from a fixed rule. There is no learning curve and no false-positive
rate to earn: the rule either matches or it doesn't, so it enforces
(`KILL`/`HIJACK`) from the moment it's turned on. This rung is exactly the
open-core pitch — every check on it ships in the public proxy, runs
deterministically, and needs no control plane to decide.

**Rung 2 — learned, shadow-first.** SSL's structural and logical layers,
anomaly-finding promotion, and loop detection are heuristic: they're right
most of the time on most workspaces, which is a different guarantee than
"right." Each one launches in **shadow mode** — it evaluates every call and
records what it *would* have done, without changing what the agent
experiences — until its false-positive rate is measured on that workspace's
own real traffic and clears the [promotion rule](#the-promotion-rule).
Only then does it graduate onto the enforcement table above (SSL as `KILL`,
loop detection as today's `REASK`, findings as a promoted `KILL`/`HIJACK`).

**Generated guardrails start on rung 2 and end on rung 1.** A rule the
[Policy Clause Ledger](/guide/policy-guardrails) derived from a policy
document had a model in its derivation, so it launches in shadow like any
other rung-2 check, whatever it renders to. When a named owner or admin
promotes it, the emitted artifact — a hook-gate rule, a front-matter key, a
compiled WASM rule — is enforced by the rung-1 machinery above and is
indistinguishable from one an operator wrote by hand. The citation it
carries says why it exists; the promotion is what lets it act.

This is a deliberate trade, not a hedge: **we don't let an LLM block your
engineers until it has proven a low false-positive rate on your traffic.** A
heuristic that blocked from day one would be indistinguishable, from the
agent's side, from a broken one — and the cost of that mistake is a blocked
engineer, not a missed detection. Shadow mode is how rung 2 pays down that
risk before it can ever cost anyone a turn.

### The promotion rule

A rung-2 check earns enforcement on counted evidence from the workspace's own
traffic, judged by a person:

- **Generated guardrails** (hook rules and front-matter rules from policy
  documents): at least 200 shadow evaluations; a would-act rate of at most
  5 %; and, among the calls it would have acted on, at least min(10, fires)
  adjudicated as true positives with a false-positive rate of at most 1 % —
  over the adjudicated fires, never the total. A rule that never fired is
  promotable only with an explicit acknowledgement, recorded on the event.
- **Generated WASM rules and rule candidates**: at least 200 shadow
  evaluations and a would-block rate of at most 1 %, per rule, by an
  authenticated member.
- **Detector findings**: adjudicated on the Findings page; the meter counts
  adjudicated findings, not total findings.

No workspace setting, plan flag or feature flag promotes anything on its own.

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
- A detector raises an advisory finding (recorded for review, not blocking)
- Cost tracking attaches attribution metadata
- Anomaly detection flags the pattern but doesn't block

Most detectors ship on `STEER` or `REASK` rather than `KILL` for exactly this reason: a
threshold that has never had its false-positive rate measured annotates the trace instead of
stopping the work. See the [promotion rule](#the-promotion-rule).

---

## HIJACK

The request is intercepted and modified before reaching the LLM. The most common cause is DLP redaction — secrets detected in prompts are replaced with placeholder tokens before the request leaves the proxy.

**When it happens:**
- DLP scanner detects API keys, passwords, or PII in the prompt → redacts before forwarding
- A WASM rule rewrites the request before it is forwarded
- PCAS downgrades a model selection (e.g., routes to a cheaper model)

**In the proxy verdict mapping:**

```typescript
// services/control-plane/src/lib/valkeySubscriber.ts
trace.verdict === 'hijacked' → EnforcementAction.HIJACK
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
- A `BLOCK:` SOP matches the tool name
- SSO group policy denies the caller
- A repeat anomaly finding has been promoted to enforcement

Note what is **not** on this list. SSL enforcement runs at the gate but is shadowed — it records
what it would have done and the call proceeds. Loop detection ships on `REASK`. Both are held
back by the [promotion rule](#the-promotion-rule) until their false-positive rates are
measured on real traffic.

**In the proxy verdict mapping:**

```typescript
// services/control-plane/src/lib/valkeySubscriber.ts
trace.verdict === 'killed' → EnforcementAction.KILL

// An unrecognised verdict also records as KILL, deliberately: a value this service
// cannot interpret means the proxy is ahead of the control plane, and assuming
// BYPASS would log an unenforced call as allowed.
```

**Example: a `BLOCK:` SOP that stops destructive commands**

A SOP whose **title** begins `BLOCK:` is enforced at the gate once it reaches `VALIDATED`. The
title carries the rule — `BLOCK:<pattern>:<reason>` — where `<pattern>` is a regular expression
tested against the tool name. No scripting is involved:

```
BLOCK:^run_command$:Recursive delete at filesystem root is prohibited
```

The reason is optional and the match is case-insensitive. Because the pattern is delimited by
colons it cannot itself contain one, and a title whose pattern is not a valid regular
expression is skipped rather than blocking every call.

For argument-level conditions — matching `rm -rf /` inside the arguments rather than the tool
name — write a [WASM rule](/guide/wasm-rules), which runs in the proxy with an explicit
host-import allowlist.

**What the agent sees:**

```
Error: Tool call blocked by governance policy
Reason: Recursive delete at filesystem root is prohibited
```

---

<!-- ENTERPRISE_ONLY_START -->
## Source code references

The enforcement action system is defined across these components:

| Component / File | What it defines | Scope |
|---|---|---|
| [enums.ts](../../../packages/shared-types/src/enums.ts#L29-L41) | `EnforcementAction` enum — `BYPASS`, `ENHANCE`, `HIJACK`, `REASK`, `KILL` | Open-Core / Shared Types |
| `routes/hookEvents.ts` | The gate itself — DLP, `BLOCK:` SOP, SSO group policy, promoted findings | Enterprise Control Plane |
| `valkeySubscriber.ts` | Proxy verdict → `EnforcementAction` mapping | Enterprise Control Plane |
| `pcasService.ts` | SSO group privilege resolution (Valkey → Postgres cascade) | Enterprise Control Plane |
| `anomalyEnforcementService.ts` | Promotion of repeat findings to an enforceable verdict | Enterprise Control Plane |
| `sslEnforcementService.ts` | SSL scheduling, structural and logical layers, plus compliance reporting | Enterprise Control Plane |
| `sslGateEvaluator.ts` | Calls the SSL layers from the hook gate in **shadow mode** — records, never blocks (`TD-300`) | Enterprise Control Plane |
| `finopsService.ts` | Budget gate enforcement + cost tracking per action | Enterprise Control Plane |

---

<!-- ENTERPRISE_ONLY_END -->

## Related

- [Core Concepts](/guide/concepts) — Workspaces, harnesses, SOPs, and scoring
- [Security](/security) — Threat model and data flow
- [Integrations](/integrations/) — How each harness connects to the enforcement pipeline
