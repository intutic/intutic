# Findings <Badge type="tip" text="Cloud" />

**Findings › Findings** (`/findings`) is where people rule on what Intutic's detectors flagged. Each ruling says whether a finding was a true or a false positive, and the page turns those rulings into a measured false-positive rate per detector.

**Findings › Incidents** (`/findings/incidents`) is the workspace's triage inbox. It is covered [below](#incidents).

## What you'll learn

- What a finding is, and how to rule on one
- Keyboard and bulk triage
- How to read the SSL detector promotion meter, the per-detector stats and the response-echo report
- What the Incidents page lists, and how to resolve an incident

## What a finding is

A finding is the record of one detector firing: which detector fired, the disposition it reached, its reason, its confidence and, where there is one, the trace it fired on. A finding has no ruling until a person gives it one. Until then it counts toward the detector's total but not toward its false-positive rate.

## Ruling on findings

**Waiting on a ruling** lists up to 50 findings nobody has ruled on yet. It is ordered by uncertainty: the findings whose detector confidence is closest to a coin flip come first, newest first among equals. A person's ruling tells the most where the detector itself was least sure.

| Column | What it shows |
|--------|---------------|
| **Created** | When the finding was recorded |
| **Detector** | The detector id, for example `scope_path` |
| **Disposition** | What the detector decided |
| **Reason** | The detector's reason |
| **Trace** | The trace id; click it to open the trace on **Activity › Traces** |
| **Ruling** | **True** and **False** buttons |

To narrow the list to one detector, type its id in the **Detector** field. When nothing matches, the list says **Nothing waiting on a ruling** and offers **Clear filter**.

### Recording a ruling

Click **True** or **False** on a row. A note field opens, labelled **Note on true positive (optional)** or **Note on false positive (optional)**. Press Enter or click **Record true positive** (or **Record false positive**) to save; press Escape or click **Cancel** to close it without a ruling.

A ruled finding leaves the queue. The person who ruled is taken from the signed-in account, not from anything the page sends. If the ruling fails, for example because someone else ruled first, the page says so; refresh to check.

