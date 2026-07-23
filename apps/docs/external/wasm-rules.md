# Custom Filters (WASM Rules Engine) <Badge type="tip" text="Open-Core" />

This page documents how the WebAssembly (WASM) Rules Engine is structured, compiled, synchronized, and executed on the request interception hot-path.

---

## 1. Overview & Sandboxing

The WASM Rules Engine enables developers to write custom, high-performance policy rules in AssemblyScript (a TypeScript subset), compile them to WebAssembly, and run them inside a sandboxed `wasmtime` environment inside the Intutic Proxy.

To guarantee that custom user code cannot degrade proxy performance or compromise host security, each rule is strictly constrained:
* **Memory Cap**: Limited to **1MB** of linear memory.
* **CPU Fuel Limit**: Bound to **1,000,000 fuel units** to prevent infinite loops.
* **Execution Timeout**: **5ms** budget per request. If a rule exceeds 5ms, it is immediately terminated and fails open to maintain low latency.

---

## 2. Rule Lifecycle

The WASM rules lifecycle supports both local offline development and centralized enterprise governance:

### Local Open-Core Mode (Standalone)
In pure Open-Core mode, rule binaries run completely offline on your local machine:

```
[Developer: AssemblyScript Code] ──(asc)──► [WASM Binary (.wasm)]
                                                   │
                                            (Local File Placement)
                                                   ▼
                                         [~/.intutic/wasm/*.wasm]
                                                   │
                                           (Local Hot-Reload Watcher)
                                                   ▼
                                             [Rust Proxy]
                                      (wasmtime module compile)
```

1. **Compilation**: Rules are compiled to WebAssembly binaries (`.wasm`) using AssemblyScript (`asc`).
2. **Local Placement**: Drop compiled `.wasm` files into your workspace or user directory (`~/.intutic/wasm/`).
3. **Hot-Reload**: The local Rust proxy detects file changes in `~/.intutic/wasm/` via a local directory watcher and instantiates the updated `wasmtime::Module` instantly without requiring a service restart.

<!-- ENTERPRISE_ONLY_START -->
### Enterprise Cloud / Team Sync Mode
In enterprise environments with centralized governance:

```
[Developer / Admin] ──(asc)──► [WASM Binary] ──(Dashboard Upload)──┐
                                                                    ▼
                                                             [PostgreSQL]
                                                                    │
                                                           (Valkey Pub/Sub)
                                                                    │
                                                                    ▼
                                                             [Rust Proxy]
                                                      (wasmtime module compile)
```

1. **Registry Storage**: Rules are uploaded via the IC Performance Dashboard (`POST /api/v1/wasm-rules`) and persisted in the `wasm_rule_bundles` database table.
2. **Real-time Sync**: The control plane broadcasts updates via Valkey Pub/Sub to active connected proxies, which load the updated module dynamically.
<!-- ENTERPRISE_ONLY_END -->

---

## 3. Host-Guest Interception Interface

When an LLM or tool request is intercepted, the Rust proxy executes the rule using a guest-host contract:

### A. Context Serialization
The Rust host normalizes the intercepted request context (tool calls, arguments, tokens, user role, etc.) and serializes it into a JSON string format:
```json
{
  "workspaceId": "wk_abc",
  "model": "claude-3-5-haiku",
  "toolName": "bash",
  "toolArgs": { "command": "rm -rf /" },
  "userRole": "developer",
  "tokenCount": 1200
}
```

### B. Memory Allocation & Injection
Because WASM sandboxes have isolated linear memory, the host must inject the context:
1. The host calls the exported WASM function `__allocate(len)` to allocate buffer memory within the guest instance.
2. The host writes the serialized JSON string directly to that allocated offset in the guest's memory.

### C. Execution
The host calls the guest's main evaluation entrypoint:
```typescript
export function evaluate(requestContextJson: ArrayBuffer): i32
```

### D. Host Logging
Guest rules can write log entries back to the host console using the imported host function `log_info(msg_ptr, len)`. These logs are piped directly into the Rust proxy's structured `tracing::info!` output.

---

## 4. Gating Verdicts

The guest function returns an integer verdict that dictates how the proxy gates the request:

| Value | Verdict | Action Taken |
|:---:|---|---|
| **`0`** | `ALLOW` | The request is marked clean and continues down the pipeline. |
| **`1`** | `BLOCK` | The request is rejected immediately. The proxy short-circuits the connection and returns a block response: `{ "error": "Blocked by WASM rule policy" }`. |
| **`2`** | `REDACT` | The proxy filters/strips out matching sensitive parameters or credentials before forwarding the payload to the provider. |

*Note: If multiple rules are active, the runner evaluates all instances sequentially and returns the **most restrictive** verdict.*
