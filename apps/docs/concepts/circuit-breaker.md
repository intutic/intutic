---
title: Circuit Breaker
description: How Intutic's circuit breaker evaluates every tool call in-process — budget gates, loop detection, policy resolution, and graceful degradation.
---

# Circuit Breaker <Badge type="tip" text="Open-Core" />

The **circuit breaker** is the decision engine that evaluates every AI agent tool call and returns an [enforcement action](/concepts/enforcement-actions) — BYPASS, ENHANCE, HIJACK, REASK, or KILL. It operates on the hot path between the proxy and the LLM provider, so every millisecond matters.

**Design goals:**
- Evaluation is in-process with no model call. Cost is measured per payload size in `packages/proxy/benches` — there is no single figure, because it is dominated by request size.
- **Fail-closed** by default for the proxy's connectivity to the control plane — if the model-request policy check can't complete, block the request (see [Proxy-side fail mode](#proxy-side-fail-mode)). This is a different guarantee from what happens *inside* a completed check: the hook gate's own per-check evaluation (DLP, SSO group policy, image provenance, and so on) fails **open** on an internal error — each check is independently wrapped so one broken detector degrades to "allowed," not "denied." Do not conflate the two.
- **Graceful degradation** — if a backend is unavailable, fall back to the next tier
- **Zero single points of failure** — Valkey cache and Postgres each provide a degradation layer

---

## Hot path architecture

Two different paths evaluate a request, and it is worth keeping them apart.

**Model requests** go through the proxy, which calls `POST /api/v1/policy/check` on the control
plane (`routes/evaluate.ts`) — the budget and loop-governance gates below.

**Tool calls** are evaluated at the [hook gate](/concepts/enforcement-actions#how-a-verdict-is-decided),
a separate endpoint with its own order of checks. That is where SSO-group
clearance runs on the server (see [§3](#_3-sso-group-clearance) below), and the
local gates apply the same decision from the policy snapshot; neither is part of
the model-request path. Loop *detection* is different again: it
is an anomaly detector running in-process in the proxy, not a control-plane
call.

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

→ Source: [metering.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/metering.rs) (proxy-side); `routes/evaluate.ts` in the control plane, which is not open source

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

## 3. SSO group clearance <Badge type="warning" text="Biz Org+" />

A workspace can restrict high-risk tools to members of named identity-provider groups. The
policy is the `sso_group_policy` workspace setting. An owner or admin sets it in
**Settings › Security › Group policy for high-risk tools**, or with the settings API:

```bash
curl -X PUT "$INTUTIC_URL/api/v1/workspace/settings" \
  -H "Authorization: Bearer $INTUTIC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sso_group_policy": {
      "highRiskTools": ["Bash", "database_write"],
      "requiredGroups": ["sre-oncall", "platform-admins"],
      "requireOboFor": ["production_deploy"]
    }
  }'
```

Each list holds up to 500 names of 1 to 256 characters, and a list left out is empty. Anything
else is refused with a `400` naming `sso_group_policy`, and nothing is stored. `null` removes
the policy. Every change is recorded in the workspace's settings history.

**Plans.** The policy needs single sign-on, because members get their groups only through SSO
sign-ins and SCIM provisioning. On a plan without SSO (Free and Self-serve) a policy is refused
with a `403` (`Upgrade required — … requires a Biz Org plan or higher`), the same refusal as the
SSO settings, and a policy stored before a downgrade is not enforced: every gate reads it as
absent. It stays stored, so it applies again after an upgrade, and `null` still removes it.

**Where a member's groups come from.** One rule, used by every gate:

- **SCIM provisioning on:** the member's [SCIM group](/guide/scim#groups-and-nesting)
  memberships, by group display name, including every group above them through nesting. Groups
  from SSO sign-ins are ignored while SCIM is on: the directory is authoritative.
- **SCIM provisioning off:** the `groups` claim of the member's last OIDC sign-in, or the group
  attribute of their last SAML assertion.

SCIM provisioning is on while the workspace holds a SCIM token the SCIM endpoint would accept:
not revoked, not expired, on a plan that includes SCIM. Issuing the first such token switches
every member to their SCIM groups, including members your directory has not put in any group
yet, who then hold none. Revoking the last one, or letting it expire, switches them back to
their sign-in groups.

**The decision**, for one member and one tool, in order:

| Step | Condition | Clearance |
|---|---|---|
| 1 | The workspace has no `sso_group_policy`, or its plan has no SSO | `GRANTED` |
| 2 | The tool is on `requireOboFor` | `REQUIRES_OBO` |
| 3 | The tool is not on `highRiskTools` | `GRANTED` |
| 4 | The gate does not know the member's groups | `DENIED` |
| 5 | The member holds one of `requiredGroups` | `GRANTED` |
| 6 | Otherwise | `DENIED` |

Tool and group names match exactly, including case, with one widening for MCP tools, which
go by two names: an entry naming a tool as its MCP server declares it (`run_query`) also
matches the name a harness gives that tool on any server (`mcp__postgres__run_query`). An
entry that already names the harness form (`mcp__postgres__run_query`) matches only that
server's tool. Every gate applies both rules alike. Every gate refuses `DENIED` and
`REQUIRES_OBO` alike: a tool-call gate acts with the member's own credentials and has no
on-behalf-of token to present. The refusal names the rule that decided, for example
`[sso_group.high_risk.Bash]` or `[sso_group.require_obo.production_deploy]`. That id is
what the `gate_decisions` SIEM source records as `rule_id`.

**Where it runs.** One evaluator makes this decision everywhere, and every implementation is
held to the same set of test cases:

| Decision point | Where the member's groups come from | When the decision can fail |
|---|---|---|
| The [hook gate](/concepts/enforcement-actions#how-a-verdict-is-decided) (`POST /api/v1/hook-gate`) | Resolved on every call | An internal error allows the call, like every check on that endpoint |
| The [MCP governance proxy](/guide/mcp-governance) | The member the proxy's API key resolves to, from its policy refresh | With a policy but no resolved member, or a key the control plane refuses, high-risk tools are refused |
| The proxy's [response gate](#the-proxy-s-response-gate) | The member the request's virtual key belongs to, from the control plane, cached per key | With a policy but no resolved member, or a key the control plane refuses, high-risk tools are refused. When the policy cannot be fetched, the proxy's [fail mode](#proxy-side-fail-mode) decides |
| The harness hook gates and the `@intutic/gate` and `intutic-clawde` SDK gates | The policy snapshot the sync daemon writes to `~/.intutic/hooks/` | See below |

**Local gates.** Most harness gates decide on the developer's machine without calling the
control plane, from the policy snapshot the sync daemon refreshes. The snapshot carries the
workspace's group policy and the member it was issued to, with their groups as the control
plane resolved them for the daemon's API key. The daemon compiles the policy for that member
into one block rule per tool they may not call, ahead of every other rule, so a harness gate
refuses exactly what the hook gate refuses. The SDK gates read the policy and groups from the
snapshot and decide with the same evaluator.

- **Unknown groups are refused, never granted.** A workspace with a group policy whose
  snapshot names no member has every high-risk tool refused. When the control plane refuses the
  daemon's key (revoked, member deactivated or offboarded, or past the
  [SSO-recency window](/guide/security)), the daemon rewrites the snapshot with the member's
  groups unknown and keeps every other rule.
- **Editing the snapshot clears nothing.** The member's groups are inside the snapshot's digest,
  so an edited group list fails the check. A gate that reads an invalid snapshot drops its
  dynamic rules except the group refusals; the SDK gates apply the policy with the member's
  groups unknown. The directory is also a protected path every gate refuses to let an agent
  write.
- **Unaffected:** a workspace with no group policy. Its snapshots are byte-identical to before.

### The proxy's response gate

The proxy reads every model response before the harness does, and withholds a tool call the
group policy refuses, on streamed and whole responses alike. That covers harnesses with no hook
system of their own, such as Roo Code or aider pointed at the proxy, where the response gate is
the only gate. It is the same check that withholds a tool on an SOP's `deny_tools` list:

- **Who is checked.** The member the request's virtual key belongs to. The proxy asks the control
  plane for the workspace's group policy and that member's groups through the per-key
  `GET /api/v1/auth/key-context` it already uses to validate keys, and keeps the answer for that
  key for 30 seconds. A key with no active member has its groups unknown, so its high-risk tools
  are refused. A key the control plane refuses (revoked, or its member deactivated) keeps the
  policy last seen for it with the groups unknown.
- **What is matched.** The tool name the model emitted, which is the name a harness hook sees
  (`Bash`, `mcp__github__create_issue`). Names match as at the hook gate, an MCP tool's own
  name included; the case-insensitive match `deny_tools` uses does not apply. Gemini's native function-call format
  is not read by the response gate, for group rules or `deny_tools`.
- **What the client sees.** The tool call never reaches the harness. In its place the model's
  turn carries a message naming the tool, the reason and the rule, for example
  `[sso_group.high_risk.Bash]`, and telling the agent not to retry.
- **What is recorded.** The request's trace is marked killed and carries a finding from detector
  `sso_group` whose reason ends with the rule id. The control plane forwards it to the
  `gate_decisions` SIEM source as a `BLOCK` with that `rule_id` and source
  `proxy_response_gate`, next to the same refusal from every other gate.
- **When the policy cannot be fetched.** The proxy's [fail mode](#proxy-side-fail-mode) applies:
  with `fail_closed: true`, the default, the request is refused before it reaches the model, as
  when the policy check cannot complete; with `fail_closed: false` it proceeds without group
  rules.
- **Not here:** a standalone proxy with no control plane has no group policy and skips the
  check, and a request made with a provider key instead of a virtual key names no member and is
  not checked.

**Propagation.** A SCIM change needs no sign-in. Every SCIM write (a group created, renamed,
deleted or re-membered, a user provisioned or deactivated), every SCIM token issued or revoked,
every change to `sso_group_policy`, and every plan change of a workspace that stores one, drops
the cached policy the MCP proxies read, moves the workspace's configuration version, and pushes a
configuration update to connected sync daemons. A policy or plan change also drops the hook
gate's own 60-second policy cache. End to end:

| Change | Hook gate | Harness and SDK gates | MCP proxy | Proxy response gate |
|---|---|---|---|---|
| SCIM group add or remove, SCIM switched on or off | Next call | Seconds, through the push; at most one sync cycle (30 seconds by default, `intutic connect --interval <ms>`) when the daemon is connected to another control-plane replica or not connected | Next policy refresh, at most 60 seconds | Next request: the configuration version moved, so the key's cached answer is refetched |
| Member deactivated or deprovisioned | Key refused on the next call | Next refresh: the key is refused and the snapshot forgets the member's groups | Next policy refresh: the key is refused and the proxy forgets the member's groups | Key refused on the next request |
| Groups changed at the identity provider, SCIM off | When the member next signs in through SSO, then next call | The sync cycle after that sign-in | The policy refresh after that sign-in | Within 30 seconds of that sign-in |
| `sso_group_policy` changed through the settings API or the dashboard | Next call | Seconds, through the push; at most one sync cycle otherwise | Next policy refresh, at most 60 seconds | Next request: the configuration version moved, so the key's cached answer is refetched |
| The plan changes to or from one with SSO (a purchase, a cancellation, a trial ending) | Next call | Seconds, through the push; at most one sync cycle otherwise | Next policy refresh, at most 60 seconds | Next request: the configuration version moved, so the key's cached answer is refetched |

A proxy that does not read the control plane's Valkey cannot see the configuration version, so
the response gate's answer for a key is at most 30 seconds old there for every change.

The group policy is not demoted by the `SILENT_LOG` intervention mode or by shadow enforcement.
The hook gate, the MCP proxy and the proxy's response gate refuse these calls in every mode, so
the local gates do too.

→ Source: `evaluateSsoGroupClearance` in `packages/shared-types/src/ssoGroupClearance.ts`; the
test cases are `packages/shared-types/fixtures/sso-group-clearance-vectors.json`

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
| **Tool-poisoning redaction** | Strips hidden/adversarial instructions from third-party MCP tool descriptions before the agent ever sees them (`[REDACTED_TOOL_POISON]`) — the same call still makes sense to the agent, it just loses the injected instruction | Every request, unconditionally (proxy-side, pre-forwarding) |
| **SnipCompactor** | Token compression — collapse repetitions, truncate JSON | Every request (proxy-side, pre-forwarding) |

The DLP scanner, tool-poisoning redaction, and SnipCompactor run **in the proxy** (Rust, on the developer's machine) — they never hit the control plane. SSL enforcement runs in the control plane, at the hook gate.

**Measured, not assumed:** the detector behind tool-poisoning redaction was run against 10,753 real tool and parameter descriptions (14 BFCL v3 splits, 2,711 tool + 8,042 parameter descriptions) and produced **zero false positives**. It is deliberately narrow — 7 patterns tuned specifically for hidden instructions in *tool descriptions*, disjoint from the conversational jailbreak patterns the request-body scan looks for — so a legitimate tool with an unusual description doesn't get flagged for describing itself. Source: `packages/proxy/src/tool_poison.rs`, corpus at `packages/proxy/tests/corpus/tooldesc/tooldesc.jsonl`.

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
| `v2:pcas:sso_group:{workspace_id}` | Cached SSO group policy, read by the gate | 60 s |
| `intutic:loop:{loop_run_id}` | Loop governance state | 7 days |

---

<!-- ENTERPRISE_ONLY_START -->
## Source code references

| Component / File | What it implements | Scope |
|---|---|---|
| [metering.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/metering.rs) | Proxy-side budget gate and virtual key validation | Open-Core / Proxy |
| [config.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/config.rs) | `PolicyConfig` — fail-closed, timeout settings | Open-Core / Proxy |
| [detectors.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/plugins/anomaly/detectors.rs) | `consecutive_repeat` loop detection and the rest of the detector registry | Open-Core / Proxy |
| `POST /api/v1/hook-gate` (`hookEvents.ts`) | The hot-path policy check endpoint | Enterprise Control Plane |
| `pcasService.ts` | SSO group clearance at the hook gate (Valkey → Postgres) | Enterprise Control Plane |
| `memberGroupsService.ts` | A member's effective SSO groups: SCIM while SCIM provisioning is on, else SSO sign-in | Enterprise Control Plane |
| `sslEnforcementService.ts` | SSL scheduling, structural and logical layers, plus compliance reporting | Enterprise Control Plane |
| `sslGateEvaluator.ts` | Calls the SSL layers from the hook gate in **shadow mode** — records, never blocks | Enterprise Control Plane |

---

<!-- ENTERPRISE_ONLY_END -->

## Continuous self-verification

The circuit breaker's own controls are checked, not just trusted:

- **Guard-liveness probes** re-run every guard against a violating and a
  benign context every 15 minutes, so a control that stopped firing is
  caught by the platform, not discovered in a postmortem. Results are
  queryable at `GET /intutic/probes`. → Source:
  [probes.rs](https://github.com/intutic/intutic/blob/main/packages/proxy/src/probes.rs)
- **Silent-gate detection** flags a gate that has gone quiet — the *absence*
  of expected activity, not a failed check — as its own finding, run hourly
  alongside the rest of the scheduled governance sweep. A gate that silently
  stops gating is an enforcement outage, and this is what catches it without
  waiting for someone to notice nothing was blocked.

## Related

- [Enforcement Actions](/concepts/enforcement-actions) — BYPASS/ENHANCE/HIJACK/REASK/KILL verdicts
- [Harnesses](/concepts/harnesses) — How the proxy and sync daemon connect
- [Standard Operating Procedures](/concepts/sops) — SOP definitions and policy evaluation rules
- [Custom Filters (WASM)](/external/wasm-rules) — Custom tool-call filtering and policy hooks
