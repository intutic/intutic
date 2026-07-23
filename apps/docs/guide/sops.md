# Agent Guidelines (SOPs) <Badge type="warning" text="Cloud / Team" />

SOPs (Standard Operating Procedures) are the governance rules that define what your AI agents can and cannot do. They are the core of Intutic's policy enforcement.

## What you'll learn

- How to create and manage SOPs from the dashboard
- The 7-state lifecycle and when to use each state
- Risk tiers, dependencies, and health metrics
- How SOPs sync to your harnesses automatically

## Why SOPs matter

Without governance rules, AI agents operate on their own judgment. SOPs give you explicit control:

- **Prevent data leaks** — block agents from accessing production databases
- **Enforce coding standards** — require agents to follow your team's conventions
- **Control costs** — restrict agents to specific models for specific tasks
- **Maintain security** — prevent unauthorized tool calls or file access

::: tip SOPs are living documents
SOPs aren't set-and-forget. They evolve as you learn how your agents behave. Intutic supports a full lifecycle from drafting through validation and eventual retirement.
:::

## Creating an SOP

From the dashboard, navigate to the **SOPs** page and click **New SOP**. You'll fill in:

| Field | Description |
|-------|-------------|
| **Title** | Short, descriptive name (e.g., "No production DB access") |
| **Content** | Markdown body — the actual policy rules |
| **Risk tier** | `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL` |
| **Complexity** | Task complexity level this SOP targets |
| **Dependencies** | Other SOPs this one requires (optional) |

The new SOP starts in `DRAFT` state.

### Writing effective content

SOP content is standard Markdown. Be specific and actionable:

```markdown
## Database Access Rules

- **NEVER** connect to production databases directly
- Use read-only replicas for data queries
- All database migrations must go through the migration pipeline
- Log every database query with a reason
```

::: warning Be precise
Vague rules like "be careful with data" don't give agents clear boundaries. Write rules that are unambiguous and verifiable.
:::

## The SOP lifecycle

SOPs follow a 7-state lifecycle. Only `VALIDATED` SOPs are actively enforced.

```
DRAFT → PENDING_REVIEW → GENERATED → HYPOTHESIZED → REFINED → VALIDATED
                                                                    ↓
                                                              INVALIDATED
```

| State | When to use | Who can transition |
|-------|-------------|-------------------|
| **DRAFT** | You're still writing the SOP | Any role |
| **PENDING_REVIEW** | Ready for team review before activation | DEVELOPER+ |
| **GENERATED** | Auto-created by the system from observed patterns | System |
| **HYPOTHESIZED** | Proposed rule being tested against live traffic | ADMIN+ |
| **REFINED** | Updated based on testing feedback and data | ADMIN+ |
| **VALIDATED** | Approved and actively enforced | ADMIN, OWNER |
| **INVALIDATED** | Retired, superseded, or found to be incorrect | ADMIN, OWNER |

::: info Auto-generated SOPs
Intutic can auto-generate SOPs from agent behavior patterns. These start in `GENERATED` state and move to `HYPOTHESIZED` for testing before you validate them.
:::

## Risk tiers

Every SOP has a risk tier that indicates the severity of violating it:

| Tier | Meaning | Example |
|------|---------|---------|
| **LOW** | Style or convention preference | "Use camelCase for variable names" |
| **MEDIUM** | Best practice that could cause bugs | "Always handle errors in async functions" |
| **HIGH** | Security or reliability concern | "Never commit API keys to source control" |
| **CRITICAL** | Could cause data loss or security breach | "Never execute DELETE queries on production" |

Risk tiers affect enforcement behavior:
- `LOW` violations may only generate warnings
- `CRITICAL` violations trigger an immediate `KILL` action and open a governance incident

## Dependencies and cascade invalidation

SOPs can depend on other SOPs. For example, a "No production writes" SOP might depend on a "Database access policy" SOP.

When a parent SOP is invalidated:
1. All dependent SOPs are **cascade-invalidated** automatically
2. Affected team members are notified
3. The dependency graph on the dashboard updates to show broken chains

::: warning Cascade effects
Invalidating a foundational SOP can cascade across many rules. Check the dependency graph before invalidating to understand the impact.
:::

## SOP health metrics

The dashboard tracks health metrics for each validated SOP:

| Metric | What it measures |
|--------|-----------------|
| **Hit rate** | How often this SOP is evaluated against incoming requests |
| **Violation rate** | Percentage of evaluations that resulted in a violation |
| **False positive rate** | How often the SOP flagged compliant requests incorrectly |
| **Last triggered** | Timestamp of the most recent evaluation |

Low hit rates may indicate an SOP that's too narrow or no longer relevant. High false positive rates suggest the SOP needs refinement.

## How SOPs sync to harnesses

You don't need to manually copy SOP rules into each agent's config. The **sync daemon** (`intutic connect`) handles this automatically:

1. The daemon polls the control plane every 30 seconds (configurable)
2. It pulls the latest `VALIDATED` SOPs for your workspace
3. It writes governance rules into each detected harness's native config file
4. It uses atomic writes (write to temp file, then rename) to prevent corruption

This means changes you make in the dashboard propagate to all connected harnesses within the next sync cycle.

