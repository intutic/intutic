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
  markdownContent: string;     // The natural language rule or V8 script body
  contentHash: string;         // SHA-256 integrity hash of content
  riskTier: 'LOW' | 'MEDIUM' | 'HIGH';
  complexityTier: 'TIER_1' | 'TIER_2' | 'TIER_3';
  isActive: boolean;           // Active status toggle
  lifecycleState: 'DRAFT' | 'UNDER_REVIEW' | 'ACTIVE' | 'ARCHIVED';
  sopType: 'standard' | 'hook'; // Standard markdown rule vs. executable hook script
  hookPhase?: 'PRE_TOOL' | 'POST_TOOL' | 'PRE_RESPONSE' | 'POST_RESPONSE';
}
```

---

## SOP Formats

Intutic supports two distinct formats of SOPs depending on whether the rule is meant for human-in-the-loop validation, sub-5ms local interception, or machine-enforceable runtime scripting:

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

### 2. Hook SOPs
Hook SOPs contain JavaScript code blocks executed dynamically inside Node's sandboxed V8 execution context during active agent operations.

---

## V8 Isolate Script execution

For hook-type SOPs, scripts are executed synchronously at designated pipeline phases.

### Phase Triggers
- `PRE_TOOL`: Fires before a tool call is executed.
- `POST_TOOL`: Fires immediately after a tool completes execution.
- `PRE_RESPONSE`: Fires before sending request payloads to the model.
- `POST_RESPONSE`: Fires immediately after receiving model completions.

### Injected Context (`intutic.context`)
Every script runs in a isolated context where it has read-only access to runtime metadata via the global `intutic.context` object:

```typescript
interface HookContext {
  sessionId: string;
  workspaceId: string;
  toolName?: string;
  toolArguments?: string;
  model?: string;
  responseContent?: string;
  estimatedCostUsd?: number;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}
```

### Setting the Verdict (`intutic.verdict`)
To enforce rules, the script must synchronously call `intutic.verdict()` with the policy outcome:

```javascript
// Example: Block unauthorized git pushes
if (intutic.context.toolName === 'run_command') {
  const args = intutic.context.toolArguments || '';
  if (args.includes('git push') && args.includes('--force')) {
    intutic.verdict({
      action: 'block',
      reason: 'Force push to git repositories is strictly prohibited by security policy.'
    });
  }
}
```

#### Verdict Options:
* `allow`: No action taken. Proceed with the run.
* `block`: Terminate the operation and return the specified `reason`.
* `modify`: Alter the request or output payload. Requires providing `modifiedContent`.
* `warn`: Complete the run but record a policy warning in the audit logs.

### Sandbox Security Constraints
To ensure isolation and performance safety:
- **No System Access:** No access to `require()`, `process`, `fs` (filesystem), or the network.
- **Execution Limits:** Strict CPU timeout limit of **100ms** per execution run.
- **Size Limits:** Maximum script size capped at **64KB**.
- **Namespace whitelist:** Access is restricted to standard JavaScript APIs (`console.log`, `Math`, `JSON`, `Date`, etc.).

---

## Lifecycle Transitions

SOP lifecycle states are tracked sequentially in the database. Every state change creates an audit record:

```
[ DRAFT ] ──> [ UNDER_REVIEW ] ──> [ ACTIVE ] ──> [ ARCHIVED ]
```

Each change projects metadata detailing the creator user, review tickets, and the migration hashes proving policy integrity.

---

## SOP Examples Library

Below are copy-pasteable examples of Standard Markdown SOPs and V8 Hook SOPs covering common security and operational guardrails:

### 1. Secret & Credential Redaction (Markdown SOP)

Save as `CLAUDE.md`, `.cursorrules`, or `.windsurfrules`:

```markdown
# SOP: Secrets DLP & Credential Protection

## Rules
1. AI agents must never output raw API keys, tokens, or private credentials (e.g., `API_KEY`, `AWS_SECRET_ACCESS_KEY`, `POSTGRES_PASSWORD`).
2. Do not read configuration files containing raw credentials (e.g., `.env`, `.env.production`, `~/.ssh/id_rsa`).
3. If credentials are identified in prompt context or tool outputs, mask them with `[REDACTED_SECRET]` before processing.
```

### 2. Destructive Command & Git Guardrails (V8 Hook SOP)

Executable JavaScript hook configured for phase `PRE_TOOL`:

```javascript
// Hook Phase: PRE_TOOL
// Purpose: Intercept destructive shell commands and force-pushes
if (intutic.context.toolName === 'run_command') {
  const command = (intutic.context.toolArguments || '').toLowerCase();

  // Block recursive file deletion
  if (command.includes('rm -rf') || command.includes('rm -r /')) {
    intutic.verdict({
      action: 'block',
      reason: 'Recursive file deletion (rm -rf) is prohibited by workspace SOP.'
    });
  }

  // Block git force push
  if (command.includes('git push') && (command.includes('--force') || command.includes('-f'))) {
    intutic.verdict({
      action: 'block',
      reason: 'Force-pushing git branches is strictly prohibited.'
    });
  }
}
```

### 3. Production Database Protection (V8 Hook SOP)

Executable JavaScript hook configured for phase `PRE_TOOL`:

```javascript
// Hook Phase: PRE_TOOL
// Purpose: Block destructive SQL operations on production connections
if (intutic.context.toolName === 'execute_sql' || intutic.context.toolName === 'run_query') {
  const query = (intutic.context.toolArguments || '').toUpperCase();

  if (query.includes('DROP TABLE') || query.includes('TRUNCATE') || (query.includes('DELETE FROM') && !query.includes('WHERE'))) {
    intutic.verdict({
      action: 'block',
      reason: 'Destructive SQL queries without a WHERE clause are blocked by database safety SOP.'
    });
  }
}
```

### 4. Code Quality & Steering Rule (Markdown SOP)

```markdown
# SOP: Code Quality & Safety Wrappers

## Rules
1. **Dynamic Execution Sanitization**: Any dynamic code execution (`eval()` or `exec()`) must be wrapped in `remedy.sanitize()`.
2. **Strict Type Safety**: All TypeScript code must pass strict typechecks without using `any`.
3. **API Domain Allowlist**: Outbound network requests are restricted to internal microservices and approved third-party APIs.
```
