---
title: Framework Mapping
description: How Intutic's compliance probes, records and controls map to the EU AI Act, ISO/IEC 42001, the NIST AI RMF and MITRE ATLAS, with live coverage, Markdown, CSV and PDF reports, copies in the evidence pack, and an Article 14 human-oversight export.
---

# Framework Mapping <Badge type="tip" text="Cloud" />

Intutic maps the evidence it already produces to three AI governance frameworks, the **EU AI Act**, **ISO/IEC 42001** and the **NIST AI RMF**, and to **MITRE ATLAS**, the catalog of adversary techniques against AI systems and the mitigations for them. The [compliance probes](/guide/compliance-evidence) are one kind of evidence; the others are records you can export (traces, incidents, plan and hold decisions) and controls the product enforces (the pre-execution gate, plan approval, trace retention).

The mapping supports an assessment; it is not a certification. A control is mapped only where Intutic's evidence bears on it, and most mappings are **partial**: each one states what its evidence does not reach.

---

## What a mapping says

Each mapped control lists:

- **Evidence** — a compliance probe, a record with the endpoint that serves it, or a product control with the source file that implements it, and one sentence on what that evidence shows.
- **Not covered** — the part of the control the evidence does not reach. A mapping with anything here is partial.

Controls with no mapped evidence stay in the catalog, so a coverage report shows what is not evidenced as plainly as what is. The mapping carries a version, stamped into every report; it changes only with a product release.

| Framework | Catalog | Mapped |
|---|---|---|
| EU AI Act, Regulation (EU) 2024/1689 | 27 paragraphs of Articles 9, 12, 13, 14, 15, 19 and 26 that apply to providers and deployers of agentic systems | 14, all partial |
| ISO/IEC 42001:2023 | All 38 Annex A controls | 7, all partial |
| NIST AI RMF 1.0 (NIST AI 100-1) | All 72 subcategories | 13, all partial |
| MITRE ATLAS, release 2026.09 | All 40 mitigations, each with the techniques ATLAS says it mitigates | 14, all partial |

The EU AI Act catalog leaves out paragraphs specific to biometric identification and to other sectors. Article 13 is in the catalog and unmapped: its obligations fall on the provider's instructions for use, which Intutic does not write.

ATLAS is mapped by **mitigation** (`AML.M…`), not by technique: a mitigation is something a control does, and each one carries the techniques (`AML.T…`) ATLAS says it mitigates, so a technique's coverage reads from the mitigations that name it. The catalog is generated from MITRE's published ATLAS data, release 2026.09 of 15 September 2026. Mitigations aimed at training data, model files, predictive models or an organization's public footprint are unmapped: Intutic sits between agents, their tools and the model providers, and sees none of those.

## Coverage state

For a workspace, each mapped control also has a **state**, read from the newest result of each probe behind it:

| State | Meaning |
|---|---|
| Evidenced | Every probe behind the control passes |
| Warning | A probe reports a warning, and none fails |
| Failing | A probe behind the control fails |
| Not evidenced | A probe behind the control has not run, could not run, or reports `not_enforced` |
| Records to review | No probe scores the control; its evidence is records and controls to review |

A control is never reported as evidenced on records alone: a record shows there is something to review, not that a check passed.

## Getting coverage

- **Dashboard** — **Policies › Compliance Scope** has a **Framework Coverage** panel under the compliance probes. Pick a framework to see its mapped controls with state, evidence and what each does not cover, and download it with **Download report** (Markdown), **Download CSV** or **Download PDF**.
- **API** — `GET /api/v1/compliance/frameworks/:frameworkId/coverage`, where `frameworkId` is `eu_ai_act`, `iso_42001`, `nist_ai_rmf` or `mitre_atlas`. Any workspace member can read it. `?format=` picks the form: `json` (the default), `markdown`, `csv` or `pdf`; any other value is refused with `400`.

These live reports are never signed, and each download says so with `X-Intutic-Export-Signed: false`. The copies sealed in the evidence pack are the ones that are signed, when the deployment has a signing key.

### Export formats

Every format carries the same content: each control's coverage and state, its evidence and what that evidence shows, what it does not cover, and the mapping version and generation time. For ATLAS, each mitigation also lists the techniques it mitigates.

