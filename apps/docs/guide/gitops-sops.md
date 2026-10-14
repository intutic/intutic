# GitOps for SOPs <Badge type="tip" text="Cloud" />

Two planes hold SOPs, and until now they barely connected. `.intutic/sops/*.md`
is the **file plane** — git-reviewable, enforced directly by the local proxy,
deliverable to a Kubernetes cluster as a `proxy-sops` ConfigMap (see
[Agent Guidelines](/guide/sops) for where the proxy looks and what
`INTUTIC_SOPS_DIR` is for). The control plane's `sop_registry` is the **DB
plane** — lifecycle states, the judge/validation pipeline, anti-gaming checks,
shadow evaluation (see [SOP Front Matter](/reference/sop-front-matter)).

`intutic sops push` / `pull` / `status` are the bridge — a deliberately manual
one, run when you mean to sync, not a background daemon silently reconciling
the two.

## `intutic sops push <name>`

```bash
intutic sops push deploy-checklist
```

Reads every `.md` file under `.intutic/sops/deploy-checklist/` and pushes
**one control-plane SOP per file** — each carrying that file's own declared
front matter faithfully. With no such folder it pushes the single file
`.intutic/sops/deploy-checklist.md`, the layout `sops pull` writes, so a
pulled SOP pushes back by its file name (`.md` optional).

A file that records its SOP — `intutic_id:` and `intutic_revision:` in its
front matter, written by `pull` and by every successful push — **updates that
SOP**; a file without one creates a new SOP and records it. Commit the files
with these keys: they are how a teammate's push lands on the same SOP.

```yaml
---
title: Never Deploy Without Tests
risk_tier: high
version: 2.1.0
---
Deploys must be preceded by a green test run.
```

`title:`, `risk_tier:` and `version:` land on the new SOP row exactly as
declared. An unstated `risk_tier:` gets the control plane's own default
(`MEDIUM`) rather than a value this command invents; an unstated `title:`
falls back to the file's first `# ` heading, then to the file name. Front
matter is stripped before the body is uploaded — a judge prompt should never
have to read `---\nrisk_tier: high\n---` as part of the policy text.

