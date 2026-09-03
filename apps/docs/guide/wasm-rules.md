# Custom Filters (WASM Rules) <Badge type="tip" text="Open-Core" />

Write custom validation rules that run at wire speed in the Intutic proxy using WebAssembly.

## What Are Custom Filters?

Custom Filters let you write policy rules in AssemblyScript (a TypeScript subset), compile them to WebAssembly, and run them inside the Intutic proxy on every request. They execute in a sandboxed environment with strict resource limits.

::: info Availability
Local filters installed into `~/.intutic/wasm/` need no capability and no role — the open-core proxy loads them on the request path in any build. Dashboard-managed filters (Cloud) require the `feature.wasm_rules` capability and are accessible to **Owner**, **Admin**, and **EM** roles.
:::

---

## Why Use Custom Filters?

While SOPs define governance rules in natural language, custom filters provide **programmatic enforcement** that executes deterministically:

| Approach | Best For |
|----------|----------|
| **SOPs** | High-level policies, behavioral guidance, context-dependent rules |
| **Custom Filters** | Exact pattern matching, data validation, compliance checks that need zero ambiguity |

### Example Use Cases

- Block requests containing specific keywords or patterns
- Enforce token limits per request based on custom logic
- Validate that tool call arguments match expected schemas
- Implement organization-specific compliance checks

---

## Sandboxing & Resource Limits

Every custom filter runs inside a secure WebAssembly sandbox with strict constraints:

| Limit | Value | Purpose |
|-------|-------|---------|
| **Memory** | 16 MB | Prevents excessive memory consumption |
| **CPU Fuel** | 1,000,000 units | Prevents infinite loops and excessive computation |
| **Timeout** | 5 ms per request | Maintains low proxy latency |

If a filter exceeds any limit, it's immediately terminated and **fails open** — the request proceeds to maintain availability.

::: tip Memory-Safety Protocol
To prevent memory corruption and guest engine crashes under multi-turn garbage collection within Wasmtime, the host-to-guest interface passes context payloads as raw binary guest buffers (`Uint8Array`) rather than standard guest string pointers. This ensures maximum execution stability and zero runtime garbage collection overhead.
:::



## Host imports

A rule may import exactly four functions, all from `env`:

| Import | Signature | What it does |
| :--- | :--- | :--- |
| `log_info` | `(ptr: usize, len: usize) => void` | Writes a line to the proxy's log. |
| `trace` | `(msg, n, a0..a4) => void` | AssemblyScript's `trace()`. |
| `abort` | `(msg, file, line, col) => void` | AssemblyScript's abort path. Terminates the rule. |
| `read_referenced_file` | `(pathPtr, pathLen, outPtr, outCap) => i32` | Copies the contents of a file **this request's tool calls reference** into guest memory. |

**Nothing else resolves.** A rule importing anything beyond these is refused at
`intutic policy install`, refused again by the control plane if pushed from the
dashboard, and refused a third time when the proxy loads it.

### Reading a manifest a command references

Governing `kubectl apply -f k8s/deploy.yaml` usually means asking a question
about the *file*, not the command line. `read_referenced_file` answers it
without giving the sandbox a filesystem.

Call it with `outCap = 0` first: it returns the byte length and writes nothing,
so you can size a buffer. Call it again with a buffer at least that large and it
returns the same length, having copied the bytes. Any negative return is a
refusal, never a trap:

| Code | Meaning |
| :--- | :--- |
| `-1` | Malformed call — pointers outside your memory, a bad length, a non-UTF-8 path. |
| `-2` | Refused. Either your request's tool calls never named this path, or it failed a path guard. |
| `-3` | Referenced and allowed, but not on disk. |
| `-4` | Larger than the 256 KiB cap. **No bytes are exposed** — a rule must not scan a prefix and conclude a manifest is clean. |
| `-5` | Your buffer was smaller than the file. Nothing was written; ask for the size first. |
| `-6` | This evaluation used its 64 reads. |

What you can read is decided entirely by the host, before your rule is even
instantiated:

- **Only paths this request's tool calls name.** Derived from path arguments
  (`file_path`, `path`, …) and from tokens inside `command`-style arguments.
  Globs are not expanded — `*.yaml` is taken literally and simply fails to
  resolve.
- **Only manifest extensions**: `.yaml`, `.yml`, `.json`, `.tf`, `.tfvars`,
  `.hcl`, `.toml`. This is why a tool call naming `/etc/shadow` produces
  nothing to read.
- **Only inside the configured root.** `..` is refused outright, and a symlink
  leading out of the root is refused too, because confinement is checked against
  the fully resolved path.
- **At most 8 files per request, 256 KiB each.**

::: warning Off unless configured
Set `INTUTIC_WASM_MANIFEST_ROOT` to the directory rules may read manifests from.
With no root set there is no readable file at all and every call returns `-2` —
write your rule so that branch is a sensible outcome, because it is what runs on
any deployment that has not opted in.
:::