A true-positive ruling also switches off any [automatic false-positive labelling](#automatic-false-positive-labels) for that detector, anomaly kind and harness, so later findings of that shape come back to a person.

### Keyboard triage

While no text field has focus, single keys work down the queue:

| Key | Action |
|-----|--------|
| `j` or ↓ | Move to the next finding |
| `k` or ↑ | Move to the previous finding |
| `t` | Rule the selected finding a true positive |
| `f` | Rule the selected finding a false positive |

`t` and `f` save the ruling straight away, with no note. The selection stays where it is, which is now the next finding, so pressing `t` or `f` again rules that one. Clicking a row moves the selection to it. Keys pressed with Cmd, Ctrl or Alt are ignored. Use the row's buttons for a ruling that needs a note.

### Bulk triage

Tick the checkboxes of several findings. A bar appears with the number selected and **Mark true positive**, **Mark false positive** and **Clear selection**. The rulings are recorded one finding at a time, without notes. If one fails, the rest are not recorded and the page says the bulk ruling stopped partway; refresh to see which findings were ruled.

### Response-injection findings

Findings whose detector id starts with `response_injection:` are echoes of an injection pattern found in a model's own output. They can carry a scrubbed, DLP-redacted excerpt of that output. On these rows:

- Owners and Admins see **Reveal snippet** beside the reason. The excerpt is fetched only when they click it, and **Hide** puts it away. **No snippet available** means there is none to show; excerpts are deleted after 14 days by default, whether or not the finding was ruled on.
- Everyone else sees **snippet — owner/admin only**, and nothing is fetched.
- Only Owners and Admins can rule on them, because a note can quote the excerpt. Their notes are shown only to Owners and Admins.

### Automatic false-positive labels

When a detector, anomaly kind and harness have collected three false-positive rulings and no true-positive one, Intutic starts labelling new findings of that shape false positive itself. They are still recorded, but they skip the queue. The automatic labelling lapses after 90 days without further evidence, and a single true-positive ruling switches it off. Automatically labelled findings are left out of the per-detector rates and the promotion meter, which count only people's rulings.

## SSL detector promotion

The two SSL detectors, **SSL — structural** (`ssl_structural`) and **SSL — logical** (`ssl_logical`), run shadow-only: they record findings but never block. They become eligible for promotion once each has at least 200 ruled findings and a false-positive rate between 0.1% and 1%.

The **SSL detector promotion** section shows one meter per detector:

- the count ruled so far, out of 200;
- the measured **FP rate** against the 0.1–1% band, or **no measured rate** when nothing has been ruled;
- **Eligible for promotion** once both conditions hold, or otherwise a projected date at the pace of the last 30 days' rulings. With no rulings in the last 30 days there is nothing to project from, and the meter says so.

It is a meter, not a control. Nothing on the page promotes a detector or changes its mode.

## Per-detector stats

**Per-detector stats** has one row per detector, with shadowed findings on a separate row from enforced ones:

| Column | What it shows |
|--------|---------------|
| **Detector** | The detector id |
| **Shadowed** | **shadowed** when these findings were recorded in shadow mode and never blocked anything |
| **Total** | Every finding the detector recorded |
| **Adjudicated** | Findings a person has ruled on |
| **FP rate** | False positives divided by **Adjudicated** |

The rate divides by the findings people ruled on, not by every finding, so a detector nobody reviews does not score well by default. A detector with no rulings shows **no measured rate**, never 0%.

Below the table, **Read these rates with care** prints the caveats the control plane sends with the numbers. In short:

- Recall is not reported: nothing records a catch a detector missed.
- These findings come from workspaces already running Intutic, so treat any rate as a lower bound.
- There is no combined score across detectors. Roughly half of them fire only on operator declarations and have no false-positive rate to measure.
- A shadowed row's rate is what enforcement would have cost, not what it did. Do not merge it with the enforced row.
- `response_injection:*` rows come from model output, not prompts, and have a different noise floor. Do not average them with the rest.
- Automatically labelled findings are left out of the rates.

## Response-echo report

**Response-echo report** measures the response-injection echo findings per pattern over a window. **Since** and **Until** pick the dates; with neither set, the window is the last 7 days.

The report first states how many traces were ingested in the window. With none, it says **no traces ingested in this window**: nothing was checked, which is not the same as nothing found.

The table lists all five patterns, including any that never fired: **Pattern**, **Findings**, **Adjudicated** and **FP rate**. A pattern's rate is shown only once it has at least 20 ruled findings in the window; below that, the rate column says the rate is withheld. There is no combined rate across patterns.

## Who can open it

The Findings area (**Findings**, **Incidents** and the [Review Queue](/guide/decisions)) is shown only to Owners, Admins and Engineering Managers. Developers and Viewers do not see it.

The control plane applies its own checks:

| Request | Who |
|---------|-----|
| Listing findings, stats, promotion status and the response-echo report | Any signed-in member |
| Recording a ruling | Owner, Admin or EM; Owner or Admin for `response_injection:*` findings |
| Revealing a snippet | Owner or Admin |

The same work can be done from the CLI with [`intutic findings`](/reference/cli#intutic-findings-list).

## Incidents {#incidents}

**Findings › Incidents** (`/findings/incidents`), headed **Incidents**, has three tabs. The open tab is kept in the address as `?tab=incidents`, `?tab=alerts` or `?tab=anomalies`, so a link can open a given tab. Like the rest of the Findings area, it is shown to Owners, Admins and Engineering Managers, and the control plane refuses anyone else.

### Incidents tab

Governance incidents in the workspace. Filters sit above the list:

- **Status**: **Open**, **Resolved** or **Auto-resolved**. The tab opens on **Open**.
- **Severity**: **Critical**, **High**, **Medium** or **Low**.
- **Incident type**: any [incident type](/guide/concepts#incident-types), or **All types**.

Click an active status or severity again to clear it. When nothing matches, **Show all incidents** clears every filter.

The list shows **Severity**, **Type**, **Description**, **Status** and **Created**, 20 to a page, with a **Resolve** button on open incidents. It is ranked by suspicion, not recency: by severity, detector confidence and age. When more incidents match than a reviewer is expected to get through, a line above the list says how many are shown, how many matched and how many are not shown.

### Drift Alerts tab

Alerts from the [Trajectory Monitor](/guide/trajectory-monitor). Filter by **Critical**, **High** or **Medium** severity. The list shows **Severity**, **Type**, **State**, **Verdict**, **Summary**, **Session** and **When**, 20 to a page, with the same line when more alerts match than are shown (ranked by severity and age).

Click an alert to open its drawer: the summary, **State**, **Verdict** with its intervention action, **Confidence**, **Mode**, any **Heuristic triggers**, the **Judge reasoning** and the **Trajectory window**. Drift alerts are read-only here.

An empty list can mean the monitor is not running: alerts appear only when the sync daemon sends trajectory summaries and the control plane runs with `FF_TRAJECTORY_MONITOR=true`.

### Anomalies tab

Traces the anomaly classifier flagged, with **Type**, **Model**, **Enforcement**, **Compliance** and **When**. Click a row to open the trace in the same drawer **Activity › Traces** uses.

### Incident detail

Click an incident to open its drawer. The header shows the incident type, its severity and status, and its id. The body shows the description, then whichever of these the incident carries:

| Field | What it shows |
|-------|---------------|
| **Judge** | For a governance-judge incident, who decided: the typed judge, human review, or an assistant ruling made at an operator's instruction (incidents from before 3.0 can also show the free-text judge's interim verdict, and `free-text` is the free-text judge deciding on a deployment with no band, deprecated until 4.0); with the first stage's violation probability and the SOP the incident most likely concerns |
| **Caller** | Who made the call: the member the API key belongs to, then what the reporting process said (OS user, key prefix, MCP server) |
| **Gate verdict** | **TAMPER**: a governance file the sync daemon restored, with its path and harness |
| **MCP call budget** | The budget that refused calls, how many it refused this period, and when it resets |
| **Session** and **Trace** | Their ids, or a dash |
| **Created** | When the incident was opened |
| **Resolved by** | Who resolved it, and when |
| **Resolution notes** | The notes given when it was resolved |
| **Spend averted** | For a killed runaway session, what it would have gone on to cost, marked **extrapolated**, with the measured rate per minute and how many minutes forward it was extrapolated. See [Runaway-Spend Counterfactual](/guide/averted-spend) |

Each incident also has its own address, `/findings/incidents/<incidentId>`. It opens the Incidents tab with that incident's drawer open, and incident notifications link to it. Closing the drawer returns to `/findings/incidents`.

### Resolving an incident

On an open incident, click **Resolve** in the list or **Resolve…** in the drawer. The **Resolve incident** dialog asks for **Resolution notes**, which are required and saved to the incident's audit trail. Click **Resolve** to confirm. The incident moves to **Resolved**, and the resolver is recorded as the signed-in account. An incident that is already resolved cannot be resolved again; the page says so.

Incidents can also be listed and read from the CLI with [`intutic incidents list`](/reference/cli#intutic-incidents-list).

## Related

- [Review Queue](/guide/decisions) — override requests, held changes and judge reviews
- [Traces](/guide/traces) — the traces findings and anomalies point at
- [Policies & Enforcement](/guide/policies)
- [Core Concepts: incident types](/guide/concepts#incident-types)
- [Audit Timeline](/guide/audit-timeline) — rulings and resolved incidents, with who made them
