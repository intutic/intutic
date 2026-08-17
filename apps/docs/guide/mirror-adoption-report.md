# Pre-Adoption Gate for Model Upgrades <Badge type="info" text="FinOps & Governance" />

Before you switch a workflow to a cheaper or newer model, you usually want more than a vibe check. The mirror-adoption report mirror-tests a candidate model against a sampled fraction of your real, live traffic, has an LLM judge each comparison, and rolls the results up into one report: win/loss/tie counts, a fault-rate delta, a cost delta, and a latency delta.

It does **not** switch anything for you. This is a signal a human reads before deciding whether to adopt a candidate — not an automatic gate on your routing.

---

## How It Works

Steps 1–2 run entirely in the proxy gateway and work the same way whether or not you have a control plane connected. Steps 3–5 need one — judging, durable verdict storage, and the report itself all live in the control plane, not the proxy.

1. **Mirror sampling** — the proxy gateway (`packages/proxy/src/routing/mirror.rs`) samples a small, capped fraction of eligible requests. For each sampled request, it serves the real response from the requested model as normal, and — off the request's latency path, after the real response has already been returned — also sends the same request to your configured candidate model.
2. **Scrub and publish** — the pair (request text + both responses) is DLP-scrubbed and published as a transient message. Nothing here is written to disk yet. A standalone open-core install without a control plane stops here: mirroring still runs and a local counter still tracks outcomes, but nothing judges the pair and there is no report to read.

<!-- ENTERPRISE_ONLY_START -->
3. **Judge at ingest** — a control-plane subscriber judges the pair the instant it arrives: an LLM judge compares the candidate's response against the response that actually served the request and returns a verdict (`candidate_better`, `original_better`, or `tie`), plus a 0–100 quality score for each side.
4. **Store the verdict, not the text** — only the verdict and its metadata (scores, candidate cost, candidate latency, which judge model was used) are written durably. The request text and both response bodies are discarded the moment judging finishes.
5. **Report** — once enough verdicts exist for a candidate model, the report aggregates them into win/loss/tie counts and the three deltas described below. You read it from the dashboard or the CLI.
<!-- ENTERPRISE_ONLY_END -->

## Honest Limits

This feature is useful, but it is not a substitute for real evaluation. Read this section before you make a decision off of it.

- **Non-streaming traffic only.** The proxy never mirrors a streaming request — the two responses can't be meaningfully compared turn-for-turn, and mirroring a stream would mean fully consuming a second stream nobody asked for just to score it. If your workload streams (most interactive agent harnesses do), it is not covered by this report at all.
- **Sampled, not exhaustive.** The mirror sample rate is hard-capped at 5% of eligible traffic, regardless of what you configure. This bounds cost — every mirrored request is billed twice — but it also means the report is built from a slice of your traffic, not all of it.
- **The judge is an opinion, not a correctness check.** The verdict comes from an LLM comparing two responses for correctness, completeness, and instruction-following. It is a real, useful signal, and it is *not* a ground-truth check — it can be wrong the same way any LLM judgment can be wrong, and it says nothing about wrong-but-well-formed answers that merely *look* right.
- **Verdict-only storage — no response text is ever retained.** The only durable trace of a mirrored comparison is the verdict plus numeric metadata (scores, cost, latency, which judge model ran). The request text and both full response bodies exist only transiently, in memory, for the moment it takes to judge them, and are never written to a database, a log line, or anywhere else. If you're evaluating this feature for a privacy- or security-sensitive workload, this is the property that matters most: mirroring a request never creates a durable copy of its contents.
- **Cost and latency deltas may come back empty.** The report can only compute a cost or latency delta from pairs where *both* the original call's and the candidate's cost/latency are known. As of this writing, only the candidate side is captured — so these two deltas are `null` until a future release adds the original side. A `null` delta means "not measured yet," never "zero difference." (Win/loss/tie counts and the fault-rate delta are unaffected by this and work today.)
- **The report is platform-wide, not scoped to your workspace's own traffic.** A candidate model's adoption signal is deliberately aggregated across every workspace mirroring that same candidate, not filtered to yours — small per-workspace sample sizes would otherwise make the report meaningless. The verdicts it aggregates never contain response text (see above), so this doesn't cross any confidentiality boundary, but it does mean the number you see reflects more than just your own traffic.
- **A ratio is refused, not guessed, below a minimum sample size.** If a candidate model doesn't yet have enough recorded verdicts, the report says so explicitly rather than computing a win/loss ratio from too few samples. Treat that response as "come back later," not as a bad or a good result.