::: tip This is the one thing a rule sees that is not the request
A verdict that depends on a file is no longer reproducible from the stored
request alone: replaying it needs the tree as it was. The proxy logs a content
hash of everything it exposes so a replay discrepancy can at least be explained.
:::

::: danger `Math.random()` is unavailable
AssemblyScript compiles it to an `env.seed` import that the proxy does not
provide — and that is deliberate, not an oversight. A governance verdict that
can differ on identical input cannot be audited, and the replay and mutation
corpus gates both assume determinism.

This mattered: `env.seed` was once offered by the CLI's validation sandbox and
registered by no proxy. A rule using randomness passed `policy test`, passed
`policy install`, and then failed to link on every request — where the runner
turns a link error into an allow. It enforced nothing, silently. If you need
variation, derive it from the request context.
:::

If you see a rule listed as active and never firing, check the proxy log for a
link error before assuming the logic is wrong.

---

## Creating a Custom Filter

### 1. Initialize with the SDK

Intutic provides an AssemblyScript Rules SDK (`@intutic/wasm-sdk`) that provides standard types and parsing helpers.

Every field below is delivered on every request. The excerpt this page used to
show carried ten of them and pointed at the SDK for "the rest" — which is how a
rule author ends up not knowing that `forbid_after`, `changes` or
`injection_findings` are already in their hand.

### Identity and request

