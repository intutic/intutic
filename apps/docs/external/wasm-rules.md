# Custom Filters (WASM Rules Engine) <Badge type="tip" text="Open-Core" />

This page documents how the WebAssembly (WASM) Rules Engine is structured, compiled, synchronized, and executed on the request interception hot-path.

---

## 1. Overview & Sandboxing

The WASM Rules Engine enables developers to write custom, high-performance policy rules in AssemblyScript (a TypeScript subset), compile them to WebAssembly, and run them inside a sandboxed `wasmtime` environment inside the Intutic Proxy.

To guarantee that custom user code cannot degrade proxy performance or compromise host security, each rule is strictly constrained:
* **Memory Cap**: Limited to **16MB** of linear memory.
* **CPU Fuel Limit**: Bound to **1,000,000 fuel units** to prevent infinite loops.
* **Execution Timeout**: **5ms** budget per request. If a rule exceeds 5ms, it is immediately terminated and fails open to maintain low latency.

---

## 2. Rule Lifecycle

The WASM rules lifecycle supports both local offline development and centralized enterprise governance:

### Local Open-Core Mode (Standalone)
In pure Open-Core mode, rule binaries run completely offline on your local machine:

```
[Developer: AssemblyScript Code] ──(asc / intutic policy compile)──► [WASM Binary (.wasm)]
                                                   │
                                       (intutic policy install)
                                                   ▼
                                       [~/.intutic/wasm/NN_name.wasm]
                                                   │
                                     (5s TTL rescan on the request path)
                                                   ▼
                                             [Rust Proxy]
                                      (wasmtime module compile)
```

1. **Compilation**: `intutic policy compile --src assembly/index.ts --out build/rule.wasm` (wraps the AssemblyScript compiler `asc`).
2. **Dry-run**: `intutic policy test --wasm build/rule.wasm --mock mock.json` — validate both a should-block and a should-allow context before installing.
3. **Install**: `intutic policy install --wasm build/rule.wasm --name <name> --priority NN` copies the validated binary into `~/.intutic/wasm/` as `NN_name.wasm`. Inspect with `intutic policy list-local`. Override the directory with the `INTUTIC_WASM_DIR` env var or `intutic_settings.wasm_local_dir` in `config.yaml`.
4. **Hot-Reload**: The proxy rescans the directory's file signatures (mtime + size) at most every **5 seconds, on the request path** — rules only matter when a request arrives, so no background watcher process is needed. Changed files are recompiled to `wasmtime::Module`s without a service restart. Loading is **fail-open per file**: a corrupt or mid-copy file is logged and skipped, and the previous good version of that rule keeps enforcing until a valid replacement compiles.
5. **Naming Convention**: `NN_name.wasm` — the numeric `NN` prefix is the evaluation priority (lower runs first); files without the prefix default to priority `100`.

#### Precedence & Coexistence
Local rules and centrally-synced (Valkey) rules are merged into a single priority-ordered list at evaluation time (ties keep central rules first). `BLOCK` short-circuits the chain and no verdict can override a block, so the union is **most-restrictive-wins**: a local rule can add restrictions but can never neutralize a centrally-synced rule.

<!-- ENTERPRISE_ONLY_START -->
### Enterprise Cloud / Team Sync Mode
In enterprise environments with centralized governance:

```
[Developer / Admin] ──(asc)──► [WASM Binary] ──(Dashboard Upload)──┐
                                                                    ▼
                                                             [Control Plane]
                                                                    │
                                                           (Valkey Pub/Sub)
                                                                    │
                                                                    ▼
                                                             [Rust Proxy]
                                                      (wasmtime module compile)
```

1. **Registry Storage**: Rules are uploaded via the Custom Filters dashboard (`POST /api/v1/wasm-rules`) and persisted in the `wasm_rule_bundles` database table.
2. **Real-time Sync**: The control plane broadcasts updates via Valkey Pub/Sub to active connected proxies, which load the updated module dynamically.
<!-- ENTERPRISE_ONLY_END -->