## Supersedes an Earlier, Automatic-Enforcement Design

An earlier design (referred to internally as "C6/C7") called for the proxy to automatically enforce routing decisions per workspace based on a mirror-measured fault-rate delta — i.e., to have the system silently switch or block a model on its own once the numbers crossed a threshold. That automatic-enforcement design was never built, and this feature does not build it either. What ships here **supersedes** that plan rather than fulfilling it: mirroring now produces a report a human reads, not a control loop that acts on your routing by itself. If per-workspace automatic enforcement is something you need, it remains unbuilt, tracked as a known gap rather than an oversight.

---

## Configuration

<!-- ENTERPRISE_ONLY_START -->
If you're connected to a control plane, you can set a candidate model from the **Settings → Smart Model Routing & Response Cache** tab, or directly in the proxy's own config (below) if you run a self-hosted gateway.
<!-- ENTERPRISE_ONLY_END -->

Whether you're standalone open-core or connected to a control plane, mirroring itself is configured the same way, directly in the proxy's `config.yaml` — no dashboard or control plane required to turn sampling *on*:

```yaml
intutic_settings:
  routing:
    # An explicit, operator-directed candidate to mirror-test — independent
    # of the bandit router's own shadow-mode candidate selection.
    mirror_candidate_model: "gpt-4o-mini"
    # Fraction of eligible, non-streaming traffic to mirror. Clamped to 0.05
    # (5%) regardless of what you set here — every mirrored request is
    # billed twice.
    mirror_sample_rate: 0.05
```

Both default off (`mirror_sample_rate: 0.0`, `mirror_candidate_model` unset) — mirroring costs a second model call on every sampled request, so it is opt-in, never on by default.

<!-- ENTERPRISE_ONLY_START -->
> [!NOTE]
> Setting `mirror_candidate_model` alone does not produce a report. Judging and durable storage of verdicts (steps 3–4 above) happen in the control plane — this configuration only controls whether the proxy *samples and publishes* mirrored pairs at all. Standalone open-core installs without a control plane will mirror traffic and record local counters, but have no judge and no report to read.
<!-- ENTERPRISE_ONLY_END -->

## Reading the Report

<!-- ENTERPRISE_ONLY_START -->
### Dashboard

Open **Settings → Smart Model Routing & Response Cache**, and scroll to **Mirror-Test Adoption Report**. Enter the candidate model id you configured above and click **Load Report**.

- A populated report shows candidate-better / original-better / tie / unjudged counts, the fault-rate delta (negative means the candidate faults *less* than the model it mirrored — the favorable direction), and the cost/latency deltas (shown as "not measured" rather than `$0.00`/`0 ms` when the underlying data isn't captured yet — see [Honest Limits](#honest-limits) above).
- An **insufficient data** state is rendered as its own distinct block, not as a report with zeroed-out numbers — this is deliberate, so a candidate with too few samples never looks like a candidate that has been cleared.
<!-- ENTERPRISE_ONLY_END -->

### CLI

```bash
intutic routing adoption-report --candidate-model gpt-4o-mini
```

```
Intutic — Mirror-Test Adoption Report
  Candidate model: gpt-4o-mini
  Sample count: 45

  Candidate better: 28
  Original better: 12
  Tie: 3
  Unjudged: 2

  Fault-rate delta: -8.0 pts (candidate faults less)
  Avg. cost delta: not measured — served-side cost is not yet on the wire event (TD-352)
  Avg. latency delta: not measured — served-side latency is not yet on the wire event (TD-352)

  This is a reported signal for human review, not an automatic gate — nothing here changes routing.
```

Add `--json` for machine-readable output (e.g. to feed into a release checklist script). Like every command that reads from the control plane, this needs a control plane behind it — a standalone open-core proxy with no control plane has nowhere for this command to read a judged report from (see [Honest Limits](#honest-limits)).
