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

## Where the proxy looks for SOPs

Writing rules into harness config files is only half of enforcement. The other half — the
detectors that block a denied tool, hold a run for review, or flag work drifting outside a
declared plan — reads SOPs directly, and it reads them from disk.

By default the proxy walks **up from its own working directory** looking for `.intutic/sops`.
That is exactly right for the deployment Intutic is built around: the proxy runs on your
machine, beside the workspace whose rules it is enforcing, so the SOPs it should apply are the
ones sitting in the repository you are working in.

::: warning A proxy that does not run beside a workspace finds no SOPs at all
Run the same binary in a container, or as a shared gateway, and the walk starts somewhere like
`/home/intutic` and finds nothing. There is no error, because "this workspace has no SOPs" is
a legitimate state. Every SOP-derived control then resolves to nothing:

| Front matter | What stops working |
| :--- | :--- |
| `deny_tools:` | denied tools are no longer blocked |
| `allow_harnesses:` | a role may use any harness |
| `plan_steps:` | drift outside the declared plan is no longer flagged |
| `scope_paths:` | out-of-scope file access is no longer flagged |
| `review_before:` | runs are never held for review |
| `requires_before:` | your ordering rules stop applying — the built-in floor still does |
| `forbid_after:` | as above |
| `max_calls:` | call ceilings stop applying, and there is no built-in floor |
| `forbid_with:` | taint co-occurrence stops being refused |

SOP prompt injection is a no-op as well, so the agent is never told the rules either.

**Set `INTUTIC_SOPS_DIR`** to an absolute path holding your `.md` SOP files. It takes
precedence over the walk. In Kubernetes that means mounting the SOPs as a volume and pointing
the variable at the mount path.
:::

The proxy does not leave you to discover this from behaviour. When it starts and resolves an
empty SOP set, it logs a **warning** naming each control that is consequently inactive, the
directory it looked for, the working directory it searched from, and the variable that fixes
it. If you are unsure whether policy reached a deployment, that line at startup is the answer
— and its absence means SOPs were found.

### The two deployment modes, and which one you are in

| | Local proxy (what the product ships) | Containerised proxy |
| :--- | :--- | :--- |
| Installed by | `intutic connect` — a native per-developer binary | your own manifests |
| Agents reach it at | `http://localhost:4000` | wherever you route them |
| Finds SOPs by | walking up from the workspace it was started in | `INTUTIC_SOPS_DIR` only |
| If you do nothing | your repo's `.intutic/sops` is enforced | **nothing is enforced** |

The walk has no answer in a container: cwd is `/home/intutic`, no ancestor holds
`.intutic/sops`, and an absent directory is indistinguishable from an empty one. Policy has
to be handed to a containerised proxy explicitly.

::: info What the bundled Kubernetes manifests do — and do not — do
`infra/kubernetes/base/proxy` now delivers policy: a `proxy-sops` ConfigMap generated from
`base/proxy/sops/*.md`, mounted read-only at `/etc/intutic-sops`, with `INTUTIC_SOPS_DIR`
pointing at that path. It is a `configMapGenerator`, so its name carries a content hash and
editing a SOP rolls the pod — an in-place `kubectl apply` of a plain ConfigMap would leave
the running proxy on the old policy. Add your own SOPs by listing each `.md` file in
`base/proxy/kustomization.yaml`; `files:` takes paths, not directories, so a file dropped
into `sops/` is not picked up until you name it.

**That pod still has no callers.** The proxy is a `ClusterIP` service with no ingress, and no
workload in the cluster sets `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GEMINI_API_ENDPOINT`
to its address — so it enforces the mounted policy for nobody. Delivering SOPs and giving
the service a caller are separate pieces of work, and only the first is done. Giving it a
caller means either deploying a workload configured to route through it, or deciding what a
hosted multi-tenant gateway would look like — who may call it, and whose SOPs it enforces.
Neither question is answered by this repository today.
:::

<!-- ENTERPRISE_ONLY_START -->
## SOP Hook Scripts — withdrawn

This page previously documented **Hook SOPs**: JavaScript policy scripts said to run
"inside the control plane's secure V8 isolate sandboxes", in a "fully air-gapped sandbox".
That section has been withdrawn and the implementation deleted. It is recorded here rather
than quietly removed, because the feature was described to readers as shipped and safe.

What the implementation actually was:

- **Not a V8 isolate.** It used Node's built-in `vm` module. `isolated-vm` was never a
  dependency of this repository. Node's own documentation states that `vm` is not a security
  mechanism and must not be used to run untrusted code.
- **Not air-gapped.** The sandbox context received the control plane's own `Object`, `Array`,
  `RegExp`, `Map` and `Set`. A script could reach `Object.prototype` through them and mutate
  the host process. The `Object.freeze` calls covered only the injected `intutic` and
  `console` shims, not the intrinsics passed alongside them.
- **Fail-open on every error**, including the CPU timeout — a script that ran too long was
  allowed, not blocked. The documented limits were real, but their consequence was not.
- **The documented API did not match the code.** The example above read `intutic.toolName`;
  the executor exposed `intutic.context.toolName`. The example as printed would have thrown.

There was also no way to create one. The `sop_type` and `hook_phase` columns exist, but no
route, UI or front-matter key could set them — only an unlisted seed script, `PRE_TOOL` only.
So no hook script has ever run against a real tool call.

If programmatic policy is wanted, use [WASM rules](./wasm-rules.md), which execute in a real
sandbox with an explicit host-import allowlist. The deleted executor remains in git history
should anyone want to redo it properly, with a genuine isolate and a fail-closed timeout.
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
* **Privacy Preservation**: If a personal prose rule is violated, the anomaly is flagged in the developer's console output to offer steering guidance. `deny_tools:` front matter in the same files is enforced harder: a call to a denied tool is blocked outright (403, `UNAUTHORIZED_TOOL`), and `allow_harnesses:` restricts which harnesses a role may use, but **no incident is logged in the remote organization database/dashboard**. `plan_steps:` is advisory rather than blocking — it declares the steps the SOP's task should consist of, and work drifting outside them raises a `SCOPE_VIOLATION` that steers. See [Graph guardrails](/guide/graph-guardrails#did-it-stay-inside-the-plan).
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
- **Google Docs** — Sync the Google Docs in one Drive folder, read-only. Created by workspace owners and admins only, with a service-account key file (share the folder with the service account's email) or a short-lived access token. Google Drive is cloud-only and is unavailable in offline mode.
- **Upload** — A one-off Markdown, plain-text or HTML document (up to 1 MB) with no connector behind it, from Policy Guardrails → Sources. The same file twice is one document; an edited copy re-binds the citations that still hold.

### Configuring Connectors

1. Open **Policy Guardrails → Sources** in the dashboard.
2. Select your provider (**Notion**, **Confluence**, **GitHub** or **Google Docs**).
3. Provide the integration token, PAT or service-account key, and specify the page, path or folder to sync.
4. Once created, the sync runner compiles external pages to Intutic's structural format (`SSL`) and auto-versions drafts in your SOP registry.

An SOP that a live guardrail cites is never written back to its source: the product does not overwrite a passage it stands on. Google Docs sources are read-only regardless.
<!-- ENTERPRISE_ONLY_END -->

## Related

- [SOP Format Reference](/reference/sop-format) — detailed field-by-field specification
- [How It Works](/guide/how-it-works) — architecture of the SOP registry and sync daemon
- [Review Queue](/guide/decisions) — approve or reject enforcement decisions that SOPs trigger
