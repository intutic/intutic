---
title: Circuit Breaker
description: How Intutic's circuit breaker evaluates every tool call in under 50ms — budget gates, loop detection, policy resolution, and graceful degradation.
---

# Circuit Breaker <Badge type="tip" text="Open-Core" />

The **circuit breaker** is the decision engine that evaluates every AI agent tool call and returns an [enforcement action](/concepts/enforcement-actions) — BYPASS, ENHANCE, HIJACK, or KILL. It operates on the hot path between the proxy and the LLM provider, so every millisecond matters.

**Design goals:**
- Typical evaluation in **< 50ms** (real benchmarks in T12)
- **Fail-closed** by default — if the check can't complete, block the request
- **Graceful degradation** — if a backend is unavailable, fall back to the next tier
- **Zero single points of failure** — Valkey cache and Postgres each provide a degradation layer

---

## Hot path architecture

The circuit breaker runs on every pre-request policy check. The proxy calls `POST /api/v1/policy/check` on the control plane, which evaluates three gates in sequence:

```
Tool call arrives at proxy (:4000)
              │
              ▼
     ┌────────────────┐
     │ 1. Budget Gate │ ◀── Valkey: v2:budget:hard_block:{wk_id}
     │   (< 1ms)      │     + loop governance kill check
     └────────┬───────┘
              │ pass
              ▼
     ┌────────────────┐
     │ 2. Loop Breaker│ ◀── Valkey: v2:loop:{session_id}
     │   (< 2ms)      │     sliding window of prompt hashes
     └────────┬───────┘
              │ pass
              ▼
      ┌────────────────┐
      │ 3. PCAS Policy │ ◀── Valkey cache (< 1ms on hit)
      │   Resolution   │     Postgres query (< 15ms on miss)
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

**Latency:** Typically < 1ms (single Valkey GET)

```typescript
// services/control-plane/src/routes/evaluate.ts
const budgetBlock = await valkey.get(budgetHardBlockKey(workspace_id))
if (budgetBlock) {
  return c.json({ action: 'deny', reason: 'Workspace budget cap exceeded' })
}
```

The proxy also does a **local budget check** before even calling the control plane — checking `v2:budget:hard_block:{workspace_id}` directly from its own Valkey connection. This means budget blocks take effect with zero network round-trips.

→ Source: [metering.rs](../../../packages/proxy/src/metering.rs) (proxy-side), [evaluate.ts](https://github.com/intutic/intutic/tree/main/services/control-plane/src/routes/evaluate.ts) (control-plane-side)

---

## 2. Loop breaker

Detects when an agent is stuck repeating the same prompt in a loop.

**Algorithm:** Sliding-window hash deduplication
1. Normalize the prompt: trim → lowercase → collapse whitespace
2. SHA-256 hash, truncated to 16 hex characters
3. Check the hash against a sliding window of the last **20 prompts** stored in Valkey
4. If the hash appears **≥ 5 times** (configurable threshold) → it's a loop → `KILL`
5. Append the new hash and write back with a 1-hour TTL

```typescript
// services/control-plane/src/services/loopBreakerService.ts

const WINDOW_SIZE = 20      // hashes in the sliding window
const DEFAULT_THRESHOLD = 5  // repetitions to trigger loop detection
const LOOP_STATE_TTL = 3_600 // 1 hour (matches session inactivity)
```

**Graceful degradation:** If Valkey is unavailable, returns `{ isLoop: false }` — the loop breaker fails open so it doesn't block legitimate requests when the cache is down.

**Latency:** Typically < 2ms (Valkey GET + JSON parse + SET)

→ Source: [loopBreakerService.ts](https://github.com/intutic/intutic/tree/main/services/control-plane/src/services/loopBreakerService.ts)

---

## 3. PCAS policy resolution

The most complex gate — resolves effective permissions for the user+agent pair by walking the organization policy hierarchy.

**Resolution cascade:**

| Step | Backend | Latency | What happens on failure |
|---|---|---|---|
| 1 | Valkey cache | < 1ms | Continue to step 2 |
| 2 | Postgres CTE resolution | < 15ms | Continue to step 3 |
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

**Cache TTL:** 5 minutes (`PCAS_CACHE_TTL`). On a warm cache, this gate completes in < 1ms.

→ Source: [pcasService.ts](https://github.com/intutic/intutic/tree/main/services/control-plane/src/services/pcasService.ts)

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
| **SOP Hook Executor** | V8-sandboxed hook scripts — `allow`/`block`/`modify`/`warn` | PRE_TOOL, POST_TOOL, PRE_RESPONSE, POST_RESPONSE |
| **SSL Enforcement** | Three-layer enforcement (scheduling → structural → logical) | Tool calls matching active SSL graphs |
| **DLP Scanner** | Regex-based secret/PII detection in prompts | Every request (proxy-side, pre-forwarding) |
| **SnipCompactor** | Token compression — collapse repetitions, truncate JSON | Every request (proxy-side, pre-forwarding) |

The DLP scanner and SnipCompactor run **in the proxy** (Rust, on the developer's machine) — they never hit the control plane. SOP hooks and SSL enforcement run in the control plane when triggered.

---

## Valkey key patterns

All circuit breaker state lives in Valkey for fast access:

| Key pattern | Purpose | TTL |
|---|---|---|
| `v2:budget:hard_block:{workspace_id}` | Budget cap exceeded flag | Set by billing cron |
| `v2:budget:{workspace_id}:monthly_limit` | Monthly spend limit | Persistent |
| `v2:budget:{workspace_id}:daily_limit` | Daily spend limit | Persistent |
| `v2:loop:{session_id}` | Sliding window of prompt hashes | 1 hour |
| `v2:pcas:{workspace_id}:{user_id}` | Cached permission set | 5 min |
| `intutic:loop:{loop_run_id}` | Loop governance state | 7 days |

---

## Source code references

| Component / File | What it implements | Scope |
|---|---|---|
| [metering.rs](../../../packages/proxy/src/metering.rs) | Proxy-side budget gate and virtual key validation | Open-Core / Proxy |
| [config.rs](../../../packages/proxy/src/config.rs) | `PolicyConfig` — fail-closed, timeout settings | Open-Core / Proxy |
| `POST /api/v1/policy/check` (`evaluate.ts`) | The hot-path policy check endpoint | Enterprise Control Plane |
| `loopBreakerService.ts` | Sliding-window loop detection | Enterprise Control Plane |
| `pcasService.ts` | PCAS permission resolution cascade | Enterprise Control Plane |
| `sopHookExecutor.ts` | V8-sandboxed hook execution | Enterprise Control Plane |
| `sslEnforcementService.ts` | Three-layer SSL enforcement | Enterprise Control Plane |

---

## Related

- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/KILL verdicts
- [Harnesses](/concepts/harnesses) — How the proxy and sync daemon connect
- [Standard Operating Procedures](/concepts/sops) — SOP definitions and policy evaluation rules
- [Custom Filters (WASM)](/external/wasm-rules) — Custom tool-call filtering and policy hooks