- **Markdown** — the readable report: summary counts, then each mapped control with an evidence table and its gaps, then the ids of the unmapped controls.
- **CSV** — one row per catalog control, unmapped ones included, with the columns Framework, Control, Title, Coverage, State, Evidence, What it shows, Not covered, Techniques mitigated, Mapping version and Generated. A control's evidence entries are one per line inside the cell (kind, title and the route, source file or probe id, plus a probe's state), with **What it shows** in the same order. Quoting follows RFC 4180, and a cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` so a spreadsheet reads it as text rather than a formula.
- **PDF** — for print: a title page naming the workspace, framework, mapping version and generation time; the summary counts; each mapped control with its evidence; the gaps; and the unmapped controls with their titles. It is set in the standard PDF fonts, so rendering fetches nothing and works air-gapped, and the same coverage always renders the same bytes.

### In the evidence pack

Every [evidence archive](/guide/compliance-evidence#evidence-runs) carries the coverage of all four frameworks, computed from the archive's own fresh probe run, as JSON, as the readable report, and (from `formatVersion` 3) as the CSV and the PDF, base64-encoded. Each framework has its own section hash in the archive manifest, `framework:<id>`, and the archive signature covers it when the deployment has a signing key (`TRACE_SIGNING_PRIVATE_KEY`). When it has none, the archive is unsigned and its manifest says so: `signed` is `false` and `unsignedReason` names the key to set. The CSV and PDF are also hashed as files, under `framework:<id>:csv` and `framework:<id>:pdf`: decode the PDF from base64, save either one, and its `sha256sum` matches the manifest. Like the rest of the archive, the sealed PDF identifies the workspace by its id, not its name.

- **Daily collection** <Badge type="danger" text="Enterprise" /> — an archive is collected automatically once a day on the Enterprise and Self-host plans.
- **On demand** — an owner or admin can collect one at any time with **Collect & export evidence**.

## Human-oversight export (EU AI Act Article 14)

`GET /api/v1/compliance/human-oversight-export?from=<ISO>&to=<ISO>` (OWNER/ADMIN; the window defaults to the trailing 90 days) returns a record of the people deciding what agents may do, signed when the deployment has a signing key (`TRACE_SIGNING_PRIVATE_KEY`); the `X-Intutic-Export-Signed` response header says `true` or `false`:

- **Plan events** — each plan captured, approved, rejected or closed in the window, with the member who acted, the time, the rationale they wrote and, for a closure, the outcome; and each deviation the gates recorded while the plan's session ran.
- **Review-hold decisions** — each tool call held before it ran by a require-approval rule, with the rule, the tool, the member who approved or rejected it and when. A hold still waiting for review is listed as pending.

Not in it: plan step contents, tool arguments, request context and decision summaries. Each section reports how many rows matched and how many it includes (at most 5,000), so a truncated export is distinguishable from a complete one. The **Export oversight record** button on the Framework Coverage panel downloads the trailing 90 days.

The export follows the evidence pack's verification rule (see [Verifying an archive](/guide/compliance-evidence#verifying-an-archive)) under its own signing domain: the signed preimage is `intutic-human-oversight-v1\n<archiveSha256>`. A signature over a human-oversight export can never be presented as a signature over an evidence pack, or the other way round.

### Plan deviations

A plan's steps that name a tool (`tool` or `toolName`) are tracked against the session's tool calls as the gates report them, in the order the gates decided them:

| Deviation | Recorded when |
|---|---|
| `STEP_SKIP` | A later planned step runs while an earlier one has not |
| `STEP_REORDER` | A skipped step runs after all, out of order |
| `EXTRA_STEP` | A tool the plan never names runs, or is attempted and blocked |

Repeating a planned tool after its steps have run is not a deviation. Steps that name no tool cannot be observed and are never reported as skipped. The first tool call observed after approval moves the plan to `EXECUTING`; a session that runs before its plan is approved leaves the plan pending, so a reviewer can still decide it, and its deviations are recorded either way. Deviations lower the plan's adherence score, which the `WORKFLOW_GOAL_DRIFT` anomaly reads (see [Core Concepts](/guide/concepts)).

## The mappings

### EU AI Act

| Control | Evidence | Not covered |
|---|---|---|
| Art. 9(2)(d) | Pre-execution tool-call gate; `sop_coverage` probe; `guardrail_authority` probe | Identifying and evaluating the risks (points (a) to (c)) is not something Intutic performs; it enforces the measures you adopt. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 12(1) | Execution traces; Pre-execution tool-call gate; `audit_log_integrity` probe | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 12(2)(a) | Governance incidents; Anomaly detection | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. Recording a substantial modification of the AI system is a provider obligation that Intutic does not evidence. |
| Art. 12(2)(c) | Execution traces; Compliance probe history; `guard_liveness` probe | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 14(1) | Plan approval lifecycle; Review holds; Human-oversight export | Oversight covers agent plans and held tool calls. Designing the underlying model for oversight is its provider’s obligation. Plans are captured only where a harness or integration submits them. |
| Art. 14(4)(a) | Anomaly detection; Governance incidents; Human-oversight export; `guard_liveness` probe | Understanding the capacities and limitations of the model is not evidenced. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 14(4)(d) | Plan approval lifecycle; Review holds; Human-oversight export | Applies to plans submitted for approval and tool calls matching a hold rule, not to every model output. |
| Art. 14(4)(e) | Loop-run stop; Pre-execution tool-call gate | The stop control applies to loop runs. Sessions outside a loop run are stopped call by call through blocking rules, not by a single control. |
| Art. 15(4) | `guard_liveness` probe; `provider_availability` probe | The accuracy and robustness of the model itself are not measured. |
| Art. 15(5) | DLP and prompt-injection scanning; MCP server pinning; `token_rotation` probe | Data and model poisoning during training are outside what Intutic sees. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 19(1) | Three-year trace retention; `audit_log_integrity` probe | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| Art. 26(2) | Role-based authority; `guardrail_authority` probe; `auto_apply_provenance` probe | The competence and training of the people assigned oversight are not evidenced. |
| Art. 26(5) | Compliance probe history; Governance incidents; Incident notifications | Informing providers and market surveillance authorities, and suspending use, are the deployer’s process. |
| Art. 26(6) | Three-year trace retention; `audit_log_integrity` probe | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |

### ISO/IEC 42001

| Control | Evidence | Not covered |
|---|---|---|
| A.3.2 | Role-based authority; `guardrail_authority` probe | Defining and allocating AI roles across the organization is broader than the roles Intutic enforces. |
| A.6.2.6 | Compliance probe history; `guard_liveness` probe; `provider_availability` probe; Governance incidents | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. The organizational process (who reviews, how often, and what they do with the result) is yours to define and document. |
| A.6.2.8 | Execution traces; Trace integrity roots; `audit_log_integrity` probe | Deciding at which lifecycle phases event logging is enabled is the organization’s documented decision. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| A.8.4 | Incident notifications; SIEM export | Communicating incidents to users and external parties is the organization’s plan to define. |
| A.9.2 | `sop_coverage` probe; `sop_git_drift` probe; Pre-execution tool-call gate | The organizational process (who reviews, how often, and what they do with the result) is yours to define and document. |
| A.9.4 | Plan approval lifecycle; Human-oversight export; Pre-execution tool-call gate | Documenting the intended use of each AI system is the organization’s responsibility. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| A.10.3 | `policy_check` probe; `provider_availability` probe | Assessing suppliers against the organization’s responsible-AI approach is not evidenced. |

### NIST AI RMF

| Control | Evidence | Not covered |
|---|---|---|
| GOVERN 1.4 | `sop_coverage` probe; `sop_git_drift` probe; Pre-execution tool-call gate | Setting risk priorities is the organization’s process. |
| GOVERN 1.5 | Compliance probe history; Evidence pack | Planning the periodic review and assigning who performs it is the organization’s process. |
| GOVERN 1.6 | Agent registry | The inventory covers agents connected to Intutic, not every AI system in the organization. |
| GOVERN 3.2 | Role-based authority; `auto_apply_provenance` probe; `guardrail_authority` probe | Writing the policies that define human-AI roles is the organization’s process. |
| GOVERN 4.3 | Governance incidents; SIEM export | AI testing practices are not evidenced. |
| MAP 3.5 | Plan approval lifecycle; Review holds; Human-oversight export | Defining and assessing the oversight process against GOVERN policies is the organization’s process. |
| MEASURE 2.4 | Execution traces; Anomaly detection; `guard_liveness` probe | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| MEASURE 2.7 | DLP and prompt-injection scanning; `token_rotation` probe; `audit_log_integrity` probe; Agent registry | Security evaluation of the model itself is not evidenced. |
| MEASURE 3.1 | Compliance probe history; Governance incidents | The organizational process (who reviews, how often, and what they do with the result) is yours to define and document. |
| MANAGE 2.4 | Loop-run stop; Pre-execution tool-call gate; Plan approval lifecycle | Assigning responsibility to disengage a system is the organization’s process. |
| MANAGE 3.1 | `provider_availability` probe; Provider incidents; `policy_check` probe | Third-party risks other than model availability and model choice are not evidenced. |
| MANAGE 4.1 | Compliance probe history; Review holds; Review-hold decisions; Governance incidents | Capturing input from users, decommissioning and change management are not evidenced. |
| MANAGE 4.3 | Governance incidents; Incident notifications | Communicating incidents to affected communities is the organization’s process. |

### MITRE ATLAS

| Mitigation | Evidence | Not covered |
|---|---|---|
| AML.M0014 Verify AI Artifacts | MCP server pinning | Only MCP tool definitions are verified. Model files, datasets and packages are not checksummed by Intutic. |
| AML.M0019 Control Access to AI Models and Data in Production | Virtual keys; `policy_check` probe; `token_rotation` probe; Execution traces | Covers access to provider models through Intutic’s proxy. Models the organization serves itself, and their extraction through an inference API (AML.T0024), are outside what Intutic controls. |
| AML.M0020 Generative AI Guardrails | DLP and prompt-injection scanning; Pre-execution tool-call gate; Review holds; `guard_liveness` probe | Injection and jailbreak detection matches known phrasings; reworded attacks get past it. Harmful-content, groundedness and hallucination checks are not performed. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0024 AI Telemetry Logging | Execution traces; Pre-execution tool-call gate; Trace integrity roots; `audit_log_integrity` probe; SIEM export | Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0026 Privileged AI Agent Permissions Configuration | Pre-execution tool-call gate; MCP server registry; Role-based authority | The credentials and resource permissions an agent holds are configured outside Intutic; Intutic decides whether each tool call may run. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0027 Single-User AI Agent Permissions Configuration | SSO-group tool clearance; Pre-execution tool-call gate | Delegating the user’s own access to the agent, and the agent’s identity lifecycle and decommissioning, are not evidenced. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0028 AI Agent Tools Permissions Configuration | MCP server registry; Pre-execution tool-call gate | Intutic decides whether a tool may be called. The identity and permissions a tool runs with are configured in the tool or its MCP server. |
| AML.M0029 Human In-the-Loop for AI Agent Actions | Review holds; Plan approval lifecycle; Review-hold decisions; Human-oversight export | Approval applies to tool calls matching a hold rule and to plans submitted for approval. Which actions need approval is the organization’s policy to write. |
| AML.M0030 Restrict AI Agent Tool Invocation on Untrusted Data | DLP and prompt-injection scanning; Review holds | Tool invocation is not restricted because untrusted content has entered the context; holds apply to the tools a rule names. Injection detection matches known phrasings; reworded attacks get past it. |
| AML.M0032 Segmentation of AI Agent Components | Agent sandbox | Applies to agents started in the sandbox; agents run directly on a host are not segmented. Separating agents’ identities, credentials and state from one another is not evidenced. |
| AML.M0033 Input and Output Validation for AI Agent Components | DLP and prompt-injection scanning; MCP server pinning | Schema and format validation of tool inputs and outputs is not performed. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0036 Limit AI Workload Resource Consumption | Spend caps; Loop-run stop; Anomaly detection | Bounds on input size, output tokens, execution time, memory and compute are not evidenced. |
| AML.M0037 AI Agent Authority Expansion Controls | Pre-execution tool-call gate; MCP server registry; Review holds | Limits on the number, scope and lifetime of the credentials and tokens an agent holds are not evidenced. Covers what passes through Intutic’s gates and proxy: model requests, tool calls and their decisions. It does not instrument the model itself or traffic that bypasses the proxy. |
| AML.M0038 AI Agent Scope Drift Detection | Plan approval lifecycle; Anomaly detection; Human-oversight export | Drift is measured only against a plan submitted for approval, from the tools its steps name. It raises an anomaly and a corrective prompt; it does not pause or stop the agent. |

The techniques each mitigation mitigates are listed in every report and export.

## Related

- [Compliance Evidence](/guide/compliance-evidence) — the probes, probe history and the evidence pack
- [Evidence and Authority Provenance](/concepts/evidence-and-authority-provenance) — the plan approval lifecycle
- [Trace Integrity](/concepts/trace-integrity) — how the trace record is sealed and verified
