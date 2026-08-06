# Standard Operating Procedures (SOPs)

Standard Operating Procedures (SOPs) form the core policy layer of Intutic. They define corporate compliance rules, architectural guidelines, security policies, and cost caps that govern autonomous AI coding agents at runtime.

---

## SOP Data Model Schema

Every SOP is stored in the database registry and projects the following data structure:

```typescript
interface SopRegistryEntry {
  sopId: string;               // Unique ID prefixed with 'sop_'
  workspaceId: string;         // Owning workspace reference
  title: string;               // Human-readable title
  version: string;             // SemVer string (default: 1.0.0)
  markdownContent: string;     // The natural language rule body
  contentHash: string;         // SHA-256 integrity hash of content
  riskTier: 'LOW' | 'MEDIUM' | 'HIGH';
  complexityTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
  isActive: boolean;           // Active status toggle
  lifecycleState: 'DRAFT' | 'UNDER_REVIEW' | 'ACTIVE' | 'ARCHIVED';
  // `sopType` and `hookPhase` are vestigial: the columns exist, nothing sets
  // them, and the executor they fed has been removed (see "SOP Formats" below).
  sopType: 'standard' | 'hook';
  hookPhase?: 'PRE_TOOL' | 'POST_TOOL' | 'PRE_RESPONSE' | 'POST_RESPONSE';
}
```

---

## SOP Formats

Intutic supports two distinct formats of SOPs depending on whether the rule is meant for
human-in-the-loop validation or in-process local interception:

### Comparison: Local Harness Rules vs. LLM-as-a-Judge

| Feature | Local Harness Rules (`CLAUDE.md` / WASM) | LLM-as-a-Judge (LLMProbe) |
| :--- | :--- | :--- |
| **Execution Timing** | **Pre-flight (Before execution)** | **Post-flight / Async (During/After execution)** |
| **Latency** | **<5 milliseconds** (Instant) | **2–5 seconds** (LLM inference delay) |
| **Purpose** | **Hard Prevention**: Instantly blocks `rm -rf`, `DROP TABLE`, force pushes, and redacts API keys before destruction occurs. | **Semantic Audit**: Evaluates whether the agent followed complex, subjective guidelines (e.g. *"Did the refactored code maintain proper architectural layering?"*). |

*Without local harness rules, an agent would execute destructive commands before an LLM judge even finishes thinking!*

### 1. Standard SOPs
Standard SOPs are authored in natural language markdown. They represent corporate policies (e.g., "Do not use deprecated cryptographic functions") and are used by:
- **LLMProbe:** Running LLM-as-a-judge checks against prompt inputs and outputs.

### 2. WASM Rules
For programmatic enforcement, rules compile to WebAssembly and run in the proxy with an
explicit host-import allowlist. See [WASM Rules](/guide/wasm-rules).

This section previously described a third format, **Hook SOPs** — JavaScript executed "inside
Node's sandboxed V8 execution context" — along with a phase model, an `intutic.verdict()` API
and a list of sandbox guarantees. That feature has been removed. It ran in Node's `vm` module,
which is not a security boundary; it received the host's own intrinsics, so a script could
reach `Object.prototype`; it failed open on every error including the documented CPU timeout;
and no route, UI or front-matter key could ever create one, so no hook script ever ran against
a real tool call. WASM rules are the supported answer.

---

## Lifecycle Transitions

SOP lifecycle states are tracked sequentially in the database. Every state change creates an audit record:

```
[ DRAFT ] ──> [ UNDER_REVIEW ] ──> [ ACTIVE ] ──> [ ARCHIVED ]
```

Each change projects metadata detailing the creator user, review tickets, and the migration hashes proving policy integrity.

---

## SOP Examples Library

Below are copy-pasteable examples of Standard Markdown SOPs covering common security and
operational guardrails. For the programmatic equivalents — blocking `rm -rf`, force pushes and
unqualified `DELETE` — see the [starter rule library](/guide/wasm-rules), which ships rules
that are tested in both directions rather than examples that were never executable.

### 1. Secret & Credential Redaction (Markdown SOP)

Save as `CLAUDE.md`, `.cursorrules`, or `.windsurfrules`:

```markdown
# SOP: Secrets DLP & Credential Protection

## Rules
1. AI agents must never output raw API keys, tokens, or private credentials (e.g., `API_KEY`, `AWS_SECRET_ACCESS_KEY`, `POSTGRES_PASSWORD`).
2. Do not read configuration files containing raw credentials (e.g., `.env`, `.env.production`, `~/.ssh/id_rsa`).
3. If credentials are identified in prompt context or tool outputs, mask them with `[REDACTED_SECRET]` before processing.
```

### 2. Code Quality & Steering Rule (Markdown SOP)

```markdown
# SOP: Code Quality & Safety Wrappers

## Rules
1. **Dynamic Execution Sanitization**: Any dynamic code execution (`eval()` or `exec()`) must be wrapped in `remedy.sanitize()`.
2. **Strict Type Safety**: All TypeScript code must pass strict typechecks without using `any`.
3. **API Domain Allowlist**: Outbound network requests are restricted to internal microservices and approved third-party APIs.
```
