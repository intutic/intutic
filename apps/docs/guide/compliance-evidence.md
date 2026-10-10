# Compliance Evidence <Badge type="tip" text="Cloud" />

Probe history and auditor-ready SOC 2 evidence exports, built directly on the compliance probes — so the evidence you hand an auditor can never disagree with the dashboard. The same evidence is mapped to the EU AI Act, ISO/IEC 42001, the NIST AI RMF and MITRE ATLAS; see [Framework Mapping](/guide/framework-mapping).

---

## The probes

Every compliance number in Intutic starts with the same eleven probes (see [Security & Identity](/guide/security) for the surrounding model). Each runs against live workspace state, hourly and on demand, and reports a 0–100 score with structured findings:

| Probe | What it checks |
|---|---|
| `policy_check` | Workspace policy completeness (budget, residency, allowed models) |
| `mfa_enforcement` | Reports `not_enforced` — MFA is not tracked in the schema, so this control cannot be attested; member-hygiene counts ride along as context |
| `data_residency` | Residency violations in the last 30 days — `not_enforced` when region locking itself is off |
| `audit_log_integrity` | Re-derives sealed Merkle roots from the live trace rows and walks the root chain; a failure raises a [notification](/concepts/trace-integrity#alerts) |
| `token_rotation` | API keys unused for 90+ days |
| `sop_coverage` | Count of active SOPs |
| `auto_apply_provenance` | Every ON auto-apply flag attributable to a human actor |
| `sop_git_drift` | File-plane vs DB-plane SOP drift, as last reported by `intutic sops status` |
| `guard_liveness` | Whether the proxy's scheduled guard probes still fire, as last reported through the sync daemon |
| `guardrail_authority` | Every enforcing policy guardrail was promoted by a named member |
| `provider_availability` | Open model-provider incidents affecting the workspace — `not_enforced` when none has been recorded |

A probe whose control is switched off reports `not_enforced`, never `pass`: a control that has not run has not passed, and every surface described below inherits that doctrine.

## Probe history

Probe results accumulate; the dashboard shows the latest per type, and the history endpoint shows everything behind it:

```
GET /api/v1/compliance/probes/history?from=<ISO>&to=<ISO>&probeType=<type>&limit=<n>&offset=<n>
```

Any authenticated workspace member can read it (it is the same data the probes panel already shows, extended backwards in time). `from`/`to` default to the trailing 90 days, `limit` defaults to 500 (max 1000), and the response carries `total` alongside `rows` so a truncated page is distinguishable from a complete one.

Each history row covers a run of identical results rather than a single run. When a probe reports exactly what it reported last time, the stored result is extended instead of repeated: `observedSince` is the first run that produced it, `probedAt` the most recent, and `observations` how many runs it covers. A row ends at midnight UTC, and after a gap of more than two hours with no run, so every probe has at least one row per day and an outage shows as a gap between rows. A row falls in the `from`/`to` window when its first run does.

Probe history is kept for 400 days: a twelve-month audit period, plus a month to collect its evidence. Older rows are deleted by a daily retention sweep.

## Evidence runs

An evidence run maps a **fresh probe run** onto the five SOC 2 trust categories — security, availability, processing integrity, confidentiality, privacy — and seals the result into a downloadable archive:

- `POST /api/v1/compliance/soc2-collect` (OWNER/ADMIN) — collect a run for a period (`periodStart`/`periodEnd` ISO strings, default trailing 90 days). The period can start at most 400 days back, the probe history's retention; an earlier `periodStart` is refused with a 400 rather than producing an archive with a short history digest. Also runs automatically once a day on the Enterprise and Self-host plans. The response says whether the archive is signed: `signed: true` with the `signingKeyId`, or `signed: false` with an `unsignedReason` naming what to configure.
- `GET /api/v1/compliance/soc2-status` (any member) — latest probe results rolled up by trust category.
- `GET /api/v1/compliance/soc2-export/:runId` (OWNER/ADMIN) — download the stored archive as JSON. The `X-Intutic-Export-Signed` header is `true` or `false`.

From the CLI, `intutic compliance collect --out evidence.json` collects a run and writes its archive, and `intutic compliance download <run_id>` fetches a stored one (see the [CLI reference](/reference/cli#intutic-compliance-collect)).

Collecting a run on request (API, CLI or dashboard) and downloading one are each recorded with who did it ([Who downloaded what](/guide/framework-mapping#who-downloaded-what)); the daily collection, which no one downloads, is not.

The **Active Compliance Probes** panel on **Policies › Compliance Scope** has a **Collect & export evidence** button that does the collect-then-download in one step, then says whether the downloaded archive is signed and, if it is not, what to configure. When `SOC2_EVIDENCE_BUCKET` is configured on the control plane, each archive is also uploaded to that GCS bucket and the run records its `artifactUrl`.

### What's in the archive

- Per-category probe results (the same `ProbeResult` objects the dashboard shows), with the category score as the **mean of its mapped probes' scores**
- Per-category row counts from the underlying governance tables, grouped by enum columns — incidents by severity, enforcement decisions by verdict, break-glass requests by status, active SOPs, active API keys, residency violations, sessions
- Capped id samples: the first 100 ids per table, so an auditor can request specific records
- A digest of the probe-result history for the period: per probe, how many runs, the first and last, and how many runs reported each status. Runs are counted by the history rows that start inside the period, so a period that ends before the collection can also count runs from the rest of its last day
- Coverage of the EU AI Act, ISO/IEC 42001, NIST AI RMF and MITRE ATLAS, computed from the same probe run, as JSON and as a readable report (archives with `formatVersion` 2), and as CSV and PDF (`formatVersion` 3; see [Framework Mapping](/guide/framework-mapping#in-the-evidence-pack))
- A sha256 manifest and, when signing is configured, a detached Ed25519 signature

### What's deliberately NOT in it

No free-text row content — no incident descriptions, no enforcement reasons, no tool arguments. Timestamps, enums, counts and ids only. The archive is designed to leave the building; the rows it points at are not.

## Verifying an archive

Every archive is self-verifying:

1. **Recompute the hash.** Remove the `manifest` and `signature` fields from the archive, serialize the remainder as *canonical JSON* (object keys sorted recursively, arrays in order), and take the sha256. It must equal `manifest.archiveSha256` (and the `archive_sha256` on the run). Per-category hashes in `manifest.sections` are the canonical JSON of each category object, and `framework:<id>` the canonical JSON of each framework entry. `framework:<id>:csv` and `framework:<id>:pdf` are the sha256 of the export files themselves: the CSV's UTF-8 bytes and the PDF decoded from base64.
2. **Verify the signature** (when present). The signed preimage is the two-line string `intutic-soc2-evidence-v1\n<archiveSha256>`. Verify the Ed25519 signature in `signature.value` (base64) against the public key whose `kid` matches `signature.keyId` in the JWKS published at `/.well-known/intutic-trace-signing.json` — the same key set that signs trace Merkle roots.

`intutic compliance verify <file>` runs both steps with nothing but the archive and the published keys (`--jwks <file>` for a saved copy, so it needs no network). It exits 0 only when the hashes match and the signature verifies, 1 when either does not match, 2 when the hashes match but the archive is unsigned or its key could not be found, and 3 when the file cannot be read or is not an archive; see the [CLI reference](/reference/cli#intutic-compliance-verify).

**Archives are signed only when the control plane has a signing key.** A run with `signature: null` was collected on a deployment without `TRACE_SIGNING_PRIVATE_KEY` (an Ed25519 private key, PEM). That is a supported state, and every surface says so: the collect response, the download header, the dashboard and, from `formatVersion` 3, the archive's own manifest (`manifest.signed: false`, with `manifest.unsignedReason`). Setting the key signs archives collected from then on; it does not sign earlier ones. The same holds for the human-oversight export and the SLA evidence archive.

## Limits

- **Availability is scored only from provider incidents.** The availability category takes its score from `provider_availability`. When no provider incident touched the workspace in the window, that probe reports `not_enforced` and the category exports `score: null` with a named gap. Session and incident counts ride along as context — they are not a control, and inventing a number for an unevidenced category is exactly what this export refuses to do.
- **Consent evidence is not collected.** Consent tracking was removed from the product; the privacy category records `consentEvidence: not_collected` rather than silently narrowing its claim.
- **The export is as fresh as its probes.** An evidence run triggers a fresh probe run at collection time, and its claims are dated by `collectedAt` — it attests to that moment, not to continuous operation across the period. The probe history digest is what covers the period in between.

## Human-oversight evidence

Plan approvals, rejections and closures, plan deviations and review-hold decisions are exported by `GET /api/v1/compliance/human-oversight-export`, signed when the deployment has a signing key — the evidence for EU AI Act Article 14 human oversight. See [Framework Mapping](/guide/framework-mapping#human-oversight-export-eu-ai-act-article-14).
