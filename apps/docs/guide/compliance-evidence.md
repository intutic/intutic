# Compliance Evidence <Badge type="danger" text="Enterprise" />

Probe history and auditor-ready SOC 2 evidence exports, built directly on the compliance probes — so the evidence you hand an auditor can never disagree with the dashboard.

---

## The eight probes

Every compliance number in Intutic starts with the same eight probes (see [Security & Identity](/guide/security) for the surrounding model). Each runs against live workspace state, hourly and on demand, and reports a 0–100 score with structured findings:

| Probe | What it checks |
|---|---|
| `policy_check` | Workspace policy completeness (budget, residency, allowed models) |
| `mfa_enforcement` | Reports `not_enforced` — MFA is not tracked in the schema, so this control cannot be attested; member-hygiene counts ride along as context |
| `data_residency` | Residency violations in the last 30 days — `not_enforced` when region locking itself is off |
| `audit_log_integrity` | Re-derives sealed Merkle roots from the live trace rows and walks the root chain |
| `token_rotation` | API keys unused for 90+ days |
| `sop_coverage` | Count of active SOPs |
| `auto_apply_provenance` | Every ON auto-apply flag attributable to a human actor |
| `sop_git_drift` | File-plane vs DB-plane SOP drift, as last reported by `intutic sops status` |

A probe whose control is switched off reports `not_enforced`, never `pass`: a control that has not run has not passed, and every surface described below inherits that doctrine.

## Probe history

Probe results accumulate; the dashboard shows the latest per type, and the history endpoint shows everything behind it:

```
GET /api/v1/compliance/probes/history?from=<ISO>&to=<ISO>&probeType=<type>&limit=<n>&offset=<n>
```

Any authenticated workspace member can read it (it is the same data the probes panel already shows, extended backwards in time). `from`/`to` default to the trailing 90 days, `limit` defaults to 500 (max 1000), and the response carries `total` alongside `rows` so a truncated page is distinguishable from a complete one.

## Evidence runs

An evidence run maps a **fresh probe run** onto the five SOC 2 trust categories — security, availability, processing integrity, confidentiality, privacy — and seals the result into a downloadable archive:

- `POST /api/v1/compliance/soc2-collect` (OWNER/ADMIN) — collect a run for a period (`periodStart`/`periodEnd` ISO strings, default trailing 90 days). Also runs automatically once a day for enterprise workspaces.
- `GET /api/v1/compliance/soc2-status` (any member) — latest probe results rolled up by trust category.
- `GET /api/v1/compliance/soc2-export/:runId` (OWNER/ADMIN) — download the stored archive as JSON.

The dashboard's Compliance Probes panel has a **Collect & export evidence** button that does the collect-then-download in one step. When `SOC2_EVIDENCE_BUCKET` is configured on the control plane, each archive is also uploaded to that GCS bucket and the run records its `artifactUrl`.

### What's in the archive

- Per-category probe results (the same `ProbeResult` objects the dashboard shows), with the category score as the **mean of its mapped probes' scores**
- Per-category row counts from the underlying governance tables, grouped by enum columns — incidents by severity, enforcement decisions by verdict, break-glass requests by status, active SOPs, active API keys, residency violations, sessions
- Capped id samples: the first 100 ids per table, so an auditor can request specific records
- A digest of the probe-result history for the period (row counts, first/last timestamps, status tallies per probe)
- A sha256 manifest and, when signing is configured, a detached Ed25519 signature

### What's deliberately NOT in it

No free-text row content — no incident descriptions, no enforcement reasons, no tool arguments. Timestamps, enums, counts and ids only. The archive is designed to leave the building; the rows it points at are not.

## Verifying an archive

Every archive is self-verifying:

1. **Recompute the hash.** Remove the `manifest` and `signature` fields from the archive, serialize the remainder as *canonical JSON* (object keys sorted recursively, arrays in order), and take the sha256. It must equal `manifest.archiveSha256` (and the `archive_sha256` on the run). Per-category hashes in `manifest.sections` are the canonical JSON of each category object.
2. **Verify the signature** (when present). The signed preimage is the two-line string `intutic-soc2-evidence-v1\n<archiveSha256>`. Verify the Ed25519 signature in `signature.value` (base64) against the public key whose `kid` matches `signature.keyId` in the JWKS published at `/.well-known/intutic-trace-signing.json` — the same key set that signs trace Merkle roots.

A run with `signature: null` was collected on a deployment without `TRACE_SIGNING_PRIVATE_KEY` configured. That is a supported state, reported honestly rather than papered over.

## Honest limits

- **Availability is unscored.** No probe governs uptime, so the availability category exports `score: null` with a named gap. Session and incident counts ride along as context — they are not a control, and inventing a number for an ungoverned category is exactly what this export refuses to do.
- **Consent evidence is not collected.** Consent tracking was removed from the product; the privacy category records `consentEvidence: not_collected` rather than silently narrowing its claim.
- **The export is as fresh as its probes.** An evidence run triggers a fresh probe run at collection time, and its claims are dated by `collectedAt` — it attests to that moment, not to continuous operation across the period. The probe history digest is what covers the period in between.
