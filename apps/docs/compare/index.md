# How Intutic Compares

Eight detailed, capability-by-capability comparisons, against three kinds of product: LLM observability/tracing platforms that log after the fact, AI governance/GRC platforms that increasingly ship runtime enforcement too, and enterprise AI-security gateways that scan or proxy model traffic. Read the page for whichever you're evaluating against — this one is the map, not the argument.

## The one-line version

**Most of what's on this page watches, scores, or scans. Intutic is the thing in the path of the tool call, deciding allow/block/hold before the action happens — synchronously, not after a log line shows up in a dashboard.**

That's true of the LLM-observability tools (LangSmith, W&B Weave, Arize AX) by design — they were built to trace and evaluate, not to intervene. It's less true than it used to be of the GRC and AI-security-gateway categories: Credo AI shipped runtime enforcement (Agent Governor) in July 2026, and Forge is the closest thing to a direct competitor we've found. Where a competitor has closed a gap, the individual comparison page says so plainly rather than pretending the old distinction still holds.

## Capability matrix

| | Intutic | Observability<br>(LangSmith, Weave, Arize AX) | GRC / Governance<br>(Credo AI) | AI Security Gateway<br>(Forge, F5 Calypso, Fiddler) |
|---|---|---|---|---|
| **When it acts** | Synchronous, in the tool-call path | After the fact (trace/log) | Runtime enforcement (Credo AI, since Jul 2026) | Synchronous, at the network/inference layer |
| **What it sees** | The actual tool call — filesystem writes, shell commands, MCP invocations | Model input/output, spans | Policy state, some runtime hooks | Prompt/response payloads |
| **Coding-agent harnesses** | 39 out-of-the-box, harness-native adapters | Generic SDK tracing | Not the focus | Network interception, 1-2 named harnesses |
| **SIEM/export** | 6 native destinations (Splunk, Syslog/CEF, Datadog, S3, GCS, webhook) with retry/DLQ | Varies | Not found in public docs | Forge: Splunk + S3 + SOAR webhooks |
| **Audit trail** | Merkle-sealed trace roots, browser-verifiable | Trace logs | Policy version history | Forge: SHA-256 hash-chain ledger |
| **Prove-before-enforce** | Replay any rule against real traffic before it's live; SOP shadow mode with a measured would-act rate | Not applicable | Not found in public docs | Not found in public docs |
| **Policy source** | Git-committed markdown (`.intutic/sops/*.md`), PR-reviewable, ConfigMap-deliverable | N/A | Dashboard-managed policy objects | Vendor-defined rule packs + custom rules |
| **Source you can read** | Open-core — the block/allow decision is code in this repo | Closed | Closed | Closed |
| **On-prem / air-gapped** | Documented deployment guides | Cloud-hosted | Enterprise tier | Varies; several undocumented as of this writing |
| **Pricing** | Open core, transparent | Usage-based, published | Enterprise sales | Sales-quote only (Forge) |

## The auditability point, stated plainly

Every closed-source governance product on this page asks you to trust that its policy engine does what its docs say. Intutic is open-core: `packages/proxy` — the code that reads a tool call and returns BYPASS/ENHANCE/HIJACK/KILL — is public. You can read the exact logic that decided your last blocked action, not a vendor's description of it. In the current AI-governance market, the only other products making a comparable open-source claim at the enforcement layer are Daxa and Pebblo — everything else in this matrix, including every product with its own comparison page below, ships a closed engine.

That doesn't make Intutic more *complete* than a mature closed platform — several of the pages below name specific areas where a competitor is ahead today, and say so directly. It makes Intutic *verifiable* in a way a closed product structurally cannot be, at any price tier.

## Detailed comparisons

| Product | Category | One-line take |
|---|---|---|
| [Portkey](/compare/portkey) | AI gateway | Observability, caching, routing — not a synchronous enforcement layer |
| [Credo AI](/compare/credo-ai) | GRC / governance | Now ships runtime enforcement (Agent Governor); the gap is maturity and breadth, not capability category |
| [Arize AX](/compare/arize-ax) | Observability | Tracing, evals, dashboards — after-the-fact, not in-path |
| [Forge](/compare/forge) | AI-agent governance | The closest direct competitor — broad connector-based enforcement vs. Intutic's purpose-built in-path proxy |
| [F5 Calypso](/compare/f5-calypso) | AI security gateway | Scans/redacts at the inference layer; Intutic intercepts inside the agent loop at the OS/tool-call level |
| [LangSmith](/compare/langsmith) | Developer tracing | Post-hoc debugging tool, not a policy-enforcement layer |
| [Fiddler AI](/compare/fiddler) | Model monitoring | Text-level guardrails (toxicity, PII, hallucination) vs. actual tool-execution governance |
| [W&B Weave](/compare/wandb-weave) | Developer tracing | Trace/log/eval tool; no opt-in egress containment or runtime sandbox isolation |

---

<div style="text-align: center; margin-top: 2rem;">

[Get Started with Intutic →](/guide/getting-started)

</div>
