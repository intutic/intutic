---
name: intutic-rule-author
description: Convert natural-language business rules into compiled WASM governance policies enforced by the local Intutic proxy — author, compile, dry-run, and install rules without a control plane.
---

# 📜 Rule Author — Business Rules as Enforced WASM Policies

Use this skill whenever the user states a rule that AI agent traffic must obey — "block any agent call that touches the prod database", "kill requests once the session budget drops below $1", "never allow shell tool calls containing rm -rf". You convert the rule into an AssemblyScript policy, compile it to WebAssembly, dry-run it against mock contexts, and install it into the local Intutic proxy. The proxy hot-loads it within ~5 seconds and enforces it on every intercepted LLM request.

## 1. The contract your rule sees

The proxy calls `evaluate(offset, len)` with a JSON-serialized `RequestContext`:

```jsonc
{
  "session_id": "sess_x", "workspace_id": "wk_x", "virtual_key_prefix": "vk_x",
  "model": "claude-3-5-sonnet",
  "tools": [{ "name": "bash", "description": "run shell commands" }],
  "tool_calls": [{ "id": "t1", "name": "bash", "arguments": {} }],
  "estimated_input_tokens": 1200,
  "budget_remaining_usd": 4.25,
  "risk_tier": "Low",
  "dlp_findings": [{ "category": "secret", "pattern_name": "aws_key", "action": "block", "offset": 0, "length": 20 }],
  "tool_sequence": ["read_file", "bash"]
}
```

`risk_tier` is one of `Low | Medium | High | Critical`. Return an `i32` verdict: `0` = ALLOW, `1` = BLOCK, `2` = REDACT (treated as block).

## 2. Author

Start from the `@intutic/wasm-sdk` template (`packages/wasm-sdk/` in the open-core repo). Add one function per business rule and call it from `runRules()` in `assembly/index.ts`.

Sandbox constraints — violating them silently disables the rule (the proxy **fails open**):

- 5 ms wall-clock budget, 1,000,000 fuel, 16 MB memory.
- Keep logic simple: no unbounded loops over `arguments`, no recursion, no I/O (none exists in the sandbox).
- Host imports are limited to `env.log_info`, `env.trace`, `env.abort`, `env.seed`, and the `onnx_rules.runOnnxInference` stub.

## 3. Compile

```bash
intutic policy compile --src assembly/index.ts --out build/rule.wasm
```

Requires AssemblyScript in the project: `pnpm add -D assemblyscript assemblyscript-json`.

## 4. Dry-run — required before install

Author BOTH mock contexts and verify both outcomes before installing:

```bash
intutic policy test --wasm build/rule.wasm --mock should-block.json
intutic policy test --wasm build/rule.wasm --mock should-allow.json
```

The first must report BLOCK, the second ALLOW. A rule that blocks everything is as broken as one that blocks nothing.

## 5. Install

```bash
intutic policy install --wasm build/rule.wasm --name block-prod-db --priority 50
intutic policy list-local
```

Rules install to `~/.intutic/wasm/` as `NN_name.wasm` (lower `NN` runs first; default 100). The proxy picks up changes within ~5 s on the next request — no restart needed.

## 6. Guardrails

- **Never embed secrets** (API keys, tokens, passwords) in rule sources or mock contexts — `intutic skill audit` flags them.
- **Local rules cannot weaken central rules.** Verdicts merge most-restrictive-wins: a KILL from any rule — local or centrally synced — ends the request. "Allow-override" rules are no-ops by design; do not author them.
- Keep rule sources (`assembly/*.ts`, mock JSON files) in version control alongside the workspace.
