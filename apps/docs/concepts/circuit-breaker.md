---
title: Circuit Breaker
description: How Intutic's circuit breaker evaluates every tool call in-process — budget gates, loop detection, policy resolution, and graceful degradation.
---

# Circuit Breaker <Badge type="tip" text="Open-Core" />

The **circuit breaker** is the decision engine that evaluates every AI agent tool call and returns an [enforcement action](/concepts/enforcement-actions) — BYPASS, ENHANCE, HIJACK, or KILL. It operates on the hot path between the proxy and the LLM provider, so every millisecond matters.

**Design goals:**
- Evaluation is in-process with no model call. Cost is measured per payload size in `packages/proxy/benches` — there is no single figure, because it is dominated by request size.
- **Fail-closed** by default — if the check can't complete, block the request
- **Graceful degradation** — if a backend is unavailable, fall back to the next tier
- **Zero single points of failure** — Valkey cache and Postgres each provide a degradation layer

---

## Hot path architecture

Two different paths evaluate a request, and it is worth keeping them apart.

**Model requests** go through the proxy, which calls `POST /api/v1/policy/check` on the control
plane (`routes/evaluate.ts`) — the budget and loop-governance gates below.

**Tool calls** are evaluated at the [hook gate](/concepts/enforcement-actions#how-a-verdict-is-decided),
a separate endpoint with its own order of checks. Loop *detection* is different again: it is an
anomaly detector running in-process in the proxy, not a control-plane call.

The proxy-side model-request sequence:

```
Model request arrives at proxy (:4000)
              │
              ▼
     ┌────────────────┐
     │ 1. Budget Gate │ ◀── Valkey: v2:budget:hard_block:{wk_id}
     │  (Valkey GET)  │     + loop governance kill check
     └────────┬───────┘
              │ pass
              ▼
     ┌────────────────┐
     │ 2. Loop budget │ ◀── loop_run status must be ACTIVE
     │  governance    │     (LoopGovernanceService)
     └────────┬───────┘
              │ pass
              ▼
      ┌────────────────┐
      │ 3. PCAS Policy │ ◀── Valkey cache (single GET on hit)
      │   Resolution   │     Postgres query (one CTE on miss)
      └────────┬───────┘
               │
               ▼
          Final verdict
```

If **any gate** returns a deny/kill, evaluation short-circuits immediately — subsequent gates are skipped.

---

## 1. Budget gate

The fastest check — a single Valkey key lookup.

**How it works:**
- The billing cron job sets `v2:budget:hard_block:{workspace_id}` = `"1"` when a workspace's daily spend exceeds `daily_spend_cap_usd`
- The policy check reads this key — if present → `KILL` immediately
- Also checks loop-level budget caps: if a loop run (`loop_run_id`) has status `KILLED` → deny

**Cost:** A single Valkey GET. No model call, no Postgres round trip.

```typescript
// services/control-plane/src/routes/evaluate.ts
const budgetBlock = await valkey.get(budgetHardBlockKey(workspace_id))
if (budgetBlock) {
  return c.json({ action: 'deny', reason: 'Workspace budget cap exceeded' })
}
```

The proxy also does a **local budget check** before even calling the control plane — checking `v2:budget:hard_block:{workspace_id}` directly from its own Valkey connection. This means budget blocks take effect with zero network round-trips.

→ Source: [metering.rs](../../../packages/proxy/src/metering.rs) (proxy-side); `routes/evaluate.ts` in the control plane, which is not open source

---

## 2. Loop breaker

Detects when an agent is stuck calling the same tool over and over.

**Algorithm:** consecutive-run counting over the session's tool sequence
1. Walk the tool sequence, counting the current run of identical consecutive calls
2. A run of **5 or more** raises a finding, with confidence scaled by how far past the
   threshold the run has gone
3. An intervening different tool resets the run — a repeated tool that is making progress
   between calls does not trip it

```rust
// packages/proxy/src/plugins/anomaly/detectors.rs
const REPETITION_THRESHOLD: usize = 5;
```

**The verdict is `REASK`, not `KILL`.** Five-in-a-row is a real signal, but the number five is
a chosen threshold with no measured false-positive rate behind it, so it does not qualify to
block under the [promotion rule](/guide/graph-guardrails). A genuinely stuck agent is told it
has repeated itself and can change approach; one doing repetitive but productive work says so
and continues.

**Graceful degradation:** the detector reads the sequence already in the request context, so
it has no cache dependency to degrade.

---

## 3. PCAS policy resolution

The most complex gate — resolves effective permissions for the user+agent pair by walking the organization policy hierarchy.

**Resolution cascade:**

| Step | Backend | Latency | What happens on failure |
|---|---|---|---|
| 1 | Valkey cache | in-memory lookup | Continue to step 2 |
| 2 | Postgres CTE resolution | single query, on cache miss only | Continue to step 3 |
| 3 | Synthetic empty set | 0ms | Return `fallbackMode: true` → forces HIJACK |

```typescript
// services/control-plane/src/services/pcasService.ts

// 1. Valkey cache check
const cached = await valkey.get(pcasCacheKey(workspaceId, userId))
if (cached) return { ...JSON.parse(cached), fallbackMode: false }

// 2. Postgres graph CTE resolution
const permissions = await graphProvider.resolveEffectivePermissions(
  userId, agentId, '*'
)

// 3. Cache the result (5 min TTL)
await valkey.set(pcasCacheKey(workspaceId, userId), ..., 'EX', PCAS_CACHE_TTL)

// 4. If database fails → synthetic empty set
return { allowedTools: [], deniedTools: [], budgetRemaining: 0, fallbackMode: true }
```

**Fallback mode:** When Postgres is unavailable, the service returns `fallbackMode: true` with an empty permission set. The circuit breaker can then escalate to `HIJACK` — restricting the agent to safe operations rather than blocking entirely.

**Cache TTL:** 5 minutes (`PCAS_CACHE_TTL`). On a warm cache this gate is a single Valkey GET; on a miss it is one Postgres query.

→ Source: `pcasService.ts` in the control plane, which is not open source

---

## Proxy-side fail mode

The proxy has its own circuit breaker behavior, configured via `PolicyConfig`:

```rust
// packages/proxy/src/config.rs
pub struct PolicyConfig {
    pub control_plane_url: String,
    pub fail_closed: bool,    // default: true
    pub timeout_ms: u64,      // default: 3,000ms
}
```

| Setting | Behavior |
|---|---|
| `fail_closed: true` (default) | If the policy check times out or fails → block the request |
| `fail_closed: false` | If the policy check times out or fails → allow the request (fail-open) |
| `timeout_ms: 3000` | Maximum time to wait for the control plane policy check response |

::: warning Fail-closed is the safe default
In production, always use `fail_closed: true`. Fail-open mode should only be used during initial setup or development when the control plane is not yet deployed.
:::

---

## Additional evaluation layers

Beyond the three hot-path gates, the circuit breaker can invoke additional evaluation layers **asynchronously** (they don't block the request):

| Layer | What it does | Runs on |
|---|---|---|
| **SSL enforcement** | Scheduling, structural and logical checks against the session's SOP graph | Every gated tool call — **in shadow**: findings are recorded to `detector_findings` and the call proceeds |
| **SSL compliance reporting** | Reports which SSL graph steps a session followed | On demand, `POST /api/v1/sessions/:id/ssl-audit` |
| **DLP Scanner** | Regex-based secret/PII detection in prompts | Every request (proxy-side, pre-forwarding) |
| **SnipCompactor** | Token compression — collapse repetitions, truncate JSON | Every request (proxy-side, pre-forwarding) |

The DLP scanner and SnipCompactor run **in the proxy** (Rust, on the developer's machine) — they
never hit the control plane. SSL enforcement runs in the control plane, at the hook gate.

::: warning SSL enforcement records; it does not block
It ships shadowed on purpose. The [promotion rule](/guide/graph-guardrails) requires advisory
telemetry from real traffic showing a false-positive rate in the 0.1–1% band before a control
that can stop a tool call is allowed to. SSL enforcement had never executed at all until it was
wired here, so it has no such measurement yet. Findings are visible through
`GET /api/v1/findings` and can be adjudicated; the rate is reported by
`GET /api/v1/findings/stats`, grouped so shadowed findings are counted separately.
:::

---

## Valkey key patterns

All circuit breaker state lives in Valkey for fast access:

| Key pattern | Purpose | TTL |
|---|---|---|
| `v2:budget:hard_block:{workspace_id}` | Budget cap exceeded flag | Set by billing cron |
| `v2:budget:{workspace_id}:monthly_limit` | Monthly spend limit | Persistent |
| `v2:budget:{workspace_id}:daily_limit` | Daily spend limit | Persistent |
| `v2:pcas:sso_group:{workspace_id}` | Cached SSO group policy, read by the gate | 5 min |
| `intutic:loop:{loop_run_id}` | Loop governance state | 7 days |

---

<!-- ENTERPRISE_ONLY_START -->
## Source code references

| Component / File | What it implements | Scope |
|---|---|---|
| [metering.rs](../../../packages/proxy/src/metering.rs) | Proxy-side budget gate and virtual key validation | Open-Core / Proxy |
| [config.rs](../../../packages/proxy/src/config.rs) | `PolicyConfig` — fail-closed, timeout settings | Open-Core / Proxy |
| [detectors.rs](../../../packages/proxy/src/plugins/anomaly/detectors.rs) | `consecutive_repeat` loop detection and the rest of the detector registry | Open-Core / Proxy |
| `POST /api/v1/hook-gate` (`hookEvents.ts`) | The hot-path policy check endpoint | Enterprise Control Plane |
| `pcasService.ts` | SSO group privilege resolution cascade | Enterprise Control Plane |
| `sslEnforcementService.ts` | SSL scheduling, structural and logical layers, plus compliance reporting | Enterprise Control Plane |
| `sslGateEvaluator.ts` | Calls the SSL layers from the hook gate in **shadow mode** — records, never blocks (`TD-300`) | Enterprise Control Plane |

---

<!-- ENTERPRISE_ONLY_END -->

## Related

- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/KILL verdicts
- [Harnesses](/concepts/harnesses) — How the proxy and sync daemon connect
- [Standard Operating Procedures](/concepts/sops) — SOP definitions and policy evaluation rules
- [Custom Filters (WASM)](/external/wasm-rules) — Custom tool-call filtering and policy hooks
