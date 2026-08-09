# Intutic vs Portkey

Portkey is an AI gateway built for LLM observability, caching, and routing. It logs requests, tracks costs, and provides dashboards for monitoring model performance. **Intutic is a synchronous enforcement layer that blocks bad actions before they happen.**

## The Core Difference

Portkey **observes** LLM traffic after the fact. Intutic **intercepts** tool calls in real time and decides whether to allow, modify, or block them — before the request leaves the machine.

If your AI agent tries to `rm -rf /`, Portkey will log it. Intutic will kill it.

## Comparison

| Capability | Intutic | Portkey |
|-----------|---------|---------|
| **Enforcement model** | Synchronous — blocks before execution | Async — logs after execution |
| **Latency overhead** | Measured per payload size in `packages/proxy/benches`; not a single published figure | N/A (post-hoc) |
| **Circuit breaker actions** | BYPASS / ENHANCE / HIJACK / KILL | Not available |
| **Custom policy rules** | WASM sandbox — run your own rules | JSON config guardrails |
| **Model routing** | Thompson Sampling bandit (cost + quality) | Round-robin, fallback chains |
| **Harness coverage** | 19 AI coding agents (Claude Code, Cursor, Antigravity, etc.) | SDK-based integration |
| **Config sync** | Bidirectional daemon — SOPs sync to agents, configs sync to cloud | One-way SDK push |
| **Data residency** | Local-first — proxy runs on your machine | Cloud-hosted gateway |
| **DLP / threat detection** | Secrets redaction, SQL injection, prompt injection | Basic content filtering |
| **FinOps & Budgets** | Local daily spend ceilings, pre-execution cost estimation blocks over-budget requests | Cost tracking and budget caps |
| **Audit trail** | Full tool-call-level audit with enforcement decisions | Request-level logging |
| **Semantic Cache & Recall** | Valkey-backed Custom Caching | Basic semantic caching |
| **Agent Sandboxing** | wasmtime WASM sandbox — 16 MB memory, 1,000,000 fuel, 5ms timeout | Not available |

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
- You need coverage across **19 AI coding harnesses** out of the box
- You want to write **custom WASM rules** for domain-specific enforcement

## Measured false-positive rate

Enforcement that fires on benign work gets switched off, so the number that matters
is how often it does.

**2 of 1,000 benign trajectories (0.2%)** trip a detector, plus **0 of 339** benign
prompts carrying injection trigger words.

The corpora are external and were not chosen by us: [BFCL v3
multi-turn](https://gorilla.cs.berkeley.edu/leaderboard.html) (Apache-2.0) and
[NotInject](https://huggingface.co/datasets/leolee99/NotInject) (MIT), vendored with
checksums rather than fetched at test time. The assertion pins the two firing
trajectories **by name**, not by count — a count still passes when one seed stops
firing and another starts. It runs unpiped, so the gate cannot go green on a
swallowed failure, and it runs on every push through the versioned `pre-push` hook
rather than only in CI. Source: `packages/proxy/tests/anomaly_corpus_test.rs`.

Three limits, because a rate without them is marketing:

- **It is a lower bound.** BFCL is API-orchestration traffic filtered to successful
  completion — short (median 6 calls) and clean. Every sequence detector's exposure
  grows with trajectory length, and agentic coding runs are far longer.
- **It covers 7 of 25 detectors.** Six against the two corpora above, plus one
  measured against 10,753 real tool and parameter descriptions. The other eighteen
  read fields no public corpus supplies — graph depth, workflow budget, DLP findings —
  or fire only on an operator declaration and so have no false-positive rate to
  measure at all. The split is generated from the registry at test time into
  `packages/proxy/tests/corpus/BASELINE.txt`, and a gate fails this page if the two
  disagree.
- **It says nothing about recall.** Nothing in the corpus records a missed catch, so
  recall is unmeasurable from this data in principle, not merely unmeasured.

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