---

## 3. Host-Guest Interception Interface

When an LLM or tool request is intercepted, the Rust proxy executes the rule using a guest-host contract:

### A. Context Serialization
The Rust host normalizes the intercepted request context (tool calls, arguments, tokens, user role, etc.) and serializes it into a JSON string format:
```json
{
  "session_id": "ses_7x2k9m",
  "workspace_id": "wk_abc",
  "virtual_key_prefix": "vk_live",
  "model": "claude-3-5-haiku",
  "tools": [],
  "tool_calls": [{ "id": "call_1", "name": "bash", "arguments": "{\"command\":\"rm -rf /\"}" }],
  "estimated_input_tokens": 1200,
  "budget_remaining_usd": 4.25,
  "risk_tier": "HIGH",
  "node_id": "ses_7x2k9m",
  "agent_role": "",
  "graph_id": "ses_7x2k9m",
  "parent_session_id": "",
  "depth": 0,
  "dlp_findings": [],
  "tool_sequence": ["Glob", "View", "bash"]
}
```

Graph position (`node_id`, `agent_role`, `graph_id`, `parent_session_id`,
`depth`) is flattened into the same object — for a standalone session the ids
fall back to the session id at depth 0. See the full field table in
[Graph Guardrails](/guide/graph-guardrails).

Field names are **snake_case** on the wire — the Rust `RequestContext` is
serialised without a rename, so the AssemblyScript SDK parses `session_id`, not
`sessionId`. `tool_sequence` carries the session's tool history oldest-first,
which is what makes ordering and cycle rules possible; see
[Graph Guardrails](/guide/graph-guardrails).

### B. Memory Allocation & Injection
Because WASM sandboxes have isolated linear memory, the host must inject the context:
1. The host calls the exported WASM function `allocate(len)` (falling back to AssemblyScript's `__new(len, 0)`) to allocate buffer memory within the guest instance.
2. The host writes the serialized JSON string directly to that allocated offset in the guest's memory.

### C. Execution
The host calls the guest's main evaluation entrypoint:
```typescript
export function evaluate(requestContextJson: ArrayBuffer): i32
```

### D. Host Imports
A rule may import exactly three functions, all from `env`: `log_info(ptr, len)`,
which is piped into the proxy's structured `tracing::info!` output, plus
AssemblyScript's own `trace` and `abort`.

**Nothing else resolves.** A rule importing anything beyond these is refused at
`intutic policy install`, refused by the control plane if pushed from the
dashboard, and refused again when the proxy loads it.

In particular `Math.random()` is unavailable — AssemblyScript compiles it to an
`env.seed` import the proxy deliberately does not provide. A governance verdict
that can differ on identical input cannot be audited.

---

## 4. Gating Verdicts

The guest function returns an integer verdict that dictates how the proxy gates the request:

| Value | Verdict | Action Taken |
|:---:|---|---|
| **`0`** | `ALLOW` | The request is marked clean and continues down the pipeline. |
| **`1`** | `BLOCK` | The request is rejected immediately. The proxy short-circuits the connection and returns a block response: `{ "error": "Blocked by WASM rule policy" }`. |
| **`3`** | `REASK` | The attempt is refused, the agent is told why, and it may retry. Prefer this over `BLOCK` for any finding that is a pattern match — pattern matches produce false positives, and a block a human has to unpick costs more than a retry. |
| **`2`** | *deprecated* | Was documented as `REDACT`. The guest never receives the request body, so redaction was never expressible; the proxy maps `2` to a block and logs it. `intutic policy install` still accepts it so already-installed rules keep their meaning, but warns. Return `1` or `3`. |

Anything else is **allowed** with a warning in the proxy log. A rule inventing a
rung enforces nothing, which is why `intutic policy install` refuses codes
outside this table.

*Note: If multiple rules are active, the runner evaluates all instances sequentially and returns the **most restrictive** verdict.*