::: warning What does not round-trip
`sop_registry` has no column for `deny_tools:`, `requires_before:`,
`scope_paths:` or any of the other declarative enforcement keys the
[proxy's front-matter parser](/reference/sop-front-matter) reads — those stay
file-plane concepts. Pushing a SOP publishes its title, risk tier, version and
prose to the control plane's judge/lifecycle pipeline; it does not make the
control plane *enforce* what the file enforces locally. The two planes answer
different questions: "does this response violate the policy text" (judge) vs.
"is this specific tool call allowed right now" (proxy, from the file).
:::

### Updating a SOP

An update goes through the same edit path as the dashboard
(`PUT /api/v1/sops/:id`), so the lifecycle applies:

- **A DRAFT** is edited in place.
- **An approved SOP** gets a new DRAFT version. The approved version keeps
  enforcing until the draft is promoted, and the file now records the draft,
  so the next push edits the draft and the next `pull` does not write the
  approved version back as a second file.
- **An edit that loosens the guideline** (classified WEAKEN) needs an Owner;
  the control plane's refusal is printed and the file is left as it is.

A file that matches its SOP sends nothing (`up to date`). The file's
`intutic_revision:` goes along as the precondition: if the SOP was edited on
the control plane since you pulled, the push is refused —

```text
✖ deploy-checklist.md: "Never Deploy Without Tests" changed on the server since you pulled it (revision 4 there, 3 recorded here). Run `intutic sops pull` to fetch it, or push with --force to overwrite it.
```

— and `--force` overwrites it. A push that would fork a second DRAFT of an
approved SOP that already has one is refused the same way. A recorded SOP
that was deleted on the control plane is refused too; `--create` creates a
new one and records it. Each file's result is printed, and the command exits
`1` if any file failed.

`--org` pushes as a mandatory org-wide floor instead (`/api/v1/workspace/org-sops`)
— see [Organizations, Teams & Billing](/guide/organizations). Org floors are
always created; there is no update path for them.

## `intutic sops pull`

```bash
intutic sops pull
```

The round trip the other direction: every SOP in the workspace, written to
`.intutic/sops/<slug-of-title>.md` with front matter reconstructed from the
row (`title:`, `risk_tier:`, `version:`, plus a `content_hash:` marker — see
below — and the `intutic_id:`/`intutic_revision:` record `push` reads). A SOP
with no risk tier gets no `risk_tier:` line, and a `push` of that file leaves
the SOP untiered. A SOP
whose id a local file already records — flat or in a `<name>/` folder — is
written into that file, and only its synced keys and body are replaced: the
enforcing keys the proxy reads stay. Two SOPs sharing a title get distinct
file names (the second suffixed with part of its `sopId`) rather than one
silently overwriting the other.

### Refusing to clobber local edits

`pull` will not overwrite a file it did not most recently write, unless you
pass `--force`:

```bash
intutic sops pull --force
```

The check is a **recorded hash**, not a live diff against the control plane.
Every file `pull` writes carries `content_hash: <sha256 of its own body>` in
its own front matter. On a later pull, that recorded hash is compared against
the *current* local body's hash:

- **Match** — nothing local has changed since the last pull. Safe to refresh
  with whatever the control plane has now, even if it moved on in the
  meantime.
- **Mismatch** — a human edited the file since the last pull. Refused; the
  file is yours until you `push` it or explicitly discard it with `--force`.
- **No recorded hash at all** — a hand-authored file, or one only ever
  `push`ed and never `pull`ed. Treated as unverifiable and always requires
  `--force`: overwriting a hand-written SOP the first time this command ever
  sees it is the expensive direction to get wrong.

## `intutic sops status`

```bash
intutic sops status
```

Does not modify any local file. For every local `.intutic/sops/*.md` and
`.intutic/sops/<name>/*.md` file (except the `guardrail-*.md` files
`intutic guardrails pull` writes, which have no control-plane SOP to compare
against), matched to its SOP by the recorded `intutic_id:` — by title for a
file without one — reports one of:

| Status | Meaning |
|---|---|
| `in-sync` | Local body hash matches the control plane's `content_hash`. |
| `local-ahead` | Recorded pull hash is stale — you edited this file since the last pull, and the SOP's revision has not moved. `push` to publish. |
| `remote-ahead` | Unedited since the last pull, but the control plane's content has moved. `pull` to catch up. |
| `diverged` | Edited here and on the control plane since the last sync (the recorded revision moved). Or: no recorded pull hash, and the local body does not match the control plane either — a file never pulled, or one edited long after a very old pull, which `status` cannot tell apart. |
| `push-only` | No SOP with a matching title exists on the control plane yet, or the SOP the file records is gone. |

Every matched (non-`push-only`) result is also reported to the control plane
over `POST /api/v1/sops/git-drift-report`, best-effort — a report failure
never fails the command, since the table above is already complete and
correct on its own. This is what feeds the `sop_git_drift` compliance probe
below.

## What this does not do

**No live sync.** `push`/`pull`/`status` are commands you run; nothing
watches `.intutic/sops/*.md` and reconciles it automatically. A full
always-on version of this would mean the sync daemon hashing and reporting
file-plane SOPs continuously in the background — deliberately not attempted
here as a half-measure. `intutic sops status`, run by a human (or a CI job)
on a schedule, is today's substitute — and unlike earlier, it now leaves a
compliance signal behind each time it runs (see `sop_git_drift` below),
instead of only printing to a terminal no one is later asked to read.

**The compliance probe reports the last run's result, not staleness.**
`sop_git_drift` reads whatever `git_drift_status` was last
recorded per SOP — it does not know how long ago that was beyond the
`git_drift_checked_at` timestamp it carries, and it cannot detect a file
that changed after the last `status` run and before the next one. Run
`status` on the cadence your compliance posture actually needs; the probe
can only be as fresh as its last report.

**A file without a sync record is matched by title.** A file that was never
pulled or pushed carries no `intutic_id:`, so `status` falls back to its
title, and renaming it breaks that match. Once a file is synced, the id
holds through renames on either side.
