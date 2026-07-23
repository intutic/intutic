# Intutic vs Portkey

Portkey is an AI gateway built for LLM observability, caching, and routing. It logs requests, tracks costs, and provides dashboards for monitoring model performance. **Intutic is a synchronous enforcement layer that blocks bad actions before they happen.**

## The Core Difference

Portkey **observes** LLM traffic after the fact. Intutic **intercepts** tool calls in real time and decides whether to allow, modify, or block them — in under 50ms.

If your AI agent tries to `rm -rf /`, Portkey will log it. Intutic will kill it.

## Comparison

| Capability | Intutic | Portkey |
|-----------|---------|---------|
| **Enforcement model** | Synchronous — blocks before execution | Async — logs after execution |
| **Latency overhead** | <50ms per tool call | N/A (post-hoc) |
| **Circuit breaker actions** | BYPASS / ENHANCE / HIJACK / KILL | Not available |
| **Custom policy rules** | WASM sandbox — run your own rules | JSON config guardrails |
| **Model routing** | Thompson Sampling bandit (cost + quality) | Round-robin, fallback chains |
| **Harness coverage** | 18 AI coding agents (Claude Code, Cursor, Antigravity, etc.) | SDK-based integration |
| **Config sync** | Bidirectional daemon — SOPs sync to agents, configs sync to cloud | One-way SDK push |
| **Data residency** | Local-first — proxy runs on your machine | Cloud-hosted gateway |
| **DLP / threat detection** | Secrets redaction, SQL injection, prompt injection | Basic content filtering |
| **FinOps & Budgets** | CFO Ledger & GL cost allocations, seat reclamation | Cost tracking and budget caps |
| **Audit trail** | Full tool-call-level audit with enforcement decisions | Request-level logging |
| **Prompt Management** | Prompt Library with versioning snapshots & Myers LCS diffs | Basic prompt registry |
| **Semantic Cache & Recall** | Valkey-backed Custom Caching | Basic semantic caching |
| **Agent Sandboxing** | Docker/V8 Process Isolation & Sandbox Guardrails | Not available |

## Integration Comparison

### Portkey (SDK Integration)
Portkey requires importing their proprietary SDK and wrapping your LLM client calls. This couples your application logic to Portkey's libraries.

```javascript
import { Portkey } from 'portkey-ai';

// Initialize the Portkey client
const portkey = new Portkey({
  apiKey: "YOUR_PORTKEY_API_KEY",
  virtualKey: "YOUR_PROVIDER_VIRTUAL_KEY"
});

// Execute wrapped chat completion
const response = await portkey.chat.completions.create({
  messages: [{ role: 'user', content: 'Scan repository files' }],
  model: 'gpt-4o'
});
```

### Intutic (Local Proxy Integration)
Intutic requires **zero code changes** or vendor SDK imports. Your agent logic remains standard. You simply point your standard OpenAI/Anthropic client to the locally running Intutic proxy gateway (`localhost:4000`).

```javascript
import OpenAI from 'openai';

// Connect to standard client pointing to local Intutic proxy
const openai = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "http://127.0.0.1:4000/v1" // Point to Intutic proxy
});

// Standard completion call, automatically governed and audited
const response = await openai.chat.completions.create({
  messages: [{ role: 'user', content: 'Scan repository files' }],
  model: 'gpt-4o'
});
```

## When to Choose Intutic

- You need to **prevent** bad actions, not just log them
- Your agents write files, run commands, and mutate databases
- You want policy enforcement that runs **locally** without sending data to a third-party cloud
- You need coverage across **18 AI coding harnesses** out of the box
- You want to write **custom WASM rules** for domain-specific enforcement

## When to Choose Portkey

- You only need request-level observability and caching for LLM API calls
- Your use case is pure LLM API routing without tool-call interception
- You don't need synchronous enforcement

## Summary

Portkey is an LLM gateway. Intutic is an AI agent firewall. They solve different problems at different layers. If your AI agents interact with infrastructure — files, databases, APIs, git — Intutic is the enforcement layer you need.

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