<!-- ENTERPRISE_ONLY_START -->
## SOP Hook Scripts (Enterprise)

For programmatic policy control, Intutic supports **Hook SOPs** written in Javascript. They run inside the control plane's secure V8 isolate sandboxes.

* **Phases**: Rules run during `PRE_TOOL`, `POST_TOOL`, `PRE_RESPONSE`, or `POST_RESPONSE`.
* **APIs**: The sandboxed script has access to a global `intutic` object containing context properties:
  - `intutic.toolName` — Name of the tool called (e.g. `execute_command`)
  - `intutic.toolArguments` — Stringified or structured arguments passed to the tool
  - `intutic.verdict({ action: 'block' | 'allow', reason: '...' })` — Emits enforcement verdict
* **Security & Constraints**:
  - Max script size: `64 KB`
  - Max CPU execution time: `100 ms`
  - Fully air-gapped sandbox: No `require`, `process`, `fs`, or network capabilities. Standard `JSON`, `Math`, `Date`, and `console.log` are permitted.

```javascript
// Example: Block destructive SQL operations inside database tools
if (intutic.toolName === 'execute_db_query' && 
    (intutic.toolArguments.toLowerCase().includes('drop table') || 
     intutic.toolArguments.toLowerCase().includes('truncate'))) {
  intutic.verdict({
    action: 'block',
    reason: 'Destructive database operations are blocked by corporate security policy'
  });
} else {
  intutic.verdict({ action: 'allow' });
}
```
<!-- ENTERPRISE_ONLY_END -->

## SOP Pointer References

When the sync daemon writes markdown rules into harness configuration files, it automatically appends invisible traceability comments:

```markdown
<!-- sop://intutic/sop_clt456 | Block unauthorized tools -->
```

These metadata comments permit the control plane to map active config lines directly to the registered SOP IDs in the database, enabling precise governance coverage tracking.

## Personal Local-Only SOPs & Session Scoping

In addition to organization-wide policies synced from the centralized control plane dashboard, Intutic allows developers to define **personal, local-only SOPs** scoped specifically to your local session workspace:

* **File Location**: Organize your personal rules inside subdirectories of `.intutic/sops/` (e.g., `.intutic/sops/security-dlp/rules.md` or `.intutic/sops/postgres-migration/migration.md`).
* **Initialization & Scoping**: When you run `@intutic initialize`, the control plane lists both open board tickets and detected local rules folders as numbered choices.
* **Activating SOPs**: Start the session scoping to a subset of local SOPs using option indices or names with the `--sops` flag (e.g., `@intutic start 1 --sops=3` or `@intutic start --sops=security-dlp`).
* **Execution**: During the scoped session, the local daemon merges only the selected active local rules with corporate policies before writing them to harness files (`CLAUDE.md`, `.cursorrules`, etc.) and evaluating pre-flight prompts. If no options are specified, all detected local SOP folders are active by default.
* **Privacy Preservation**: If a personal rule is violated, the anomaly is flagged in the developer's console output to offer steering guidance, but **no incident is logged in the remote organization database/dashboard**.
* **Sharing & Version Control**: Since these rules are standard text files, you can check them into Git version control to share with specific teammates or add the `.intutic/sops/` folder to `.gitignore` to keep them strictly private to your machine.

## Change classification

When you update a validated SOP, Intutic classifies the change for the audit trail:

| Classification | Meaning |
|----------------|---------|
| **STRENGTHEN** | Making the rule stricter (e.g., blocking more actions) |
| **CLARIFY** | Improving wording without changing scope |
| **NARROW** | Reducing the scope of what the rule covers |
| **WEAKEN** | Making the rule more permissive |

`WEAKEN` changes require OWNER or ADMIN approval and are flagged in the audit log.

## Best practices

1. **Start with CRITICAL rules** — begin with your most important security and data-protection policies
2. **Use dependencies** — build a hierarchy of rules rather than one monolithic SOP
3. **Review GENERATED SOPs** — the system learns from agent behavior, but always validate auto-generated rules before enforcing them
4. **Monitor health metrics** — retire SOPs with zero hit rates and refine those with high false positive rates
5. **Version thoughtfully** — use change classification to communicate the intent of each update

<!-- ENTERPRISE_ONLY_START -->
## External SOP Sync (Enterprise)

Instead of manually entering and updating SOPs on the dashboard, you can connect external document repositories to sync guidelines automatically:

- **Notion** — Sync Notion databases or specific page block trees.
- **Confluence** — Sync Space wikis and page hierarchies.
- **GitHub** — Sync markdown files from code repositories.

### Configuring Connectors

1. Navigate to **Settings → Connectors** in the dashboard.
2. Select your provider (**Notion**, **Confluence**, or **GitHub**).
3. Provide the integration token or PAT, and specify the page/path to sync.
4. Once created, the sync runner compiles external pages to Intutic's structural format (`SSL`) and auto-versions drafts in your SOP registry.
<!-- ENTERPRISE_ONLY_END -->

## Related

- [SOP Format Reference](/reference/sop-format) — detailed field-by-field specification
- [How It Works](/guide/how-it-works) — architecture of the SOP registry and sync daemon
- [Review Queue](/guide/decisions) — approve or reject enforcement decisions that SOPs trigger