| Field | Type | What it is |
| :--- | :--- | :--- |
| `session_id` | `string` | The agent session this request belongs to. |
| `workspace_id` | `string` | Owning workspace. |
| `virtual_key_prefix` | `string` | Which virtual key authenticated the call. |
| `model` | `string` | Model the agent asked for. |
| `harness` | `string` | The agent that sent it — `claude-code`, `cursor`, … |
| `estimated_input_tokens` | `i32` | Prompt size for this turn. |
| `sandbox_attested` | `bool` | Whether this session's sandbox proved the proxy is its only egress path. Session-scoped, not per-call — once true, every subsequent request in the session reads `true`. `false` (never absent) until attestation happens or if the session isn't sandboxed at all. See [Sandbox attestation](/guide/graph-guardrails#sandbox-attestation) for how it's set and what it does and doesn't prove. |

### Tools

| Field | Type | What it is |
| :--- | :--- | :--- |
| `tools` | `ToolSchema[]` | Tools declared on this request. Name and description only — **not** the input schema. |
| `tool_calls` | `ToolCall[]` | Calls in this turn's message. |
| `tool_sequence` | `string[]` | Session history, oldest first. Includes this turn. |
| `tool_call_counts` | `(string, i32)[]` | How many times each distinct tool/action appears in `tool_sequence` — a fold of it, not a fetch. AssemblyScript has no map type to fold `tool_sequence` into itself, so this is pre-resolved for you. |
| `calls_last_60s` | `i32` | Tool calls in the last 60 seconds, across the whole session. Not derivable from `tool_sequence`/`tool_call_counts`: that window is a fixed entry count with no timestamps, so a burst that fills it in ten seconds and one spread over an hour look identical there. Always a real count — `0` means none, never "unknown". See [Temporal policy](#temporal-policy) below. |
| `corroborating_detectors` | `i32` | How many *distinct* built-in anomaly detectors fired at Medium+ severity on this request — the same pool the proxy's own corroboration escalation counts, so `ctx.corroborating_detectors >= 2` agrees with the built-in rung by construction, and `>= 3` gives you a stricter bar than the built-in without re-deriving anything. `0` when nothing fired and under break-glass. A rule gating on this stays advisory territory until you have measured what your traffic's agreement rate actually is — replay it first. |
| `new_tool_calls` | `string[]` | This turn's delta. **Use this, not `tool_sequence`, for a hold** — matching on history re-fires the hold forever. |
| `tool_contract_changed` | `bool` | A server changed a tool's contract mid-session. |
| `transition_baseline` | `map` | Observed transition frequencies. Absent early in a session. |

### Findings

| Field | Type | What it is |
| :--- | :--- | :--- |
| `dlp_findings` | `DlpFinding[]` | Secrets and sensitive data matched in this request. **Carries no position in the tool sequence** — see `forbid_with` below. |
| `injection_findings` | `string[]` | Prompt-injection pattern matches, deduplicated by pattern name. Pattern matches produce false positives; prefer `REASK` over `KILL`. |
| `injection_sources` | `string[]` | Which parts of the request contributed at least one match in `injection_findings` — `user_prompt`, `system_prompt`, `tool_result`, `tool_description`. Deduplicated by source, not paired 1:1 with `injection_findings`: a rule wanting to treat a `tool_result`-sourced match more seriously than a user typing "ignore previous instructions" checks this, not the count. Empty when nothing matched. |
| `changes` | `ChangeEntry[]` | The change manifest — what this run has written. |

### Policy, from the SOP front matter

Declaring these in a SOP makes the proxy's own detectors enforce them. They are
**also** handed to your rule, so a WASM rule can refine a declarative one.

| Field | Type | Declared as |
| :--- | :--- | :--- |
| `denied_tools` | `string[]` | `deny_tools:` |
| `allowed_harnesses` | `string[]` | `allow_harnesses:` |
| `plan_steps` | `string[]` | `plan_steps:` |
| `scope_paths` | `string[]` | `scope_paths:` |
| `review_before` | `string[]` | `review_before:` |
| `requires_before` | `(string, string)[]` | `requires_before: A -> B` |
| `forbid_after` | `(string, string, bool)[]` | `forbid_after: A -> B`. The bool is adjacency — `~>` means "immediately after". |
| `max_calls` | `(string, i32)[]` | `max_calls: Tool <= N` |
| `forbid_with` | `(string, string)[]` | `forbid_with: secrets(), action:http_post` — **co-occurrence, not flow**, because `dlp_findings` carries no sequence position. |
| `risk_tier` | `string` | `risk_tier:` — `Low` \| `Medium` \| `High` \| `Critical`. No proxy detector reads it; it exists for your rules. |

### Temporal policy

This context already carries most of what a time-aware policy needs — spread
across three shapes, because they answer three different questions:

- **Ordering** — `requires_before`/`forbid_after` above, "A must (not) happen
  relative to B". Cross-call by construction: the proxy resolves an entire
  session's sequence before your rule ever runs.
- **Count ceilings** — `max_calls`, "at most N calls to this tool, ever in
  this run". No notion of time; a workspace that made 3 deploys over a week
  and one that made 3 in a minute are indistinguishable to it.
- **Spend ceilings** — `budget_remaining_usd`, `workflow_spend_usd` /
  `workflow_budget_usd` above, and `graph_spend_usd` / `graph_budget_usd` on
  [`node`](#budget-and-graph) — the same "at most N, ever" shape as
  `max_calls`, just in dollars instead of calls.

What none of those can express is a **rate** — "at most N in the last M
seconds". `tool_sequence` and its fold `tool_call_counts` come closest but
still cannot: both are bounded by a fixed *entry count*, not a duration, so a
burst that fills the window in ten seconds and one spread over an hour are
the same shape to them.

`calls_last_60s` (in the [Tools](#tools) table above) is the field that
closes that gap — a genuinely time-windowed count, resolved from a dedicated
store rather than derived from the sequence. The starter rule
`rules/call-rate-guard/` in the SDK reads it: REASK, not block, since the
ceiling a rule picks here is an unmeasured threshold, the same reasoning
`risk-tier-ceiling` and `injection-then-egress` use for theirs.

### Budget and graph

| Field | Type | What it is |
| :--- | :--- | :--- |
| `budget_remaining_usd` | `f64` | Workspace budget left. |
| `workflow_spend_usd` | `f64?` | Spend on this workflow. Absent outside a workflow. |
| `workflow_budget_usd` | `f64?` | Its ceiling. Absent outside a workflow. |
| `node` | `NodeIdentity` | Position in the agent graph — id, parent, depth, liveness, node count. |

::: warning Unknown is not zero
The optional numerics arrive as `-1` when the host has nothing to send, not `0`.
A rule written `if (ctx.workflow_spend_usd > ctx.workflow_budget_usd)` reads
"unknown" as "under budget"; one written `if (remaining < 10)` reads it as
"broke" and blocks every request outside a workflow. Check for `-1` first.

The same shape bites on empty lists: an empty `allowed_harnesses` means
**unrestricted**, not "permit nothing".
:::

### The starter rules

The template ships six working rules in `runRules()`, each with a should-block
and should-allow mock in `assembly/mocks/` and a test asserting both. Keep the
ones you want, delete the rest.

| Rule | Reads | Verdict |
| :--- | :--- | :--- |
| `ruleToolContractPinned` | `tool_contract_changed` | block — a server changing its schema mid-session is not something the agent can correct |
| `ruleOrphanedNode` | `parent_alive`, `depth` | block — work nobody is waiting for |
| `ruleGraphBudgetGuard` | `graph_spend_usd`, `graph_budget_usd` | block — per-node budgets do not bound a fan-out |
| `ruleHarnessAllowlist` | `harness`, `allowed_harnesses` | block — arrived on a harness the SOPs do not permit |
| `ruleInjectionThenEgress` | `injection_findings`, `new_tool_calls` | **reask** — pattern matches do produce false positives |
| `ruleRiskTierCeiling` | `risk_tier`, `new_tool_calls` | **reask** — the tier describes the SOP, not this request |

Each was chosen to read a field family nothing else consumes, so the rule is
also the coverage test for it — delete the parser for `tool_contract_changed`
and that rule stops blocking its own mock.

Two of them are worth reading before you write anything of your own, because
they show the mistake the context invites:

- `ruleGraphBudgetGuard` treats `-1` as **unknown, not zero**. A graph whose
  cost was never aggregated has not spent nothing, and reading the sentinel as
  zero blocks graphs that have done nothing wrong.
- `ruleHarnessAllowlist` treats an empty list as **unrestricted, not "permit
  nothing"**. The inversion blocks every workspace that never declared the key.

The allow mocks are the sharper half of the suite: each is a near-miss aimed at
exactly that inversion.

### 2. Write the Rule

Write your rule logic in `assembly/index.ts` using the SDK:

```typescript
import { JSON } from "assemblyscript-json/assembly";

let activeBuffer: Uint8Array | null = null;

// Memory allocator helper for the host
export function allocate(size: i32): i32 {
  const buf = new Uint8Array(size);
  activeBuffer = buf;
  return changetype<i32>(buf.dataStart);
}

// Evaluation entry point
export function evaluate(offset: i32, len: i32): i32 {
  // 1. Read JSON bytes from the heap.
  //
  // Read into the Uint8Array the allocator already handed the host, and let
  // JSON.parse take the bytes. Building the string character by character —
  // which this example used to do — allocates once per byte, and the tip above
  // is a warning against exactly that: it is how a rule exhausts its fuel on a
  // large context and is silently skipped.
  const buf = activeBuffer;
  if (buf == null) return 0;
  const jsonObj = <JSON.Obj>JSON.parse(buf);

  // 2. Read the field you need
  const budget = jsonObj.getFloat("budget_remaining_usd");

  // 3. Block if budget is exhausted
  if (budget && budget.valueOf() <= 0.0) {
    return 1; // Block / Kill request
  }

  return 0; // Bypass / Allow
}
```

### 3. Compile to WebAssembly

Compile using the AssemblyScript compiler with runtime exports enabled:

```bash
npx asc assembly/index.ts -o build/rule.wasm --optimize --exportRuntime
```

### 4. Test Locally using the CLI

You can dry-run and test your compiled `.wasm` binary locally against any mock request context JSON file without deploying:

```bash
intutic policy test --wasm build/rule.wasm --mock mock_context.json
```

Test both directions before installing: a context your rule should block and one it should allow.

### 5. Install into the Local Proxy (Open-Core)

Install the validated rule into the local rules directory the proxy watches:

```bash
intutic policy install --wasm build/rule.wasm --name budget-guard --priority 50
intutic policy list-local
```

The rule lands in `~/.intutic/wasm/` as `50_budget-guard.wasm` (lower priority numbers run first) and the proxy hot-loads it within ~5 seconds on the next request — no restart, no control plane. `install` refuses binaries that fail instantiation, because a broken rule enforces nothing (the sandbox fails open).

> [!TIP]
> Any AI coding agent in your workspace can drive this whole loop — authoring, compiling, dry-running, and installing — via the [Rule Author agent skill](/integrations/rule-author).

---

<!-- ENTERPRISE_ONLY_START -->
## Deploying Filters

### 1. Upload via the Dashboard

1. Navigate to **Custom Filters** in the dashboard sidebar
2. Click **Upload Rule**
3. Select your compiled `.wasm` file
4. Add a name and description
5. Activate the filter

### 2. Hot-Reload

Filters are hot-reloaded into the proxy without requiring a service restart:

1. The compiled WASM binary is stored in the database and the workspace's active rule set is published to Valkey
2. Each connected proxy polls that rule set every 5 seconds (there is no push channel)
3. A new WebAssembly module is instantiated on the fly when the descriptor changes
4. The filter is active on the request path within one poll interval

---

## Managing Filters

From the Custom Filters dashboard:

| Action | Description |
|--------|-------------|
| **Activate** | Enable the filter on the request path |
| **Deactivate** | Disable without deleting |
| **Update** | Upload a new version of the WASM binary |
| **Delete** | Permanently remove the filter |
| **Test** | Run the filter against sample inputs to verify behavior |

---

## Monitoring

The dashboard shows filter execution metrics:

- **Hit count** — How many requests triggered the filter
- **Block count** — How many requests were blocked
- **Average execution time** — Latency impact per request
- **Fuel consumption** — CPU fuel used per execution
<!-- ENTERPRISE_ONLY_END -->

---

## Related

- [Standard Operating Procedures](/concepts/sops) — Policy evaluation and SOP rules
- [How It Works](/guide/how-it-works) — Proxy architecture
- [Custom Filters (WASM Rules Engine)](/external/wasm-rules) — Technical architecture deep-dive

