# Evaluator Sandbox <Badge type="warning" text="Cloud / Biz Org+" />

**Labs › Evaluator Sandbox** (`/labs/evaluator`) replays a candidate evaluator config against a golden dataset, and blocks a deploy that would weaken enforcement. Owners and Admins only, on a plan that includes it (Biz Org and the Enterprise plans).

The page has two tabs: **Golden Datasets** and **Run & Results**.

## Golden Datasets

A golden dataset is a set of prompts, each paired with the verdict (`BYPASS`, `ENHANCE`, `HIJACK` or `KILL`) and risk tier (`LOW`, `MEDIUM`, `HIGH` or `CRITICAL`) the evaluator should reach. A run needs at least **50 samples**; the list marks a dataset below that floor, and a run against it is refused.

To create one, fill in **Create Golden Dataset**:

- **Dataset Name**
- One row per sample (**Add sample** adds another): **Prompt**, **Context**, **Expected Verdict**, **Expected Risk Tier** and **Tags (comma-separated)**
- Optionally, **Structured trace fields (optional)**: a JSON object of trace fields such as `toolName`, `toolArguments`, `dlpFlagged` or `budgetExceeded`. Eight of the nine detectors read these fields, so a sample without them exercises far less of the evaluator

Then **Create Dataset**.

## Run & Results

**Trigger Evaluation** takes:

| Field | What it does |
|-------|--------------|
| **Golden Dataset** | The dataset to replay |
| **Evaluator Prompt Override (optional)** | Leave blank to score with the evaluator prompt deployed now |
| **Model Override (optional)** | A different model for the run |
| **HIJACK at or above**, **KILL at or above**, **BYPASS at or below** | Score thresholds, 0 to 1 (defaults 0.7, 0.9 and 0.3) |
| **LLM scoring layer enabled** | Whether the LLM layer scores the samples |
| **Compare with the config deployed now** | Score every sample under the deployed config as well. Needed to deploy: without it the weakening check cannot pass |

**Run evaluation** starts the run on the server. The view checks it every 2 seconds until it completes or fails. There is no list of past runs: **Existing run** looks one up by its ID (`esr_…`), and the page remembers the last ten runs started in this browser.

A complete run shows:

- **Precision**, **Recall**, **F1** and **Accuracy** against the dataset's expected verdicts
- **Weakening check** — the flip rate against its threshold, marked **Clear** or **Weakens enforcement**, with a recommendation
- **Per-sample results** — each prompt's expected and actual verdict and risk tier, score, change against the deployed config, and **Match** or **Mismatch**

### How the weakening check works

Every sample is scored under the candidate config and, unless the comparison is off, under the config deployed for the workspace now. If more than **10%** of the high-risk samples (expected `KILL` or `HIJACK`) flip to a non-enforcing verdict (`BYPASS` or `ENHANCE`) under the candidate, deploy is blocked. There is no override.

## Deploying a config

**Deploy config** appears on a complete run. It stays disabled when the run did not compare with the deployed config, or when the weakening check found the candidate weakens enforcement; the control plane refuses both cases too. A deploy writes the candidate to the workspace's live evaluator settings, so the evaluator uses it from the next call. The page confirms the time it went live.

## Related

- [Enforcement Actions](/concepts/enforcement-actions) — what `BYPASS`, `ENHANCE`, `HIJACK` and `KILL` do
- [Security & Identity](/guide/security#feature-access-by-role) — roles and which pages each can open
