# Custom Filters (WASM Rules) <Badge type="tip" text="Open-Core" />

Write custom validation rules that run at wire speed in the Intutic proxy using WebAssembly.

## What Are Custom Filters?

Custom Filters let you write policy rules in AssemblyScript (a TypeScript subset), compile them to WebAssembly, and run them inside the Intutic proxy on every request. They execute in a sandboxed environment with strict resource limits.

::: info Availability
Custom Filters require the `feature.wasm_rules` capability and are accessible to **Owner**, **Admin**, and **EM** roles.
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
| **Memory** | 1 MB | Prevents excessive memory consumption |
| **CPU Fuel** | 1,000,000 units | Prevents infinite loops and excessive computation |
| **Timeout** | 5 ms per request | Maintains low proxy latency |

If a filter exceeds any limit, it's immediately terminated and **fails open** — the request proceeds to maintain availability.

::: tip Memory-Safety Protocol
To prevent memory corruption and guest engine crashes under multi-turn garbage collection within Wasmtime, the host-to-guest interface passes context payloads as raw binary guest buffers (`Uint8Array`) rather than standard guest string pointers. This ensures maximum execution stability and zero runtime garbage collection overhead.
:::


---

## Creating a Custom Filter

### 1. Initialize with the SDK

Intutic provides an AssemblyScript Rules SDK (`@intutic/wasm-sdk`) that provides standard types and parsing helpers.

```typescript
import { JSON } from "assemblyscript-json/assembly";

// Standard request context structure
export class RequestContext {
  session_id: string = "";
  workspace_id: string = "";
  virtual_key_prefix: string = "";
  model: string = "";
  tools: ToolSchema[] = [];
  tool_calls: ToolCall[] = [];
  estimated_input_tokens: i32 = 0;
  budget_remaining_usd: f64 = 0.0;
  risk_tier: string = "";
  dlp_findings: DlpFinding[] = [];
}
```

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
  // 1. Read JSON bytes from heap
  let jsonStr = "";
  for (let i = 0; i < len; i++) {
    jsonStr += String.fromCharCode(load<u8>(offset + i));
  }

  // 2. Parse request context
  const jsonObj = <JSON.Obj>JSON.parse(jsonStr);
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

1. The compiled WASM binary is stored in the database
2. The proxy receives a notification via pub/sub
3. A new WebAssembly module is instantiated on the fly
4. The filter is immediately active on the request path

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

